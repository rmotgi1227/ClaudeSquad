#!/usr/bin/env node
/**
 * claude-squad daemon
 * Runs as a detached background process. Owns SQLite. Accepts bridge connections
 * via Unix socket (or TCP on Windows). Handles all DB operations.
 */
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  SOCKET_PATH,
  DB_PATH,
  SQUAD_DIR,
  DAEMON_PID_PATH,
  SHUTDOWN_TOKEN_PATH,
  isWindows,
  TCP_PORT_BASE,
  TCP_PORT_MAX,
  PORT_PATH,
  DaemonRequest,
  DaemonResponse,
  RegisterParams,
  BroadcastParams,
  ReadMessagesParams,
  AskParams,
  AnswerParams,
  HeartbeatParams,
  SetSharedParams,
  GetSharedParams,
  ListInstancesParams,
  MAX_BROADCAST_BYTES,
  makeInstanceId,
  nowMs,
} from "./types.js";
import {
  openDb,
  upsertInstance,
  heartbeat,
  markOffline,
  listInstances,
  broadcast,
  ask,
  answer,
  readMessages,
  setShared,
  getShared,
  buildStandup,
  pruneOldMessages,
  getInstanceRepo,
  writeStatusCache,
} from "./db.js";
import Database from "better-sqlite3";

let db: Database.Database;

function handleRequest(req: DaemonRequest): unknown {
  switch (req.method) {
    case "ping":
      return { pong: true, uptime: process.uptime() };

    case "shutdown": {
      // Verify token to prevent unauthenticated shutdown from other processes
      const p = req.params as { token?: string };
      let expectedToken: string | null = null;
      try { expectedToken = fs.readFileSync(SHUTDOWN_TOKEN_PATH, "utf8").trim(); } catch { /* no token file */ }
      if (!expectedToken || p.token !== expectedToken) {
        throw new Error("Unauthorized: invalid shutdown token");
      }
      setImmediate(() => process.kill(process.pid, "SIGTERM"));
      return { ok: true };
    }

    case "register": {
      const p = req.params as unknown as RegisterParams;
      const id = makeInstanceId(p.name, p.cwd, p.pid, p.startup_ts);
      upsertInstance(db, id, p.name, p.cwd, p.branch ?? null, p.repo);
      const standup = buildStandup(db, p.repo);
      return { instance_id: id, standup };
    }

    case "heartbeat": {
      const p = req.params as unknown as HeartbeatParams;
      heartbeat(db, p.instance_id, p.branch);
      return { ok: true };
    }

    case "mark_offline": {
      const p = req.params as { instance_id: string };
      markOffline(db, p.instance_id);
      return { ok: true };
    }

    case "broadcast": {
      const p = req.params as unknown as BroadcastParams;
      const repo = getInstanceRepo(db, p.instance_id);
      const id = broadcast(db, p.instance_id, p.content, p.tags, repo);
      writeStatusCache(db);
      return { message_id: id };
    }

    case "read_messages": {
      const p = req.params as ReadMessagesParams;
      const msgs = readMessages(db, p.since, p.tags, p.limit, p.repo);
      return { messages: msgs };
    }

    case "ask": {
      const p = req.params as unknown as AskParams;
      const repo = getInstanceRepo(db, p.instance_id);
      const id = ask(db, p.instance_id, p.question, p.context, repo);
      writeStatusCache(db);
      return { message_id: id };
    }

    case "answer": {
      const p = req.params as unknown as AnswerParams;
      const id = answer(db, p.instance_id, p.question_id, p.answer);
      writeStatusCache(db);
      return { message_id: id };
    }

    case "list_instances": {
      const p = req.params as unknown as ListInstancesParams;
      const instances = listInstances(db, p.repo);
      return { instances };
    }

    case "set_shared": {
      const p = req.params as unknown as SetSharedParams;
      const repo = getInstanceRepo(db, p.instance_id);
      setShared(db, p.instance_id, p.key, p.value, repo);
      return { ok: true };
    }

    case "get_shared": {
      const p = req.params as unknown as GetSharedParams;
      const entry = getShared(db, p.key, p.repo);
      return { entry: entry ?? null };
    }

    default:
      throw new Error(`Unknown method: ${req.method}`);
  }
}

function handleConnection(socket: net.Socket): void {
  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    if (buffer.length > MAX_BROADCAST_BYTES * 4) {
      socket.destroy();
      return;
    }
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let req: DaemonRequest;
      try {
        req = JSON.parse(line) as DaemonRequest;
      } catch {
        const errResp: DaemonResponse = { id: "unknown", error: "Invalid JSON" };
        socket.write(JSON.stringify(errResp) + "\n");
        continue;
      }

      const resp: DaemonResponse = { id: req.id };
      try {
        resp.result = handleRequest(req);
      } catch (e) {
        resp.error = e instanceof Error ? e.message : String(e);
      }
      socket.write(JSON.stringify(resp) + "\n");
    }
  });

  socket.on("error", () => { /* client disconnected */ });
}

async function findAvailableTcpPort(): Promise<number> {
  for (let port = TCP_PORT_BASE; port <= TCP_PORT_MAX; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const tester = net.createServer();
      tester.once("error", () => resolve(false));
      tester.once("listening", () => {
        tester.close(() => resolve(true));
      });
      tester.listen(port, "127.0.0.1");
    });
    if (available) return port;
  }
  throw new Error(`No available TCP ports in range ${TCP_PORT_BASE}-${TCP_PORT_MAX}`);
}

async function startServer(): Promise<void> {
  fs.mkdirSync(SQUAD_DIR, { recursive: true });
  db = openDb(DB_PATH);
  pruneOldMessages(db);

  let server: net.Server;

  const shutdownToken = crypto.randomBytes(32).toString("hex");

  if (isWindows()) {
    const port = await findAvailableTcpPort();
    fs.writeFileSync(PORT_PATH, String(port), "utf8");
    server = net.createServer(handleConnection);
    server.listen(port, "127.0.0.1", () => {
      // Write PID and token only after socket is confirmed ready
      fs.writeFileSync(DAEMON_PID_PATH, String(process.pid), "utf8");
      fs.writeFileSync(SHUTDOWN_TOKEN_PATH, shutdownToken, { encoding: "utf8", mode: 0o600 });
      process.stdout.write(`claude-squad daemon listening on 127.0.0.1:${port}\n`);
    });
  } else {
    if (fs.existsSync(SOCKET_PATH)) {
      fs.unlinkSync(SOCKET_PATH);
    }
    server = net.createServer(handleConnection);
    server.listen(SOCKET_PATH, () => {
      fs.chmodSync(SOCKET_PATH, 0o600);
      // Write PID and token only after socket is confirmed ready
      fs.writeFileSync(DAEMON_PID_PATH, String(process.pid), "utf8");
      fs.writeFileSync(SHUTDOWN_TOKEN_PATH, shutdownToken, { encoding: "utf8", mode: 0o600 });
      process.stdout.write(`claude-squad daemon listening on ${SOCKET_PATH}\n`);
    });
  }

  function shutdown(signal: string): void {
    process.stderr.write(`daemon: received ${signal}, shutting down\n`);
    server.close();
    if (!isWindows() && fs.existsSync(SOCKET_PATH)) {
      try { fs.unlinkSync(SOCKET_PATH); } catch { /* best effort */ }
    }
    if (fs.existsSync(PORT_PATH)) {
      try { fs.unlinkSync(PORT_PATH); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* best effort */ }
    try { fs.unlinkSync(SHUTDOWN_TOKEN_PATH); } catch { /* best effort */ }
    db.close();
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    process.stderr.write(`daemon: uncaught exception: ${err.message}\n`);
  });
}

startServer().catch((err) => {
  process.stderr.write(`daemon: failed to start: ${err.message}\n`);
  process.exit(1);
});
