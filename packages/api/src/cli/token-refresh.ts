/**
 * Keep a `valet login` device sign-in fresh. The dispatcher calls this
 * before a command runs: if the selected profile's access token expires
 * within REFRESH_WINDOW_MS, it gets a new token pair and saves it. A long
 * command (`chat`) then has hours of validity left.
 *
 * A refresh token works once, so two commands that start together must not
 * both refresh. A lock file next to the config file serializes them. The
 * command that waited reloads the config, finds the fresh pair the other
 * one saved, and uses it. A refresh whose response was lost is retried
 * once; the server accepts that replay (`auth/cli-tokens.ts`).
 *
 * A failed refresh changes nothing. The command then gets a 401, and the
 * error tells the person to run `valet login` again.
 */
import { openSync, closeSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { configPath, loadConfig, saveConfig, type ValetConfig } from "./config.js";
import { refreshDeviceLogin } from "./device-login.js";
import { UnreachableError } from "./exit.js";

const REFRESH_WINDOW_MS = 12 * 60 * 60_000;
const LOCK_WAIT_MS = 10_000;
/** A lock older than this is left over from a crashed command. */
const LOCK_STALE_MS = 30_000;

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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exclusive-create lock file beside the config. Gives up after LOCK_WAIT_MS and runs anyway. */
async function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const path = join(dirname(configPath()), "refresh.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (!held && Date.now() < deadline) {
    try {
      closeSync(openSync(path, "wx", 0o600));
      held = true;
    } catch {
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) unlinkSync(path);
      } catch {
        // Gone already: the next attempt creates it.
      }
      if (!held) await sleep(150);
    }
  }
  try {
    return await fn();
  } finally {
    if (held) {
      try {
        unlinkSync(path);
      } catch {
        // Removed by a stale-lock cleanup: nothing to release.
      }
    }
  }
}

const defaultDeps: RefreshDeps = { refresh: refreshDeviceLogin, save: saveConfig, now: Date.now, reload: () => loadConfig(), withLock: withFileLock };

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
export async function latestCredential(url: string, stale: string | undefined, deps: RefreshDeps = defaultDeps): Promise<string | undefined> {
  if (!stale?.startsWith("vltc_")) return stale;
  const base = url.replace(/\/$/, "");
  let config: ValetConfig;
  try {
    config = deps.reload();
  } catch {
    return stale;
  }
  const entry = Object.entries(config.profiles ?? {}).find(([, p]) => p.cli !== undefined && p.url.replace(/\/$/, "") === base);
  if (!entry) return stale;
  const [name, profile] = entry;
  if (profile.cli && profile.cli.accessToken !== stale) return profile.cli.accessToken;
  const next = await refreshSelectedProfile(config, ["--instance", name], deps);
  return next.profiles?.[name]?.cli?.accessToken ?? stale;
}
