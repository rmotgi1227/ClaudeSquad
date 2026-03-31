/**
 * Tests for the uninstall command — verifies CLAUDE.md sentinel removal,
 * MCP deregistration, hook removal, and directory cleanup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { runUninstall } from "../src/uninstall.js";

// Mock client to avoid real daemon interactions (daemon won't be running in tests)
vi.mock("../src/client.js", () => ({
  isDaemonRunning: vi.fn().mockResolvedValue(false),
  daemonRpc: vi.fn().mockResolvedValue({ ok: true }),
}));

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cs-uninstall-test-"));
}

const PASSIVE_BLOCK = `<!-- claude-squad:start mode=passive -->
## claude-squad coordination

On session start: call \`list_instances\` and \`read_messages\`.
<!-- claude-squad:end -->`;

describe("runUninstall", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function opts(overrides: Record<string, unknown> = {}) {
    return {
      claudeJsonPath: path.join(dir, ".claude.json"),
      claudeMdPath: path.join(dir, "CLAUDE.md"),
      settingsJsonPath: path.join(dir, "settings.json"),
      squadDir: path.join(dir, "squad"),
      ...overrides,
    };
  }

  describe("CLAUDE.md sentinel removal", () => {
    it("removes sentinel block from CLAUDE.md", async () => {
      const claudeMdPath = path.join(dir, "CLAUDE.md");
      fs.writeFileSync(claudeMdPath, `# My Project\n\n${PASSIVE_BLOCK}\n\nOther content.\n`, "utf8");

      await runUninstall(opts());

      const content = fs.readFileSync(claudeMdPath, "utf8");
      expect(content).not.toContain("claude-squad:start");
      expect(content).not.toContain("claude-squad:end");
      expect(content).toContain("# My Project");
      expect(content).toContain("Other content.");
    });

    it("handles missing CLAUDE.md gracefully", async () => {
      await expect(runUninstall(opts())).resolves.not.toThrow();
    });

    it("handles CLAUDE.md with no sentinel block gracefully", async () => {
      const claudeMdPath = path.join(dir, "CLAUDE.md");
      fs.writeFileSync(claudeMdPath, "# My Project\n\nNo squad block.\n", "utf8");
      await runUninstall(opts());
      const content = fs.readFileSync(claudeMdPath, "utf8");
      expect(content).toBe("# My Project\n\nNo squad block.\n");
    });
  });

  describe("MCP deregistration", () => {
    it("removes claude-squad from claude.json mcpServers", async () => {
      fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({
        mcpServers: {
          "claude-squad": { command: "claude-squad", args: [] },
          "other-mcp": { command: "other", args: [] },
        },
      }, null, 2), "utf8");

      await runUninstall(opts());

      const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".claude.json"), "utf8"));
      expect(cfg.mcpServers["claude-squad"]).toBeUndefined();
      expect(cfg.mcpServers["other-mcp"]).toBeTruthy();
    });

    it("handles missing claude.json gracefully", async () => {
      await expect(runUninstall(opts())).resolves.not.toThrow();
    });

    it("handles claude.json without mcpServers gracefully", async () => {
      fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ theme: "dark" }), "utf8");
      await expect(runUninstall(opts())).resolves.not.toThrow();
    });
  });

  describe("PostToolUse hook removal", () => {
    it("removes the statusline hook from settings.json", async () => {
      const squadDir = path.join(dir, "squad");
      fs.mkdirSync(squadDir, { recursive: true });
      const scriptPath = path.join(squadDir, "statusline.sh");

      fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: "", hooks: [{ type: "command", command: scriptPath, timeout: 200 }] },
            { matcher: "other", hooks: [{ type: "command", command: "/other/script" }] },
          ],
        },
      }, null, 2), "utf8");

      await runUninstall(opts({ squadDir }));

      const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
      const hooks: Array<{ hooks: Array<{ command: string }>; matcher: string }> = settings.hooks?.PostToolUse ?? [];
      // Claude-squad hook removed
      expect(hooks.every((h) => !h.hooks?.some((inner) => inner.command === scriptPath))).toBe(true);
      // Other hooks preserved
      expect(hooks.some((h) => h.matcher === "other")).toBe(true);
    });

    it("removes PostToolUse key entirely when no hooks remain", async () => {
      const squadDir = path.join(dir, "squad");
      fs.mkdirSync(squadDir, { recursive: true });
      const scriptPath = path.join(squadDir, "statusline.sh");

      fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: "", hooks: [{ type: "command", command: scriptPath, timeout: 200 }] },
          ],
        },
      }, null, 2), "utf8");

      await runUninstall(opts({ squadDir }));

      const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
      expect(settings.hooks?.PostToolUse).toBeUndefined();
    });

    it("handles missing settings.json gracefully", async () => {
      await expect(runUninstall(opts())).resolves.not.toThrow();
    });
  });

  describe("squadDir deletion", () => {
    it("deletes the squadDir and its contents", async () => {
      const squadDir = path.join(dir, "squad");
      fs.mkdirSync(squadDir, { recursive: true });
      fs.writeFileSync(path.join(squadDir, "state.db"), "data", "utf8");
      fs.writeFileSync(path.join(squadDir, "daemon.pid"), "12345", "utf8");

      await runUninstall(opts({ squadDir }));

      expect(fs.existsSync(squadDir)).toBe(false);
    });

    it("handles non-existent squadDir gracefully", async () => {
      await expect(runUninstall(opts())).resolves.not.toThrow();
    });
  });
});
