/**
 * Shared plumbing for CLI commands that call an instance: resolve the
 * profile, build the client, and read typed flag values. Commands keep a
 * pure `run*` function that takes the client, so tests inject a fake.
 */
import { readFileSync } from "node:fs";
import { InstanceClient } from "./client.js";
import { ExitCode } from "./exit.js";
import { parseGlobalFlags, printErr, type ParsedFlags } from "./output.js";
import { resolveInstance } from "./resolve.js";
import type { CliContext } from "./types.js";

/** A string flag's value, or undefined when absent or given as a bare boolean. */
export function strFlag(flags: ParsedFlags, name: string): string | undefined {
  const value = flags.flags[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * A positive whole-number flag. Returns the number, undefined when absent,
 * or an error message naming the fix.
 */
export function intFlag(flags: ParsedFlags, name: string): number | undefined | { error: string } {
  const raw = strFlag(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return { error: `Set --${name} to a whole number of 0 or more.` };
  return value;
}

/** Reads a file, or stdin for "-". */
export async function readSource(source: string): Promise<string> {
  if (source !== "-") return readFileSync(source, "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Parses a JSON object flag value, or returns an error message naming the fix. */
export function parseJsonObject(raw: string, flag: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `--${flag} is not valid JSON. Pass a JSON object, e.g. --${flag} '{"name":"value"}'.` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, error: `--${flag} must be a JSON object.` };
  return { ok: true, value: Object.fromEntries(Object.entries(parsed)) };
}

/** Prints a usage error and returns the usage exit code. */
export function usage(text: string): number {
  printErr(text);
  return ExitCode.Usage;
}

/** Entry-point glue: parse flags, resolve the profile, and run the command with a real client. */
export async function runWithClient(
  args: string[],
  ctx: CliContext,
  fn: (client: InstanceClient, flags: ParsedFlags) => Promise<number>,
): Promise<number> {
  const flags = parseGlobalFlags(args);
  const instance = resolveInstance({
    flag: strFlag(flags, "instance"),
    env: process.env.VALET_INSTANCE,
    config: ctx.config,
  });
  return fn(new InstanceClient({ url: instance.url, apiKey: instance.apiKey }), flags);
}
