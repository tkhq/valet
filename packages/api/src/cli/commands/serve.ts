/**
 * `valet serve` — boot the full Valet product (the packaged single-binary
 * server) with sensible packaged defaults.
 *
 * Design (single-binary CLI plan, T5, spec decision 2):
 * - Serve default port is **8788** (distinct from `main.ts`'s own 8787
 *   fallback — the serve command owns the 8788 default and sets `PORT`).
 * - Sandbox backend auto-detects: with no explicit choice, `docker` if a
 *   reachable daemon is found, else `local`.
 * - Auth defaults to the stub (`VALET_LOCAL_AUTH=1`) unless a real
 *   `BETTER_AUTH_SECRET` is configured, so a fresh instance is usable with no
 *   API key.
 * - After listening, an implicit `local` profile is written to the CLI config
 *   so the other subcommands can talk to it out of the box.
 * - A `serve.lock` pidfile guards the data dir against two concurrent serves
 *   sharing one PGlite instance.
 *
 * The heavy server boot (`startServer`) is imported lazily so unrelated
 * subcommands never pay for it.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, saveConfig, type ValetConfig } from "../config.js";
import { printErr, printLine } from "../output.js";
import { resolveDataDir, type SandboxKind } from "../resolve.js";
import { ExitCode } from "../exit.js";
import { detectDockerDaemon } from "../docker-detect.js";
import type { CliContext } from "../types.js";
import type { ServerHandle } from "../../main.js";

/** Serve default port (spec decision 2) — NOT main.ts's 8787 fallback. */
const SERVE_DEFAULT_PORT = 8788;

const SANDBOX_KINDS: readonly SandboxKind[] = ["docker", "local", "kubernetes"];

/** The `serve.lock` pidfile shape. */
export interface ServeLock {
  pid: number;
  port: number;
  startedAt: string;
}

export interface ServeFlags {
  port?: string;
  sandbox?: string;
  dataDir?: string;
}

export interface ServeSettingsInput {
  flags: ServeFlags;
  env: NodeJS.ProcessEnv;
  config: ValetConfig;
  /** Whether a reachable Docker daemon was detected (auto-detect input). */
  dockerReachable: boolean;
}

export interface ServeSettings {
  port: number;
  backend: SandboxKind;
  dataDir: string;
  /** True → run in stub-auth mode (`VALET_LOCAL_AUTH=1`). */
  authStub: boolean;
  /** True when `backend` came from docker auto-detect, not an explicit source. */
  backendAutoDetected: boolean;
}

function isSandboxKind(value: string): value is SandboxKind {
  return (SANDBOX_KINDS as readonly string[]).includes(value);
}

/** Coerce one port source to a positive integer, or throw a clear error. A
 * hand-edited config could carry `serve.port` as a string, so accept both. */
function coercePort(value: string | number | undefined, source: string): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`invalid port from ${source}: ${JSON.stringify(value)} (expected a positive integer)`);
  }
  return n;
}

/**
 * Resolve every effective serve setting. Pure — no env writes, no fs, no
 * spawn — so it's unit-testable in isolation.
 *
 * Precedence (per field): flag > env > config.serve > built-in default.
 * Backend is special: an explicit choice from any source wins; absent all
 * three, it auto-detects (`docker` if reachable, else `local`).
 */
export function resolveServeSettings(input: ServeSettingsInput): ServeSettings {
  const { flags, env, config, dockerReachable } = input;

  const port =
    coercePort(flags.port, "--port") ??
    coercePort(env.PORT, "PORT") ??
    coercePort(config.serve?.port, "config serve.port") ??
    SERVE_DEFAULT_PORT;

  const explicitRaw =
    flags.sandbox ??
    (env.VALET_SANDBOX_BACKEND && env.VALET_SANDBOX_BACKEND !== "" ? env.VALET_SANDBOX_BACKEND : undefined) ??
    config.serve?.sandbox;

  let backend: SandboxKind;
  let backendAutoDetected: boolean;
  if (explicitRaw !== undefined) {
    if (!isSandboxKind(explicitRaw)) {
      throw new Error(`invalid sandbox backend: ${JSON.stringify(explicitRaw)} (expected ${SANDBOX_KINDS.join(", ")})`);
    }
    backend = explicitRaw;
    backendAutoDetected = false;
  } else {
    backend = dockerReachable ? "docker" : "local";
    backendAutoDetected = true;
  }

  const dataDir = resolveDataDir({ flag: flags.dataDir, env: env.VALET_DATA_DIR, config: config.serve });

  // Stub auth unless a real secret is configured (same knob `make dev-local`
  // uses). Empty string counts as unset.
  const authStub = !env.BETTER_AUTH_SECRET;

  return { port, backend, dataDir, authStub, backendAutoDetected };
}

/**
 * Upsert the implicit `local` profile pointing at this instance, without
 * clobbering an existing non-local default. Returns a NEW config (no mutation
 * of the input).
 */
export function upsertLocalProfile(config: ValetConfig, port: number): ValetConfig {
  const profiles = { ...(config.profiles ?? {}), local: { url: `http://localhost:${port}` } };
  return {
    ...config,
    profiles,
    // Only claim the default when nothing else already holds it.
    defaultProfile: config.defaultProfile ?? "local",
  };
}

/** Parse a `serve.lock` file body; `undefined` if malformed or missing fields. */
export function parseLock(raw: string): ServeLock | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.pid !== "number" || typeof obj.port !== "number" || typeof obj.startedAt !== "string") {
    return undefined;
  }
  return { pid: obj.pid, port: obj.port, startedAt: obj.startedAt };
}

/** True if a pid is alive (signal 0 probe). `EPERM` means it exists but isn't
 * ours — still alive. Any other error → dead/absent. */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether a lock is owned by a still-running process (a live owner blocks a
 * second serve on the same data dir). `isAlive` is injectable for tests. */
export function isLiveLock(lock: ServeLock, isAlive: (pid: number) => boolean = defaultIsPidAlive): boolean {
  return isAlive(lock.pid);
}

/** Read + parse the lock at `path`; `undefined` if absent or malformed. */
function readLock(path: string): ServeLock | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  return parseLock(raw);
}

/**
 * Atomically claim the serve lock at `path`. The create uses `O_EXCL`
 * (`flag: "wx"`) so create-if-absent is a single syscall — two serves racing
 * to boot on the same data dir cannot both succeed, closing the TOCTOU where a
 * plain read-then-write would let both open PGlite on one dir. If a lock
 * already exists: a live owner → `"busy"`; a stale (dead-pid) or malformed lock
 * is removed and the atomic create retried once. `isAlive` is injectable for
 * tests.
 */
export function claimServeLock(
  path: string,
  lock: ServeLock,
  isAlive: (pid: number) => boolean = defaultIsPidAlive,
): "claimed" | "busy" {
  const body = `${JSON.stringify(lock, null, 2)}\n`;
  try {
    writeFileSync(path, body, { flag: "wx" });
    return "claimed";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const cur = readLock(path);
  if (cur && isLiveLock(cur, isAlive)) return "busy";
  // Stale (dead pid) or malformed lock — remove and retry the atomic create.
  try {
    unlinkSync(path);
  } catch {
    // Raced away; the retry below resolves the outcome.
  }
  try {
    writeFileSync(path, body, { flag: "wx" });
    return "claimed";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return "busy";
    throw err;
  }
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const flags = parseServeFlags(args);

  // ── Load the config from the RESOLVED data dir, not the default. cli.ts
  // loaded `ctx.config` from the default (~/.valet) BEFORE serve resolves
  // --data-dir / VALET_DATA_DIR, so `config.serve.*` would come from the wrong
  // file when --data-dir points elsewhere.
  //
  // Ordering (config.serve.dataDir is itself a config value — chicken-and-egg):
  // to LOCATE the config file we resolve the data dir from flag > env > default
  // ONLY; `config.serve.dataDir` is not consulted here. It still acts as a
  // fallback for the *effective* data dir (via resolveServeSettings below) when
  // neither flag nor env is set. So config.serve.dataDir can redirect where
  // PGlite/the lock live, but the config file itself is always read from
  // flag/env/default.
  const configDir = resolveDataDir({ flag: flags.dataDir, env: process.env.VALET_DATA_DIR });
  const ctxConfigDir = resolveDataDir({ env: process.env.VALET_DATA_DIR });
  let config = ctx.config;
  if (resolve(configDir) !== resolve(ctxConfigDir)) {
    // Point configPath() at the resolved dir, then re-read from there.
    process.env.VALET_DATA_DIR = configDir;
    config = loadConfig();
  }

  // Skip the docker probe entirely when the backend is chosen explicitly — no
  // reason to spawn `docker` if the choice is already made.
  const explicitBackend =
    flags.sandbox !== undefined ||
    (process.env.VALET_SANDBOX_BACKEND ?? "") !== "" ||
    config.serve?.sandbox !== undefined;
  const dockerReachable = explicitBackend ? false : await detectDockerDaemon();

  let settings: ServeSettings;
  try {
    settings = resolveServeSettings({ flags, env: process.env, config, dockerReachable });
  } catch (err) {
    printErr(`serve: ${err instanceof Error ? err.message : String(err)}`);
    return ExitCode.Usage;
  }

  printLine(
    settings.backendAutoDetected && settings.backend === "local"
      ? "sandbox backend: local (no docker daemon detected)"
      : `sandbox backend: ${settings.backend}`,
  );

  const lockPath = join(settings.dataDir, "serve.lock");

  // Publish resolved values into the environment BEFORE booting — startServer
  // reads them from process.env.
  process.env.PORT = String(settings.port);
  process.env.VALET_SANDBOX_BACKEND = settings.backend;
  process.env.VALET_DATA_DIR = settings.dataDir;
  if (settings.authStub && !process.env.BETTER_AUTH_SECRET) {
    process.env.VALET_LOCAL_AUTH = "1";
  }

  // Remove the pidfile on ANY exit path (signal, crash-after-close, normal) —
  // only if we still own it (a parseable lock whose pid is ours), so we never
  // delete a fresher serve's lock nor another process's unparseable one.
  const removeLock = (): void => {
    try {
      const cur = readLock(lockPath);
      if (cur && cur.pid === process.pid) unlinkSync(lockPath);
    } catch {
      // best-effort
    }
  };

  // ── serve.lock: refuse to share a live data dir (the one-owner rule).
  // claimServeLock does an ATOMIC O_EXCL create so two serves booting on the
  // same dir can't both win — closing the check-and-claim race where both open
  // PGlite. A stale (dead-pid) or malformed lock is reclaimed automatically.
  mkdirSync(settings.dataDir, { recursive: true });
  const lock: ServeLock = { pid: process.pid, port: settings.port, startedAt: new Date().toISOString() };
  if (claimServeLock(lockPath, lock) === "busy") {
    const cur = readLock(lockPath);
    printErr(
      `serve: another valet serve${cur ? ` (pid ${cur.pid}, port ${cur.port})` : ""} already owns ${settings.dataDir}. ` +
        `Stop it first, or run with a different --data-dir.`,
    );
    return ExitCode.Usage;
  }
  // Register cleanup BEFORE booting so an in-boot process.exit (e.g. startServer
  // aborting on a missing ANTHROPIC_API_KEY) still drops the lock we just claimed.
  process.on("exit", removeLock);

  // Lazy: keep the heavy server graph off every other subcommand's path. If the
  // boot throws, drop the lock we just claimed so a failed boot leaves no stale
  // lock we own.
  let handle: ServerHandle;
  try {
    const { startServer } = await import("../../main.js");
    handle = await startServer();
  } catch (err) {
    removeLock();
    throw err;
  }

  // Implicit `local` profile so the client subcommands work with no login.
  // Reuse the config loaded from the resolved data dir and persist it back
  // under settings.dataDir (VALET_DATA_DIR now points there).
  try {
    saveConfig(upsertLocalProfile(config, settings.port));
  } catch (err) {
    printErr(`serve: failed to persist local profile: ${err instanceof Error ? err.message : String(err)}`);
  }

  printLine(`\nValet is serving at http://localhost:${settings.port}`);
  printLine(`  open the web UI at http://localhost:${settings.port}`);

  // Stay alive until a shutdown signal, then close gracefully and resolve OK.
  return await new Promise<number>((resolveExit) => {
    const onSignal = (signal: NodeJS.Signals): void => {
      printLine(`\nReceived ${signal}, shutting down (sessions evicted, durable state kept)...`);
      void handle
        .close()
        .then(removeLock)
        .finally(() => resolveExit(ExitCode.OK));
      // Hard-exit if close() hangs (containers can be slow to stop).
      setTimeout(() => {
        removeLock();
        process.exit(1);
      }, 5_000).unref();
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));
  });
}

/** Extract serve's typed flags from raw argv. */
function parseServeFlags(args: string[]): ServeFlags {
  const flags: ServeFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const take = (inline: string | undefined): string | undefined => {
      if (inline !== undefined) return inline;
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        i++;
        return next;
      }
      return undefined;
    };
    if (arg === "--port" || arg.startsWith("--port=")) {
      flags.port = take(arg.startsWith("--port=") ? arg.slice("--port=".length) : undefined);
    } else if (arg === "--sandbox" || arg.startsWith("--sandbox=")) {
      flags.sandbox = take(arg.startsWith("--sandbox=") ? arg.slice("--sandbox=".length) : undefined);
    } else if (arg === "--data-dir" || arg.startsWith("--data-dir=")) {
      flags.dataDir = take(arg.startsWith("--data-dir=") ? arg.slice("--data-dir=".length) : undefined);
    }
  }
  return flags;
}
