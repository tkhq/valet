import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ProfileConfig, ProxyKeyRecord, ValetConfig } from "../config.js";
import { ApiError, ExitCode } from "../exit.js";
import { harnessAdapter } from "../proxy/harnesses/index.js";
import { findValetPath, helperCommand, parseProxyArgs, runProxy, shellWord, type ProxyClient, type ProxyDeps } from "./proxy.js";
import type { ProxySettingsResponse } from "../../wire/types.js";

const URL_ = "https://valet.example.com";
const KEY: ProxyKeyRecord = { id: "key_1", key: "vlt_secret_1", name: "claude-code@box", createdAt: 1 };
const KEY2: ProxyKeyRecord = { id: "key_2", key: "vlt_secret_2", name: "claude-code@box", createdAt: 2 };

function config(extra: Partial<ProfileConfig> = {}): ValetConfig {
  return {
    defaultProfile: "work",
    profiles: {
      work: {
        url: URL_,
        cli: { accessToken: "vltc_access", refreshToken: "vltr_refresh", accessExpiresAt: 9e15, refreshExpiresAt: 9e15 },
        ...extra,
      },
    },
  };
}

let dir: string;
let prevClaude: string | undefined;
let outSpy: MockInstance;
let errSpy: MockInstance;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "valet-proxy-"));
  prevClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaude;
  rmSync(dir, { recursive: true, force: true });
});

const stdout = (): string => outSpy.mock.calls.map((c) => String(c[0])).join("");
const stderr = (): string => errSpy.mock.calls.map((c) => String(c[0])).join("");
const settings = (): Record<string, unknown> => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;

function deps(opts: { settings?: ProxySettingsResponse; key?: ProxyKeyRecord; deleteError?: Error } = {}) {
  const saved: Array<{ profile: string; harness: string; key: ProxyKeyRecord | undefined }> = [];
  const requested: Array<{ url: string; cliToken: string; keyName: string }> = [];
  const deleted: string[] = [];
  const client: ProxyClient = {
    proxySettings: async () => opts.settings ?? { enabled: true, mode: "centralized" },
    deleteProxyKey: async (id) => {
      deleted.push(id);
      if (opts.deleteError) throw opts.deleteError;
    },
  };
  const d: ProxyDeps = {
    client: () => client,
    requestKey: async (req) => {
      requested.push(req);
      return opts.key ?? KEY;
    },
    saveKey: async (profile, harness, key) => {
      saved.push({ profile, harness, key });
    },
    adapter: harnessAdapter,
    valetPath: () => "/usr/local/bin/valet",
    hostname: () => "box",
    env: {},
  };
  return { deps: d, saved, requested, deleted };
}

const HELPER = "/usr/local/bin/valet proxy token claude-code --instance work";

describe("parseProxyArgs", () => {
  it("gives back a harness that a boolean flag swallowed", () => {
    expect(parseProxyArgs(["setup", "--force", "claude-code"])).toMatchObject({ sub: "setup", harness: "claude-code", force: true, rotate: false });
    expect(parseProxyArgs(["setup", "claude-code", "--rotate", "--instance", "work"])).toMatchObject({ harness: "claude-code", rotate: true, instance: "work" });
  });
});

describe("helper command", () => {
  it("quotes words a shell would split", () => {
    expect(shellWord("/usr/bin/valet")).toBe("/usr/bin/valet");
    expect(helperCommand("/Users/a b/valet", "claude-code", "it's")).toBe(`'/Users/a b/valet' proxy token claude-code --instance 'it'\\''s'`);
  });

  it("uses the running single binary, else valet on PATH", () => {
    expect(findValetPath("/opt/valet", {})).toBe("/opt/valet");
    expect(findValetPath("/usr/bin/node", { PATH: "" })).toBeUndefined();
    const bin = mkdtempSync(join(tmpdir(), "valet-bin-"));
    writeFileSync(join(bin, "valet"), "#!/bin/sh\n", { mode: 0o755 });
    expect(findValetPath("/usr/bin/node", { PATH: `/nowhere:${bin}` })).toBe(join(bin, "valet"));
    rmSync(bin, { recursive: true, force: true });
  });
});

describe("valet proxy setup", () => {
  it("asks for a key, stores it, and points Claude Code at the proxy", async () => {
    const { deps: d, saved, requested } = deps();
    expect(await runProxy(["setup", "claude-code"], config(), d)).toBe(ExitCode.OK);
    expect(requested).toEqual([{ url: URL_, cliToken: "vltc_access", keyName: "claude-code@box" }]);
    expect(saved).toEqual([{ profile: "work", harness: "claude-code", key: KEY }]);
    expect(settings()).toEqual({ env: { ANTHROPIC_BASE_URL: `${URL_}/proxy/anthropic` }, apiKeyHelper: HELPER });
    expect(stdout()).toContain("Start a new `claude` session");
    expect(stdout() + stderr()).not.toContain(KEY.key);
  });

  it("reuses the stored key", async () => {
    const { deps: d, requested } = deps();
    expect(await runProxy(["setup", "claude-code"], config({ proxyKeys: { "claude-code": KEY } }), d)).toBe(ExitCode.OK);
    expect(requested).toEqual([]);
    expect(settings().apiKeyHelper).toBe(HELPER);
  });

  it("rotates: stores the new key, then revokes the old one, and warns when revoke fails", async () => {
    const { deps: d, saved, deleted } = deps({ key: KEY2, deleteError: new ApiError(500, "boom") });
    expect(await runProxy(["setup", "claude-code", "--rotate"], config({ proxyKeys: { "claude-code": KEY } }), d)).toBe(ExitCode.OK);
    expect(saved).toEqual([{ profile: "work", harness: "claude-code", key: KEY2 }]);
    expect(deleted).toEqual(["key_1"]);
    expect(stderr()).toContain("could not revoke proxy key claude-code@box (key_1)");
  });

  it("refuses conflicts before it asks for a key, and replaces them under --force", async () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ apiKeyHelper: "~/bin/get-key.sh" }));
    const first = deps();
    expect(await runProxy(["setup", "claude-code"], config(), first.deps)).toBe(ExitCode.Failure);
    expect(first.requested).toEqual([]);
    expect(stderr()).toContain("~/bin/get-key.sh");
    expect(settings().apiKeyHelper).toBe("~/bin/get-key.sh");

    const forced = deps();
    expect(await runProxy(["setup", "--force", "claude-code"], config(), forced.deps)).toBe(ExitCode.OK);
    expect(settings().apiKeyHelper).toBe(HELPER);
    expect(readFileSync(join(dir, "settings.json.valet-backup"), "utf8")).toContain("get-key.sh");
  });

  it("refuses when the gateway is off or in pass-through mode", async () => {
    const off = deps({ settings: { enabled: false, mode: "centralized" } });
    expect(await runProxy(["setup", "claude-code"], config(), off.deps)).toBe(ExitCode.Failure);
    expect(stderr()).toContain("proxy is off");
    const passthrough = deps({ settings: { enabled: true, mode: "passthrough" } });
    expect(await runProxy(["setup", "claude-code"], config(), passthrough.deps)).toBe(ExitCode.Failure);
    expect(stderr()).toContain("pass-through mode");
    expect(off.requested).toEqual([]);
    expect(passthrough.requested).toEqual([]);
  });

  it("needs a browser sign-in, not an API key profile", async () => {
    const { deps: d, requested } = deps();
    const cfg: ValetConfig = { defaultProfile: "work", profiles: { work: { url: URL_, apiKey: "vlt_personal" } } };
    expect(await runProxy(["setup", "claude-code"], cfg, d)).toBe(ExitCode.AuthFailure);
    expect(stderr()).toContain(`valet login ${URL_}`);
    expect(requested).toEqual([]);
  });

  it("names the supported harnesses for an unknown one", async () => {
    const { deps: d } = deps();
    expect(await runProxy(["setup", "codex"], config(), d)).toBe(ExitCode.Usage);
    expect(stderr()).toContain("Supported: claude-code");
  });

  it("warns about shell exports that bypass the proxy", async () => {
    const { deps: d } = deps();
    d.env = { ANTHROPIC_API_KEY: "sk-mine" };
    expect(await runProxy(["setup", "claude-code"], config(), d)).toBe(ExitCode.OK);
    expect(stderr()).toContain("Your shell exports ANTHROPIC_API_KEY");
    expect(stderr()).not.toContain("sk-mine");
  });
});

describe("valet proxy token", () => {
  it("prints exactly the stored key", async () => {
    const { deps: d } = deps();
    expect(await runProxy(["token", "claude-code", "--instance", "work"], config({ proxyKeys: { "claude-code": KEY } }), d)).toBe(ExitCode.OK);
    expect(stdout()).toBe(`${KEY.key}\n`);
  });

  it("fails with the setup command when no key is stored", async () => {
    const { deps: d } = deps();
    expect(await runProxy(["token", "claude-code"], config(), d)).toBe(ExitCode.AuthFailure);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("valet proxy setup claude-code");
  });
});

describe("valet proxy remove", () => {
  it("removes the settings setup wrote, revokes the key, and forgets it", async () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "opus", env: { ANTHROPIC_BASE_URL: `${URL_}/proxy/anthropic` }, apiKeyHelper: HELPER }));
    const { deps: d, saved, deleted } = deps();
    expect(await runProxy(["remove", "claude-code"], config({ proxyKeys: { "claude-code": KEY } }), d)).toBe(ExitCode.OK);
    expect(settings()).toEqual({ model: "opus" });
    expect(deleted).toEqual(["key_1"]);
    expect(saved).toEqual([{ profile: "work", harness: "claude-code", key: undefined }]);
  });

  it("treats a key already revoked on the server as done", async () => {
    const { deps: d, saved } = deps({ deleteError: new ApiError(404, "gone") });
    expect(await runProxy(["remove", "claude-code"], config({ proxyKeys: { "claude-code": KEY } }), d)).toBe(ExitCode.OK);
    expect(stderr()).not.toContain("warning");
    expect(saved).toHaveLength(1);
  });
});
