/**
 * `valet instance list|use` — manage named instance profiles.
 *
 * - `list`  prints every profile (url + a marker for the default). `--json`
 *   emits `{ profiles, defaultProfile }`; api keys are NEVER emitted — only a
 *   `hasKey: boolean` flag.
 * - `use <name>` sets `defaultProfile`; a missing profile throws
 *   `ProfileNotFoundError` (exit 2).
 *
 * The pure `runInstance` is exported for tests; it persists via `saveConfig`
 * (tests point `VALET_DATA_DIR` at a temp dir).
 */
import type { ValetConfig } from "../config.js";
import { saveConfig } from "../config.js";
import { ExitCode, ProfileNotFoundError } from "../exit.js";
import { parseGlobalFlags, printErr, printJson, printLine, renderTable, type ParsedFlags } from "../output.js";
import type { CliContext } from "../types.js";

const USAGE = "usage: valet instance <list|use>";

/** Key-masked JSON view of the profiles: url + `hasKey`, never the key itself. */
export interface InstanceListJson {
  profiles: Record<string, { url: string; hasKey: boolean }>;
  defaultProfile?: string;
}

/** Build the masked JSON view of a config's profiles. Pure — exported for tests. */
export function buildListJson(config: ValetConfig): InstanceListJson {
  const profiles: Record<string, { url: string; hasKey: boolean }> = {};
  for (const [name, p] of Object.entries(config.profiles ?? {})) {
    profiles[name] = { url: p.url, hasKey: p.apiKey !== undefined && p.apiKey !== "" };
  }
  const out: InstanceListJson = { profiles };
  if (config.defaultProfile !== undefined) out.defaultProfile = config.defaultProfile;
  return out;
}

function instanceList(config: ValetConfig, json: boolean): number {
  if (json) {
    printJson(buildListJson(config));
    return ExitCode.OK;
  }
  const names = Object.keys(config.profiles ?? {}).sort();
  if (names.length === 0) {
    printLine("no profiles. Run `valet login <url>` to add one.");
    return ExitCode.OK;
  }
  const profiles = config.profiles ?? {};
  const rows = names.map((name) => [
    config.defaultProfile === name ? "*" : "",
    name,
    profiles[name].url,
  ]);
  printLine(renderTable(["", "NAME", "URL"], rows));
  return ExitCode.OK;
}

function instanceUse(config: ValetConfig, name: string | undefined): number {
  if (name === undefined || name === "") {
    printErr("usage: valet instance use <name>");
    return ExitCode.Usage;
  }
  if (!(name in (config.profiles ?? {}))) throw new ProfileNotFoundError(name);
  saveConfig({ ...config, defaultProfile: name });
  printLine(`default instance set to "${name}"`);
  return ExitCode.OK;
}

/** Pure dispatch over the `instance` subcommands. */
export function runInstance(config: ValetConfig, flags: ParsedFlags): number {
  switch (flags.rest[0]) {
    case "list":
      return instanceList(config, flags.json);
    case "use":
      return instanceUse(config, flags.rest[1]);
    default:
      printErr(USAGE);
      return ExitCode.Usage;
  }
}

export function run(args: string[], ctx: CliContext): number {
  return runInstance(ctx.config, parseGlobalFlags(args));
}
