import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import Database from "better-sqlite3";
import {
  openDb,
  upsertInstance,
  heartbeat,
  markOffline,
  listInstances,
  getActiveInstances,
  broadcast,
  ask,
  answer,
  readMessages,
  setShared,
  getShared,
  buildStandup,
  pruneOldMessages,
  getRecentMessageCount,
} from "../src/db.js";
import { nowMs, makeInstanceId, STALE_INSTANCE_MS } from "../src/types.js";

function tempDbPath(): string {
  return path.join(os.tmpdir(), `cs-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

const REPO_A = "/home/user/project-a/.git";
const REPO_B = "/home/user/project-b/.git";

describe("openDb", () => {
  it("creates schema tables", () => {
    const dbPath = tempDbPath();
    const db = openDb(dbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("instances");
    expect(names).toContain("messages");
    expect(names).toContain("kv");
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("instances table has repo column", () => {
    const dbPath = tempDbPath();
    const db = openDb(dbPath);
    const cols = db.pragma("table_info(instances)") as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("repo");
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("messages table has repo column", () => {
    const dbPath = tempDbPath();
    const db = openDb(dbPath);
    const cols = db.pragma("table_info(messages)") as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("repo");
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("kv table has composite primary key (key, repo)", () => {
    const dbPath = tempDbPath();
    const db = openDb(dbPath);
    const cols = db.pragma("table_info(kv)") as Array<{ name: string; pk: number }>;
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);
    expect(pkCols).toContain("key");
    expect(pkCols).toContain("repo");
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("fresh db is schema version 2", () => {
    const dbPath = tempDbPath();
    const db = openDb(dbPath);
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("creates idx_messages_created_at index", () => {
    const dbPath = tempDbPath();
    const db = openDb(dbPath);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_created_at'").get();
    expect(idx).toBeTruthy();
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("is idempotent — calling openDb twice doesn't error", () => {
    const dbPath = tempDbPath();
    const db1 = openDb(dbPath);
    db1.close();
    const db2 = openDb(dbPath);
    db2.close();
    fs.unlinkSync(dbPath);
  });
});

describe("schema migration v1 → v2", () => {
  it("migrates v1 schema to v2 and tags existing rows as legacy", () => {
    const dbPath = tempDbPath();

    // Create v1 schema manually (no repo columns, single-key kv PK)
    const v1 = new Database(dbPath);
    v1.exec(`
      CREATE TABLE instances (id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, branch TEXT, last_seen INTEGER NOT NULL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL, tags TEXT, reply_to INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, set_by TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
    v1.prepare("INSERT INTO instances (id, name, cwd, branch, last_seen) VALUES (?, ?, ?, ?, ?)").run("i1", "Frontend", "/proj", "main", nowMs());
    v1.prepare("INSERT INTO messages (instance_id, type, content, created_at) VALUES (?, 'broadcast', ?, ?)").run("i1", "hello", nowMs());
    v1.prepare("INSERT INTO kv (key, value, set_by, updated_at) VALUES (?, ?, ?, ?)").run("schema", "users(id)", "i1", nowMs());
    v1.close();

    // Open with our openDb — should migrate
    const db = openDb(dbPath);

    // Schema version bumped
    expect(db.pragma("user_version", { simple: true })).toBe(2);

    // instances has repo column, existing row tagged 'legacy'
    const inst = db.prepare("SELECT repo FROM instances WHERE id = 'i1'").get() as { repo: string };
    expect(inst.repo).toBe("legacy");

    // messages has repo column, existing row tagged 'legacy'
    const msg = db.prepare("SELECT repo FROM messages WHERE instance_id = 'i1'").get() as { repo: string };
    expect(msg.repo).toBe("legacy");

    // kv still accessible by key + 'legacy' repo
    const entry = db.prepare("SELECT repo FROM kv WHERE key = 'schema'").get() as { repo: string };
    expect(entry.repo).toBe("legacy");

    db.close();
    fs.unlinkSync(dbPath);
  });

  it("migration is idempotent — v2 db does not re-migrate", () => {
    const dbPath = tempDbPath();
    const db1 = openDb(dbPath);
    db1.close();
    // Second open should not throw
    const db2 = openDb(dbPath);
    expect(db2.pragma("user_version", { simple: true })).toBe(2);
    db2.close();
    fs.unlinkSync(dbPath);
  });
});

describe("instances", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDb(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("upserts an instance with repo", () => {
    upsertInstance(db, "abc", "Frontend", "/home/user/project", "main", REPO_A);
    const instances = listInstances(db);
    expect(instances).toHaveLength(1);
    expect(instances[0].name).toBe("Frontend");
    expect(instances[0].repo).toBe(REPO_A);
  });

  it("listInstances filters by repo", () => {
    upsertInstance(db, "a1", "Frontend", "/project-a", "main", REPO_A);
    upsertInstance(db, "b1", "Backend", "/project-b", "main", REPO_B);
    const repoA = listInstances(db, REPO_A);
    expect(repoA).toHaveLength(1);
    expect(repoA[0].id).toBe("a1");
  });

  it("updates existing instance on upsert", () => {
    upsertInstance(db, "abc", "Frontend", "/home/user/project", "main", REPO_A);
    upsertInstance(db, "abc", "Frontend", "/home/user/project", "feature/auth", REPO_A);
    const instances = listInstances(db);
    expect(instances).toHaveLength(1);
    expect(instances[0].branch).toBe("feature/auth");
  });

  it("heartbeat updates last_seen and branch", () => {
    upsertInstance(db, "abc", "Frontend", "/home/user/project", "main", REPO_A);
    const before = listInstances(db)[0].last_seen;
    heartbeat(db, "abc", "feature/new");
    const after = listInstances(db)[0];
    expect(after.last_seen).toBeGreaterThanOrEqual(before);
    expect(after.branch).toBe("feature/new");
  });

  it("heartbeat without branch doesn't clear branch", () => {
    upsertInstance(db, "abc", "Frontend", "/home/user/project", "main", REPO_A);
    heartbeat(db, "abc");
    const inst = listInstances(db)[0];
    expect(inst.branch).toBe("main");
  });

  it("markOffline sets last_seen to 0", () => {
    upsertInstance(db, "abc", "Frontend", "/home/user/project", "main", REPO_A);
    markOffline(db, "abc");
    const inst = db.prepare("SELECT last_seen FROM instances WHERE id = 'abc'").get() as { last_seen: number };
    expect(inst.last_seen).toBe(0);
  });

  it("getActiveInstances excludes stale instances", () => {
    upsertInstance(db, "active", "Active", "/a", "main", REPO_A);
    const staleTs = nowMs() - STALE_INSTANCE_MS - 1000;
    db.prepare("INSERT INTO instances (id, name, cwd, branch, repo, last_seen) VALUES (?, ?, ?, ?, ?, ?)").run("stale", "Stale", "/b", "main", REPO_A, staleTs);
    const active = getActiveInstances(db);
    expect(active.map((i) => i.id)).toContain("active");
    expect(active.map((i) => i.id)).not.toContain("stale");
  });

  it("makeInstanceId is unique for different pids", () => {
    const id1 = makeInstanceId("Frontend", "/project", 1234, 1000);
    const id2 = makeInstanceId("Frontend", "/project", 1235, 1000);
    expect(id1).not.toBe(id2);
  });

  it("makeInstanceId is unique for different startup timestamps", () => {
    const id1 = makeInstanceId("Frontend", "/project", 1234, 1000);
    const id2 = makeInstanceId("Frontend", "/project", 1234, 1001);
    expect(id1).not.toBe(id2);
  });

  it("two instances in same cwd get different ids", () => {
    const id1 = makeInstanceId("Frontend", "/project", 100, nowMs());
    const id2 = makeInstanceId("Frontend", "/project", 101, nowMs());
    upsertInstance(db, id1, "Frontend", "/project", "main", REPO_A);
    upsertInstance(db, id2, "Frontend", "/project", "main", REPO_A);
    const instances = listInstances(db);
    expect(instances).toHaveLength(2);
  });
});

describe("messages", () => {
  let db: Database.Database;
  let dbPath: string;
  const instanceId = "test-instance";

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDb(dbPath);
    upsertInstance(db, instanceId, "TestInstance", "/project", "main", REPO_A);
  });

  afterEach(() => {
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("broadcast saves a message with repo", () => {
    const id = broadcast(db, instanceId, "Hello squad", undefined, REPO_A);
    expect(id).toBeGreaterThan(0);
    const msgs = readMessages(db);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Hello squad");
    expect(msgs[0].type).toBe("broadcast");
  });

  it("readMessages filters by repo — messages from other repo not returned", () => {
    const instanceB = "inst-b";
    upsertInstance(db, instanceB, "Backend", "/project-b", "main", REPO_B);
    broadcast(db, instanceId, "repo A message", undefined, REPO_A);
    broadcast(db, instanceB, "repo B message", undefined, REPO_B);

    const msgsA = readMessages(db, undefined, undefined, 20, REPO_A);
    expect(msgsA).toHaveLength(1);
    expect(msgsA[0].content).toBe("repo A message");

    const msgsB = readMessages(db, undefined, undefined, 20, REPO_B);
    expect(msgsB).toHaveLength(1);
    expect(msgsB[0].content).toBe("repo B message");
  });

  it("broadcast with tags saves tags as JSON array", () => {
    broadcast(db, instanceId, "DB schema updated", ["db-schema", "breaking"], REPO_A);
    const msgs = readMessages(db);
    expect(msgs[0].tags).toEqual(["db-schema", "breaking"]);
  });

  it("broadcast rejects content over 10KB", () => {
    const big = "x".repeat(10 * 1024 + 1);
    expect(() => broadcast(db, instanceId, big, undefined, REPO_A)).toThrow(/too large/);
  });

  it("ask saves a question", () => {
    const id = ask(db, instanceId, "What DB are we using?", undefined, REPO_A);
    expect(id).toBeGreaterThan(0);
    const msgs = readMessages(db);
    expect(msgs[0].type).toBe("ask");
  });

  it("answer saves a reply to a valid question", () => {
    const questionId = ask(db, instanceId, "What DB are we using?", undefined, REPO_A);
    const answerId = answer(db, instanceId, questionId, "Postgres with Prisma");
    expect(answerId).toBeGreaterThan(0);
    const msgs = readMessages(db, undefined, undefined, 20);
    const ans = msgs.find((m) => m.id === answerId);
    expect(ans).toBeTruthy();
    expect(ans!.reply_to).toBe(questionId);
  });

  it("answer rejects non-existent question_id", () => {
    expect(() => answer(db, instanceId, 9999, "answer")).toThrow(/not found/);
  });

  it("answer rejects replying to a broadcast", () => {
    const broadcastId = broadcast(db, instanceId, "hello", undefined, REPO_A);
    expect(() => answer(db, instanceId, broadcastId, "this should fail")).toThrow(/not a question/);
  });

  it("readMessages respects default limit of 5", () => {
    for (let i = 0; i < 10; i++) broadcast(db, instanceId, `msg ${i}`, undefined, REPO_A);
    const msgs = readMessages(db);
    expect(msgs).toHaveLength(5);
  });

  it("readMessages respects custom limit", () => {
    for (let i = 0; i < 10; i++) broadcast(db, instanceId, `msg ${i}`, undefined, REPO_A);
    const msgs = readMessages(db, undefined, undefined, 8);
    expect(msgs).toHaveLength(8);
  });

  it("readMessages caps at max 20", () => {
    for (let i = 0; i < 30; i++) broadcast(db, instanceId, `msg ${i}`, undefined, REPO_A);
    const msgs = readMessages(db, undefined, undefined, 100);
    expect(msgs).toHaveLength(20);
  });

  it("readMessages filters by since timestamp", async () => {
    broadcast(db, instanceId, "old message", undefined, REPO_A);
    const mid = nowMs();
    await new Promise((r) => setTimeout(r, 5));
    broadcast(db, instanceId, "new message", undefined, REPO_A);
    const msgs = readMessages(db, mid);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("new message");
  });

  it("readMessages filters by tags in SQL — works correctly with limit", () => {
    // Post 10 untagged messages, then 1 tagged — tag filter should find it
    for (let i = 0; i < 10; i++) broadcast(db, instanceId, `untagged ${i}`, undefined, REPO_A);
    broadcast(db, instanceId, "db change", ["db-schema"], REPO_A);
    // Default limit is 5, but all top-5 are untagged — old JS filter would return 0
    const msgs = readMessages(db, undefined, ["db-schema"], 5, REPO_A);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("db change");
  });

  it("readMessages filters by tags (basic)", () => {
    broadcast(db, instanceId, "db change", ["db-schema"], REPO_A);
    broadcast(db, instanceId, "auth change", ["auth"], REPO_A);
    broadcast(db, instanceId, "no tags", undefined, REPO_A);
    const msgs = readMessages(db, undefined, ["db-schema"], 20);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("db change");
  });

  it("readMessages returns messages newest first", () => {
    broadcast(db, instanceId, "first", undefined, REPO_A);
    broadcast(db, instanceId, "second", undefined, REPO_A);
    broadcast(db, instanceId, "third", undefined, REPO_A);
    const msgs = readMessages(db, undefined, undefined, 10);
    expect(msgs[0].content).toBe("third");
    expect(msgs[2].content).toBe("first");
  });

  it("messages are ordered newest first by created_at", () => {
    for (let i = 0; i < 5; i++) broadcast(db, instanceId, `msg-${i}`, undefined, REPO_A);
    const msgs = readMessages(db, undefined, undefined, 5);
    for (let i = 0; i < msgs.length - 1; i++) {
      expect(msgs[i].created_at).toBeGreaterThanOrEqual(msgs[i + 1].created_at);
    }
  });
});

describe("kv store", () => {
  let db: Database.Database;
  let dbPath: string;
  const instanceId = "kv-test";

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDb(dbPath);
    upsertInstance(db, instanceId, "KVTest", "/project", null, REPO_A);
  });

  afterEach(() => {
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("set and get a key within same repo", () => {
    setShared(db, instanceId, "db_schema", "{ users: { id, email } }", REPO_A);
    const entry = getShared(db, "db_schema", REPO_A);
    expect(entry).toBeTruthy();
    expect(entry!.value).toBe("{ users: { id, email } }");
    expect(entry!.set_by).toBe(instanceId);
    expect(entry!.repo).toBe(REPO_A);
  });

  it("kv is scoped by repo — repo B cannot see repo A value", () => {
    setShared(db, instanceId, "db_schema", "repo A schema", REPO_A);
    const entry = getShared(db, "db_schema", REPO_B);
    expect(entry).toBeUndefined();
  });

  it("same key can exist in different repos independently", () => {
    const instB = "kv-test-b";
    upsertInstance(db, instB, "KVTestB", "/project-b", null, REPO_B);
    setShared(db, instanceId, "convention", "AppError", REPO_A);
    setShared(db, instB, "convention", "HttpError", REPO_B);
    expect(getShared(db, "convention", REPO_A)!.value).toBe("AppError");
    expect(getShared(db, "convention", REPO_B)!.value).toBe("HttpError");
  });

  it("update overwrites existing key in same repo", () => {
    setShared(db, instanceId, "convention", "AppError", REPO_A);
    setShared(db, instanceId, "convention", "HttpError", REPO_A);
    const entry = getShared(db, "convention", REPO_A);
    expect(entry!.value).toBe("HttpError");
  });

  it("returns undefined for missing key", () => {
    const entry = getShared(db, "nonexistent", REPO_A);
    expect(entry).toBeUndefined();
  });

  it("rejects values over 50KB", () => {
    const big = "x".repeat(50 * 1024 + 1);
    expect(() => setShared(db, instanceId, "big_key", big, REPO_A)).toThrow(/too large/);
  });

  it("accepts values at exactly 50KB", () => {
    const exact = "x".repeat(50 * 1024);
    expect(() => setShared(db, instanceId, "exact_key", exact, REPO_A)).not.toThrow();
  });
});

describe("standup", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDb(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("returns empty standup when no data", () => {
    const standup = buildStandup(db);
    expect(standup.active_instances).toHaveLength(0);
    expect(standup.recent_messages).toHaveLength(0);
  });

  it("includes active instances and recent messages", () => {
    upsertInstance(db, "a1", "Frontend", "/proj", "main", REPO_A);
    upsertInstance(db, "a2", "Backend", "/proj", "main", REPO_A);
    broadcast(db, "a1", "Using tRPC", undefined, REPO_A);
    const standup = buildStandup(db, REPO_A);
    expect(standup.active_instances).toHaveLength(2);
    expect(standup.recent_messages).toHaveLength(1);
    expect(standup.recent_messages[0].content).toBe("Using tRPC");
  });

  it("standup with repo filter only shows that repo's messages", () => {
    upsertInstance(db, "a1", "Frontend", "/proj-a", "main", REPO_A);
    upsertInstance(db, "b1", "Backend", "/proj-b", "main", REPO_B);
    broadcast(db, "a1", "repo A msg", undefined, REPO_A);
    broadcast(db, "b1", "repo B msg", undefined, REPO_B);
    const standup = buildStandup(db, REPO_A);
    expect(standup.recent_messages).toHaveLength(1);
    expect(standup.recent_messages[0].content).toBe("repo A msg");
  });

  it("caps message content at 200 chars in standup", () => {
    upsertInstance(db, "a1", "Frontend", "/proj", null, REPO_A);
    broadcast(db, "a1", "x".repeat(300), undefined, REPO_A);
    const standup = buildStandup(db);
    expect(standup.recent_messages[0].content.length).toBe(200);
  });

  it("returns at most 5 recent messages", () => {
    upsertInstance(db, "a1", "Frontend", "/proj", null, REPO_A);
    for (let i = 0; i < 10; i++) broadcast(db, "a1", `msg ${i}`, undefined, REPO_A);
    const standup = buildStandup(db);
    expect(standup.recent_messages).toHaveLength(5);
  });
});

describe("status cache", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDb(dbPath);
    upsertInstance(db, "inst", "Test", "/p", null, REPO_A);
  });

  afterEach(() => {
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("getRecentMessageCount returns 0 when no recent messages", () => {
    expect(getRecentMessageCount(db)).toBe(0);
  });

  it("getRecentMessageCount counts messages within window", () => {
    broadcast(db, "inst", "msg1", undefined, REPO_A);
    broadcast(db, "inst", "msg2", undefined, REPO_A);
    expect(getRecentMessageCount(db)).toBe(2);
  });

  it("getRecentMessageCount ignores old messages", () => {
    const oldTs = nowMs() - 31 * 60 * 1000; // 31 minutes ago
    db.prepare("INSERT INTO messages (instance_id, type, content, repo, created_at) VALUES (?, 'broadcast', ?, ?, ?)").run("inst", "old", REPO_A, oldTs);
    broadcast(db, "inst", "new", undefined, REPO_A);
    expect(getRecentMessageCount(db, 30 * 60 * 1000)).toBe(1);
  });
});

describe("pruneOldMessages", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDb(dbPath);
    upsertInstance(db, "inst", "Test", "/p", null, REPO_A);
  });

  afterEach(() => {
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("deletes messages older than cutoff", () => {
    const oldTs = nowMs() - 8 * 24 * 60 * 60 * 1000;
    db.prepare("INSERT INTO messages (instance_id, type, content, repo, created_at) VALUES (?, 'broadcast', ?, ?, ?)").run("inst", "old msg", REPO_A, oldTs);
    broadcast(db, "inst", "new msg", undefined, REPO_A);
    pruneOldMessages(db);
    const msgs = readMessages(db, undefined, undefined, 20);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("new msg");
  });

  it("keeps messages newer than cutoff", () => {
    broadcast(db, "inst", "recent", undefined, REPO_A);
    pruneOldMessages(db);
    const msgs = readMessages(db, undefined, undefined, 20);
    expect(msgs).toHaveLength(1);
  });
});
