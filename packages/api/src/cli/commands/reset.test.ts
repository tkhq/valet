import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExitCode } from "../exit.js";
import { pgDataDirLockPath, resolvePgDataDir, type DataDirLock } from "../../providers/data-dir-lock.js";
import { runReset, type ResetDeps } from "./reset.js";

let dir: string;

/** Seed a data dir with config.json, a pg/ dir, and (optionally) a lock. */
function seed(lock?: DataDirLock): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { a: { url: "http://a" } } }));
  mkdirSync(join(dir, "pg"), { recursive: true });
  writeFileSync(join(dir, "pg", "data.bin"), "durable");
  writeFileSync(join(dir, "blobs.db"), "blob");
  if (lock) writeFileSync(pgDataDirLockPath(resolvePgDataDir(dir, {})), JSON.stringify(lock));
}

function deps(over: Partial<ResetDeps> = {}): ResetDeps {
  return {
    confirm: () => Promise.resolve(true),
    isAlive: () => false,
    isTTY: true,
    ...over,
  };
}

// `startedAt` is NOW on purpose: `isLiveLock` reads a lock written before the
// current boot of the machine as stale, whatever its pid says.
const LOCK: DataDirLock = { pid: 4242, port: 8788, startedAt: new Date().toISOString() };

/** Where `runReset` looks for the one-owner lock, for this test's data dir. */
function lockFile(): string {
  return pgDataDirLockPath(resolvePgDataDir(dir, {}));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "valet-reset-"));
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("runReset live-lock guard", () => {
  it("refuses when a LIVE lock owns the dir and wipes nothing", async () => {
    seed(LOCK);
    const code = await runReset(deps({ isAlive: (pid) => pid === LOCK.pid }), { yes: true, dataDir: dir });
    expect(code).toBe(ExitCode.Usage);
    // untouched.
    expect(existsSync(join(dir, "pg", "data.bin"))).toBe(true);
    expect(existsSync(lockFile())).toBe(true);
    expect(existsSync(join(dir, "config.json"))).toBe(true);
  });

  it("wipes when the lock is STALE (dead pid)", async () => {
    seed(LOCK);
    const code = await runReset(deps({ isAlive: () => false }), { yes: true, dataDir: dir });
    expect(code).toBe(ExitCode.OK);
    expect(existsSync(join(dir, "pg"))).toBe(false);
    expect(existsSync(lockFile())).toBe(false);
  });

  it("wipes when the lock is malformed", async () => {
    seed();
    writeFileSync(lockFile(), "not json");
    const code = await runReset(deps({ isAlive: () => true }), { yes: true, dataDir: dir });
    expect(code).toBe(ExitCode.OK);
    expect(existsSync(join(dir, "pg"))).toBe(false);
  });
});

describe("runReset wipe scope", () => {
  it("removes runtime/DB state but PRESERVES config.json", async () => {
    seed();
    const code = await runReset(deps(), { yes: true, dataDir: dir });
    expect(code).toBe(ExitCode.OK);
    expect(existsSync(join(dir, "pg"))).toBe(false);
    expect(existsSync(join(dir, "blobs.db"))).toBe(false);
    // config.json (and its profiles) survive intact.
    expect(existsSync(join(dir, "config.json"))).toBe(true);
    const cfg: unknown = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect(cfg).toEqual({ profiles: { a: { url: "http://a" } } });
  });

  it("reports nothing to reset for a non-existent data dir", async () => {
    const missing = join(dir, "does-not-exist");
    const code = await runReset(deps(), { yes: true, dataDir: missing });
    expect(code).toBe(ExitCode.OK);
  });

  it("reports nothing to reset when only config.json is present", async () => {
    writeFileSync(join(dir, "config.json"), "{}");
    const code = await runReset(deps(), { yes: true, dataDir: dir });
    expect(code).toBe(ExitCode.OK);
    expect(existsSync(join(dir, "config.json"))).toBe(true);
  });
});

describe("runReset confirmation", () => {
  it("--yes bypasses the prompt (confirm never called)", async () => {
    seed();
    const confirm = vi.fn(() => Promise.resolve(false));
    const code = await runReset(deps({ confirm }), { yes: true, dataDir: dir });
    expect(code).toBe(ExitCode.OK);
    expect(confirm).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "pg"))).toBe(false);
  });

  it("proceeds when an interactive confirm returns true", async () => {
    seed();
    const confirm = vi.fn(() => Promise.resolve(true));
    const code = await runReset(deps({ confirm, isTTY: true }), { yes: false, dataDir: dir });
    expect(code).toBe(ExitCode.OK);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, "pg"))).toBe(false);
  });

  it("aborts (OK, no wipe) when an interactive confirm returns false", async () => {
    seed();
    const code = await runReset(deps({ confirm: () => Promise.resolve(false), isTTY: true }), {
      yes: false,
      dataDir: dir,
    });
    expect(code).toBe(ExitCode.OK);
    expect(existsSync(join(dir, "pg", "data.bin"))).toBe(true);
  });

  it("refuses a non-TTY invocation without --yes and wipes nothing", async () => {
    seed();
    const confirm = vi.fn(() => Promise.resolve(true));
    const code = await runReset(deps({ confirm, isTTY: false }), { yes: false, dataDir: dir });
    expect(code).toBe(ExitCode.Usage);
    expect(confirm).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "pg", "data.bin"))).toBe(true);
  });
});
