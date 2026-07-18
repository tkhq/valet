import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ValetConfig } from "../config.js";
import {
  claimServeLock,
  isLiveLock,
  parseLock,
  redactDbUrl,
  resolveServeSettings,
  upsertLocalProfile,
  type ServeLock,
} from "./serve.js";

describe("serve/resolveServeSettings port", () => {
  it("defaults the serve port to 8788", () => {
    const s = resolveServeSettings({ flags: {}, env: {}, config: {}, dockerReachable: false });
    expect(s.port).toBe(8788);
  });

  it("flag beats env beats config for the port", () => {
    expect(
      resolveServeSettings({ flags: { port: "1" }, env: { PORT: "2" }, config: { serve: { port: 3 } }, dockerReachable: false }).port,
    ).toBe(1);
    expect(
      resolveServeSettings({ flags: {}, env: { PORT: "2" }, config: { serve: { port: 3 } }, dockerReachable: false }).port,
    ).toBe(2);
    expect(
      resolveServeSettings({ flags: {}, env: {}, config: { serve: { port: 3 } }, dockerReachable: false }).port,
    ).toBe(3);
  });

  it("coerces a hand-edited string config port", () => {
    // A hand-edited config.json could carry serve.port as a string. JSON.parse
    // returns `any`, so assigning it to a typed const needs no cast.
    const config: ValetConfig = JSON.parse('{"serve":{"port":"9001"}}');
    expect(resolveServeSettings({ flags: {}, env: {}, config, dockerReachable: false }).port).toBe(9001);
  });

  it("rejects a non-numeric port with a clear error", () => {
    expect(() =>
      resolveServeSettings({ flags: { port: "not-a-port" }, env: {}, config: {}, dockerReachable: false }),
    ).toThrow(/port/i);
  });
});

describe("serve/resolveServeSettings sandbox auto-detect", () => {
  it("auto-detects local when docker is unreachable and no explicit choice", () => {
    const s = resolveServeSettings({ flags: {}, env: {}, config: {}, dockerReachable: false });
    expect(s.backend).toBe("local");
    expect(s.backendAutoDetected).toBe(true);
  });

  it("auto-detects docker when the daemon is reachable and no explicit choice", () => {
    const s = resolveServeSettings({ flags: {}, env: {}, config: {}, dockerReachable: true });
    expect(s.backend).toBe("docker");
    expect(s.backendAutoDetected).toBe(true);
  });

  it("an explicit --sandbox flag wins even when docker is unreachable", () => {
    const s = resolveServeSettings({ flags: { sandbox: "docker" }, env: {}, config: {}, dockerReachable: false });
    expect(s.backend).toBe("docker");
    expect(s.backendAutoDetected).toBe(false);
  });

  it("an explicit env backend wins over auto-detect", () => {
    const s = resolveServeSettings({ flags: {}, env: { VALET_SANDBOX_BACKEND: "kubernetes" }, config: {}, dockerReachable: true });
    expect(s.backend).toBe("kubernetes");
    expect(s.backendAutoDetected).toBe(false);
  });

  it("an explicit config backend wins over auto-detect", () => {
    const s = resolveServeSettings({ flags: {}, env: {}, config: { serve: { sandbox: "local" } }, dockerReachable: true });
    expect(s.backend).toBe("local");
    expect(s.backendAutoDetected).toBe(false);
  });

  it("rejects an invalid --sandbox flag", () => {
    expect(() =>
      resolveServeSettings({ flags: { sandbox: "bogus" }, env: {}, config: {}, dockerReachable: true }),
    ).toThrow(/sandbox/i);
  });
});

describe("serve/resolveServeSettings auth stub", () => {
  it("defaults to auth stub when no BETTER_AUTH_SECRET", () => {
    expect(resolveServeSettings({ flags: {}, env: {}, config: {}, dockerReachable: false }).authStub).toBe(true);
  });

  it("leaves real auth when BETTER_AUTH_SECRET is set", () => {
    expect(
      resolveServeSettings({ flags: {}, env: { BETTER_AUTH_SECRET: "s" }, config: {}, dockerReachable: false }).authStub,
    ).toBe(false);
  });
});

describe("serve/resolveServeSettings dataDir", () => {
  it("flag beats env for the data dir", () => {
    expect(
      resolveServeSettings({ flags: { dataDir: "/a" }, env: { VALET_DATA_DIR: "/b" }, config: {}, dockerReachable: false }).dataDir,
    ).toBe("/a");
    expect(
      resolveServeSettings({ flags: {}, env: { VALET_DATA_DIR: "/b" }, config: {}, dockerReachable: false }).dataDir,
    ).toBe("/b");
  });
});

describe("serve/resolveServeSettings databaseUrl", () => {
  const flag = "postgres://f/db";
  const envUrl = "postgres://e/db";
  const cfgUrl = "postgres://c/db";

  it("flag beats env beats config", () => {
    expect(
      resolveServeSettings({
        flags: { databaseUrl: flag },
        env: { DATABASE_URL: envUrl },
        config: { serve: { databaseUrl: cfgUrl } },
        dockerReachable: false,
      }).databaseUrl,
    ).toBe(flag);
    expect(
      resolveServeSettings({
        flags: {},
        env: { DATABASE_URL: envUrl },
        config: { serve: { databaseUrl: cfgUrl } },
        dockerReachable: false,
      }).databaseUrl,
    ).toBe(envUrl);
    expect(
      resolveServeSettings({ flags: {}, env: {}, config: { serve: { databaseUrl: cfgUrl } }, dockerReachable: false })
        .databaseUrl,
    ).toBe(cfgUrl);
  });

  it("is undefined (embedded pglite) when no source sets it", () => {
    expect(resolveServeSettings({ flags: {}, env: {}, config: {}, dockerReachable: false }).databaseUrl).toBeUndefined();
  });

  it("treats an empty env DATABASE_URL as unset", () => {
    expect(
      resolveServeSettings({ flags: {}, env: { DATABASE_URL: "" }, config: { serve: { databaseUrl: cfgUrl } }, dockerReachable: false })
        .databaseUrl,
    ).toBe(cfgUrl);
  });
});

describe("serve/redactDbUrl", () => {
  it("masks the password", () => {
    expect(redactDbUrl("postgres://user:secret@host:5432/db")).toBe("postgres://user:***@host:5432/db");
  });

  it("leaves a passwordless url untouched", () => {
    expect(redactDbUrl("postgres://host:5432/db")).toBe("postgres://host:5432/db");
  });
});

describe("serve/upsertLocalProfile", () => {
  it("adds a local profile and sets it as default when none exists", () => {
    const next = upsertLocalProfile({}, 8788);
    expect(next.profiles?.local).toEqual({ url: "http://localhost:8788" });
    expect(next.defaultProfile).toBe("local");
  });

  it("refreshes the local profile url on a new port", () => {
    const next = upsertLocalProfile({ profiles: { local: { url: "http://localhost:1" } }, defaultProfile: "local" }, 8790);
    expect(next.profiles?.local).toEqual({ url: "http://localhost:8790" });
    expect(next.defaultProfile).toBe("local");
  });

  it("does not clobber an existing non-local defaultProfile", () => {
    const config: ValetConfig = {
      profiles: { prod: { url: "https://prod", apiKey: "sk" } },
      defaultProfile: "prod",
    };
    const next = upsertLocalProfile(config, 8788);
    expect(next.defaultProfile).toBe("prod");
    expect(next.profiles?.local).toEqual({ url: "http://localhost:8788" });
    expect(next.profiles?.prod).toEqual({ url: "https://prod", apiKey: "sk" });
  });

  it("does not mutate the input config", () => {
    const config: ValetConfig = {};
    upsertLocalProfile(config, 8788);
    expect(config.profiles).toBeUndefined();
  });
});

describe("serve/parseLock", () => {
  it("parses a well-formed lock file", () => {
    const raw = JSON.stringify({ pid: 123, port: 8788, startedAt: "2026-07-17T00:00:00.000Z" });
    expect(parseLock(raw)).toEqual({ pid: 123, port: 8788, startedAt: "2026-07-17T00:00:00.000Z" });
  });

  it("returns undefined for malformed JSON", () => {
    expect(parseLock("{not json")).toBeUndefined();
  });

  it("returns undefined when required fields are missing/wrong type", () => {
    expect(parseLock(JSON.stringify({ pid: "x", port: 1, startedAt: "t" }))).toBeUndefined();
    expect(parseLock(JSON.stringify({ port: 1, startedAt: "t" }))).toBeUndefined();
  });
});

describe("serve/isLiveLock", () => {
  const lock: ServeLock = { pid: 4242, port: 8788, startedAt: "t" };

  it("is live when the pid is alive", () => {
    expect(isLiveLock(lock, () => true)).toBe(true);
  });

  it("is stale when the pid is dead", () => {
    expect(isLiveLock(lock, () => false)).toBe(false);
  });

  it("treats our own pid as live", () => {
    const self: ServeLock = { pid: process.pid, port: 8788, startedAt: "t" };
    expect(isLiveLock(self)).toBe(true);
  });
});

describe("serve/claimServeLock", () => {
  let dir: string;
  let lockPath: string;
  const lock: ServeLock = { pid: 1234, port: 8788, startedAt: "t" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "valet-lock-"));
    lockPath = join(dir, "serve.lock");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("claims when no lock exists and writes our pid", () => {
    expect(claimServeLock(lockPath, lock)).toBe("claimed");
    expect(parseLock(readFileSync(lockPath, "utf8"))).toEqual(lock);
  });

  it("refuses when a live lock already exists", () => {
    writeFileSync(lockPath, `${JSON.stringify({ pid: 4242, port: 1, startedAt: "t" })}\n`);
    expect(claimServeLock(lockPath, lock, () => true)).toBe("busy");
    // The existing lock is untouched.
    expect(parseLock(readFileSync(lockPath, "utf8"))?.pid).toBe(4242);
  });

  it("reclaims a stale (dead-pid) lock", () => {
    writeFileSync(lockPath, `${JSON.stringify({ pid: 4242, port: 1, startedAt: "t" })}\n`);
    expect(claimServeLock(lockPath, lock, () => false)).toBe("claimed");
    expect(parseLock(readFileSync(lockPath, "utf8"))).toEqual(lock);
  });

  it("reclaims a malformed lock", () => {
    writeFileSync(lockPath, "{not json");
    expect(claimServeLock(lockPath, lock)).toBe("claimed");
    expect(parseLock(readFileSync(lockPath, "utf8"))).toEqual(lock);
  });
});
