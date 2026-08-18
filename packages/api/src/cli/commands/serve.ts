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
 * - The one-owner lock on the PGlite data dir is NOT taken here. It is taken
 *   by `buildNodeProviders` (`providers/data-dir-lock.ts`), so `valet serve`,
 *   `tsx watch src/main.ts` and the bundled binary all share one guard, one
 *   lock file and one refusal message. This command only turns that refusal
 *   into a clean exit code.
 *
 * The heavy server boot (`startServer`) is imported lazily so unrelated
 * subcommands never pay for it.
 */
import { join, resolve } from "node:path";
import { loadConfig, saveConfig, type ValetConfig } from "../config.js";
import { printErr, printLine } from "../output.js";
import { resolveDataDir, type SandboxKind } from "../resolve.js";
import { ExitCode } from "../exit.js";
import { detectDockerDaemon } from "../docker-detect.js";
import { DataDirLockError } from "../../providers/data-dir-lock.js";
import type { CliContext } from "../types.js";
import type { ServerHandle } from "../../main.js";

/** Serve default port (spec decision 2) — NOT main.ts's 8787 fallback. */
const SERVE_DEFAULT_PORT = 8788;

const SANDBOX_KINDS: readonly SandboxKind[] = ["docker", "local", "kubernetes"];

export interface ServeFlags {
  port?: string;
  sandbox?: string;
  dataDir?: string;
  databaseUrl?: string;
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
  /** Remote Postgres connection string. When set, the server uses node-postgres
   * (`pg.Pool`) against this DB instead of the embedded PGlite in `dataDir`.
   * Unset → embedded PGlite. */
  databaseUrl?: string;
}

/** Redact the password in a Postgres connection string for log output.
 * `postgres://user:secret@host/db` → `postgres://user:***@host/db`. */
export function redactDbUrl(url: string): string {
  return url.replace(/:[^:@]*@/, ":***@");
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

  // Remote Postgres: flag > env DATABASE_URL > config.serve.databaseUrl. Empty
  // string counts as unset. Absent → embedded PGlite in dataDir.
  const databaseUrl =
    flags.databaseUrl ??
    (env.DATABASE_URL && env.DATABASE_URL !== "" ? env.DATABASE_URL : undefined) ??
    config.serve?.databaseUrl;

  // Stub auth unless a real secret is configured (same knob `make dev-local`
  // uses). Empty string counts as unset.
  const authStub = !env.BETTER_AUTH_SECRET;

  return { port, backend, dataDir, authStub, backendAutoDetected, databaseUrl };
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
  printLine(
    settings.databaseUrl
      ? `database: remote postgres (${redactDbUrl(settings.databaseUrl)})`
      : `database: embedded pglite (${settings.dataDir})`,
  );

  // Publish resolved values into the environment BEFORE booting — startServer
  // reads them from process.env.
  process.env.PORT = String(settings.port);
  process.env.VALET_SANDBOX_BACKEND = settings.backend;
  process.env.VALET_DATA_DIR = settings.dataDir;
  // Remote Postgres overrides the embedded PGlite (providers/node.ts branches on
  // DATABASE_URL). Only set it when resolved so an unset flag/config doesn't
  // clobber an inherited env value.
  if (settings.databaseUrl) {
    process.env.DATABASE_URL = settings.databaseUrl;
  }
  if (settings.authStub && !process.env.BETTER_AUTH_SECRET) {
    process.env.VALET_LOCAL_AUTH = "1";
  }

  // Lazy: keep the heavy server graph off every other subcommand's path.
  let handle: ServerHandle;
  try {
    const { startServer } = await import("../../main.js");
    handle = await startServer();
  } catch (err) {
    // The one-owner rule, refused by `buildNodeProviders`. Its message names
    // the process to stop and the command to see it, so print that alone —
    // a stack trace adds nothing a reader can act on.
    if (err instanceof DataDirLockError) {
      printErr(`serve: ${err.message}`);
      return ExitCode.Usage;
    }
    throw err;
  }

  // Implicit `local` profile so the client subcommands work with no login.
  // Persist it back to the config file we actually LOADED (configDir), not the
  // effective data dir: `config.serve.dataDir` may have redirected
  // settings.dataDir (and VALET_DATA_DIR, above) elsewhere, but a fresh
  // shell's client subcommands locate config from flag/env/default only and
  // would never see a profile saved under the redirected dir.
  try {
    saveConfig(upsertLocalProfile(config, settings.port), join(configDir, "config.json"));
  } catch (err) {
    printErr(`serve: failed to persist local profile: ${err instanceof Error ? err.message : String(err)}`);
  }

  printLine(`\nValet is serving at http://localhost:${settings.port}`);
  printLine(`  open the web UI at http://localhost:${settings.port}`);

  // Stay alive until a shutdown signal, then close gracefully and resolve OK.
  return await new Promise<number>((resolveExit) => {
    const onSignal = (signal: NodeJS.Signals): void => {
      printLine(`\nReceived ${signal}, shutting down (sessions evicted, durable state kept)...`);
      void handle.close().finally(() => resolveExit(ExitCode.OK));
      // Hard-exit if close() hangs (containers can be slow to stop). The
      // lock's own `process.on("exit")` hook still drops it.
      setTimeout(() => process.exit(1), 5_000).unref();
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
    } else if (arg === "--database-url" || arg.startsWith("--database-url=")) {
      flags.databaseUrl = take(arg.startsWith("--database-url=") ? arg.slice("--database-url=".length) : undefined);
    }
  }
  return flags;
}
