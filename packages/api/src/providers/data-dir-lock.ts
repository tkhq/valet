/**
 * One owner for the embedded PGlite data directory, enforced at boot.
 *
 * ## The failure this prevents
 *
 * PGlite permits one process to hold a data directory. A second API process
 * does not fail cleanly: it can lose the race for the HTTP port, stay alive,
 * and keep the directory open. The next boot then writes over a directory
 * that another process still writes to, and the database is damaged. Two
 * such losses happened in one evening. Each recovery needed a copy of the
 * directory, a deleted `postmaster.pid`, and `pg_resetwal -f` from a
 * PostgreSQL 18 build.
 *
 * The development guide told a person to look for the second process with
 * `lsof` before every boot. A person does not do that. The API does it here.
 *
 * ## Why PGlite's own file cannot answer the question
 *
 * PGlite writes a `postmaster.pid` into the data directory, but its first
 * line is the constant `-42`, not a process id. The file is also left behind
 * when a process stops with SIGKILL. So the file tells us neither WHO holds
 * the directory nor WHETHER anybody still does. A lock that refused to boot
 * on the presence of that file would turn every hard kill into a lockout —
 * one fault traded for another.
 *
 * ## What this module uses instead
 *
 * A lock file that this module owns, holding the real process id of the
 * owner. Two properties make it a lock and not a hint:
 *
 *   1. The create is `O_EXCL` (`flag: "wx"`), so create-if-absent is ONE
 *      syscall. Two boots that start together cannot both succeed: the
 *      kernel gives the file to one of them and `EEXIST` to the other.
 *      Nothing here deletes a file and then recreates it in the hope that
 *      no other boot slipped between the two calls.
 *   2. Liveness is a signal-0 probe of the recorded pid, so a lock left by a
 *      process stopped with SIGKILL is reclaimed. The reclaim removes the
 *      dead file and RETRIES THE SAME ATOMIC CREATE, so a boot that loses
 *      that retry reads `EEXIST` and refuses, rather than assuming the
 *      reclaim made it the owner.
 *
 * A pid can be reused, which would make a dead owner read as live. The
 * common cause of that is a machine restart, and this module rules it out:
 * a lock written before the current boot of the operating system cannot
 * belong to a running process, whatever the pid says. See `isLiveLock`.
 *
 * ## Where the lock lives
 *
 * Beside the data directory it protects, as `<pgDataDir>.lock` — for the
 * default layout, `~/.valet/pg.lock`. The lock is keyed to the RESOURCE, not
 * to the process that takes it and not to `$TMPDIR`. Two processes that
 * share a data directory therefore share a lock file, even when they run
 * under different temporary directories, different users, or one of them in
 * a container with the directory bind-mounted.
 *
 * The file sits BESIDE the data directory rather than inside it, because
 * `initdb` refuses to initialize a directory that already holds files.
 *
 * ## One guard, both entry points
 *
 * `buildNodeProviders` takes the lock, so it covers every way the server
 * starts: `valet serve`, `tsx watch src/main.ts` (what `make dev-local`
 * runs), and the bundled binary. `cli/commands/reset.ts` reads the same file
 * to refuse a wipe while a server owns the directory.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The lock file body. */
export interface DataDirLock {
  pid: number;
  /** The HTTP port the owner listens on, when the owner knows it. Reported
   * in the refusal so a reader can tell which server is in the way. */
  port?: number;
  startedAt: string;
}

/** Tolerance for the wall-clock/uptime comparison in `isLiveLock`. The two
 * clocks are read at different moments and one of them can be adjusted, so
 * only a lock that predates the boot by more than this counts as stale. */
const BOOT_SKEW_MS = 60_000;

/**
 * Refuses a boot that would open a data directory another process holds, or
 * that cannot be locked at all. `main.ts` and `cli/commands/serve.ts` print
 * `message` and stop, so the message names the corrective action.
 *
 *   - `busy` — another live process holds the directory.
 *   - `unwritable` — the lock file cannot be created, so this module cannot
 *     answer the question at all.
 */
export class DataDirLockError extends Error {
  constructor(
    readonly code: "busy" | "unwritable",
    message: string,
  ) {
    super(message);
    this.name = "DataDirLockError";
  }
}

/** Node reports system faults as an `Error` with a `code`. Read it without a
 * cast so an object of another shape cannot pass as one. */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const { code } = err as { code: unknown };
  return typeof code === "string" ? code : undefined;
}

/**
 * The PGlite data directory for one Valet data directory. `VALET_PG_DATA_DIR`
 * overrides it. One rule in one place: `main.ts`, the serve command and the
 * reset command all resolve the directory and its lock through here, so they
 * cannot drift onto two different files.
 */
export function resolvePgDataDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.VALET_PG_DATA_DIR;
  return override !== undefined && override !== "" ? override : join(dataDir, "pg");
}

/** The lock file that stands for one PGlite data directory. */
export function pgDataDirLockPath(pgDataDir: string): string {
  return `${resolve(pgDataDir)}.lock`;
}

/** Parse a lock file body; `undefined` if malformed or missing fields. A
 * malformed lock is reclaimed, so this must not throw. */
export function parseLock(raw: string): DataDirLock | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.pid !== "number" || typeof obj.startedAt !== "string") return undefined;
  // A non-positive pid must read as malformed: `process.kill(0/-n, 0)` probes
  // a process GROUP (usually alive), so a corrupted lock with pid<=0 would
  // wedge every later boot on this data dir instead of being reclaimed.
  if (!Number.isInteger(obj.pid) || obj.pid <= 0) return undefined;
  const port = typeof obj.port === "number" && Number.isInteger(obj.port) ? obj.port : undefined;
  return port === undefined
    ? { pid: obj.pid, startedAt: obj.startedAt }
    : { pid: obj.pid, port, startedAt: obj.startedAt };
}

/** True if a pid is alive (signal 0 probe). `EPERM` means it exists but isn't
 * ours — still alive. Any other error → dead/absent. */
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === "EPERM";
  }
}

/** When the operating system last started, in wall-clock milliseconds. */
export function machineBootTimeMs(): number {
  return Date.now() - uptime() * 1000;
}

/**
 * Whether a lock is owned by a still-running process. A live owner blocks a
 * second server on the same data directory.
 *
 * The pid probe alone is not enough. A pid is reused, and the everyday cause
 * is a machine restart: `~/.valet/pg.lock` outlives the restart, some
 * unrelated process now carries pid 4242, and the probe says "alive"
 * forever. That is a lockout that only a person with `rm` can clear. So a
 * lock written before this boot of the operating system is stale, whatever
 * the pid says. An unparseable `startedAt` skips the test and falls back to
 * the pid probe alone.
 *
 * `isAlive` and `bootTimeMs` are injectable so both branches are testable
 * without a restart.
 */
export function isLiveLock(
  lock: DataDirLock,
  isAlive: (pid: number) => boolean = defaultIsPidAlive,
  bootTimeMs: number = machineBootTimeMs(),
): boolean {
  const startedAt = Date.parse(lock.startedAt);
  if (Number.isFinite(startedAt) && startedAt < bootTimeMs - BOOT_SKEW_MS) return false;
  return isAlive(lock.pid);
}

/** Read + parse the lock at `path`; `undefined` if absent or malformed. */
export function readLock(path: string): DataDirLock | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  return parseLock(raw);
}

/**
 * Atomically claim the lock at `path`.
 *
 *   - `claimed` — this process now owns the file.
 *   - `held` — the file was already ours (this process claimed it earlier).
 *   - `busy` — another live process owns it.
 *
 * The create uses `O_EXCL` (`flag: "wx"`), so create-if-absent is a single
 * syscall and two boots racing on one directory cannot both win. A stale
 * (dead-pid) or malformed lock is removed and the SAME atomic create is
 * retried once; a boot that loses that retry reads `EEXIST` and reports
 * `busy`, so a reclaim never grants two owners.
 *
 * `isAlive` is injectable for tests.
 */
export function claimDataDirLock(
  path: string,
  lock: DataDirLock,
  isAlive: (pid: number) => boolean = defaultIsPidAlive,
): "claimed" | "held" | "busy" {
  const body = `${JSON.stringify(lock, null, 2)}\n`;
  try {
    writeFileSync(path, body, { flag: "wx" });
    return "claimed";
  } catch (err) {
    if (errorCode(err) !== "EEXIST") throw err;
  }
  const cur = readLock(path);
  // Already ours. A second call in one process must not read as a conflict
  // with itself, and must not rewrite the file the first call owns.
  if (cur && cur.pid === process.pid) return "held";
  if (cur && isLiveLock(cur, isAlive)) return "busy";
  // Stale (dead pid) or malformed lock — remove and retry the atomic create.
  try {
    unlinkSync(path);
  } catch {
    // Raced away, or not ours to delete. The retry below resolves the
    // outcome either way: it reports `busy` rather than assuming ownership.
  }
  try {
    writeFileSync(path, body, { flag: "wx" });
    return "claimed";
  } catch (err) {
    if (errorCode(err) === "EEXIST") return "busy";
    throw err;
  }
}

/** Delete the lock at `path`, but only while this process owns it. A lock
 * that another process now owns must survive: deleting it would hand a third
 * boot a directory that is in use. */
export function releaseDataDirLock(path: string): void {
  try {
    const cur = readLock(path);
    if (cur && cur.pid === process.pid) unlinkSync(path);
  } catch {
    // Best effort. The next boot reclaims a lock whose pid is dead.
  }
}

/** The refusal a person reads. Every branch names what to run next. */
export function busyMessage(pgDataDir: string, lockPath: string, owner: DataDirLock | undefined): string {
  const lines = [
    `Another process uses the Valet database directory ${resolve(pgDataDir)}.`,
    "PGlite permits one process only. A second process can damage the data.",
  ];
  if (owner === undefined) {
    lines.push(
      `Valet cannot read a process id from the lock file ${lockPath}.`,
      "To find the process that holds the directory, run:",
      `  lsof +D ${resolve(pgDataDir)}`,
      "Stop that process, then start Valet again.",
    );
  } else {
    const where = owner.port === undefined ? "" : ` on port ${owner.port}`;
    lines.push(
      `Process ${owner.pid} holds it${where}.`,
      "To see that process, run:",
      `  ps -p ${owner.pid} -o pid,command`,
      "To stop it, run:",
      `  kill ${owner.pid}`,
      "If that process is not Valet, delete the lock file:",
      `  rm ${lockPath}`,
      "Then start Valet again.",
    );
  }
  return lines.join("\n");
}

/** A held lock. The operating system does not release this one on process
 * death — the next boot reclaims it from the dead pid instead — so `release`
 * exists for a graceful shutdown and for tests. */
export interface HeldDataDirLock {
  /** The lock file. Named in the refusal so a reader can remove it when the
   * process that holds it is not Valet. */
  readonly path: string;
  release(): void;
}

export interface AcquireDataDirLockOpts {
  /** The PGlite data directory to protect. */
  pgDataDir: string;
  /** The HTTP port of this server, when the caller knows it. */
  port?: number;
  /** Injectable for tests. */
  isAlive?: (pid: number) => boolean;
}

/**
 * Take the lock for `pgDataDir`, or throw `DataDirLockError`.
 *
 * A `busy` refusal is the point of the module. An `unwritable` refusal
 * covers the case where the lock file itself cannot be created — a read-only
 * or root-owned parent directory, for example. That is reported and NOT
 * ignored: a directory Valet cannot write a lock into is a directory PGlite
 * cannot write a database into either, so continuing would only move the
 * same fault to a worse message.
 */
export function acquireDataDirLock(opts: AcquireDataDirLockOpts): HeldDataDirLock {
  const path = pgDataDirLockPath(opts.pgDataDir);
  const lock: DataDirLock =
    opts.port === undefined
      ? { pid: process.pid, startedAt: new Date().toISOString() }
      : { pid: process.pid, port: opts.port, startedAt: new Date().toISOString() };

  let outcome: "claimed" | "held" | "busy";
  try {
    mkdirSync(dirname(path), { recursive: true });
    outcome = claimDataDirLock(path, lock, opts.isAlive);
  } catch (err) {
    // Never let an errno escape as the boot's user-facing error.
    throw new DataDirLockError(
      "unwritable",
      [
        `Valet cannot create the database lock file ${path} (${errorCode(err) ?? "unknown fault"}).`,
        "Valet needs write access to that directory to guard the database.",
        "To see who owns the directory, run:",
        `  ls -ld ${dirname(path)}`,
        "Give your account write access to it, then start Valet again.",
      ].join("\n"),
    );
  }

  if (outcome === "busy") {
    throw new DataDirLockError("busy", busyMessage(opts.pgDataDir, path, readLock(path)));
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.removeListener("exit", release);
    releaseDataDirLock(path);
  };
  // Covers a `process.exit` inside the boot that follows this call. A hard
  // kill skips it, which is what the stale-reclaim path above handles.
  process.once("exit", release);
  return { path, release };
}
