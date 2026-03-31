import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";

export const SQUAD_DIR = path.join(os.homedir(), ".ccsquad");
export const SOCKET_PATH = path.join(SQUAD_DIR, "server.sock");
export const LOCK_PATH = path.join(SQUAD_DIR, "server.lock");
export const DB_PATH = path.join(SQUAD_DIR, "state.db");
export const PORT_PATH = path.join(SQUAD_DIR, "port");
export const DAEMON_PID_PATH = path.join(SQUAD_DIR, "daemon.pid");
export const SHUTDOWN_TOKEN_PATH = path.join(SQUAD_DIR, "shutdown.token");
export const STATUS_CACHE_PATH = path.join(SQUAD_DIR, "status-cache");
export const TCP_PORT_BASE = 38475;
export const TCP_PORT_MAX = 38499;

export const MAX_BROADCAST_BYTES = 10 * 1024; // 10KB
export const MAX_KV_VALUE_BYTES = 50 * 1024;  // 50KB
export const MAX_MESSAGES_LIMIT = 20;
export const DEFAULT_MESSAGES_LIMIT = 5;
export const STALE_INSTANCE_MS = 30 * 60 * 1000; // 30 minutes
export const SQLITE_BUSY_TIMEOUT_MS = 5000;
export const STATUS_CACHE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

export interface Instance {
  id: string;
  name: string;
  cwd: string;
  branch: string | null;
  repo: string;
  slot: number | null;
  last_seen: number; // millisecond epoch
}

export interface Message {
  id: number;
  instance_id: string;
  instance_name?: string;    // joined from instances
  to_instance_name?: string; // joined from instances via to_instance_id
  type: "broadcast" | "ask" | "answer";
  content: string;
  tags: string[] | null;
  reply_to: number | null;
  to_instance_id: string | null; // directed ask — null means public
  created_at: number; // millisecond epoch
}

export interface KVEntry {
  key: string;
  repo: string;
  value: string;
  set_by: string;
  updated_at: number;
}

export interface Standup {
  active_instances: Array<{ name: string; branch: string | null; cwd: string; last_seen: number }>;
  recent_messages: Array<{ from: string; type: string; content: string; created_at: number }>;
  inbox_count: number;
}

// Daemon RPC protocol (NDJSON over Unix socket)
export interface DaemonRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface DaemonResponse {
  id: string;
  result?: unknown;
  error?: string;
}

// Tool param types
export interface RegisterParams {
  name: string;
  cwd: string;
  branch?: string;
  repo: string;
  pid: number;
  startup_ts: number;
}

export interface BroadcastParams {
  instance_id: string;
  content: string;
  tags?: string[];
}

export interface ReadMessagesParams {
  since?: number;
  tags?: string[];
  limit?: number;
  repo?: string;
  reply_to_id?: number;
}

export interface AskParams {
  instance_id: string;
  question: string;
  context?: string;
}

export interface AskInstanceParams {
  instance_id: string;
  target: number | string;
  question: string;
  context?: string;
  repo: string;
}

export interface CheckInboxParams {
  instance_id: string;
  limit?: number;
}

export interface AnswerParams {
  instance_id: string;
  question_id: number;
  answer: string;
}

export interface HeartbeatParams {
  instance_id: string;
  branch?: string;
}

export interface SetSharedParams {
  instance_id: string;
  key: string;
  value: string;
}

export interface GetSharedParams {
  key: string;
  repo: string;
}

export interface ListInstancesParams {
  repo?: string;
}

export function makeInstanceId(name: string, cwd: string, pid: number, startupTs: number): string {
  const raw = `${os.hostname()}:${name}:${cwd}:${pid}:${startupTs}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function nowMs(): number {
  return Date.now();
}

export function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Get a stable repo identifier for the given working directory.
 * Uses git --git-common-dir so all worktrees of the same repo share the same ID.
 * Falls back to cwd if not in a git repo.
 */
export function getRepoId(cwd: string = process.cwd()): string {
  // Try remote URL first — normalizes across separate clones of the same repo
  try {
    const remote = execSync("git remote get-url origin", {
      encoding: "utf8",
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    }).trim();
    if (remote) return normalizeRemoteUrl(remote);
  } catch { /* no remote, fall through */ }

  // Fall back to local git-common-dir (handles worktrees, no-remote repos)
  try {
    const commonDir = execSync("git rev-parse --git-common-dir", {
      encoding: "utf8",
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    }).trim();
    return path.resolve(cwd, commonDir);
  } catch {
    return cwd;
  }
}

/**
 * Normalize git remote URLs so https and ssh forms of the same repo match.
 * https://github.com/user/repo.git → github.com/user/repo
 * git@github.com:user/repo.git    → github.com/user/repo
 */
function normalizeRemoteUrl(url: string): string {
  // SSH: git@github.com:user/repo.git
  const ssh = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  // HTTPS: https://github.com/user/repo.git
  try {
    const u = new URL(url);
    return (u.host + u.pathname).replace(/\.git$/, "").replace(/\/$/, "");
  } catch {
    return url;
  }
}

export function formatAge(ms: number): string {
  const diff = nowMs() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}
