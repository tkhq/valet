import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { PendingLogin, ProfileConfig, ProxyKeyRecord, ValetConfig } from "../config.js";
import { ApiError, AuthError, ExitCode } from "../exit.js";
import { claudeCodeAdapter } from "../proxy/harnesses/claude-code.js";
import type { HarnessAdapter, HarnessPreflight } from "../proxy/harnesses/index.js";
import { findValetPath, helperCommand, parseProxyArgs, runProxy, shellWord, type HelperResult, type ProxyClient, type ProxyDeps } from "./proxy.js";
import type { ProxySettingsResponse } from "../../wire/types.js";

const URL_ = "https://valet.example.com";
const KEY: ProxyKeyRecord = { id: "key_1", key: "vlt_secret_1", name: "claude-code@box", createdAt: 1 };
const KEY2: ProxyKeyRecord = { id: "key_2", key: "vlt_secret_2", name: "claude-code@box", createdAt: 2 };
const PENDING: PendingLogin = { url: URL_, deviceCode: "dev", userCode: "BCDF-GHJK", verificationPath: "/cli/device", expiresAt: 600_000, interval: 5 };
const HELPER = "/usr/local/bin/valet proxy token claude-code --instance work";

function config(extra: Partial<ProfileConfig> = {}, top: Partial<ValetConfig> = {}): ValetConfig {
  return {
    defaultProfile: "work",
    profiles: {
      work: {
        url: URL_,
        cli: { accessToken: "vltc_access", refreshToken: "vltr_refresh", accessExpiresAt: 9e15, refreshExpiresAt: 9e15 },
        ...extra,
      },
    },
    ...top,
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
const settingsExist = (): boolean => {
  try {
    readFileSync(join(dir, "settings.json"));
    return true;
  } catch {
    return false;
  }
};

/** The real Claude Code adapter, with its preflight replaced so the host's managed settings and shell do not leak in. */
function adapterWith(preflight: Partial<HarnessPreflight> = {}): HarnessAdapter {
  return { ...claudeCodeAdapter, preflight: () => ({ blockers: [], shellBlockers: [], warnings: [], ...preflight }) };
}

interface DepOpts {
  settings?: ProxySettingsResponse;
  key?: ProxyKeyRecord;
  deleteError?: Error;
  /** Ids the server no longer knows. */
  gone?: string[];
  poll?: () => Promise<ProxyKeyRecord>;
  helper?: (command: string) => HelperResult;
  preflight?: Partial<HarnessPreflight>;
}

function deps(opts: DepOpts = {}) {
  const saved: Array<{ profile: string; harness: string; key: ProxyKeyRecord | undefined }> = [];
  const pendings: Array<{ slot: string; pending: PendingLogin | undefined }> = [];
  const started: Array<{ url: string; cliToken: string; keyName: string }> = [];
  const polled: PendingLogin[] = [];
  const opened: string[] = [];
  const deleted: string[] = [];
  const helpers: string[] = [];
  let current: ProxyKeyRecord | undefined;
  const client: ProxyClient = {
    proxySettings: async () => opts.settings ?? { enabled: true, mode: "centralized" },
    proxyKeyStatus: async (id) => {
      if (opts.gone?.includes(id)) throw new ApiError(404, "gone");
      return { id, name: "claude-code@box", created_at: 1 };
    },
    deleteProxyKey: async (id) => {
      deleted.push(id);
      if (opts.deleteError) throw opts.deleteError;
    },
  };
  const d: ProxyDeps = {
    client: () => client,
    startKeyRequest: async (req) => {
      started.push(req);
      return PENDING;
    },
    pollKeyRequest: async (pending) => {
      polled.push(pending);
      return opts.poll ? opts.poll() : (opts.key ?? KEY);
    },
    openUrl: async (url) => {
      opened.push(url);
      return true;
    },
    saveKey: async (profile, harness, key) => {
      saved.push({ profile, harness, key });
      current = key;
    },
    savePending: async (slot, pending) => {
      pendings.push({ slot, pending });
    },
    // The helper prints whatever key setup stored, as `valet proxy token` does.
    runHelper: async (command) => {
      helpers.push(command);
      if (opts.helper) return opts.helper(command);
      return { ok: true, stdout: `${(current ?? KEY).key}\n` };
    },
    adapter: (id) => (id === "claude-code" ? adapterWith(opts.preflight) : undefined),
    valetPath: () => "/usr/local/bin/valet",
    hostname: () => "box",
    now: () => 1_000,
    env: {},
  };
  return { deps: d, saved, pendings, started, polled, opened, deleted, helpers };
}

describe("parseProxyArgs", () => {
  it("gives back a harness that a boolean flag swallowed", () => {
    expect(parseProxyArgs(["setup", "--force", "claude-code"])).toMatchObject({ sub: "setup", harness: "claude-code", force: true, rotate: false });
    expect(parseProxyArgs(["setup", "--no-wait", "claude-code", "--rotate", "--instance", "work"]))
      .toMatchObject({ harness: "claude-code", noWait: true, rotate: true, instance: "work" });
  });
});

describe("helper command", () => {
  it("quotes words a shell would split, and carries VALET_DATA_DIR", () => {
    expect(shellWord("/usr/bin/valet")).toBe("/usr/bin/valet");
    expect(helperCommand("/Users/a b/valet", "claude-code", "it's", {})).toBe(`'/Users/a b/valet' proxy token claude-code --instance 'it'\\''s'`);
    expect(helperCommand("/v", "claude-code", "work", { VALET_DATA_DIR: "/data dir" })).toBe(`VALET_DATA_DIR='/data dir' /v proxy token claude-code --instance work`);
  });

  it("uses the running binary under any name, and looks on PATH only under node or bun", () => {
    expect(findValetPath("/Users/me/Downloads/valet-darwin-arm64", {})).toBe("/Users/me/Downloads/valet-darwin-arm64");
    expect(findValetPath("/usr/bin/node", { PATH: "" })).toBeUndefined();
    const bin = mkdtempSync(join(tmpdir(), "valet-bin-"));
    writeFileSync(join(bin, "valet"), "#!/bin/sh\n", { mode: 0o755 });
    expect(findValetPath("/opt/homebrew/bin/bun", { PATH: `/nowhere:${bin}` })).toBe(join(bin, "valet"));
    rmSync(bin, { recursive: true, force: true });
  });
});

describe("valet proxy --help", () => {
  it("prints usage and exits 0", async () => {
    expect(await runProxy(["--help"], config(), deps().deps)).toBe(ExitCode.OK);
    expect(stdout()).toContain("usage: valet proxy");
  });
});

describe("valet proxy setup", () => {
  it("asks for a key, checks the helper, stores the key, and points Claude Code at the proxy", async () => {
    const t = deps();
    expect(await runProxy(["setup", "claude-code"], config(), t.deps)).toBe(ExitCode.OK);
    expect(t.started).toEqual([{ url: URL_, cliToken: "vltc_access", keyName: "claude-code@box" }]);
    expect(t.opened).toEqual([`${URL_}/cli/device`]);
    expect(t.saved).toEqual([{ profile: "work", harness: "claude-code", key: KEY }]);
    expect(t.pendings.map((p) => p.pending)).toEqual([PENDING, undefined]);
    expect(t.helpers).toEqual([HELPER]);
    expect(settings()).toEqual({ env: { ANTHROPIC_BASE_URL: `${URL_}/proxy/anthropic` }, apiKeyHelper: HELPER });
    expect(stdout()).toContain("bills through Valet");
    expect(stdout()).toContain("Start a new `claude` session");
    expect(stdout() + stderr()).not.toContain(KEY.key);
  });

  it("with --no-wait, prints the code and exits; a later setup resumes the same request", async () => {
    const first = deps();
    expect(await runProxy(["setup", "claude-code", "--no-wait"], config(), first.deps)).toBe(ExitCode.OK);
    expect(first.polled).toEqual([]);
    expect(first.opened).toEqual([]);
    expect(first.pendings).toEqual([{ slot: "work/claude-code", pending: PENDING }]);
    expect(stderr()).toContain("BCDF-GHJK");
    expect(stderr()).toContain("run `valet proxy setup claude-code` again");
    expect(settingsExist()).toBe(false);

    const second = deps();
    expect(await runProxy(["setup", "claude-code"], config({}, { pendingProxyKeys: { "work/claude-code": PENDING } }), second.deps)).toBe(ExitCode.OK);
    expect(second.started).toEqual([]);
    expect(second.polled).toEqual([PENDING]);
    expect(stderr()).toContain("Resuming the proxy key request");
    expect(settings().apiKeyHelper).toBe(HELPER);
  });

  it("forgets a denied request so the next setup starts a new one", async () => {
    const t = deps({ poll: () => Promise.reject(new AuthError("the proxy key request was denied in the browser.")) });
    expect(await runProxy(["setup", "claude-code"], config(), t.deps)).toBe(ExitCode.AuthFailure);
    expect(t.pendings.at(-1)).toEqual({ slot: "work/claude-code", pending: undefined });
    expect(stderr()).toContain("denied");
    expect(settingsExist()).toBe(false);
  });

  it("reuses a stored key that still works", async () => {
    const t = deps();
    expect(await runProxy(["setup", "claude-code"], config({ proxyKeys: { "claude-code": KEY } }), t.deps)).toBe(ExitCode.OK);
    expect(t.started).toEqual([]);
    expect(stdout()).toContain("Using the stored proxy key");
  });

  it("replaces a stored key that was revoked in Settings", async () => {
    const t = deps({ gone: ["key_1"], key: KEY2 });
    expect(await runProxy(["setup", "claude-code"], config({ proxyKeys: { "claude-code": KEY } }), t.deps)).toBe(ExitCode.OK);
    expect(stderr()).toContain("no longer works");
    expect(t.saved).toEqual([{ profile: "work", harness: "claude-code", key: KEY2 }]);
  });

  it("rotates: stores the new key, then revokes the old one, and warns when revoke fails", async () => {
    const t = deps({ key: KEY2, deleteError: new ApiError(500, "boom") });
    expect(await runProxy(["setup", "claude-code", "--rotate"], config({ proxyKeys: { "claude-code": KEY } }), t.deps)).toBe(ExitCode.OK);
    expect(t.saved).toEqual([{ profile: "work", harness: "claude-code", key: KEY2 }]);
    expect(t.deleted).toEqual(["key_1"]);
    expect(stderr()).toContain("could not revoke proxy key claude-code@box (key_1)");
  });

  it("leaves the settings alone when the helper does not print the key", async () => {
    const t = deps({ helper: () => ({ ok: false, error: "unknown command: proxy" }) });
    expect(await runProxy(["setup", "claude-code"], config(), t.deps)).toBe(ExitCode.Failure);
    expect(stderr()).toContain("unknown command: proxy");
    expect(stderr()).toContain(HELPER);
    expect(settingsExist()).toBe(false);
    const wrong = deps({ helper: () => ({ ok: true, stdout: "vlt_other\n" }) });
    expect(await runProxy(["setup", "claude-code"], config(), wrong.deps)).toBe(ExitCode.Failure);
    expect(settingsExist()).toBe(false);
  });

  it("refuses conflicts before it asks for a key, and replaces them under --force", async () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ apiKeyHelper: "~/bin/get-key.sh" }));
    const first = deps();
    expect(await runProxy(["setup", "claude-code"], config(), first.deps)).toBe(ExitCode.Failure);
    expect(first.started).toEqual([]);
    expect(stderr()).toContain("~/bin/get-key.sh");
    expect(settings().apiKeyHelper).toBe("~/bin/get-key.sh");

    const forced = deps();
    expect(await runProxy(["setup", "--force", "claude-code"], config(), forced.deps)).toBe(ExitCode.OK);
    expect(settings().apiKeyHelper).toBe(HELPER);
    expect(readFileSync(join(dir, "settings.json.valet-backup"), "utf8")).toContain("get-key.sh");
  });

  it("refuses an exported key before it asks for one, unless --force", async () => {
    const blocked = deps({ preflight: { shellBlockers: ["Your shell exports ANTHROPIC_API_KEY."] } });
    expect(await runProxy(["setup", "claude-code"], config(), blocked.deps)).toBe(ExitCode.Failure);
    expect(blocked.started).toEqual([]);
    expect(stderr()).toContain("--force skips this check");
    const forced = deps({ preflight: { shellBlockers: ["Your shell exports ANTHROPIC_API_KEY."] } });
    expect(await runProxy(["setup", "claude-code", "--force"], config(), forced.deps)).toBe(ExitCode.OK);
    expect(stderr()).toContain("warning: Your shell exports ANTHROPIC_API_KEY.");
  });

  it("refuses admin policy that blocks the helper, even with --force", async () => {
    const t = deps({ preflight: { blockers: ["/m sets forceLoginMethod."] } });
    expect(await runProxy(["setup", "claude-code", "--force"], config(), t.deps)).toBe(ExitCode.Failure);
    expect(t.started).toEqual([]);
    expect(stderr()).toContain("forceLoginMethod");
  });

  it("refuses when the gateway is off or in pass-through mode", async () => {
    const off = deps({ settings: { enabled: false, mode: "centralized" } });
    expect(await runProxy(["setup", "claude-code"], config(), off.deps)).toBe(ExitCode.Failure);
    expect(stderr()).toContain("proxy is off");
    const passthrough = deps({ settings: { enabled: true, mode: "passthrough" } });
    expect(await runProxy(["setup", "claude-code"], config(), passthrough.deps)).toBe(ExitCode.Failure);
    expect(stderr()).toContain("pass-through mode");
    expect(off.started).toEqual([]);
    expect(passthrough.started).toEqual([]);
  });

  it("needs a browser sign-in, and says so for an API key profile and a keyless one", async () => {
    const t = deps();
    const apiKey: ValetConfig = { defaultProfile: "work", profiles: { work: { url: URL_, apiKey: "vlt_personal" } } };
    expect(await runProxy(["setup", "claude-code"], apiKey, t.deps)).toBe(ExitCode.AuthFailure);
    expect(stderr()).toContain("not an API key");
    const keyless: ValetConfig = { defaultProfile: "work", profiles: { work: { url: URL_ } } };
    expect(await runProxy(["setup", "claude-code"], keyless, t.deps)).toBe(ExitCode.AuthFailure);
    expect(stderr()).toContain("real auth");
    expect(t.started).toEqual([]);
  });

  it("names the supported harnesses for an unknown one", async () => {
    expect(await runProxy(["setup", "codex"], config(), deps().deps)).toBe(ExitCode.Usage);
    expect(stderr()).toContain("Supported: claude-code");
  });
});

describe("valet proxy token", () => {
  it("prints exactly the stored key", async () => {
    expect(await runProxy(["token", "claude-code", "--instance", "work"], config({ proxyKeys: { "claude-code": KEY } }), deps().deps)).toBe(ExitCode.OK);
    expect(stdout()).toBe(`${KEY.key}\n`);
  });

  it("fails with the setup command when no key is stored", async () => {
    expect(await runProxy(["token", "claude-code"], config(), deps().deps)).toBe(ExitCode.AuthFailure);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("valet proxy setup claude-code");
  });
});

describe("valet proxy remove", () => {
  it("removes the settings setup wrote, revokes the key, and forgets it", async () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "opus", env: { ANTHROPIC_BASE_URL: `${URL_}/proxy/anthropic` }, apiKeyHelper: HELPER }));
    const t = deps();
    expect(await runProxy(["remove", "claude-code"], config({ proxyKeys: { "claude-code": KEY } }), t.deps)).toBe(ExitCode.OK);
    expect(settings()).toEqual({ model: "opus" });
    expect(t.deleted).toEqual(["key_1"]);
    expect(t.saved).toEqual([{ profile: "work", harness: "claude-code", key: undefined }]);
  });

  it("treats a key already revoked on the server as done", async () => {
    const t = deps({ deleteError: new ApiError(404, "gone") });
    expect(await runProxy(["remove", "claude-code"], config({ proxyKeys: { "claude-code": KEY } }), t.deps)).toBe(ExitCode.OK);
    expect(stderr()).not.toContain("warning");
    expect(t.saved).toHaveLength(1);
  });

  it("keeps the stored key on a revoke failure but still forgets it locally, with the manual fix", async () => {
    const t = deps({ deleteError: new ApiError(500, "boom") });
    expect(await runProxy(["remove", "claude-code"], config({ proxyKeys: { "claude-code": KEY } }), t.deps)).toBe(ExitCode.OK);
    expect(stderr()).toContain("Revoke it in Settings > API keys");
  });

  it("reports invalid settings JSON without failing the revoke", async () => {
    writeFileSync(join(dir, "settings.json"), "{ nope");
    const t = deps();
    expect(await runProxy(["remove", "claude-code"], config({ proxyKeys: { "claude-code": KEY } }), t.deps)).toBe(ExitCode.OK);
    expect(stderr()).toContain("could not update the Claude Code settings");
    expect(t.deleted).toEqual(["key_1"]);
  });
});
