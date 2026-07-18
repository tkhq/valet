import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { loadConfig, type ValetConfig } from "../config.js";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags } from "../output.js";
import { coerceServeValue, parseServeKey, runConfig, setServeField } from "./config.js";

let dir: string;
let prevDataDir: string | undefined;
let outSpy: MockInstance;
let errSpy: MockInstance;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "valet-config-"));
  prevDataDir = process.env.VALET_DATA_DIR;
  process.env.VALET_DATA_DIR = dir;
  outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (prevDataDir === undefined) delete process.env.VALET_DATA_DIR;
  else process.env.VALET_DATA_DIR = prevDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const stdout = (): string => outSpy.mock.calls.map((c) => String(c[0])).join("");
const stderr = (): string => errSpy.mock.calls.map((c) => String(c[0])).join("");

describe("parseServeKey", () => {
  it("accepts known serve.* fields", () => {
    expect(parseServeKey("serve.port")).toBe("port");
    expect(parseServeKey("serve.sandbox")).toBe("sandbox");
    expect(parseServeKey("serve.dataDir")).toBe("dataDir");
    expect(parseServeKey("serve.authMode")).toBe("authMode");
  });
  it("rejects wrong prefix, depth, or unknown leaf", () => {
    expect(parseServeKey("profiles.foo")).toBeUndefined();
    expect(parseServeKey("serve")).toBeUndefined();
    expect(parseServeKey("serve.port.extra")).toBeUndefined();
    expect(parseServeKey("serve.bogus")).toBeUndefined();
  });
});

describe("coerceServeValue", () => {
  it("coerces port to an integer", () => {
    expect(coerceServeValue("port", "8790")).toEqual({ ok: true, value: 8790 });
  });
  it("rejects a non-numeric port", () => {
    expect(coerceServeValue("port", "abc")).toEqual({ ok: false, error: expect.stringContaining("integer") });
  });
  it("rejects a non-positive port", () => {
    expect(coerceServeValue("port", "0").ok).toBe(false);
    expect(coerceServeValue("port", "-5").ok).toBe(false);
  });
  it("validates the sandbox enum", () => {
    expect(coerceServeValue("sandbox", "kubernetes")).toEqual({ ok: true, value: "kubernetes" });
    expect(coerceServeValue("sandbox", "vm").ok).toBe(false);
  });
  it("validates the authMode enum", () => {
    expect(coerceServeValue("authMode", "real")).toEqual({ ok: true, value: "real" });
    expect(coerceServeValue("authMode", "oauth").ok).toBe(false);
  });
  it("accepts a non-empty dataDir string", () => {
    expect(coerceServeValue("dataDir", "/tmp/x")).toEqual({ ok: true, value: "/tmp/x" });
    expect(coerceServeValue("dataDir", "").ok).toBe(false);
  });
});

describe("setServeField (pure)", () => {
  it("writes the field without touching others", () => {
    const base: ValetConfig = { serve: { port: 1 }, profiles: { a: { url: "http://a" } }, defaultProfile: "a" };
    const next = setServeField(base, "sandbox", "local");
    expect(next.serve).toEqual({ port: 1, sandbox: "local" });
    expect(next.profiles).toEqual(base.profiles);
    expect(next.defaultProfile).toBe("a");
  });
});

describe("runConfig get", () => {
  it("prints a set value", () => {
    const cfg: ValetConfig = { serve: { port: 8790 } };
    expect(runConfig(cfg, parseGlobalFlags(["get", "serve.port"]))).toBe(ExitCode.OK);
    expect(stdout().trim()).toBe("8790");
  });
  it("notes an unset value", () => {
    expect(runConfig({}, parseGlobalFlags(["get", "serve.sandbox"]))).toBe(ExitCode.OK);
    expect(stdout()).toContain("not set");
  });
  it("emits JSON with --json", () => {
    const cfg: ValetConfig = { serve: { port: 8790 } };
    expect(runConfig(cfg, parseGlobalFlags(["get", "serve.port", "--json"]))).toBe(ExitCode.OK);
    expect(JSON.parse(stdout())).toBe(8790);
  });
  it("emits null JSON for an unset value", () => {
    expect(runConfig({}, parseGlobalFlags(["get", "serve.port", "--json"]))).toBe(ExitCode.OK);
    expect(JSON.parse(stdout())).toBeNull();
  });
  it("returns Usage for an unknown key", () => {
    expect(runConfig({}, parseGlobalFlags(["get", "serve.bogus"]))).toBe(ExitCode.Usage);
    expect(stderr()).toContain("unknown key");
  });
});

describe("runConfig set", () => {
  it("coerces and persists a port as an integer", () => {
    expect(runConfig({}, parseGlobalFlags(["set", "serve.port", "8790"]))).toBe(ExitCode.OK);
    const saved = loadConfig();
    expect(saved.serve?.port).toBe(8790);
    expect(typeof saved.serve?.port).toBe("number");
  });

  it("persists a valid sandbox enum", () => {
    expect(runConfig({}, parseGlobalFlags(["set", "serve.sandbox", "kubernetes"]))).toBe(ExitCode.OK);
    expect(loadConfig().serve?.sandbox).toBe("kubernetes");
  });

  it("persists a valid authMode enum", () => {
    expect(runConfig({}, parseGlobalFlags(["set", "serve.authMode", "real"]))).toBe(ExitCode.OK);
    expect(loadConfig().serve?.authMode).toBe("real");
  });

  it("rejects a non-numeric port with Usage and writes nothing", () => {
    expect(runConfig({}, parseGlobalFlags(["set", "serve.port", "abc"]))).toBe(ExitCode.Usage);
    expect(loadConfig()).toEqual({});
  });

  it("rejects an invalid sandbox with Usage", () => {
    expect(runConfig({}, parseGlobalFlags(["set", "serve.sandbox", "vm"]))).toBe(ExitCode.Usage);
    expect(loadConfig()).toEqual({});
  });

  it("rejects an unknown key with Usage", () => {
    expect(runConfig({}, parseGlobalFlags(["set", "serve.bogus", "1"]))).toBe(ExitCode.Usage);
    expect(stderr()).toContain("unknown key");
    expect(loadConfig()).toEqual({});
  });

  it("does not touch profiles/defaultProfile when setting a serve field", () => {
    const cfg: ValetConfig = { profiles: { a: { url: "http://a", apiKey: "k" } }, defaultProfile: "a" };
    expect(runConfig(cfg, parseGlobalFlags(["set", "serve.port", "9000"]))).toBe(ExitCode.OK);
    const saved = loadConfig();
    expect(saved.profiles).toEqual({ a: { url: "http://a", apiKey: "k" } });
    expect(saved.defaultProfile).toBe("a");
    expect(saved.serve?.port).toBe(9000);
  });

  it("returns Usage for a missing value", () => {
    expect(runConfig({}, parseGlobalFlags(["set", "serve.port"]))).toBe(ExitCode.Usage);
  });
});

describe("runConfig unknown subcommand", () => {
  it("returns Usage", () => {
    expect(runConfig({}, parseGlobalFlags(["bogus"]))).toBe(ExitCode.Usage);
  });
});
