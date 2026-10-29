/**
 * `valet logout <name>` (or `--instance <name>`) — remove an instance profile.
 *
 * A profile with `valet proxy setup` keys gets `valet proxy remove` for each
 * harness first: its settings are undone and its key is revoked.
 *
 * If the removed profile was the `defaultProfile`, the default is repointed to
 * the first remaining profile (chosen deterministically by sorted name) or
 * cleared when none remain. A missing profile throws `ProfileNotFoundError`
 * (exit 2). The pure `runLogout` is exported for tests; it operates on the
 * passed config and persists via `saveConfig` (tests point `VALET_DATA_DIR` at
 * a temp dir).
 */
import type { ProfileConfig, ValetConfig } from "../config.js";
import { harnessAdapter } from "../proxy/harnesses/index.js";
import { realProxyDeps, removeProxySetup } from "./proxy.js";
import { loadConfig, saveConfig, withConfigLock } from "../config.js";
import { ExitCode, ProfileNotFoundError } from "../exit.js";
import { parseGlobalFlags, printErr, printLine } from "../output.js";
import { refreshDeviceLogin, revokeDeviceLogin } from "../device-login.js";
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

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const flags = parseGlobalFlags(args);
  const name =
    flags.rest[0] ?? (typeof flags.flags.instance === "string" ? flags.flags.instance : undefined);
  // Sign a device sign-in out on the server too, so its token stops working
  // now rather than when it expires.
  const profile = name ? ctx.config.profiles?.[name] : undefined;
  // Undo `valet proxy setup` first, while the CLI token can still revoke the
  // keys: a forgotten key would keep working, and the harness would run a
  // key helper for a profile that is gone.
  let cli = profile?.cli;
  if (name && profile?.proxyKeys) {
    // Logout skips the usual refresh; revoking the keys needs a live token.
    if (cli && cli.accessExpiresAt <= Date.now()) {
      const fresh = await refreshDeviceLogin(profile.url.replace(/\/$/, ""), cli.refreshToken).catch(() => undefined);
      if (fresh) cli = { ...cli, accessToken: fresh.access_token, refreshToken: fresh.refresh_token };
    }
    await removeProxySetups(name, { ...profile, cli });
  }
  if (profile && cli) await revokeDeviceLogin(profile.url.replace(/\/$/, ""), cli.refreshToken);
  // Reload under the lock, so a refresh another command saved meanwhile is kept.
  return withConfigLock(async () => runLogout(loadConfig(), name));
}

/** Run `valet proxy remove` for every harness the profile set up. */
async function removeProxySetups(name: string, profile: ProfileConfig): Promise<void> {
  const deps = realProxyDeps();
  const instance = { name, url: profile.url, apiKey: profile.cli?.accessToken ?? profile.apiKey };
  for (const harness of Object.keys(profile.proxyKeys ?? {})) {
    const adapter = harnessAdapter(harness);
    if (adapter) await removeProxySetup(instance, profile, adapter, deps);
    else printErr(`warning: proxy key for unknown harness "${harness}" was not revoked. Revoke it in Settings > API keys.`);
  }
}
