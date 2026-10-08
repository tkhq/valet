import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { configPath, loadConfig, saveConfig, type ValetConfig } from "../config.js";
import { ApiError, AuthError, ExitCode, UnreachableError } from "../exit.js";
import { parseGlobalFlags } from "../output.js";
import { apiKeyFromFlags, profileNameForUrl, runLogin, type LoginClient, type LoginDeps } from "./login.js";
import type { MeResponse } from "../../wire/types.js";

const PENDING = { url: "https://valet.example.com", deviceCode: "dev", userCode: "BCDF-GHJK", verificationPath: "/cli/device", expiresAt: 600_000, interval: 5 };
const TOKENS = { access_token: "vltc_access", refresh_token: "vltr_refresh", access_expires_at: 2_000, refresh_expires_at: 3_000 };

const ME: MeResponse = {
  id: "u1",
  email: "me@x.com",
  name: "Me",
  avatarUrl: null,
  role: "admin",
  orgId: "o1",
  orgRole: "admin",
  defaultModel: null,
  defaultReasoning: null,
  newThreadBehavior: "keep_current",
};

let dir: string;
let prevDataDir: string | undefined;
let outSpy: MockInstance;
let errSpy: MockInstance;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "valet-login-"));
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

/** A deps bundle whose `me()` resolves, recording the key it was built with. */
function okDeps(overrides: Partial<LoginDeps> = {}): {
  deps: LoginDeps;
  built: Array<{ url: string; apiKey?: string }>;
  readCalls: number;
} {
  const built: Array<{ url: string; apiKey?: string }> = [];
  let readCalls = 0;
  const deps: LoginDeps = {
    makeClient: (opts): LoginClient => {
      built.push(opts);
      return { me: () => Promise.resolve(ME) };
    },
    readSecret: () => {
      readCalls += 1;
      return Promise.resolve("vlt_prompted");
    },
    authConfig: () => Promise.resolve({ stub: false }),
    startDevice: (url: string) => Promise.resolve({ ...PENDING, url }),
    pollDevice: () => Promise.resolve(TOKENS),
    openUrl: () => Promise.resolve(true),
    now: () => 1_000,
    revoke: () => Promise.resolve(),
    ...overrides,
  };
  return {
    deps,
    built,
    get readCalls() {
      return readCalls;
    },
  };
}

describe("apiKeyFromFlags", () => {
  it("returns the string for a non-empty --api-key", () => {
    expect(apiKeyFromFlags(parseGlobalFlags(["url", "--api-key", "vlt_x"]))).toBe("vlt_x");
  });
  it("returns keyless sentinel for an empty --api-key=", () => {
    expect(apiKeyFromFlags(parseGlobalFlags(["url", "--api-key="]))).toEqual({ keyless: true });
  });
  it("returns keyless sentinel for a bare --api-key", () => {
    expect(apiKeyFromFlags(parseGlobalFlags(["url", "--api-key"]))).toEqual({ keyless: true });
  });
  it("returns the prompt sentinel for --api-key -", () => {
    expect(apiKeyFromFlags(parseGlobalFlags(["url", "--api-key", "-"]))).toEqual({ prompt: true });
  });
  it("returns undefined when the flag is absent", () => {
    expect(apiKeyFromFlags(parseGlobalFlags(["url"]))).toBeUndefined();
  });
});

describe("profileNameForUrl", () => {
  it("uses the url host including port", () => {
    expect(profileNameForUrl("http://localhost:8788")).toBe("localhost:8788");
    expect(profileNameForUrl("https://valet.example.com")).toBe("valet.example.com");
  });
});

describe("runLogin", () => {
  it("rejects a missing url with Usage and writes no config", async () => {
    const { deps } = okDeps();
    const code = await runLogin(deps, parseGlobalFlags([]), {});
    expect(code).toBe(ExitCode.Usage);
    expect(existsSync(configPath())).toBe(false);
  });

  it("verifies then saves a keyed profile as the default (key never logged)", async () => {
    const { deps, built, readCalls } = okDeps();
    const flags = parseGlobalFlags(["https://valet.example.com", "--api-key", "vlt_secret"]);
    const code = await runLogin(deps, flags, {});
    expect(code).toBe(ExitCode.OK);
    // client built with the flag key; prompt NOT consulted.
    expect(built).toEqual([{ url: "https://valet.example.com", apiKey: "vlt_secret" }]);
    expect(readCalls).toBe(0);
    // persisted correctly.
    const saved = loadConfig();
    expect(saved.defaultProfile).toBe("valet.example.com");
    expect(saved.profiles?.["valet.example.com"]).toEqual({
      url: "https://valet.example.com",
      apiKey: "vlt_secret",
    });
    // the key never appears in any output.
    expect(stdout()).not.toContain("vlt_secret");
    expect(stderr()).not.toContain("vlt_secret");
  });

  it("honors --name for the profile name", async () => {
    const { deps } = okDeps();
    const flags = parseGlobalFlags(["https://valet.example.com", "--api-key", "k", "--name", "prod"]);
    expect(await runLogin(deps, flags, {})).toBe(ExitCode.OK);
    const saved = loadConfig();
    expect(saved.defaultProfile).toBe("prod");
    expect(saved.profiles?.prod?.url).toBe("https://valet.example.com");
  });

  it("does NOT save and returns AuthFailure on a bad key", async () => {
    const built: Array<{ url: string; apiKey?: string }> = [];
    const deps: LoginDeps = {
      makeClient: (opts): LoginClient => {
        built.push(opts);
        return { me: () => Promise.reject(new AuthError("authentication failed (401)")) };
      },
      readSecret: () => Promise.resolve(undefined),
      authConfig: () => Promise.resolve({ stub: false }),
      startDevice: (url: string) => Promise.resolve({ ...PENDING, url }),
      pollDevice: () => Promise.resolve(TOKENS),
      openUrl: () => Promise.resolve(true),
      now: () => 1_000,
      revoke: () => Promise.resolve(),
    };
    const flags = parseGlobalFlags(["https://valet.example.com", "--api-key", "bad"]);
    const code = await runLogin(deps, flags, {});
    expect(code).toBe(ExitCode.AuthFailure);
    expect(existsSync(configPath())).toBe(false);
    expect(stderr()).toContain("authentication failed");
    expect(stderr()).not.toContain("bad");
  });

  it("verifies a keyless stub login via an empty --api-key and saves no key", async () => {
    const { deps, built, readCalls } = okDeps();
    const flags = parseGlobalFlags(["http://localhost:8788", "--api-key="]);
    const code = await runLogin(deps, flags, {});
    expect(code).toBe(ExitCode.OK);
    expect(built).toEqual([{ url: "http://localhost:8788", apiKey: undefined }]);
    expect(readCalls).toBe(0);
    const saved = loadConfig();
    expect(saved.profiles?.["localhost:8788"]).toEqual({ url: "http://localhost:8788" });
    expect(saved.profiles?.["localhost:8788"]).not.toHaveProperty("apiKey");
  });

  it("signs in with a device code when no --api-key flag is present, and saves a CLI token, not a key", async () => {
    const opened: string[] = [];
    const bundle = okDeps({ openUrl: (u) => {
      opened.push(u);
      return Promise.resolve(true);
    } });
    const flags = parseGlobalFlags(["https://valet.example.com/"]);
    expect(await runLogin(bundle.deps, flags, {})).toBe(ExitCode.OK);
    expect(opened).toEqual(["https://valet.example.com/cli/device"]);
    expect(stderr()).toContain("BCDF-GHJK");
    expect(bundle.readCalls).toBe(0);
    expect(bundle.built).toEqual([{ url: "https://valet.example.com/", apiKey: "vltc_access" }]);
    const saved = loadConfig();
    expect(saved.profiles?.["valet.example.com"]).toEqual({
      url: "https://valet.example.com/",
      cli: { accessToken: "vltc_access", refreshToken: "vltr_refresh", accessExpiresAt: 2_000, refreshExpiresAt: 3_000 },
    });
    // The finished sign-in no longer waits.
    expect(saved.pendingLogins).toBeUndefined();
    expect(stdout()).not.toContain("vltc_access");
  });

  it("--no-wait prints the code, saves the sign-in, and a later login resumes it", async () => {
    const polls: string[] = [];
    const starts = vi.fn((url: string) => Promise.resolve({ ...PENDING, url }));
    const { deps } = okDeps({ startDevice: starts, pollDevice: (p) => {
      polls.push(p.deviceCode);
      return Promise.resolve(TOKENS);
    } });
    expect(await runLogin(deps, parseGlobalFlags(["https://valet.example.com", "--name", "v", "--no-wait"]), {})).toBe(ExitCode.OK);
    expect(stderr()).toContain("BCDF-GHJK");
    expect(stderr()).toContain("valet login https://valet.example.com --name v");
    expect(polls).toEqual([]);
    const afterStart = loadConfig();
    expect(afterStart.pendingLogins?.v?.deviceCode).toBe("dev");
    expect(afterStart.profiles).toBeUndefined();

    expect(await runLogin(deps, parseGlobalFlags(["https://valet.example.com", "--name", "v"]), afterStart)).toBe(ExitCode.OK);
    expect(starts).toHaveBeenCalledTimes(1);
    expect(polls).toEqual(["dev"]);
    expect(stderr()).toContain("Resuming the sign-in");
    const done = loadConfig();
    expect(done.profiles?.v?.cli?.accessToken).toBe("vltc_access");
    expect(done.pendingLogins).toBeUndefined();
  });

  it("starts a new sign-in when the saved one expired, and does not open a browser with --no-browser", async () => {
    const starts = vi.fn((url: string) => Promise.resolve({ ...PENDING, url, deviceCode: "new" }));
    const open = vi.fn(() => Promise.resolve(true));
    const { deps } = okDeps({ startDevice: starts, openUrl: open, now: () => 700_000 });
    const config: ValetConfig = { pendingLogins: { v: { ...PENDING, expiresAt: 600_000 } } };
    expect(await runLogin(deps, parseGlobalFlags(["https://valet.example.com", "--name", "v", "--no-browser"]), config)).toBe(ExitCode.OK);
    expect(starts).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps a refresh another command saved while this login waited", async () => {
    const other = { url: "https://other.example.com", cli: { accessToken: "vltc_a", refreshToken: "vltr_a_old", accessExpiresAt: 1, refreshExpiresAt: 1 } };
    const startup: ValetConfig = { profiles: { a: other } };
    saveConfig(startup);
    const { deps } = okDeps({ pollDevice: async () => {
      // Profile a refreshes in another command while this login polls.
      saveConfig({ profiles: { a: { ...other, cli: { ...other.cli, refreshToken: "vltr_a_new" } } } });
      return TOKENS;
    } });
    expect(await runLogin(deps, parseGlobalFlags(["https://valet.example.com", "--name", "b"]), startup)).toBe(ExitCode.OK);
    const saved = loadConfig();
    expect(saved.profiles?.a?.cli?.refreshToken).toBe("vltr_a_new");
    expect(saved.profiles?.b?.cli?.accessToken).toBe("vltc_access");
  });

  it("signs out the device sign-in a new login replaces", async () => {
    const revoked: string[] = [];
    const { deps } = okDeps({ revoke: (_url, token) => {
      revoked.push(token);
      return Promise.resolve();
    } });
    const existing: ValetConfig = { profiles: { prod: { url: "https://valet.example.com", cli: { accessToken: "a", refreshToken: "vltr_old", accessExpiresAt: 1, refreshExpiresAt: 1 } } } };
    expect(await runLogin(deps, parseGlobalFlags(["https://valet.example.com", "--name", "prod"]), existing)).toBe(ExitCode.OK);
    expect(revoked).toEqual(["vltr_old"]);
  });

  it("saves a keyless profile for a stub-auth instance without a device sign-in", async () => {
    const starts = vi.fn((url: string) => Promise.resolve({ ...PENDING, url }));
    const { deps, built } = okDeps({ authConfig: () => Promise.resolve({ stub: true }), startDevice: starts });
    expect(await runLogin(deps, parseGlobalFlags(["http://localhost:8788"]), {})).toBe(ExitCode.OK);
    expect(starts).not.toHaveBeenCalled();
    expect(built).toEqual([{ url: "http://localhost:8788", apiKey: undefined }]);
    expect(loadConfig().profiles?.["localhost:8788"]).toEqual({ url: "http://localhost:8788" });
  });

  it("returns AuthFailure, saves no profile, and forgets the sign-in when it is denied", async () => {
    const { deps } = okDeps({ pollDevice: () => Promise.reject(new AuthError("the sign-in was denied in the browser.")) });
    expect(await runLogin(deps, parseGlobalFlags(["https://valet.example.com"]), {})).toBe(ExitCode.AuthFailure);
    const saved = loadConfig();
    expect(saved.profiles).toBeUndefined();
    expect(saved.pendingLogins).toBeUndefined();
    expect(stderr()).toContain("denied in the browser");
  });

  it("reads the key with readSecret for --api-key -", async () => {
    // NB: access readCalls via the bundle AFTER the call — destructuring the
    // getter would snapshot it at 0 before runLogin runs.
    const bundle = okDeps();
    const flags = parseGlobalFlags(["http://localhost:8788", "--api-key", "-"]);
    expect(await runLogin(bundle.deps, flags, {})).toBe(ExitCode.OK);
    expect(bundle.readCalls).toBe(1);
    expect(bundle.built).toEqual([{ url: "http://localhost:8788", apiKey: "vlt_prompted" }]);
    expect(loadConfig().profiles?.["localhost:8788"]?.apiKey).toBe("vlt_prompted");
  });

  it("treats an empty readSecret result as keyless", async () => {
    const { deps } = okDeps({ readSecret: () => Promise.resolve(undefined) });
    const flags = parseGlobalFlags(["http://localhost:8788", "--api-key", "-"]);
    expect(await runLogin(deps, flags, {})).toBe(ExitCode.OK);
    expect(loadConfig().profiles?.["localhost:8788"]).toEqual({ url: "http://localhost:8788" });
  });

  it("preserves existing profiles when adding a new one", async () => {
    const existing: ValetConfig = {
      profiles: { old: { url: "http://old", apiKey: "k_old" } },
      defaultProfile: "old",
    };
    saveConfig(existing); // The CLI passes the config it loaded from disk.
    const { deps } = okDeps();
    const flags = parseGlobalFlags(["http://localhost:8788", "--api-key", "k_new"]);
    expect(await runLogin(deps, flags, existing)).toBe(ExitCode.OK);
    const saved = loadConfig();
    expect(saved.profiles?.old).toEqual({ url: "http://old", apiKey: "k_old" });
    expect(saved.defaultProfile).toBe("localhost:8788");
  });

  it("propagates a non-auth error (unreachable) without saving", async () => {
    const deps: LoginDeps = {
      makeClient: (): LoginClient => ({
        me: () => Promise.reject(new UnreachableError("could not reach")),
      }),
      readSecret: () => Promise.resolve(undefined),
      authConfig: () => Promise.resolve({ stub: false }),
      startDevice: (url: string) => Promise.resolve({ ...PENDING, url }),
      pollDevice: () => Promise.resolve(TOKENS),
      openUrl: () => Promise.resolve(true),
      now: () => 1_000,
      revoke: () => Promise.resolve(),
    };
    const flags = parseGlobalFlags(["http://localhost:8788", "--api-key", "k"]);
    await expect(runLogin(deps, flags, {})).rejects.toBeInstanceOf(UnreachableError);
    expect(existsSync(configPath())).toBe(false);
  });

  it("propagates a generic ApiError without saving", async () => {
    const deps: LoginDeps = {
      makeClient: (): LoginClient => ({
        me: () => Promise.reject(new ApiError(500, "boom")),
      }),
      readSecret: () => Promise.resolve(undefined),
      authConfig: () => Promise.resolve({ stub: false }),
      startDevice: (url: string) => Promise.resolve({ ...PENDING, url }),
      pollDevice: () => Promise.resolve(TOKENS),
      openUrl: () => Promise.resolve(true),
      now: () => 1_000,
      revoke: () => Promise.resolve(),
    };
    const flags = parseGlobalFlags(["http://localhost:8788", "--api-key", "k"]);
    await expect(runLogin(deps, flags, {})).rejects.toBeInstanceOf(ApiError);
    expect(existsSync(configPath())).toBe(false);
  });
});
