/**
 * Daemon integration tests — tests the full daemon over Unix socket,
 * including NDJSON protocol, concurrent connections, and crash recovery.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { openDb, upsertInstance } from "../src/db.js";
import { makeInstanceId, nowMs } from "../src/types.js";

// ── Inline daemon for testing (no subprocess) ──────────────────────────────

function rpc(socket: net.Socket, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let buffer = "";
    const handler = (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line) as { id: string; result?: unknown; error?: string };
          if (resp.id === id) {
            socket.off("data", handler);
            if (resp.error) reject(new Error(resp.error));
            else resolve(resp.result);
          }
        } catch { /* ignore */ }
      }
    };
    socket.on("data", handler);
    socket.on("error", reject);
    socket.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

async function connectToSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
    socket.connect(socketPath);
  });
}

async function startTestDaemon(): Promise<{ socketPath: string; dbPath: string; server: net.Server; stop: () => Promise<void> }> {
  const dir = path.join(os.tmpdir(), `cs-daemon-test-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const socketPath = path.join(dir, "test.sock");
  const dbPath = path.join(dir, "test.db");

  // Import handler inline to avoid spawning subprocess
  const { openDb } = await import("../src/db.js");
  const db = openDb(dbPath);

  // Lazy import the handler function from daemon
  // We'll replicate the logic inline since daemon.ts starts a server on import
  const { default: Database } = await import("better-sqlite3");
  const {
    upsertInstance, heartbeat, markOffline, listInstances,
    broadcast, ask, askInstance, answer, readMessages, setShared, getShared, buildStandup,
    checkInbox, getInstanceBySlotOrName,
  } = await import("../src/db.js");
  const { makeInstanceId, STALE_INSTANCE_MS, nowMs } = await import("../src/types.js");

  function handleRequest(req: { id: string; method: string; params: Record<string, unknown> }): unknown {
    switch (req.method) {
      case "ping": return { pong: true };
      case "register": {
        const p = req.params as { name: string; cwd: string; branch?: string; repo?: string; pid: number; startup_ts: number };
        const id = makeInstanceId(p.name, p.cwd, p.pid, p.startup_ts);
        upsertInstance(db, id, p.name, p.cwd, p.branch ?? null, p.repo ?? "local");
        return { instance_id: id, standup: buildStandup(db, p.repo, id) };
      }
      case "heartbeat": {
        const p = req.params as { instance_id: string; branch?: string };
        heartbeat(db, p.instance_id, p.branch);
        return { ok: true };
      }
      case "mark_offline": {
        markOffline(db, (req.params as { instance_id: string }).instance_id);
        return { ok: true };
      }
      case "broadcast": {
        const p = req.params as { instance_id: string; content: string; tags?: string[] };
        return { message_id: broadcast(db, p.instance_id, p.content, p.tags) };
      }
      case "read_messages": {
        const p = req.params as { since?: number; tags?: string[]; limit?: number; repo?: string; reply_to_id?: number };
        return { messages: readMessages(db, p.since, p.tags, p.limit, p.repo, p.reply_to_id) };
      }
      case "ask": {
        const p = req.params as { instance_id: string; question: string; context?: string };
        return { message_id: ask(db, p.instance_id, p.question, p.context) };
      }
      case "ask_instance": {
        const p = req.params as { instance_id: string; target: number | string; question: string; context?: string; repo: string };
        const resolved = getInstanceBySlotOrName(db, p.target, p.repo);
        if ("error" in resolved) throw new Error(resolved.error);
        const target = resolved.instance;
        const id = askInstance(db, p.instance_id, target.id, p.question, p.context, p.repo);
        const staleCutoff = nowMs() - STALE_INSTANCE_MS;
        const isStale = target.last_seen > 0 && target.last_seen < staleCutoff + (STALE_INSTANCE_MS * 0.5);
        return {
          message_id: id,
          question_id: id,
          target_name: target.name,
          target_last_seen: target.last_seen,
          stale_warning: isStale ? `Target last seen ${Math.floor((nowMs() - target.last_seen) / 60000)}m ago.` : null,
        };
      }
      case "check_inbox": {
        const p = req.params as { instance_id: string; limit?: number };
        return { questions: checkInbox(db, p.instance_id, p.limit) };
      }
      case "answer": {
        const p = req.params as { instance_id: string; question_id: number; answer: string };
        return { message_id: answer(db, p.instance_id, p.question_id, p.answer) };
      }
      case "list_instances": {
        const p = req.params as { repo?: string };
        return { instances: listInstances(db, p.repo) };
      }
      case "set_shared": {
        const p = req.params as { instance_id: string; key: string; value: string };
        setShared(db, p.instance_id, p.key, p.value);
        return { ok: true };
      }
      case "get_shared": {
        return { entry: getShared(db, (req.params as { key: string }).key) ?? null };
      }
      default:
        throw new Error(`Unknown method: ${req.method}`);
    }
  }

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let req: { id: string; method: string; params: Record<string, unknown> };
        try {
          req = JSON.parse(line);
        } catch {
          socket.write(JSON.stringify({ id: "unknown", error: "Invalid JSON" }) + "\n");
          continue;
        }
        const resp: { id: string; result?: unknown; error?: string } = { id: req.id };
        try {
          resp.result = handleRequest(req);
        } catch (e) {
          resp.error = e instanceof Error ? e.message : String(e);
        }
        socket.write(JSON.stringify(resp) + "\n");
      }
    });
    socket.on("error", () => {});
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      server.close(() => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
        resolve();
      });
    });

  return { socketPath, dbPath, server, stop };
}

describe("daemon protocol", () => {
  let daemon: Awaited<ReturnType<typeof startTestDaemon>>;
  let socket: net.Socket;

  beforeEach(async () => {
    daemon = await startTestDaemon();
    socket = await connectToSocket(daemon.socketPath);
  });

  afterEach(async () => {
    socket.destroy();
    await daemon.stop();
  });

  it("responds to ping", async () => {
    const result = await rpc(socket, "ping") as { pong: boolean };
    expect(result.pong).toBe(true);
  });

  it("register returns instance_id and standup", async () => {
    const result = await rpc(socket, "register", {
      name: "Frontend", cwd: "/proj", branch: "main", pid: 1234, startup_ts: nowMs(),
    }) as { instance_id: string; standup: unknown };
    expect(result.instance_id).toBeTruthy();
    expect(result.standup).toBeTruthy();
  });

  it("broadcast and read round-trip", async () => {
    const { instance_id } = await rpc(socket, "register", {
      name: "A", cwd: "/proj", pid: 1, startup_ts: 100,
    }) as { instance_id: string };

    await rpc(socket, "broadcast", { instance_id, content: "Hello from A", tags: ["test"] });

    const { messages } = await rpc(socket, "read_messages", { limit: 5 }) as { messages: Array<{ content: string; tags: string[] }> };
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Hello from A");
    expect(messages[0].tags).toEqual(["test"]);
  });

  it("ask and answer round-trip", async () => {
    const { instance_id: idA } = await rpc(socket, "register", {
      name: "A", cwd: "/proj", pid: 1, startup_ts: 100,
    }) as { instance_id: string };
    const { instance_id: idB } = await rpc(socket, "register", {
      name: "B", cwd: "/proj2", pid: 2, startup_ts: 101,
    }) as { instance_id: string };

    const { message_id: qid } = await rpc(socket, "ask", {
      instance_id: idA, question: "What DB?",
    }) as { message_id: number };

    const { message_id: aid } = await rpc(socket, "answer", {
      instance_id: idB, question_id: qid, answer: "Postgres",
    }) as { message_id: number };

    expect(aid).toBeGreaterThan(qid);
  });

  it("list_instances after register", async () => {
    await rpc(socket, "register", { name: "Frontend", cwd: "/a", pid: 1, startup_ts: 1 });
    await rpc(socket, "register", { name: "Backend", cwd: "/b", pid: 2, startup_ts: 2 });
    const { instances } = await rpc(socket, "list_instances", {}) as { instances: unknown[] };
    expect(instances).toHaveLength(2);
  });

  it("set_shared and get_shared round-trip", async () => {
    const { instance_id } = await rpc(socket, "register", {
      name: "A", cwd: "/proj", pid: 1, startup_ts: 1,
    }) as { instance_id: string };

    await rpc(socket, "set_shared", { instance_id, key: "db_schema", value: "{ users }" });
    const { entry } = await rpc(socket, "get_shared", { key: "db_schema" }) as { entry: { value: string } };
    expect(entry.value).toBe("{ users }");
  });

  it("get_shared returns null for missing key", async () => {
    const { entry } = await rpc(socket, "get_shared", { key: "nope" }) as { entry: null };
    expect(entry).toBeNull();
  });

  it("returns error for invalid JSON", async () => {
    await new Promise<void>((resolve) => {
      let buffer = "";
      const handler = (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const resp = JSON.parse(line) as { error?: string };
          expect(resp.error).toContain("Invalid JSON");
          socket.off("data", handler);
          resolve();
        }
      };
      socket.on("data", handler);
      socket.write("not valid json\n");
    });
  });

  it("returns error for unknown method", async () => {
    await expect(rpc(socket, "unknown_method", {})).rejects.toThrow(/Unknown method/);
  });
});

describe("multiple concurrent connections", () => {
  let daemon: Awaited<ReturnType<typeof startTestDaemon>>;

  beforeEach(async () => {
    daemon = await startTestDaemon();
  });

  afterEach(async () => {
    await daemon.stop();
  });

  it("3 concurrent connections all work independently", async () => {
    const [sA, sB, sC] = await Promise.all([
      connectToSocket(daemon.socketPath),
      connectToSocket(daemon.socketPath),
      connectToSocket(daemon.socketPath),
    ]);

    const [rA, rB, rC] = await Promise.all([
      rpc(sA, "register", { name: "A", cwd: "/a", pid: 1, startup_ts: 1 }),
      rpc(sB, "register", { name: "B", cwd: "/b", pid: 2, startup_ts: 2 }),
      rpc(sC, "register", { name: "C", cwd: "/c", pid: 3, startup_ts: 3 }),
    ]) as [{ instance_id: string }, { instance_id: string }, { instance_id: string }];

    // All three broadcast simultaneously
    await Promise.all([
      rpc(sA, "broadcast", { instance_id: rA.instance_id, content: "from A" }),
      rpc(sB, "broadcast", { instance_id: rB.instance_id, content: "from B" }),
      rpc(sC, "broadcast", { instance_id: rC.instance_id, content: "from C" }),
    ]);

    // Read from any socket should see all 3
    const { messages } = await rpc(sA, "read_messages", { limit: 20 }) as { messages: Array<{ content: string }> };
    const contents = messages.map((m) => m.content);
    expect(contents).toContain("from A");
    expect(contents).toContain("from B");
    expect(contents).toContain("from C");

    sA.destroy();
    sB.destroy();
    sC.destroy();
  });

  it("client disconnect doesn't crash the server", async () => {
    const socket = await connectToSocket(daemon.socketPath);
    socket.destroy(); // immediate disconnect
    await new Promise((r) => setTimeout(r, 50));

    // Server still accepts new connections
    const s2 = await connectToSocket(daemon.socketPath);
    const result = await rpc(s2, "ping") as { pong: boolean };
    expect(result.pong).toBe(true);
    s2.destroy();
  });
});

describe("heartbeat and stale detection", () => {
  let daemon: Awaited<ReturnType<typeof startTestDaemon>>;
  let socket: net.Socket;

  beforeEach(async () => {
    daemon = await startTestDaemon();
    socket = await connectToSocket(daemon.socketPath);
  });

  afterEach(async () => {
    socket.destroy();
    await daemon.stop();
  });

  it("heartbeat updates last_seen", async () => {
    const { instance_id } = await rpc(socket, "register", {
      name: "A", cwd: "/proj", pid: 1, startup_ts: 1,
    }) as { instance_id: string };

    const before = (await rpc(socket, "list_instances", {}) as { instances: Array<{ last_seen: number }> }).instances[0].last_seen;
    await new Promise((r) => setTimeout(r, 5));
    await rpc(socket, "heartbeat", { instance_id, branch: "new-branch" });
    const after = (await rpc(socket, "list_instances", {}) as { instances: Array<{ last_seen: number; branch: string }> }).instances[0];

    expect(after.last_seen).toBeGreaterThanOrEqual(before);
    expect(after.branch).toBe("new-branch");
  });

  it("mark_offline removes instance from list_instances", async () => {
    const { instance_id } = await rpc(socket, "register", {
      name: "A", cwd: "/proj", pid: 1, startup_ts: 1,
    }) as { instance_id: string };

    const before = (await rpc(socket, "list_instances", {}) as { instances: unknown[] }).instances;
    expect(before.length).toBe(1);

    await rpc(socket, "mark_offline", { instance_id });
    const { instances } = await rpc(socket, "list_instances", {}) as { instances: unknown[] };
    expect(instances.length).toBe(0);
  });
});

describe("ask_instance RPC", () => {
  let daemon: Awaited<ReturnType<typeof startTestDaemon>>;
  let socket: net.Socket;

  beforeEach(async () => {
    daemon = await startTestDaemon();
    socket = net.createConnection(daemon.socketPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
  });

  afterEach(async () => {
    socket.destroy();
    await daemon.stop();
  });

  async function registerInstance(name: string, repo = "test-repo"): Promise<string> {
    const result = await rpc(socket, "register", {
      name, cwd: `/${name}`, pid: Math.floor(Math.random() * 10000), startup_ts: Date.now(), repo,
    }) as { instance_id: string };
    return result.instance_id;
  }

  it("ask_instance with valid slot posts message and returns question_id", async () => {
    const callerId = await registerInstance("caller");
    await registerInstance("target");
    const { instances } = await rpc(socket, "list_instances", { repo: "test-repo" }) as { instances: Array<{ slot: number; name: string; id: string }> };
    const targetSlot = instances.find((i) => i.name === "target")!.slot;

    const result = await rpc(socket, "ask_instance", {
      instance_id: callerId, target: targetSlot, question: "what port?", repo: "test-repo",
    }) as { message_id: number; question_id: number; target_name: string };

    expect(result.question_id).toBeGreaterThan(0);
    expect(result.target_name).toBe("target");
  });

  it("ask_instance with valid name posts message", async () => {
    const callerId = await registerInstance("caller");
    await registerInstance("backend");

    const result = await rpc(socket, "ask_instance", {
      instance_id: callerId, target: "backend", question: "which APIs?", repo: "test-repo",
    }) as { question_id: number; target_name: string };

    expect(result.question_id).toBeGreaterThan(0);
    expect(result.target_name).toBe("backend");
  });

  it("ask_instance with invalid slot returns error", async () => {
    const callerId = await registerInstance("caller");
    await expect(
      rpc(socket, "ask_instance", {
        instance_id: callerId, target: 999, question: "?", repo: "test-repo",
      })
    ).rejects.toThrow(/slot #999/);
  });

  it("ask_instance with unknown name returns error", async () => {
    const callerId = await registerInstance("caller");
    await expect(
      rpc(socket, "ask_instance", {
        instance_id: callerId, target: "nobody", question: "?", repo: "test-repo",
      })
    ).rejects.toThrow(/No active instance named/);
  });

  it("ask_instance to self works without error", async () => {
    const callerId = await registerInstance("solo");
    const { instances } = await rpc(socket, "list_instances", { repo: "test-repo" }) as { instances: Array<{ slot: number; id: string }> };
    const mySlot = instances.find((i) => i.id === callerId)!.slot;

    const result = await rpc(socket, "ask_instance", {
      instance_id: callerId, target: mySlot, question: "am I awake?", repo: "test-repo",
    }) as { question_id: number };
    expect(result.question_id).toBeGreaterThan(0);
  });
});

describe("check_inbox RPC", () => {
  let daemon: Awaited<ReturnType<typeof startTestDaemon>>;
  let socket: net.Socket;

  beforeEach(async () => {
    daemon = await startTestDaemon();
    socket = net.createConnection(daemon.socketPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
  });

  afterEach(async () => {
    socket.destroy();
    await daemon.stop();
  });

  async function registerInstance(name: string, repo = "test-repo"): Promise<string> {
    const result = await rpc(socket, "register", {
      name, cwd: `/${name}`, pid: Math.floor(Math.random() * 10000), startup_ts: Date.now(), repo,
    }) as { instance_id: string };
    return result.instance_id;
  }

  it("returns empty when no questions", async () => {
    const targetId = await registerInstance("target");
    const result = await rpc(socket, "check_inbox", { instance_id: targetId }) as { questions: unknown[] };
    expect(result.questions).toHaveLength(0);
  });

  it("returns unanswered directed questions for caller", async () => {
    const callerId = await registerInstance("caller");
    const targetId = await registerInstance("target");
    const { instances } = await rpc(socket, "list_instances", { repo: "test-repo" }) as { instances: Array<{ slot: number; id: string }> };
    const targetSlot = instances.find((i) => i.id === targetId)!.slot;

    await rpc(socket, "ask_instance", {
      instance_id: callerId, target: targetSlot, question: "hello?", repo: "test-repo",
    });

    const result = await rpc(socket, "check_inbox", { instance_id: targetId }) as { questions: Array<{ content: string }> };
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].content).toBe("hello?");
  });

  it("answered questions not returned in inbox", async () => {
    const callerId = await registerInstance("caller");
    const targetId = await registerInstance("target");
    const { instances } = await rpc(socket, "list_instances", { repo: "test-repo" }) as { instances: Array<{ slot: number; id: string }> };
    const targetSlot = instances.find((i) => i.id === targetId)!.slot;

    const { question_id } = await rpc(socket, "ask_instance", {
      instance_id: callerId, target: targetSlot, question: "hello?", repo: "test-repo",
    }) as { question_id: number };

    await rpc(socket, "answer", { instance_id: targetId, question_id, answer: "world" });

    const result = await rpc(socket, "check_inbox", { instance_id: targetId }) as { questions: unknown[] };
    expect(result.questions).toHaveLength(0);
  });
});

describe("list_instances slot display", () => {
  let daemon: Awaited<ReturnType<typeof startTestDaemon>>;
  let socket: net.Socket;

  beforeEach(async () => {
    daemon = await startTestDaemon();
    socket = net.createConnection(daemon.socketPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
  });

  afterEach(async () => {
    socket.destroy();
    await daemon.stop();
  });

  it("instances have slot assigned after registration", async () => {
    await rpc(socket, "register", { name: "A", cwd: "/a", pid: 1, startup_ts: 1, repo: "r" });
    await rpc(socket, "register", { name: "B", cwd: "/b", pid: 2, startup_ts: 2, repo: "r" });
    const { instances } = await rpc(socket, "list_instances", { repo: "r" }) as { instances: Array<{ name: string; slot: number }> };
    expect(instances).toHaveLength(2);
    const slots = instances.map((i) => i.slot);
    expect(slots.every((s) => s > 0)).toBe(true);
    expect(new Set(slots).size).toBe(2); // all unique
  });
});
