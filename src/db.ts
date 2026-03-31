import Database from "better-sqlite3";
import * as fs from "fs";
import {
  DB_PATH,
  SQUAD_DIR,
  STATUS_CACHE_PATH,
  STATUS_CACHE_WINDOW_MS,
  SQLITE_BUSY_TIMEOUT_MS,
  STALE_INSTANCE_MS,
  Instance,
  Message,
  KVEntry,
  Standup,
  DEFAULT_MESSAGES_LIMIT,
  MAX_MESSAGES_LIMIT,
  MAX_BROADCAST_BYTES,
  MAX_KV_VALUE_BYTES,
  nowMs,
} from "./types.js";

export function openDb(dbPath = DB_PATH): Database.Database {
  fs.mkdirSync(SQUAD_DIR, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = " + SQLITE_BUSY_TIMEOUT_MS);
  db.pragma("foreign_keys = ON");
  initSchema(db);
  migrateSchema(db);
  ensureRepoIndex(db);
  purgeStaleInstances(db);
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      branch TEXT,
      repo TEXT NOT NULL DEFAULT 'local',
      last_seen INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('broadcast','ask','answer')),
      content TEXT NOT NULL,
      tags TEXT,
      reply_to INTEGER,
      repo TEXT NOT NULL DEFAULT 'local',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT NOT NULL,
      repo TEXT NOT NULL DEFAULT 'local',
      value TEXT NOT NULL,
      set_by TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (key, repo)
    );
  `);

}

/**
 * Migrate v1 schema (no repo columns) to v2.
 * Wrapped in a transaction — partial migration leaves DB at v1 and retries next startup.
 */
function migrateSchema(db: Database.Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;

  // Detect repo column presence to distinguish fresh DB (version=0, has repo)
  // from v1 legacy DB (version=0, no repo) from already-migrated (version>=2)
  const cols = db.pragma("table_info(instances)") as Array<{ name: string }>;
  const hasRepo = cols.some((c) => c.name === "repo");

  if (version >= 2 || hasRepo) {
    // Fresh DB or already migrated — just ensure version is stamped
    if (version < 2) db.pragma("user_version = 2");
    return;
  }

  process.stderr.write("claude-squad: migrating schema to v2 (adding repo scoping)...\n");

  const migrate = db.transaction(() => {
    db.exec(`ALTER TABLE instances ADD COLUMN repo TEXT NOT NULL DEFAULT 'legacy'`);
    db.exec(`ALTER TABLE messages ADD COLUMN repo TEXT NOT NULL DEFAULT 'legacy'`);
    // kv needs composite PK (key, repo) — recreate the table
    db.exec(`
      CREATE TABLE kv_v2 (
        key TEXT NOT NULL,
        repo TEXT NOT NULL DEFAULT 'legacy',
        value TEXT NOT NULL,
        set_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (key, repo)
      );
      INSERT INTO kv_v2 SELECT key, 'legacy', value, set_by, updated_at FROM kv;
      DROP TABLE kv;
      ALTER TABLE kv_v2 RENAME TO kv;
    `);
  });

  migrate();
  db.pragma("user_version = 2");

  process.stderr.write(
    "claude-squad: migration complete. Existing data tagged as repo='legacy'.\n"
  );
}

/** Creates the repo-scoped index — only safe to call after migration ensures the column exists. */
function ensureRepoIndex(db: Database.Database): void {
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_repo ON messages(repo, created_at DESC)");
}

function purgeStaleInstances(db: Database.Database): void {
  const cutoff = nowMs() - STALE_INSTANCE_MS;
  db.prepare("DELETE FROM instances WHERE last_seen > 0 AND last_seen < ?").run(cutoff);
}

// ── Instances ────────────────────────────────────────────────────────────────

export function upsertInstance(
  db: Database.Database,
  id: string,
  name: string,
  cwd: string,
  branch: string | null,
  repo = "local"
): void {
  db.prepare(`
    INSERT INTO instances (id, name, cwd, branch, repo, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      cwd = excluded.cwd,
      branch = excluded.branch,
      repo = excluded.repo,
      last_seen = excluded.last_seen
  `).run(id, name, cwd, branch ?? null, repo, nowMs());
}

export function heartbeat(
  db: Database.Database,
  instanceId: string,
  branch?: string
): void {
  const updates: string[] = ["last_seen = ?"];
  const values: unknown[] = [nowMs()];
  if (branch !== undefined) {
    updates.push("branch = ?");
    values.push(branch);
  }
  values.push(instanceId);
  db.prepare(`UPDATE instances SET ${updates.join(", ")} WHERE id = ?`).run(...values);
}

export function markOffline(db: Database.Database, instanceId: string): void {
  db.prepare("UPDATE instances SET last_seen = 0 WHERE id = ?").run(instanceId);
}

export function listInstances(db: Database.Database, repo?: string): Instance[] {
  const cutoff = nowMs() - STALE_INSTANCE_MS;
  if (repo !== undefined) {
    return db
      .prepare(
        "SELECT * FROM instances WHERE (last_seen > ? OR last_seen = 0) AND repo = ? ORDER BY last_seen DESC"
      )
      .all(cutoff, repo) as Instance[];
  }
  return db
    .prepare("SELECT * FROM instances WHERE last_seen > ? OR last_seen = 0 ORDER BY last_seen DESC")
    .all(cutoff) as Instance[];
}

export function getActiveInstances(db: Database.Database, repo?: string): Instance[] {
  const cutoff = nowMs() - STALE_INSTANCE_MS;
  if (repo !== undefined) {
    return db
      .prepare("SELECT * FROM instances WHERE last_seen >= ? AND repo = ? ORDER BY last_seen DESC")
      .all(cutoff, repo) as Instance[];
  }
  return db
    .prepare("SELECT * FROM instances WHERE last_seen >= ? ORDER BY last_seen DESC")
    .all(cutoff) as Instance[];
}

/** Look up a single instance's repo. Returns 'local' if not found. */
export function getInstanceRepo(db: Database.Database, instanceId: string): string {
  const row = db
    .prepare("SELECT repo FROM instances WHERE id = ?")
    .get(instanceId) as { repo: string } | undefined;
  return row?.repo ?? "local";
}

// ── Messages ─────────────────────────────────────────────────────────────────

export function broadcast(
  db: Database.Database,
  instanceId: string,
  content: string,
  tags?: string[],
  repo?: string
): number {
  if (Buffer.byteLength(content, "utf8") > MAX_BROADCAST_BYTES) {
    throw new Error(`Message too large (max ${MAX_BROADCAST_BYTES / 1024}KB)`);
  }
  const tagsJson = tags && tags.length > 0 ? JSON.stringify(tags) : null;
  const effectiveRepo = repo ?? getInstanceRepo(db, instanceId);
  const result = db.prepare(`
    INSERT INTO messages (instance_id, type, content, tags, reply_to, repo, created_at)
    VALUES (?, 'broadcast', ?, ?, NULL, ?, ?)
  `).run(instanceId, content, tagsJson, effectiveRepo, nowMs());
  return result.lastInsertRowid as number;
}

export function ask(
  db: Database.Database,
  instanceId: string,
  question: string,
  context?: string,
  repo?: string
): number {
  const content = context ? `${question}\n\nContext: ${context}` : question;
  if (Buffer.byteLength(content, "utf8") > MAX_BROADCAST_BYTES) {
    throw new Error(`Question too large (max ${MAX_BROADCAST_BYTES / 1024}KB)`);
  }
  const effectiveRepo = repo ?? getInstanceRepo(db, instanceId);
  const result = db.prepare(`
    INSERT INTO messages (instance_id, type, content, tags, reply_to, repo, created_at)
    VALUES (?, 'ask', ?, NULL, NULL, ?, ?)
  `).run(instanceId, content, effectiveRepo, nowMs());
  return result.lastInsertRowid as number;
}

export function answer(
  db: Database.Database,
  instanceId: string,
  questionId: number,
  answerText: string
): number {
  const target = db.prepare(
    "SELECT id, type, repo FROM messages WHERE id = ?"
  ).get(questionId) as { id: number; type: string; repo: string } | undefined;

  if (!target) {
    throw new Error(`Question ID ${questionId} not found`);
  }
  if (target.type !== "ask") {
    throw new Error(`Message ${questionId} is not a question (type: ${target.type})`);
  }
  if (Buffer.byteLength(answerText, "utf8") > MAX_BROADCAST_BYTES) {
    throw new Error(`Answer too large (max ${MAX_BROADCAST_BYTES / 1024}KB)`);
  }

  const result = db.prepare(`
    INSERT INTO messages (instance_id, type, content, tags, reply_to, repo, created_at)
    VALUES (?, 'answer', ?, NULL, ?, ?, ?)
  `).run(instanceId, answerText, questionId, target.repo, nowMs());
  return result.lastInsertRowid as number;
}

export function readMessages(
  db: Database.Database,
  since?: number,
  tags?: string[],
  limit?: number,
  repo?: string
): Message[] {
  const effectiveLimit = Math.min(limit ?? DEFAULT_MESSAGES_LIMIT, MAX_MESSAGES_LIMIT);

  let query = `
    SELECT m.*, i.name AS instance_name
    FROM messages m
    LEFT JOIN instances i ON m.instance_id = i.id
  `;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (repo !== undefined) {
    conditions.push("m.repo = ?");
    params.push(repo);
  }

  if (since !== undefined) {
    conditions.push("m.created_at > ?");
    params.push(since);
  }

  // SQL tag filter via json_each — LIMIT applies after filtering
  if (tags && tags.length > 0) {
    const placeholders = tags.map(() => "?").join(", ");
    conditions.push(
      `(m.tags IS NOT NULL AND EXISTS (
        SELECT 1 FROM json_each(m.tags) WHERE value IN (${placeholders})
      ))`
    );
    params.push(...tags);
  }

  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }

  query += " ORDER BY m.created_at DESC, m.id DESC LIMIT ?";
  params.push(effectiveLimit);

  const rows = db.prepare(query).all(...params) as Array<Message & { tags: string | null }>;

  return rows.map((r) => ({
    ...r,
    tags: r.tags ? (JSON.parse(r.tags) as string[]) : null,
  }));
}

// ── KV Store ─────────────────────────────────────────────────────────────────

export function setShared(
  db: Database.Database,
  instanceId: string,
  key: string,
  value: string,
  repo?: string
): void {
  if (Buffer.byteLength(value, "utf8") > MAX_KV_VALUE_BYTES) {
    throw new Error(`KV value too large (max ${MAX_KV_VALUE_BYTES / 1024}KB). Use broadcast for large context.`);
  }
  const effectiveRepo = repo ?? getInstanceRepo(db, instanceId);
  db.prepare(`
    INSERT INTO kv (key, repo, value, set_by, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key, repo) DO UPDATE SET
      value = excluded.value,
      set_by = excluded.set_by,
      updated_at = excluded.updated_at
  `).run(key, effectiveRepo, value, instanceId, nowMs());
}

export function getShared(
  db: Database.Database,
  key: string,
  repo?: string
): KVEntry | undefined {
  if (repo !== undefined) {
    return db.prepare("SELECT * FROM kv WHERE key = ? AND repo = ?").get(key, repo) as KVEntry | undefined;
  }
  return db.prepare("SELECT * FROM kv WHERE key = ?").get(key) as KVEntry | undefined;
}

// ── Standup ───────────────────────────────────────────────────────────────────

export function buildStandup(db: Database.Database, repo?: string): Standup {
  const active = getActiveInstances(db, repo);

  let msgQuery = `
    SELECT m.type, m.content, m.created_at, i.name AS instance_name
    FROM messages m
    LEFT JOIN instances i ON m.instance_id = i.id
  `;
  const msgParams: unknown[] = [];
  if (repo !== undefined) {
    msgQuery += " WHERE m.repo = ?";
    msgParams.push(repo);
  }
  msgQuery += " ORDER BY m.created_at DESC, m.id DESC LIMIT 5";

  const recent = db.prepare(msgQuery).all(...msgParams) as Array<{
    type: string;
    content: string;
    created_at: number;
    instance_name: string;
  }>;

  return {
    active_instances: active.map((i) => ({
      name: i.name,
      branch: i.branch,
      cwd: i.cwd,
      last_seen: i.last_seen,
    })),
    recent_messages: recent.map((r) => ({
      from: r.instance_name || "unknown",
      type: r.type,
      content: r.content.slice(0, 200),
      created_at: r.created_at,
    })),
  };
}

// ── Status Cache ──────────────────────────────────────────────────────────────

/** Count messages in the last withinMs (default 30 min) for the status bar. */
export function getRecentMessageCount(
  db: Database.Database,
  withinMs = STATUS_CACHE_WINDOW_MS
): number {
  const since = nowMs() - withinMs;
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM messages WHERE created_at > ?")
    .get(since) as { cnt: number };
  return row.cnt;
}

/** Write recent message count to the flat status-cache file. Never throws. */
export function writeStatusCache(db: Database.Database): void {
  try {
    const count = getRecentMessageCount(db);
    fs.writeFileSync(STATUS_CACHE_PATH, String(count), "utf8");
  } catch {
    // best effort
  }
}

// ── Pruning ───────────────────────────────────────────────────────────────────

export function pruneOldMessages(db: Database.Database, olderThanMs = 7 * 24 * 60 * 60 * 1000): void {
  const cutoff = nowMs() - olderThanMs;
  db.prepare("DELETE FROM messages WHERE created_at < ?").run(cutoff);
}
