import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../exit.js";
import { claudeCodeAdapter, claudeSettingsPath, planClaudeSettings, unapplyClaudeSettings } from "./claude-code.js";

const TARGET = { instanceUrl: "https://valet.example.com", helperCommand: "/usr/local/bin/valet proxy token claude-code --instance work" };
const BASE = "https://valet.example.com/proxy/anthropic";

let dir: string;
let prev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "valet-claude-"));
  prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const settingsFile = () => join(dir, "settings.json");
const readSettings = (): Record<string, unknown> => JSON.parse(readFileSync(settingsFile(), "utf8")) as Record<string, unknown>;

describe("planClaudeSettings", () => {
  it("sets the base URL and helper on empty settings, with no conflicts", () => {
    const plan = planClaudeSettings({}, TARGET);
    expect(plan.conflicts).toEqual([]);
    expect(plan.next).toEqual({ env: { ANTHROPIC_BASE_URL: BASE }, apiKeyHelper: TARGET.helperCommand });
  });

  it("keeps unrelated keys and env values", () => {
    const plan = planClaudeSettings({ model: "opus", env: { DEBUG: "1" }, permissions: { allow: ["Bash(ls)"] } }, TARGET);
    expect(plan.conflicts).toEqual([]);
    expect(plan.next).toEqual({
      model: "opus", permissions: { allow: ["Bash(ls)"] },
      env: { DEBUG: "1", ANTHROPIC_BASE_URL: BASE }, apiKeyHelper: TARGET.helperCommand,
    });
  });

  it("reports nothing to change when setup already ran", () => {
    const plan = planClaudeSettings({ env: { ANTHROPIC_BASE_URL: BASE }, apiKeyHelper: TARGET.helperCommand }, TARGET);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("flags each value it did not write, and never prints a credential", () => {
    const plan = planClaudeSettings({
      apiKeyHelper: "~/bin/get-key.sh",
      env: { ANTHROPIC_BASE_URL: "https://gateway.other", ANTHROPIC_AUTH_TOKEN: "sk-secret-1", ANTHROPIC_API_KEY: "sk-secret-2" },
    }, TARGET);
    expect(plan.conflicts).toHaveLength(4);
    expect(plan.conflicts.join("\n")).toContain("~/bin/get-key.sh");
    expect(plan.conflicts.join("\n")).toContain("https://gateway.other");
    expect(plan.conflicts.join("\n")).not.toContain("sk-secret");
    expect(plan.changes.join("\n")).not.toContain("sk-secret");
    expect(plan.next).toEqual({ env: { ANTHROPIC_BASE_URL: BASE }, apiKeyHelper: TARGET.helperCommand });
  });

  it("treats an older setup helper (the valet binary moved) as its own value", () => {
    const plan = planClaudeSettings({ env: { ANTHROPIC_BASE_URL: BASE }, apiKeyHelper: "/old/valet proxy token claude-code --instance work" }, TARGET);
    expect(plan.conflicts).toEqual([]);
    expect(plan.changes).toEqual([`apiKeyHelper = ${TARGET.helperCommand}`]);
  });
});

describe("unapplyClaudeSettings", () => {
  it("removes only the values setup wrote", () => {
    const out = unapplyClaudeSettings({ model: "opus", env: { ANTHROPIC_BASE_URL: BASE, DEBUG: "1" }, apiKeyHelper: TARGET.helperCommand }, TARGET);
    expect(out.next).toEqual({ model: "opus", env: { DEBUG: "1" } });
    expect(out.removed).toEqual(["apiKeyHelper", "env.ANTHROPIC_BASE_URL"]);
    expect(out.kept).toEqual([]);
  });

  it("drops an env object it empties, and keeps values someone changed", () => {
    expect(unapplyClaudeSettings({ env: { ANTHROPIC_BASE_URL: BASE } }, TARGET).next).toEqual({});
    const changed = unapplyClaudeSettings({ env: { ANTHROPIC_BASE_URL: "https://gateway.other" }, apiKeyHelper: "~/bin/get-key.sh" }, TARGET);
    expect(changed.next).toEqual({ env: { ANTHROPIC_BASE_URL: "https://gateway.other" }, apiKeyHelper: "~/bin/get-key.sh" });
    expect(changed.removed).toEqual([]);
    expect(changed.kept).toHaveLength(2);
  });
});

describe("claudeCodeAdapter files", () => {
  it("follows CLAUDE_CONFIG_DIR", () => {
    expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: "/tmp/cc" })).toBe("/tmp/cc/settings.json");
    expect(claudeSettingsPath({}).endsWith(join(".claude", "settings.json"))).toBe(true);
  });

  it("creates the settings file when it is missing", () => {
    const plan = claudeCodeAdapter.plan(TARGET);
    expect(plan.path).toBe(settingsFile());
    plan.apply({ force: false });
    expect(readSettings()).toEqual({ env: { ANTHROPIC_BASE_URL: BASE }, apiKeyHelper: TARGET.helperCommand });
    expect(claudeCodeAdapter.plan(TARGET).apply({ force: false })).toEqual([`${settingsFile()} is already set up.`]);
  });

  it("refuses invalid JSON and writes nothing", () => {
    writeFileSync(settingsFile(), "{ not json");
    expect(() => claudeCodeAdapter.plan(TARGET)).toThrow(ConfigError);
    expect(readFileSync(settingsFile(), "utf8")).toBe("{ not json");
  });

  it("writes conflicts only under force, after a backup", () => {
    const original = JSON.stringify({ apiKeyHelper: "~/bin/get-key.sh" });
    writeFileSync(settingsFile(), original);
    const plan = claudeCodeAdapter.plan(TARGET);
    expect(() => plan.apply({ force: false })).toThrow(ConfigError);
    expect(readFileSync(settingsFile(), "utf8")).toBe(original);
    plan.apply({ force: true });
    expect(readFileSync(`${settingsFile()}.valet-backup`, "utf8")).toBe(original);
    expect(readSettings().apiKeyHelper).toBe(TARGET.helperCommand);
  });

  it("unapply leaves a missing file missing", () => {
    expect(claudeCodeAdapter.unapply(TARGET)).toEqual({ path: settingsFile(), removed: [], kept: [] });
    expect(existsSync(settingsFile())).toBe(false);
  });

  it("warns about shell exports that bypass the proxy", () => {
    expect(claudeCodeAdapter.envWarnings({ ANTHROPIC_API_KEY: "sk", PATH: "/bin" })).toEqual([
      expect.stringContaining("ANTHROPIC_API_KEY"),
    ]);
    expect(claudeCodeAdapter.envWarnings({})).toEqual([]);
  });
});
