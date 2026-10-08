/**
 * Keep a `valet login` device sign-in fresh. The dispatcher calls this
 * before a command runs: if the selected profile's access token expires
 * within REFRESH_WINDOW_MS, it gets a new token pair and saves it. A long
 * command (`chat`) then has hours of validity left.
 *
 * A refresh token works once, so two commands that start together must not
 * both refresh. The config lock (`withConfigLock`) serializes them. The
 * command that waited reloads the config, finds the fresh pair the other
 * one saved, and uses it. A refresh whose response was lost is retried
 * once; the server accepts that replay (`auth/cli-tokens.ts`).
 *
 * A failed refresh changes nothing. The command then gets a 401, and the
 * error tells the person to run `valet login` again.
 */
import { loadConfig, saveConfig, withConfigLock, type ValetConfig } from "./config.js";
import { refreshDeviceLogin } from "./device-login.js";
import { UnreachableError } from "./exit.js";

const REFRESH_WINDOW_MS = 12 * 60 * 60_000;
/** Replaced access tokens a profile remembers, so a long command finds it again. */
const PREVIOUS_TOKENS_KEPT = 3;

export interface RefreshDeps {
  refresh: typeof refreshDeviceLogin;
  save: (config: ValetConfig) => void;
  now: () => number;
  /** Re-read the config file after waiting for another command's refresh. */
  reload: () => ValetConfig;
  /** Run `fn` while holding the refresh lock. */
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
}

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

function needsRefresh(config: ValetConfig, name: string, now: number): boolean {
  const cli = config.profiles?.[name]?.cli;
  return cli !== undefined && cli.accessExpiresAt - now <= REFRESH_WINDOW_MS;
}

const defaultDeps: RefreshDeps = { refresh: refreshDeviceLogin, save: saveConfig, now: Date.now, reload: () => loadConfig(), withLock: (fn) => withConfigLock(fn) };

export async function refreshSelectedProfile(config: ValetConfig, args: string[], deps: RefreshDeps = defaultDeps): Promise<ValetConfig> {
  const name = selectedProfile(config, args);
  if (!name || !needsRefresh(config, name, deps.now())) return config;
  return deps.withLock(async () => {
    // Another command may have refreshed while this one waited for the lock.
    const current = deps.reload();
    if (!needsRefresh(current, name, deps.now())) return current;
    const profile = current.profiles?.[name];
    const cli = profile?.cli;
    if (!profile || !cli) return current;
    const url = profile.url.replace(/\/$/, "");
    let fresh: Awaited<ReturnType<typeof refreshDeviceLogin>>;
    try {
      fresh = await deps.refresh(url, cli.refreshToken);
    } catch (err) {
      if (!(err instanceof UnreachableError)) return current;
      // The request may have reached the server and lost its response.
      try {
        fresh = await deps.refresh(url, cli.refreshToken);
      } catch {
        return current; // Still unreachable: the command reports it.
      }
    }
    if (!fresh) return current;
    const next: ValetConfig = {
      ...current,
      profiles: {
        ...current.profiles,
        [name]: {
          ...profile,
          cli: {
            accessToken: fresh.access_token,
            refreshToken: fresh.refresh_token,
            accessExpiresAt: fresh.access_expires_at,
            refreshExpiresAt: fresh.refresh_expires_at,
            previousAccessTokens: [cli.accessToken, ...(cli.previousAccessTokens ?? [])].slice(0, PREVIOUS_TOKENS_KEPT),
          },
        },
      },
    };
    deps.save(next);
    return next;
  });
}

/**
 * The newest credential for a long-running command that started with
 * `stale`. Another command may have refreshed the profile since, which
 * retires `stale` after the server's short grace, or the token may be near
 * expiry. A non-CLI credential (an API key) comes back unchanged.
 */
export async function latestCredential(stale: string | undefined, deps: RefreshDeps = defaultDeps): Promise<string | undefined> {
  if (!stale?.startsWith("vltc_")) return stale;
  let config: ValetConfig;
  try {
    config = deps.reload();
  } catch {
    return stale;
  }
  // Only the profile that held `stale`, never another profile for the same
  // URL: two people can sign in to one instance from one computer.
  const entry = Object.entries(config.profiles ?? {}).find(([, p]) =>
    p.cli !== undefined && (p.cli.accessToken === stale || (p.cli.previousAccessTokens ?? []).includes(stale)));
  if (!entry) return stale;
  const [name, profile] = entry;
  if (profile.cli && profile.cli.accessToken !== stale) return profile.cli.accessToken;
  const next = await refreshSelectedProfile(config, ["--instance", name], deps);
  return next.profiles?.[name]?.cli?.accessToken ?? stale;
}
