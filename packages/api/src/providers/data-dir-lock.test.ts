/**
 * The one-owner lock, in both directions. A lock that only refuses is as
 * damaging as no lock at all:
 *
 *   - A LIVE second owner is refused, with a message that names the process
 *     to stop. That is the corruption this exists to prevent.
 *   - A STALE lock, left by a process stopped with SIGKILL, does NOT block
 *     the next boot. Without this half, the fix trades a damaged database
 *     for a machine that cannot start.
 *   - Two boots that RACE after a hard kill produce exactly one owner. The
 *     reclaim is the dangerous moment: a lock that deletes the dead file and
 *     then recreates it can hand the directory to both.
 *
 * The last three are proved with real child processes and a real SIGKILL.
 * Nothing but a killed process leaves the exact on-disk state the boot path
 * has to survive.
 *
 * Every directory here is created by this file and removed by it. The real
 * `~/.valet/pg` is never touched.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireDataDirLock,
  claimDataDirLock,
  DataDirLockError,
  isLiveLock,
  machineBootTimeMs,
  parseLock,
  pgDataDirLockPath,
  readLock,
  releaseDataDirLock,
  resolvePgDataDir,
  type DataDirLock,
  type HeldDataDirLock,
} from "./data-dir-lock.js";

const HOLDER = fileURLToPath(new URL("../../test/data-dir-lock-holder.ts", import.meta.url));

const dirs: string[] = [];
const held: HeldDataDirLock[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "valet-lock-test-"));
  dirs.push(dir);
  return dir;
}

/** A data directory path that does not exist yet, the way a first boot sees
 * it. `acquireDataDirLock` must create the parent it needs. */
function freshPgDataDir(): string {
  return join(freshDir(), "pg");
}

/** A timestamp that always reads as "written during this boot". */
function now(): string {
  return new Date().toISOString();
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const lock of held.splice(0)) lock.release();
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Where the lock lives ───────────────────────────────────────────────

describe("data-dir-lock/paths", () => {
  it("keys the lock to the data directory, not to the temp directory", () => {
    // The lock's namespace must be the resource. Two processes with
    // different $TMPDIR values that share one data directory have to reach
    // the same file, or they both boot.
    expect(pgDataDirLockPath("/srv/valet/pg")).toBe("/srv/valet/pg.lock");
    expect(pgDataDirLockPath("/srv/valet/pg/")).toBe("/srv/valet/pg.lock");
  });

  it("keeps the lock file OUTSIDE the data directory", () => {
    // `initdb` refuses a directory that already holds files.
    expect(pgDataDirLockPath("/srv/valet/pg").startsWith("/srv/valet/pg/")).toBe(false);
  });

  it("resolves the PGlite directory from the data dir, with an env override", () => {
    expect(resolvePgDataDir("/srv/valet", {})).toBe(join("/srv/valet", "pg"));
    expect(resolvePgDataDir("/srv/valet", { VALET_PG_DATA_DIR: "/other/pg" })).toBe("/other/pg");
    // An empty string is a common shell "unset" attempt, and must not point
    // the lock at a relative path.
    expect(resolvePgDataDir("/srv/valet", { VALET_PG_DATA_DIR: "" })).toBe(join("/srv/valet", "pg"));
  });
});

// ── The lock file body ─────────────────────────────────────────────────

describe("data-dir-lock/parseLock", () => {
  it("parses a well-formed lock file", () => {
    const raw = JSON.stringify({ pid: 123, port: 8788, startedAt: "2026-07-17T00:00:00.000Z" });
    expect(parseLock(raw)).toEqual({ pid: 123, port: 8788, startedAt: "2026-07-17T00:00:00.000Z" });
  });

  it("accepts a lock with no port (a boot that does not know one)", () => {
    expect(parseLock(JSON.stringify({ pid: 123, startedAt: "t" }))).toEqual({ pid: 123, startedAt: "t" });
  });

  it("returns undefined for malformed JSON", () => {
    expect(parseLock("{not json")).toBeUndefined();
  });

  it("returns undefined when required fields are missing or the wrong type", () => {
    expect(parseLock(JSON.stringify({ pid: "x", startedAt: "t" }))).toBeUndefined();
    expect(parseLock(JSON.stringify({ startedAt: "t" }))).toBeUndefined();
    expect(parseLock(JSON.stringify({ pid: 1 }))).toBeUndefined();
  });

  it("rejects non-positive/non-integer pids (kill(0/-n, 0) probes a process GROUP)", () => {
    expect(parseLock(JSON.stringify({ pid: 0, startedAt: "t" }))).toBeUndefined();
    expect(parseLock(JSON.stringify({ pid: -42, startedAt: "t" }))).toBeUndefined();
    expect(parseLock(JSON.stringify({ pid: 1.5, startedAt: "t" }))).toBeUndefined();
  });
});

describe("data-dir-lock/isLiveLock", () => {
  const lock: DataDirLock = { pid: 4242, port: 8788, startedAt: "t" };

  it("is live when the pid is alive", () => {
    expect(isLiveLock(lock, () => true)).toBe(true);
  });

  it("is stale when the pid is dead", () => {
    expect(isLiveLock(lock, () => false)).toBe(false);
  });

  it("treats our own pid as live", () => {
    expect(isLiveLock({ pid: process.pid, startedAt: now() })).toBe(true);
  });

  it("is stale when the lock predates this boot of the machine, whatever the pid says", () => {
    // The everyday pid-reuse case: the machine restarted, the lock file
    // outlived it, and some unrelated process now carries that pid. Without
    // this rule the data dir is locked out until a person runs `rm`.
    const boot = Date.parse("2026-08-18T12:00:00.000Z");
    const before: DataDirLock = { pid: 4242, startedAt: "2026-08-18T09:00:00.000Z" };
    expect(isLiveLock(before, () => true, boot)).toBe(false);
    const after: DataDirLock = { pid: 4242, startedAt: "2026-08-18T12:30:00.000Z" };
    expect(isLiveLock(after, () => true, boot)).toBe(true);
  });

  it("keeps a lock written just before the boot reading, for clock skew", () => {
    const boot = Date.now();
    const justBefore: DataDirLock = { pid: 4242, startedAt: new Date(boot - 5_000).toISOString() };
    expect(isLiveLock(justBefore, () => true, boot)).toBe(true);
  });

  it("falls back to the pid probe when startedAt cannot be parsed", () => {
    expect(isLiveLock({ pid: 4242, startedAt: "t" }, () => true, Date.now())).toBe(true);
  });

  it("reads the machine boot time as a moment in the past", () => {
    const boot = machineBootTimeMs();
    expect(boot).toBeLessThanOrEqual(Date.now());
  });
});

// ── The claim ──────────────────────────────────────────────────────────

describe("data-dir-lock/claimDataDirLock", () => {
  function lockPath(): string {
    return join(freshDir(), "pg.lock");
  }
  const mine: DataDirLock = { pid: 1234, port: 8788, startedAt: "t" };

  it("claims when no lock exists and writes our pid", () => {
    const path = lockPath();
    expect(claimDataDirLock(path, mine)).toBe("claimed");
    expect(parseLock(readFileSync(path, "utf8"))).toEqual(mine);
  });

  it("refuses when a live lock already exists, and leaves it untouched", () => {
    const path = lockPath();
    writeFileSync(path, `${JSON.stringify({ pid: 4242, port: 1, startedAt: "t" })}\n`);
    expect(claimDataDirLock(path, mine, () => true)).toBe("busy");
    expect(parseLock(readFileSync(path, "utf8"))?.pid).toBe(4242);
  });

  it("reclaims a stale (dead-pid) lock", () => {
    const path = lockPath();
    writeFileSync(path, `${JSON.stringify({ pid: 4242, port: 1, startedAt: "t" })}\n`);
    expect(claimDataDirLock(path, mine, () => false)).toBe("claimed");
    expect(parseLock(readFileSync(path, "utf8"))).toEqual(mine);
  });

  it("reclaims a malformed lock", () => {
    const path = lockPath();
    writeFileSync(path, "{not json");
    expect(claimDataDirLock(path, mine)).toBe("claimed");
    expect(parseLock(readFileSync(path, "utf8"))).toEqual(mine);
  });

  it("reports a lock this process already owns as held, and does not rewrite it", () => {
    const path = lockPath();
    const ours: DataDirLock = { pid: process.pid, port: 1, startedAt: now() };
    expect(claimDataDirLock(path, ours)).toBe("claimed");
    expect(claimDataDirLock(path, { pid: process.pid, port: 2, startedAt: now() })).toBe("held");
    expect(parseLock(readFileSync(path, "utf8"))?.port).toBe(1);
  });
});

describe("data-dir-lock/releaseDataDirLock", () => {
  it("removes a lock this process owns", () => {
    const path = join(freshDir(), "pg.lock");
    writeFileSync(path, `${JSON.stringify({ pid: process.pid, startedAt: now() })}\n`);
    releaseDataDirLock(path);
    expect(existsSync(path)).toBe(false);
  });

  it("keeps a lock another process owns", () => {
    // Deleting it would hand a third boot a directory that is in use.
    const path = join(freshDir(), "pg.lock");
    writeFileSync(path, `${JSON.stringify({ pid: 4242, startedAt: now() })}\n`);
    releaseDataDirLock(path);
    expect(existsSync(path)).toBe(true);
  });
});

// ── The boot-facing call ───────────────────────────────────────────────

describe("data-dir-lock/acquireDataDirLock", () => {
  it("creates the parent directory a first boot has not made yet", () => {
    const pgDataDir = freshPgDataDir();
    const lock = acquireDataDirLock({ pgDataDir });
    held.push(lock);
    expect(existsSync(lock.path)).toBe(true);
  });

  it("refuses a live owner and names the process to stop", () => {
    const pgDataDir = freshPgDataDir();
    mkdirSync(pgDataDir, { recursive: true });
    writeFileSync(pgDataDirLockPath(pgDataDir), `${JSON.stringify({ pid: 4242, port: 8788, startedAt: now() })}\n`);

    let thrown: unknown;
    try {
      acquireDataDirLock({ pgDataDir, isAlive: () => true });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DataDirLockError);
    const err = thrown instanceof DataDirLockError ? thrown : undefined;
    expect(err?.code).toBe("busy");
    // Every corrective action a reader needs, named.
    expect(err?.message).toContain("Process 4242");
    expect(err?.message).toContain("on port 8788");
    expect(err?.message).toContain("ps -p 4242");
    expect(err?.message).toContain("kill 4242");
    expect(err?.message).toContain(`rm ${pgDataDirLockPath(pgDataDir)}`);
  });

  it("reclaims a stale lock rather than locking the boot out", () => {
    const pgDataDir = freshPgDataDir();
    mkdirSync(pgDataDir, { recursive: true });
    writeFileSync(pgDataDirLockPath(pgDataDir), `${JSON.stringify({ pid: 4242, startedAt: now() })}\n`);
    const lock = acquireDataDirLock({ pgDataDir, isAlive: () => false });
    held.push(lock);
    expect(readLock(lock.path)?.pid).toBe(process.pid);
  });

  it("releases only once, and only what it owns", () => {
    const pgDataDir = freshPgDataDir();
    const lock = acquireDataDirLock({ pgDataDir });
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
    writeFileSync(lock.path, `${JSON.stringify({ pid: 4242, startedAt: now() })}\n`);
    lock.release();
    expect(existsSync(lock.path)).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("names the fix when the lock file cannot be written", () => {
    const parent = freshDir();
    const pgDataDir = join(parent, "nested", "pg");
    mkdirSync(join(parent, "nested"), { recursive: true });
    chmodSync(join(parent, "nested"), 0o500);

    let thrown: unknown;
    try {
      acquireDataDirLock({ pgDataDir });
    } catch (err) {
      thrown = err;
    } finally {
      chmodSync(join(parent, "nested"), 0o700);
    }
    expect(thrown).toBeInstanceOf(DataDirLockError);
    const err = thrown instanceof DataDirLockError ? thrown : undefined;
    // Not a raw errno stack: the message names the path and what to run.
    expect(err?.code).toBe("unwritable");
    expect(err?.message).toContain(pgDataDirLockPath(pgDataDir));
    expect(err?.message).toContain("ls -ld");
  });
});

// ── Real processes ─────────────────────────────────────────────────────

interface Holder {
  pid: number;
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
}

/** Start a holder and wait until it reports `ready`. It has NOT taken the
 * lock yet — `release` below is the starting gate. */
function startHolder(pgDataDir: string): Promise<Holder> {
  const child = spawn(process.execPath, ["--import", "tsx", HOLDER, pgDataDir], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  let err = "";
  child.stdout.on("data", (b: Buffer) => {
    out += b.toString();
  });
  child.stderr.on("data", (b: Buffer) => {
    err += b.toString();
  });
  const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));

  return new Promise<Holder>((res, rej) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (/^ready$/m.test(out)) {
        clearInterval(poll);
        res({ pid: child.pid ?? 0, child, stdout: () => out, stderr: () => err, exited });
        return;
      }
      if (Date.now() - started > 60_000) {
        clearInterval(poll);
        rej(new Error(`holder never reported ready (stdout: ${out}, stderr: ${err})`));
      }
    }, 25);
  });
}

/** Open the gate: every holder tries the lock at the same moment. */
function release(...holders: Holder[]): void {
  for (const holder of holders) holder.child.stdin.write("go\n");
}

/** Wait for one holder to settle: it holds the lock, or it exited. */
async function settle(holder: Holder): Promise<"holding" | "refused"> {
  const started = Date.now();
  for (;;) {
    if (/^holding \d+$/m.test(holder.stdout())) return "holding";
    if (holder.child.exitCode !== null) {
      if (/^refused busy$/m.test(holder.stderr())) return "refused";
      throw new Error(`holder exited ${holder.child.exitCode} (stderr: ${holder.stderr()})`);
    }
    if (Date.now() - started > 60_000) {
      throw new Error(`holder never settled (stdout: ${holder.stdout()}, stderr: ${holder.stderr()})`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("data-dir-lock/real processes", () => {
  it(
    "refuses a second boot while the first is alive, and names its pid",
    async () => {
      const pgDataDir = freshPgDataDir();
      const first = await startHolder(pgDataDir);
      release(first);
      expect(await settle(first)).toBe("holding");

      const second = await startHolder(pgDataDir);
      release(second);
      expect(await settle(second)).toBe("refused");
      expect(second.stderr()).toContain(`Process ${first.pid}`);
      expect(second.stderr()).toContain(`kill ${first.pid}`);
      // The refusal did not disturb the live owner's lock.
      expect(readLock(pgDataDirLockPath(pgDataDir))?.pid).toBe(first.pid);
    },
    120_000,
  );

  it(
    "does not block the next boot after a hard kill",
    async () => {
      const pgDataDir = freshPgDataDir();
      const first = await startHolder(pgDataDir);
      release(first);
      expect(await settle(first)).toBe("holding");

      // A real SIGKILL: no exit hook runs, and the lock file survives.
      first.child.kill("SIGKILL");
      await first.exited;
      expect(existsSync(pgDataDirLockPath(pgDataDir))).toBe(true);

      const second = await startHolder(pgDataDir);
      release(second);
      expect(await settle(second)).toBe("holding");
      expect(readLock(pgDataDirLockPath(pgDataDir))?.pid).toBe(second.pid);
    },
    120_000,
  );

  it(
    "gives the directory to exactly one of two boots that race after a hard kill",
    async () => {
      // The reclaim is the dangerous moment. A lock that deletes the dead
      // file and then recreates it lets both boots through: both see the
      // dead owner, both delete, both create. That is the two-owner state
      // that damaged the database. The atomic create makes the loser read
      // EEXIST and refuse.
      for (let trial = 0; trial < 6; trial++) {
        const pgDataDir = freshPgDataDir();
        const dead = await startHolder(pgDataDir);
        release(dead);
        expect(await settle(dead)).toBe("holding");
        dead.child.kill("SIGKILL");
        await dead.exited;

        const racers = [await startHolder(pgDataDir), await startHolder(pgDataDir)];
        release(...racers);
        const outcomes = await Promise.all(racers.map(settle));
        expect(outcomes.filter((o) => o === "holding")).toHaveLength(1);
        expect(readLock(pgDataDirLockPath(pgDataDir))?.pid).toBe(
          racers[outcomes.indexOf("holding")].pid,
        );
        for (const racer of racers) racer.child.kill("SIGKILL");
      }
    },
    240_000,
  );
});
