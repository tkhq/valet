/**
 * `valet config get|set` — view or edit the `serve` block via a dot-path key
 * (`serve.port`, `serve.sandbox`, `serve.dataDir`, `serve.authMode`).
 *
 * Scope is intentionally limited to the `serve` block: profiles and the default
 * are managed by `login`/`instance`, so `config set` cannot rewrite them. `set`
 * validates the key and coerces the value (port → integer; sandbox/authMode →
 * their enums). An unknown key warns to stderr and returns `Usage`.
 *
 * The pure `runConfig` is exported for tests; `set` persists via `saveConfig`
 * (tests point `VALET_DATA_DIR` at a temp dir).
 */
import type { ServeConfig, ValetConfig } from "../config.js";
import { saveConfig } from "../config.js";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags, printErr, printJson, printLine, type ParsedFlags } from "../output.js";
import type { CliContext } from "../types.js";

const USAGE = "usage: valet config <get|set> serve.<port|sandbox|dataDir|authMode|databaseUrl> [value]";

/** The settable `serve.*` fields. Anything else is rejected. */
const SERVE_FIELDS = ["port", "sandbox", "dataDir", "authMode", "databaseUrl"] as const;
type ServeField = (typeof SERVE_FIELDS)[number];

const SANDBOX_VALUES = ["docker", "local", "kubernetes"] as const;
const AUTH_VALUES = ["stub", "real"] as const;

function isServeField(v: string): v is ServeField {
  return (SERVE_FIELDS as readonly string[]).includes(v);
}

/**
 * Parse a `serve.<field>` dot-path key into its field. Returns `undefined` for
 * any key that isn't a known `serve.*` field (wrong prefix, wrong depth,
 * unknown leaf).
 */
export function parseServeKey(key: string): ServeField | undefined {
  const parts = key.split(".");
  if (parts.length !== 2 || parts[0] !== "serve") return undefined;
  return isServeField(parts[1]) ? parts[1] : undefined;
}

/** The coercion result: a typed value to store, or an error message. */
export type CoerceResult =
  | { ok: true; value: number | string }
  | { ok: false; error: string };

/** Coerce a raw string value for a serve field to its typed form, or fail. */
export function coerceServeValue(field: ServeField, raw: string): CoerceResult {
  switch (field) {
    case "port": {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        return { ok: false, error: `serve.port must be a positive integer (got "${raw}")` };
      }
      return { ok: true, value: n };
    }
    case "sandbox":
      if (!(SANDBOX_VALUES as readonly string[]).includes(raw)) {
        return { ok: false, error: `serve.sandbox must be one of ${SANDBOX_VALUES.join(", ")} (got "${raw}")` };
      }
      return { ok: true, value: raw };
    case "authMode":
      if (!(AUTH_VALUES as readonly string[]).includes(raw)) {
        return { ok: false, error: `serve.authMode must be one of ${AUTH_VALUES.join(", ")} (got "${raw}")` };
      }
      return { ok: true, value: raw };
    case "dataDir":
      if (raw === "") return { ok: false, error: "serve.dataDir must not be empty" };
      return { ok: true, value: raw };
    case "databaseUrl":
      if (raw === "") return { ok: false, error: "serve.databaseUrl must not be empty" };
      return { ok: true, value: raw };
  }
}

/**
 * Apply a coerced value onto a config's `serve` block, returning a NEW config.
 * Pure — exported for tests. The `value` is already typed/validated.
 */
export function setServeField(config: ValetConfig, field: ServeField, value: number | string): ValetConfig {
  const serve: ServeConfig = { ...(config.serve ?? {}) };
  // Narrow at runtime (no casts) — `coerceServeValue` guarantees the pairing,
  // but the compiler can't see that across the call boundary.
  if (field === "port") {
    if (typeof value === "number") serve.port = value;
  } else if (field === "sandbox") {
    if (value === "docker" || value === "local" || value === "kubernetes") serve.sandbox = value;
  } else if (field === "authMode") {
    if (value === "stub" || value === "real") serve.authMode = value;
  } else if (field === "dataDir") {
    if (typeof value === "string") serve.dataDir = value;
  } else if (field === "databaseUrl") {
    if (typeof value === "string") serve.databaseUrl = value;
  }
  return { ...config, serve };
}

/** Read a serve field's current value (`undefined` when unset). */
export function getServeField(config: ValetConfig, field: ServeField): number | string | undefined {
  return config.serve?.[field];
}

function configGet(config: ValetConfig, key: string | undefined, json: boolean): number {
  if (key === undefined) {
    printErr(USAGE);
    return ExitCode.Usage;
  }
  const field = parseServeKey(key);
  if (field === undefined) {
    printErr(`valet config: unknown key "${key}" (settable keys: ${SERVE_FIELDS.map((f) => `serve.${f}`).join(", ")})`);
    return ExitCode.Usage;
  }
  const value = getServeField(config, field);
  if (json) {
    printJson(value ?? null);
    return ExitCode.OK;
  }
  if (value === undefined) printLine(`${key} is not set`);
  else printLine(String(value));
  return ExitCode.OK;
}

function configSet(config: ValetConfig, key: string | undefined, raw: string | undefined): number {
  if (key === undefined || raw === undefined) {
    printErr("usage: valet config set serve.<key> <value>");
    return ExitCode.Usage;
  }
  const field = parseServeKey(key);
  if (field === undefined) {
    printErr(`valet config: unknown key "${key}" (settable keys: ${SERVE_FIELDS.map((f) => `serve.${f}`).join(", ")})`);
    return ExitCode.Usage;
  }
  const coerced = coerceServeValue(field, raw);
  if (!coerced.ok) {
    printErr(`valet config: ${coerced.error}`);
    return ExitCode.Usage;
  }
  saveConfig(setServeField(config, field, coerced.value));
  printLine(`${key} = ${coerced.value}`);
  return ExitCode.OK;
}

/** Pure dispatch over the `config` subcommands. */
export function runConfig(config: ValetConfig, flags: ParsedFlags): number {
  switch (flags.rest[0]) {
    case "get":
      return configGet(config, flags.rest[1], flags.json);
    case "set":
      return configSet(config, flags.rest[1], flags.rest[2]);
    default:
      printErr(USAGE);
      return ExitCode.Usage;
  }
}

export function run(args: string[], ctx: CliContext): number {
  return runConfig(ctx.config, parseGlobalFlags(args));
}
