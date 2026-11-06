import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harnessAdapter } from "./index.js";
function adapter() { const value = harnessAdapter("codex"); expect(value, "Codex adapter is available").toBeDefined(); if (!value) throw new Error("Codex adapter missing"); return value; }

const TARGET = { instanceUrl: "https://valet.example", helperCommand: "/bin/valet proxy token codex --instance work", helperArgs: "proxy token codex --instance work" };
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "valet-codex-")); vi.stubEnv("CODEX_HOME", dir); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe("Codex profile setup", () => {
  it("writes a named profile with command auth and preserves the default config and login", () => {
    writeFileSync(join(dir, "config.toml"), 'model = "existing-model"\n');
    writeFileSync(join(dir, "auth.json"), '{"login":"existing"}');
    const plan = adapter().plan(TARGET);
    expect(plan.conflicts).toEqual([]);
    plan.apply({ force: false });
    expect(readFileSync(plan.path, "utf8")).toContain('model_provider = "valet"');
    expect(readFileSync(plan.path, "utf8")).toContain('[model_providers.valet.auth]\ncommand = "/bin/sh"\nargs = ["-c", "/bin/valet proxy token codex --instance work"]');
    expect(readFileSync(plan.path, "utf8")).toContain('base_url = "https://valet.example/proxy/openai/v1"');
    expect(readFileSync(join(dir, "config.toml"), "utf8")).toBe('model = "existing-model"\n');
    expect(readFileSync(join(dir, "auth.json"), "utf8")).toBe('{"login":"existing"}');
    expect(adapter().plan(TARGET).changes).toEqual([]);
    expect(adapter().unapply(TARGET).removed).toHaveLength(1);
    expect(existsSync(plan.path)).toBe(false);
  });

  it("refuses a user profile unless forced, saves a backup, and retains later user edits on removal", () => {
    const path = join(dir, "valet.config.toml");
    writeFileSync(path, 'model = "my-model"\n');
    const plan = adapter().plan(TARGET);
    expect(plan.conflicts).toHaveLength(1);
    expect(() => plan.apply({ force: false })).toThrow();
    plan.apply({ force: true });
    expect(readFileSync(`${path}.valet-backup`, "utf8")).toBe('model = "my-model"\n');
    writeFileSync(path, `${readFileSync(path, "utf8")}# keep my notes\n`);
    expect(adapter().unapply(TARGET).removed).toEqual([]);
    expect(readFileSync(path, "utf8")).toContain("keep my notes");
  });

  it("keeps another instance's profile and detects edits during approval", () => {
    const plan = adapter().plan(TARGET);
    writeFileSync(plan.path, 'model = "changed-while-waiting"\n');
    expect(() => plan.apply({ force: false })).toThrow(/changed/);
    adapter().plan(TARGET).apply({ force: true });
    expect(adapter().unapply({ ...TARGET, helperArgs: "proxy token codex --instance home" }).removed).toEqual([]);
  });

  it("refuses an old installed CLI before setup changes files", () => {
    vi.stubEnv("PATH", dir);
    writeFileSync(join(dir, "codex"), '#!/bin/sh\nprintf "codex-cli 0.133.0\\n"\n', { mode: 0o755 });
    expect(adapter().preflight({}).blockers).toHaveLength(1);
    expect(existsSync(join(dir, "valet.config.toml"))).toBe(false);
    writeFileSync(join(dir, "codex"), '#!/bin/sh\nprintf "codex-cli 0.164.0-alpha.11.1\\n"\n', { mode: 0o755 });
    expect(adapter().preflight({}).blockers).toEqual([]);
  });


});
