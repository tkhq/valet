/**
 * Option precedence resolution for the CLI.
 *
 * Serve options follow: CLI flag > env var > config file > built-in default.
 * Instance selection follows: `--instance` flag > `VALET_INSTANCE` env >
 * `config.defaultProfile`, then the name is looked up in `config.profiles`.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ProfileConfig, ServeConfig, ValetConfig } from "./config.js";
import { NoInstanceError, ProfileNotFoundError } from "./exit.js";

/** Return the first argument that is neither `undefined` nor `null`. */
export function firstDefined<T>(...values: Array<T | undefined | null>): T | undefined {
  for (const v of values) {
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/** Built-in defaults for serve options (the lowest-precedence source). */
export const SERVE_DEFAULTS = {
  port: 8787,
  sandbox: "docker" as const,
  dataDir: resolve(homedir(), ".valet"),
};

export interface PortSources {
  flag?: number;
  env?: string;
  config?: ServeConfig;
}

/** Resolve the serve port: flag > env (`PORT`) > config.serve.port > 8787. */
export function resolvePort(sources: PortSources): number {
  const envPort = parseIntOrUndefined(sources.env);
  return firstDefined(sources.flag, envPort, sources.config?.port, SERVE_DEFAULTS.port) ?? SERVE_DEFAULTS.port;
}

export type SandboxKind = "docker" | "local" | "kubernetes";

export interface SandboxSources {
  flag?: string;
  env?: string;
  config?: ServeConfig;
}

/** Resolve the sandbox backend: flag > env > config.serve.sandbox > docker. */
export function resolveSandbox(sources: SandboxSources): SandboxKind {
  const candidate = firstDefined(
    normalizeSandbox(sources.flag),
    normalizeSandbox(sources.env),
    sources.config?.sandbox,
    SERVE_DEFAULTS.sandbox,
  );
  return candidate ?? SERVE_DEFAULTS.sandbox;
}

export interface DataDirSources {
  flag?: string;
  env?: string;
  config?: ServeConfig;
}

/** Resolve the data dir: flag > env (`VALET_DATA_DIR`) > config > `~/.valet`. */
export function resolveDataDir(sources: DataDirSources): string {
  return (
    firstDefined(sources.flag, sources.env, sources.config?.dataDir, SERVE_DEFAULTS.dataDir) ?? SERVE_DEFAULTS.dataDir
  );
}

export interface InstanceSources {
  flag?: string;
  env?: string;
  config: ValetConfig;
}

export interface ResolvedInstance {
  name: string;
  url: string;
  apiKey?: string;
}

/**
 * Resolve which instance/profile to talk to.
 *
 * Selection precedence: `--instance` flag > `VALET_INSTANCE` env >
 * `config.defaultProfile`. The selected name is looked up in
 * `config.profiles`:
 * - name selected but absent → `ProfileNotFoundError`.
 * - nothing selected and no default → `NoInstanceError`.
 */
export function resolveInstance(sources: InstanceSources): ResolvedInstance {
  const name = firstDefined(sources.flag, sources.env, sources.config.defaultProfile);
  if (name === undefined) throw new NoInstanceError();

  const profile: ProfileConfig | undefined = sources.config.profiles?.[name];
  if (profile === undefined) throw new ProfileNotFoundError(name);

  return { name, url: profile.url, apiKey: profile.apiKey };
}

function parseIntOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? undefined : n;
}

function normalizeSandbox(value: string | undefined): SandboxKind | undefined {
  if (value === "docker" || value === "local" || value === "kubernetes") return value;
  return undefined;
}
