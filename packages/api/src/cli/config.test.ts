import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configPath, loadConfig, saveConfig, type ValetConfig } from "./config.js";
import { ConfigError } from "./exit.js";

describe("cli/config", () => {
  let dir: string;
  const prev = process.env.VALET_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "valet-cfg-"));
    process.env.VALET_DATA_DIR = dir;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.VALET_DATA_DIR;
    else process.env.VALET_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("configPath is config.json under VALET_DATA_DIR", () => {
    expect(configPath()).toBe(join(dir, "config.json"));
  });

  it("missing file loads as empty object", () => {
    expect(existsSync(configPath())).toBe(false);
    expect(loadConfig()).toEqual({});
  });

  it("save then load round-trips the config", () => {
    const cfg: ValetConfig = {
      serve: { port: 9000, sandbox: "local", authMode: "real" },
      profiles: { prod: { url: "https://valet.example", apiKey: "sk-1" } },
      defaultProfile: "prod",
    };
    saveConfig(cfg);
    expect(loadConfig()).toEqual(cfg);
  });

  it("writes the file mode 0600 and the dir mode 0700", () => {
    saveConfig({ defaultProfile: "prod", profiles: { prod: { url: "https://x" } } });
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("tightens perms on a pre-existing looser file", () => {
    writeFileSync(configPath(), "{}", { mode: 0o644 });
    expect(statSync(configPath()).mode & 0o777).toBe(0o644);
    saveConfig({ defaultProfile: "prod", profiles: { prod: { url: "https://x" } } });
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  it("drops unknown top-level keys and warns to stderr", () => {
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    writeFileSync(
      configPath(),
      JSON.stringify({ defaultProfile: "prod", bogus: 1, alsoBogus: { x: 2 } }),
    );
    const cfg = loadConfig();
    expect(cfg).toEqual({ defaultProfile: "prod" });
    const written = warn.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain('config: ignoring unknown key "bogus"');
    expect(written).toContain('config: ignoring unknown key "alsoBogus"');
  });

  it("throws ConfigError on malformed JSON (never silently wipes)", () => {
    writeFileSync(configPath(), "{ not json ");
    expect(() => loadConfig()).toThrow(ConfigError);
    // The bad bytes are still on disk — not clobbered.
    expect(existsSync(configPath())).toBe(true);
  });

  it("throws ConfigError when the top-level JSON is not an object", () => {
    writeFileSync(configPath(), "[1,2,3]");
    expect(() => loadConfig()).toThrow(ConfigError);
  });
});
