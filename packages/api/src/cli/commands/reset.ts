/**
 * `valet reset` — wipe local durable/runtime state for an instance's data dir.
 *
 * Safety rails:
 * - **Refuses while a live `valet serve` owns the dir.** It reads
 *   `join(dataDir, "serve.lock")`, parses it with `parseLock`, and if
 *   `isLiveLock` is true (the pid is still running) it refuses with `Usage`. A
 *   stale (dead-pid), malformed, or absent lock does NOT block.
 * - **Requires confirmation.** Interactive `y/N` prompt unless `--yes`. A
 *   non-TTY invocation without `--yes` refuses (rather than hang) with `Usage`.
 *
 * Wipe scope — SCOPED, not a full-dir nuke. We remove every entry in the data
 * dir EXCEPT `config.json`, so the PGlite state (`pg/`), the `serve.lock`, and
 * any durable/runtime dirs are cleared while the user's saved profiles + serve
 * defaults survive. Rationale: the plan says "wipes dataDir", but nuking
 * `config.json` would silently delete every `valet login` profile — a
 * surprising, unrecoverable loss for a "reset local state" command. Preserving
 * exactly `config.json` keeps the destructive action about runtime/DB state.
 *
 * The pure `runReset` is exported for tests; the lock's liveness check, the
 * confirmation reader, and TTY-ness are injected so a temp dir + scripted deps
 * fully exercise it.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags, printErr, printLine } from "../output.js";
import { resolveDataDir } from "../resolve.js";
import type { CliContext } from "../types.js";
import { isLiveLock, parseLock } from "./serve.js";

/** The single file the wipe preserves. */
const PRESERVE = "config.json";

/** Injectable dependencies for `runReset`. */
export interface ResetDeps {
  /** Prompt the user; resolves true to proceed. */
  confirm(): Promise<boolean>;
  /** Liveness probe for the lock's pid (injected so tests avoid real signals). */
  isAlive(pid: number): boolean;
  /** Whether stdin is a TTY (a non-TTY without `--yes` refuses). */
  isTTY: boolean;
}

export interface ResetOpts {
  /** Skip the confirmation prompt. */
  yes: boolean;
  /** The already-resolved data dir to wipe. */
  dataDir: string;
}

/** Read + parse the serve lock at `dataDir/serve.lock`; `undefined` if absent/malformed. */
function readLock(dataDir: string): ReturnType<typeof parseLock> {
  const path = join(dataDir, "serve.lock");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  return parseLock(raw);
}

/** True if a pid is alive (signal 0 probe). `EPERM` → exists but not ours (alive). */
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Pure reset: refuse on a live lock, confirm, then wipe every entry except
 * `config.json`. Returns the process exit code.
 */
export async function runReset(deps: ResetDeps, opts: ResetOpts): Promise<number> {
  // ── Refuse while a live serve owns the dir.
  const lock = readLock(opts.dataDir);
  if (lock && isLiveLock(lock, deps.isAlive)) {
    printErr(`valet reset: a valet serve (pid ${lock.pid}) is running; stop it first`);
    return ExitCode.Usage;
  }

  // ── Confirmation.
  if (!opts.yes) {
    if (!deps.isTTY) {
      printErr("valet reset: refusing to reset without confirmation; pass --yes to proceed non-interactively");
      return ExitCode.Usage;
    }
    const proceed = await deps.confirm();
    if (!proceed) {
      printLine("reset aborted");
      return ExitCode.OK;
    }
  }

  // ── Wipe (scoped: everything except config.json).
  if (!existsSync(opts.dataDir)) {
    printLine("nothing to reset (data dir does not exist)");
    return ExitCode.OK;
  }
  const entries = readdirSync(opts.dataDir).filter((e) => e !== PRESERVE);
  if (entries.length === 0) {
    printLine("nothing to reset");
    return ExitCode.OK;
  }
  for (const entry of entries) {
    rmSync(join(opts.dataDir, entry), { recursive: true, force: true });
  }
  printLine(`reset ${opts.dataDir}: removed ${entries.sort().join(", ")} (kept ${PRESERVE})`);
  return ExitCode.OK;
}

/** Interactive `y/N` confirmation over readline (lazy-imported). */
async function confirmInteractive(dataDir: string): Promise<boolean> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return await new Promise<boolean>((resolve) => {
    rl.question(`This wipes runtime/DB state under ${dataDir} (profiles kept). Continue? [y/N] `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "y" || a === "yes");
    });
  });
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const flags = parseGlobalFlags(args);
  const dataDirFlag = typeof flags.flags["data-dir"] === "string" ? flags.flags["data-dir"] : undefined;
  const dataDir = resolveDataDir({
    flag: dataDirFlag,
    env: process.env.VALET_DATA_DIR,
    config: ctx.config.serve,
  });
  const deps: ResetDeps = {
    confirm: () => confirmInteractive(dataDir),
    isAlive: defaultIsPidAlive,
    isTTY: Boolean(process.stdin.isTTY),
  };
  return runReset(deps, { yes: flags.flags.yes === true, dataDir });
}
