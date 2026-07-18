/**
 * The `valet` CLI config file (`~/.valet/config.json`). Holds `serve`
 * defaults, named instance `profiles`, and a `defaultProfile` selection.
 *
 * This module MUST stay free of side effects on import — no fs access, no
 * env reads at module scope. Everything happens inside the exported fns.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ConfigError } from "./exit.js";

export interface ServeConfig {
  port?: number;
  sandbox?: "docker" | "local" | "kubernetes";
  dataDir?: string;
  authMode?: "stub" | "real";
}

export interface ProfileConfig {
  url: string;
  apiKey?: string;
}

export interface ValetConfig {
  serve?: ServeConfig;
  profiles?: Record<string, ProfileConfig>;
  defaultProfile?: string;
}

/** The known top-level keys of `ValetConfig`. Anything else warns + is dropped. */
const KNOWN_KEYS = new Set<string>(["serve", "profiles", "defaultProfile"]);

/** Resolve the data root, honoring `VALET_DATA_DIR` (default `~/.valet`). */
function dataDir(): string {
  return process.env.VALET_DATA_DIR ?? resolve(homedir(), ".valet");
}

/** Absolute path to `config.json` under the data root. */
export function configPath(): string {
  return join(dataDir(), "config.json");
}

/**
 * Load and validate the config file.
 *
 * - Missing file → `{}`.
 * - Malformed JSON → throws `ConfigError` (never silently wiped).
 * - Unknown top-level keys → warned to stderr and dropped; the known-shaped
 *   subset is returned.
 */
export function loadConfig(): ValetConfig {
  const path = configPath();
  if (!existsSync(path)) return {};

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`config: failed to read ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config: ${path} is not valid JSON: ${(err as Error).message}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`config: ${path} must be a JSON object`);
  }

  const obj = parsed as Record<string, unknown>;
  const known: ValetConfig = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!KNOWN_KEYS.has(key)) {
      process.stderr.write(`config: ignoring unknown key "${key}"\n`);
      continue;
    }
    if (key === "serve" && isRecord(value)) known.serve = value as ServeConfig;
    else if (key === "profiles" && isRecord(value)) known.profiles = value as Record<string, ProfileConfig>;
    else if (key === "defaultProfile" && typeof value === "string") known.defaultProfile = value;
  }
  return known;
}

/**
 * Persist config, ensuring the data dir exists (mode 0700) and the file is
 * written with mode 0600. `chmodSync` is applied unconditionally so a file
 * that pre-existed with looser perms gets tightened.
 */
export function saveConfig(cfg: ValetConfig): void {
  const path = configPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // recursive:true won't chmod an already-existing dir — force it.
  chmodSync(dir, 0o700);

  const json = `${JSON.stringify(cfg, null, 2)}\n`;
  writeFileSync(path, json, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
