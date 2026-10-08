/**
 * Keep a `valet login` device sign-in fresh. The dispatcher calls this
 * before a command runs: if the selected profile's access token expires
 * within REFRESH_WINDOW_MS, it gets a new token pair and saves it. A long
 * command (`chat`) then has hours of validity left.
 *
 * A failed refresh changes nothing. The command then gets a 401, and the
 * error tells the person to run `valet login` again.
 */
import { saveConfig, type ValetConfig } from "./config.js";
import { refreshDeviceLogin } from "./device-login.js";

const REFRESH_WINDOW_MS = 12 * 60 * 60_000;

/** The profile a command would use, by the same precedence as `resolveInstance`. */
function selectedProfile(config: ValetConfig, args: string[]): string | undefined {
  const i = args.findIndex((a) => a === "--instance" || a.startsWith("--instance="));
  if (i !== -1) {
    const arg = args[i];
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[i + 1];
    if (value) return value;
  }
  return process.env.VALET_INSTANCE || config.defaultProfile;
}

export async function refreshSelectedProfile(
  config: ValetConfig,
  args: string[],
  deps: { refresh: typeof refreshDeviceLogin; save: typeof saveConfig; now: () => number } = { refresh: refreshDeviceLogin, save: saveConfig, now: Date.now },
): Promise<ValetConfig> {
  const name = selectedProfile(config, args);
  const profile = name ? config.profiles?.[name] : undefined;
  const cli = profile?.cli;
  if (!name || !profile || !cli || cli.accessExpiresAt - deps.now() > REFRESH_WINDOW_MS) return config;
  let fresh: Awaited<ReturnType<typeof refreshDeviceLogin>>;
  try {
    fresh = await deps.refresh(profile.url.replace(/\/$/, ""), cli.refreshToken);
  } catch {
    return config; // Unreachable: the command reports it.
  }
  if (!fresh) return config;
  const next: ValetConfig = {
    ...config,
    profiles: {
      ...config.profiles,
      [name]: {
        ...profile,
        cli: {
          accessToken: fresh.access_token,
          refreshToken: fresh.refresh_token,
          accessExpiresAt: fresh.access_expires_at,
          refreshExpiresAt: fresh.refresh_expires_at,
        },
      },
    },
  };
  deps.save(next);
  return next;
}
