/**
 * claude-squad uninstall command
 * Removes MCP registration, CLAUDE.md block, status line hook, and ~/.claude-squad/ data.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { isDaemonRunning, daemonRpc } from "./client.js";
import { DAEMON_PID_PATH } from "./types.js";

export interface UninstallOptions {
  // Overridable paths for testing
  claudeJsonPath?: string;
  claudeMdPath?: string;
  settingsJsonPath?: string;
  squadDir?: string;
}

const SENTINEL_START_RE = /<!-- claude-squad:start(?: mode=\w+)? -->/;
const SENTINEL_END = "<!-- claude-squad:end -->";

function defaultClaudeJsonPath(): string {
  return path.join(os.homedir(), ".claude.json");
}

function defaultSettingsJsonPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function defaultSquadDir(): string {
  return path.join(os.homedir(), ".claude-squad");
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, data: Record<string, unknown>): void {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function removeSentinelBlock(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, "utf8");
  const startMatch = SENTINEL_START_RE.exec(content);
  if (!startMatch) return false;
  const endIdx = content.indexOf(SENTINEL_END, startMatch.index);
  if (endIdx === -1) return false;

  const before = content.slice(0, startMatch.index).trimEnd();
  const after = content.slice(endIdx + SENTINEL_END.length);
  const newContent = (before ? before + "\n" : "") + after.replace(/^\n+/, "");
  fs.writeFileSync(filePath, newContent, "utf8");
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function killDaemon(squadDir: string): Promise<void> {
  const pidFile = path.join(squadDir, "daemon.pid");

  // Strategy 1: PID file
  if (fs.existsSync(pidFile)) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      if (!isNaN(pid)) {
        process.kill(pid, "SIGTERM");
        await sleep(500);
        // Check if still running, escalate to SIGKILL
        try {
          process.kill(pid, 0); // throws if not running
          await sleep(2500);
          try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
        } catch { /* already gone */ }
        console.log("✓ Daemon stopped");
        return;
      }
    } catch (err) {
      // PID file existed but process not found — already stopped
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        console.log("  Daemon was not running");
        return;
      }
    }
  }

  // Strategy 2: RPC shutdown (requires token to prevent unauthenticated shutdown)
  try {
    if (await isDaemonRunning()) {
      const tokenPath = path.join(squadDir, "shutdown.token");
      let token: string | undefined;
      try { token = fs.readFileSync(tokenPath, "utf8").trim(); } catch { /* no token file */ }
      await daemonRpc("shutdown", token ? { token } : {});
      await sleep(1000);
      console.log("✓ Daemon stopped via RPC");
      return;
    }
  } catch { /* fall through */ }

  // Strategy 3: pkill fallback
  try {
    execSync("pkill -f 'claude-squad.*daemon'", { stdio: "pipe" });
    await sleep(500);
    console.log("✓ Daemon stopped via pkill");
  } catch {
    console.log("  Daemon not running or could not be stopped (safe to continue)");
  }
}

export async function runUninstall(opts: UninstallOptions = {}): Promise<void> {
  const claudeJsonPath = opts.claudeJsonPath ?? defaultClaudeJsonPath();
  const settingsJsonPath = opts.settingsJsonPath ?? defaultSettingsJsonPath();
  const squadDir = opts.squadDir ?? defaultSquadDir();

  // Step 1: Kill daemon
  await killDaemon(squadDir);

  // Step 2: Remove MCP entry from ~/.claude.json
  const cfg = readJson(claudeJsonPath);
  if (cfg) {
    const mcpServers = cfg.mcpServers as Record<string, unknown> | undefined;
    if (mcpServers?.["claude-squad"]) {
      delete mcpServers["claude-squad"];
      cfg.mcpServers = mcpServers;
      try {
        writeJsonAtomic(claudeJsonPath, cfg);
        console.log(`✓ MCP server removed from ${claudeJsonPath}`);
      } catch (err) {
        console.error(`  Could not update ${claudeJsonPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Step 3: Remove PostToolUse hook from settings.json
  const settings = readJson(settingsJsonPath);
  if (settings) {
    const hooks = settings.hooks as Record<string, unknown> | undefined;
    if (hooks?.["PostToolUse"]) {
      const scriptPath = path.join(squadDir, "statusline.sh");
      const filtered = (hooks["PostToolUse"] as unknown[]).filter((h: unknown) => {
        if (typeof h !== "object" || !h) return true;
        const innerHooks = (h as Record<string, unknown>)["hooks"] as unknown[] | undefined;
        return !innerHooks?.some(
          (inner: unknown) =>
            typeof inner === "object" &&
            inner !== null &&
            (inner as Record<string, unknown>)["command"] === scriptPath
        );
      });
      if (filtered.length !== (hooks["PostToolUse"] as unknown[]).length) {
        hooks["PostToolUse"] = filtered.length > 0 ? filtered : undefined;
        if (!hooks["PostToolUse"]) delete hooks["PostToolUse"];
        settings.hooks = hooks;
        try {
          writeJsonAtomic(settingsJsonPath, settings);
          console.log(`✓ Status line hook removed from ${settingsJsonPath}`);
        } catch (err) {
          console.error(`  Could not update ${settingsJsonPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  // Step 4: Remove sentinel blocks from CLAUDE.md files
  const claudeMdCandidates: string[] = [];

  // Current project CLAUDE.md
  const claudeMdPath = opts.claudeMdPath;
  if (claudeMdPath) {
    claudeMdCandidates.push(claudeMdPath);
  } else {
    try {
      const root = execSync("git rev-parse --show-toplevel", {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      claudeMdCandidates.push(path.join(root, "CLAUDE.md"));
    } catch {
      claudeMdCandidates.push(path.join(process.cwd(), "CLAUDE.md"));
    }
    // Global CLAUDE.md
    claudeMdCandidates.push(path.join(os.homedir(), ".claude", "CLAUDE.md"));
  }

  for (const mdPath of claudeMdCandidates) {
    if (removeSentinelBlock(mdPath)) {
      console.log(`✓ claude-squad block removed from ${mdPath}`);
    }
  }

  // Step 5: Remove ~/.claude-squad/
  try {
    fs.rmSync(squadDir, { recursive: true, force: true });
    console.log(`✓ ${squadDir} deleted`);
  } catch (err) {
    console.error(`  Could not delete ${squadDir}: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`\nclaude-squad removed. Check any other project CLAUDE.md files for leftover blocks.`);
}
