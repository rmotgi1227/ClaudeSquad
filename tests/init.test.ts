/**
 * Tests for the init command — verifies MCP registration, CLAUDE.md injection,
 * status line hook, idempotency, and --update behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { runInit } from "../src/init.js";

// Mock ensure-running so tests don't spawn a real daemon
vi.mock("../src/ensure-running.js", () => ({
  ensureRunning: vi.fn().mockResolvedValue(undefined),
}));

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cs-init-test-"));
}

describe("runInit", () => {
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

  describe("MCP registration", () => {
    it("registers claude-squad in claude.json", async () => {
      await runInit(opts());
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".claude.json"), "utf8"));
      expect(cfg.mcpServers["claude-squad"]).toEqual({ command: "claude-squad", args: [] });
    });

    it("preserves existing mcpServers entries", async () => {
      fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({
        mcpServers: { "other-mcp": { command: "other", args: [] } },
      }), "utf8");
      await runInit(opts());
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".claude.json"), "utf8"));
      expect(cfg.mcpServers["other-mcp"]).toBeTruthy();
      expect(cfg.mcpServers["claude-squad"]).toBeTruthy();
    });

    it("does not crash when claude.json does not exist", async () => {
      await expect(runInit(opts())).resolves.not.toThrow();
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".claude.json"), "utf8"));
      expect(cfg.mcpServers["claude-squad"]).toBeTruthy();
    });

    it("skips re-registration when already present (no --update)", async () => {
      await runInit(opts());
      const before = fs.readFileSync(path.join(dir, ".claude.json"), "utf8");
      await runInit(opts());
      const after = fs.readFileSync(path.join(dir, ".claude.json"), "utf8");
      expect(after).toBe(before);
    });

    it("re-registers when --update is set", async () => {
      await runInit(opts());
      await runInit(opts({ update: true }));
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".claude.json"), "utf8"));
      expect(cfg.mcpServers["claude-squad"]).toEqual({ command: "claude-squad", args: [] });
    });
  });

  describe("CLAUDE.md injection", () => {
    it("creates passive block by default", async () => {
      await runInit(opts());
      const content = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
      expect(content).toContain("<!-- claude-squad:start mode=passive -->");
      expect(content).toContain("<!-- claude-squad:end -->");
    });

    it("creates aggressive block when mode=aggressive", async () => {
      await runInit(opts({ mode: "aggressive" }));
      const content = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
      expect(content).toContain("<!-- claude-squad:start mode=aggressive -->");
      expect(content).not.toContain("mode=passive");
    });

    it("appends block to existing CLAUDE.md without overwriting", async () => {
      fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# My Project\n\nExisting content.\n", "utf8");
      await runInit(opts());
      const content = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
      expect(content).toContain("# My Project");
      expect(content).toContain("Existing content");
      expect(content).toContain("claude-squad:start");
    });

    it("is idempotent — second call without --update skips re-injection", async () => {
      await runInit(opts());
      const before = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
      await runInit(opts());
      const after = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
      expect(after).toBe(before);
    });

    it("only one sentinel block present after multiple calls", async () => {
      await runInit(opts());
      await runInit(opts({ update: true }));
      const content = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
      const count = (content.match(/<!-- claude-squad:start/g) || []).length;
      expect(count).toBe(1);
    });

    it("--update replaces passive block with aggressive", async () => {
      await runInit(opts({ mode: "passive" }));
      await runInit(opts({ update: true, mode: "aggressive" }));
      const content = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
      expect(content).toContain("mode=aggressive");
      expect(content).not.toContain("mode=passive");
    });

    it("--update preserves existing mode when no new mode specified", async () => {
      await runInit(opts({ mode: "aggressive" }));
      await runInit(opts({ update: true }));
      const content = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
      expect(content).toContain("mode=aggressive");
    });
  });

  describe("status line hook", () => {
    it("--status-line injects PostToolUse hook into settings.json", async () => {
      await runInit(opts({ statusLine: true }));
      const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
      const hooks = settings.hooks?.PostToolUse;
      expect(Array.isArray(hooks)).toBe(true);
      expect(hooks.length).toBe(1);
      const scriptPath = path.join(dir, "squad", "statusline.sh");
      expect(hooks[0].hooks[0].command).toBe(scriptPath);
    });

    it("--status-line creates statusline.sh script", async () => {
      await runInit(opts({ statusLine: true }));
      const scriptPath = path.join(dir, "squad", "statusline.sh");
      expect(fs.existsSync(scriptPath)).toBe(true);
      const content = fs.readFileSync(scriptPath, "utf8");
      expect(content).toContain("#!/bin/bash");
      expect(content).toContain("status-cache");
    });

    it("--status-line is idempotent — second call does not double-inject hook", async () => {
      await runInit(opts({ statusLine: true }));
      await runInit(opts({ statusLine: true }));
      const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
      expect(settings.hooks.PostToolUse.length).toBe(1);
    });

    it("no --status-line means no hook in settings.json", async () => {
      await runInit(opts());
      expect(fs.existsSync(path.join(dir, "settings.json"))).toBe(false);
    });
  });
});
