/**
 * `valet login <url>` — sign in to an instance, verify the credential, then
 * persist it as a named profile and make it the default.
 *
 * Structure (mirrors `sessions`/`send`): `run` is a thin shell that builds the
 * real deps and delegates to the pure, injectable `runLogin`. Tests pass a
 * stub client factory, a scripted `readSecret`, and a stub device sign-in.
 *
 * Credential precedence:
 *   1. `--api-key <key>`: use that key (scripts and CI).
 *   2. `--api-key -`: read a key from stdin, or from a hidden prompt on a TTY.
 *   3. `--api-key=` or a bare `--api-key`: keyless, for a local stub instance.
 *   4. No flag, but a key piped on stdin: use that key, as older versions did.
 *   5. Otherwise: keyless if the instance runs stub auth, else device sign-in
 *      (`cli/device-login.ts`): the person enters a code in a browser on any
 *      computer, and the CLI gets a CLI token pair. No API key is created.
 *
 * A device sign-in is saved in `pendingLogins` until it ends, and a later
 * `valet login` for the same profile resumes it. `--no-wait` starts one,
 * prints the code, and exits, so an agent whose commands cannot run for
 * minutes can finish the sign-in with a second `valet login`.
 *
 * The credential is verified via `client.me()` BEFORE anything is written: an
 * `AuthError` prints a failure and returns `AuthFailure` with NO config write.
 * A credential is never echoed back to the user.
 */
import { InstanceClient } from "../client.js";
import type { PendingLogin, ProfileConfig, ValetConfig } from "../config.js";
import { updateConfig } from "../config.js";
import { deviceCodeInstructions, openInBrowser, pollDeviceLogin, revokeDeviceLogin, startDeviceLogin } from "../device-login.js";
import { AuthError, ExitCode, UnreachableError } from "../exit.js";
import { parseGlobalFlags, printErr, printLine, type ParsedFlags } from "../output.js";
import type { CliContext } from "../types.js";
import type { AuthConfigResponse, CliTokenResponse, GetMeResponse } from "../../wire/types.js";

/** The subset of `InstanceClient` the `login` command needs. */
export interface LoginClient {
  me(): Promise<GetMeResponse>;
}

/** Injectable dependencies for `runLogin`. */
export interface LoginDeps {
  /** Build a client for a url + optional credential (real: `new InstanceClient`). */
  makeClient(opts: { url: string; apiKey?: string }): LoginClient;
  /** Read a secret interactively (hidden TTY) or from stdin; `undefined` = keyless. */
  readSecret(): Promise<string | undefined>;
  /** A key piped on stdin with no flag (`printf %s "$KEY" | valet login <url>`), or undefined. Never waits on a terminal. */
  pipedKey(): Promise<string | undefined>;
  /** `GET /api/auth-config`: whether the instance runs stub auth (no credential needed). */
  authConfig(url: string): Promise<Pick<AuthConfigResponse, "stub">>;
  /** Start a device sign-in (`POST /api/cli/device/code`). */
  startDevice(url: string): Promise<PendingLogin>;
  /** Poll a device sign-in until it ends. Throws `AuthError` on denial or expiry. */
  pollDevice(pending: PendingLogin): Promise<CliTokenResponse>;
  /** Open the page where the person enters the code. False when nothing opened it. */
  openUrl(url: string): Promise<boolean>;
  now(): number;
  /** Sign out a replaced device sign-in on the server. Best effort. */
  revoke(url: string, token: string): Promise<void>;
}

/**
 * Resolve the api key from the parsed flags, WITHOUT prompting.
 *
 * - a non-empty `--api-key` string other than `-` → that key.
 * - `--api-key -` → `{ prompt: true }` (read it from stdin or a hidden prompt).
 * - `--api-key` present but empty (`--api-key=` or bare `--api-key` → boolean) →
 *   `{ keyless: true }` (verify + save a keyless profile).
 * - the flag absent → `undefined` (caller signs in through the browser).
 */
export function apiKeyFromFlags(flags: ParsedFlags): string | { keyless: true } | { prompt: true } | undefined {
  const raw = flags.flags["api-key"];
  if (raw === undefined) return undefined;
  if (raw === "-") return { prompt: true };
  if (typeof raw === "string" && raw !== "") return raw;
  // Present but empty / boolean → explicit keyless.
  return { keyless: true };
}

/** Derive a default profile name from a url's host (`http://localhost:8788` → `localhost:8788`). */
export function profileNameForUrl(url: string): string {
  return new URL(url).host;
}

/**
 * Pure login: resolve the credential, verify it, then persist. Returns the
 * process exit code. Never echoes a credential.
 */
export async function runLogin(deps: LoginDeps, flags: ParsedFlags, config: ValetConfig): Promise<number> {
  const url = flags.rest[0];
  if (url === undefined || url === "") {
    printErr("usage: valet login <url> [--name <name>] [--no-browser] [--no-wait] [--api-key <key> | --api-key -]");
    return ExitCode.Usage;
  }

  let name: string;
  const nameFlag = flags.flags.name;
  if (typeof nameFlag === "string" && nameFlag !== "") {
    name = nameFlag;
  } else {
    try {
      name = profileNameForUrl(url);
    } catch {
      printErr(`valet login: invalid url "${url}"`);
      return ExitCode.Usage;
    }
  }

  // Resolve the credential: flags first, else device sign-in.
  let profile: ProfileConfig = { url };
  const fromFlags = apiKeyFromFlags(flags);
  if (typeof fromFlags === "string") {
    profile = { url, apiKey: fromFlags };
  } else if (fromFlags && "prompt" in fromFlags) {
    const key = await deps.readSecret();
    if (key !== undefined) profile = { url, apiKey: key };
  } else if (!fromFlags) {
    const base = url.replace(/\/$/, "");
    const piped = await deps.pipedKey();
    const { stub } = piped === undefined ? await deps.authConfig(base) : { stub: true };
    if (piped !== undefined) {
      profile = { url, apiKey: piped };
      printErr("valet login: using the API key from stdin. Pass --api-key - to make that explicit.");
    } else if (!stub) {
      const outcome = await signInWithDevice(deps, flags, config, name, url);
      if (typeof outcome === "number") return outcome;
      profile = outcome;
    }
  }

  // Verify BEFORE persisting.
  const credential = profile.cli?.accessToken ?? profile.apiKey;
  const client = deps.makeClient({ url, apiKey: credential });
  try {
    await client.me();
  } catch (err) {
    if (err instanceof AuthError) {
      printErr(`valet login: authentication failed for ${url}. Profile not saved. Check the key, or run \`valet login ${url}\` to sign in through the browser.`);
      return ExitCode.AuthFailure;
    }
    throw err; // UnreachableError / ApiError propagate to the dispatcher.
  }

  // A replaced device sign-in would otherwise stay valid until it expires.
  const replaced = config.profiles?.[name]?.cli;
  if (replaced) await deps.revoke(config.profiles?.[name]?.url.replace(/\/$/, "") ?? url, replaced.refreshToken);

  // Reload under the lock: while this login waited, another command may have
  // refreshed a profile, and saving the startup copy would undo that.
  await updateConfig((current) => ({
    ...withoutPending(current, name),
    profiles: { ...(current.profiles ?? {}), [name]: profile },
    defaultProfile: name,
  }));

  printLine(`logged in to ${url} as profile "${name}"${credential === undefined ? " (keyless)" : ""}`);
  return ExitCode.OK;
}

/**
 * Read a secret from a TTY with the input muted, or from stdin when piped.
 * Lazily imports `node:readline` so non-`login` commands never pay for it and
 * the module stays side-effect-free on import.
 */
/** `config` without a waiting sign-in for profile `name`. */
function withoutPending(config: ValetConfig, name: string): ValetConfig {
  const { [name]: _ended, ...rest } = config.pendingLogins ?? {};
  return { ...config, pendingLogins: Object.keys(rest).length > 0 ? rest : undefined };
}

/**
 * Run or resume the device sign-in for profile `name`. Returns the profile
 * to verify and save, or an exit code when the command ends here.
 */
async function signInWithDevice(
  deps: LoginDeps,
  flags: ParsedFlags,
  config: ValetConfig,
  name: string,
  url: string,
): Promise<ProfileConfig | number> {
  const base = url.replace(/\/$/, "");
  const saved = config.pendingLogins?.[name];
  const resumed = saved !== undefined && saved.url === base && saved.expiresAt > deps.now();
  const pending = resumed ? saved : await deps.startDevice(base);
  if (!resumed) {
    await updateConfig((current) => ({ ...current, pendingLogins: { ...(current.pendingLogins ?? {}), [name]: pending } }));
  }
  const opened = !resumed && flags.flags["no-browser"] !== true && flags.flags["no-wait"] !== true
    ? await deps.openUrl(`${pending.url}${pending.verificationPath}`)
    : false;
  if (resumed) printErr(`Resuming the sign-in that waits for code ${pending.userCode} (open ${pending.url}${pending.verificationPath}).`);
  else for (const line of deviceCodeInstructions(pending, opened)) printErr(line);

  if (flags.flags["no-wait"] === true) {
    printErr(`When the person has chosen Allow, run \`valet login ${base} --name ${name}\` to finish. The code expires in ${Math.max(1, Math.round((pending.expiresAt - deps.now()) / 60_000))} minutes.`);
    return ExitCode.OK;
  }
  printErr("Waiting for approval...");
  let tokens: CliTokenResponse;
  try {
    tokens = await deps.pollDevice(pending);
  } catch (err) {
    if (err instanceof AuthError) {
      // The sign-in ended: forget it, so the next login starts a new one.
      await updateConfig((current) => withoutPending(current, name));
      printErr(`valet login: ${err.message} Profile not saved.`);
      return ExitCode.AuthFailure;
    }
    throw err;
  }
  return {
    url,
    cli: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessExpiresAt: tokens.access_expires_at,
      refreshExpiresAt: tokens.refresh_expires_at,
    },
  };
}

/**
 * A key piped on stdin. A pipe that brings no data within PIPE_WAIT_MS (an
 * agent's tool runner often leaves stdin open and empty) counts as none, so
 * the device sign-in starts instead of hanging.
 */
const PIPE_WAIT_MS = 500;

async function pipedKey(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      clearTimeout(timer); // Data arrived: wait for the end of the pipe.
    };
    const onEnd = (): void => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      finish(text === "" ? undefined : text);
    };
    const timer = setTimeout(() => finish(undefined), PIPE_WAIT_MS);
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });
}

async function readSecret(): Promise<string | undefined> {
  if (!process.stdin.isTTY) {
    const raw = (await readAllStdin()).trim();
    return raw === "" ? undefined : raw;
  }
  const raw = (await promptHidden("API key: ")).trim();
  return raw === "" ? undefined : raw;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function promptHidden(promptText: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  const { Writable } = await import("node:stream");
  let muted = false;
  // Only pass the prompt through; swallow keystroke echo once muted.
  const output = new Writable({
    write(chunk, _enc, cb): void {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return await new Promise<string>((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    // question() writes the prompt synchronously before returning; mute after
    // so the prompt shows but keystrokes don't echo.
    muted = true;
  });
}

async function authConfig(url: string): Promise<Pick<AuthConfigResponse, "stub">> {
  const endpoint = `${url}/api/auth-config`;
  let res: Response;
  try {
    res = await fetch(endpoint);
  } catch (err) {
    throw new UnreachableError(`could not reach ${endpoint}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new UnreachableError(`${endpoint} returned ${res.status}. Check that the URL is a Valet instance.`);
  const body = (await res.json()) as Partial<AuthConfigResponse>; // Public route; narrowed below.
  return { stub: body.stub === true };
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const flags = parseGlobalFlags(args);
  const deps: LoginDeps = {
    makeClient: (opts) => new InstanceClient(opts),
    readSecret,
    pipedKey,
    authConfig,
    startDevice: (url) => startDeviceLogin(url),
    pollDevice: (pending) => pollDeviceLogin(pending),
    openUrl: openInBrowser,
    now: Date.now,
    revoke: revokeDeviceLogin,
  };
  return runLogin(deps, flags, ctx.config);
}
