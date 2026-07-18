/**
 * `valet logout <name>` (or `--instance <name>`) — remove an instance profile.
 *
 * If the removed profile was the `defaultProfile`, the default is repointed to
 * the first remaining profile (chosen deterministically by sorted name) or
 * cleared when none remain. A missing profile throws `ProfileNotFoundError`
 * (exit 2). The pure `runLogout` is exported for tests; it operates on the
 * passed config and persists via `saveConfig` (tests point `VALET_DATA_DIR` at
 * a temp dir).
 */
import type { ValetConfig } from "../config.js";
import { saveConfig } from "../config.js";
import { ExitCode, ProfileNotFoundError } from "../exit.js";
import { parseGlobalFlags, printErr, printLine } from "../output.js";
import type { CliContext } from "../types.js";

/**
 * Compute the config after removing `name`. Pure — returns a NEW config and
 * throws `ProfileNotFoundError` if the profile is absent. Repoints
 * `defaultProfile` deterministically (sorted first remaining) or clears it.
 */
export function removeProfile(config: ValetConfig, name: string): ValetConfig {
  const profiles = config.profiles ?? {};
  if (!(name in profiles)) throw new ProfileNotFoundError(name);

  const nextProfiles = { ...profiles };
  delete nextProfiles[name];

  const next: ValetConfig = { ...config, profiles: nextProfiles };

  if (config.defaultProfile === name) {
    const remaining = Object.keys(nextProfiles).sort();
    if (remaining.length > 0) next.defaultProfile = remaining[0];
    else delete next.defaultProfile;
  }
  return next;
}

/** Pure entry: remove the named profile, persist, confirm. */
export function runLogout(config: ValetConfig, name: string | undefined): number {
  if (name === undefined || name === "") {
    printErr("usage: valet logout <name>");
    return ExitCode.Usage;
  }
  const next = removeProfile(config, name); // throws ProfileNotFoundError if absent
  saveConfig(next);

  if (next.defaultProfile !== undefined && next.defaultProfile !== config.defaultProfile) {
    printLine(`removed profile "${name}" (default is now "${next.defaultProfile}")`);
  } else if (config.defaultProfile === name) {
    printLine(`removed profile "${name}" (no default profile set)`);
  } else {
    printLine(`removed profile "${name}"`);
  }
  return ExitCode.OK;
}

export function run(args: string[], ctx: CliContext): number {
  const flags = parseGlobalFlags(args);
  const name =
    flags.rest[0] ?? (typeof flags.flags.instance === "string" ? flags.flags.instance : undefined);
  return runLogout(ctx.config, name);
}
