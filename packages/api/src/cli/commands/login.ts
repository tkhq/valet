/**
 * `valet login <url>` — sign in to an instance, verify the credential, then
 * persist it as a named profile and make it the default.
 *
 * Structure (mirrors `sessions`/`send`): `run` is a thin shell that builds the
 * real deps and delegates to the pure, injectable `runLogin`. Tests pass a
 * stub client factory, a scripted `readSecret`, and a stub browser sign-in.
 *
 * Credential precedence:
 *   1. `--api-key <key>`: use that key (scripts and CI).
 *   2. `--api-key -`: read a key from stdin, or from a hidden prompt on a TTY.
 *      Use it on a remote machine, where the browser cannot reach the CLI.
 *   3. `--api-key=` or a bare `--api-key`: keyless, for a local stub instance.
 *   4. Otherwise: keyless if the instance runs stub auth, else browser sign-in
 *      (`cli/browser-login.ts`), which mints a personal API key for this
 *      computer after the person approves it in the browser.
 *
 * The key is verified via `client.me()` BEFORE anything is written: an
 * `AuthError` prints a failure and returns `AuthFailure` with NO config write.
 * The key is never echoed back to the user.
 */
import { InstanceClient } from "../client.js";
import type { ValetConfig } from "../config.js";
import { saveConfig } from "../config.js";
import { BROWSER_LOGIN_TIMEOUT_MS, browserLogin, openInBrowser } from "../browser-login.js";
import { AuthError, ExitCode, UnreachableError } from "../exit.js";
import { parseGlobalFlags, printErr, printLine, type ParsedFlags } from "../output.js";
import type { CliContext } from "../types.js";
import type { AuthConfigResponse, GetMeResponse } from "../../wire/types.js";

/** The subset of `InstanceClient` the `login` command needs. */
export interface LoginClient {
  me(): Promise<GetMeResponse>;
}

/** Injectable dependencies for `runLogin`. */
export interface LoginDeps {
  /** Build a client for a url + optional key (real: `new InstanceClient`). */
  makeClient(opts: { url: string; apiKey?: string }): LoginClient;
  /** Read a secret interactively (hidden TTY) or from stdin; `undefined` = keyless. */
  readSecret(): Promise<string | undefined>;
  /** `GET /api/auth-config`: whether the instance runs stub auth (no credential needed). */
  authConfig(url: string): Promise<Pick<AuthConfigResponse, "stub">>;
  /** Sign in through the browser and return a new API key. Throws `AuthError` on denial or timeout. */
  browserLogin(url: string, opts: { openBrowser: boolean }): Promise<string>;
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
 * process exit code. Never echoes the key.
 */
export async function runLogin(deps: LoginDeps, flags: ParsedFlags, config: ValetConfig): Promise<number> {
  const url = flags.rest[0];
  if (url === undefined || url === "") {
    printErr("usage: valet login <url> [--name <name>] [--no-browser] [--api-key <key> | --api-key -]");
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

  // Resolve the credential: flags first, else browser sign-in.
  let apiKey: string | undefined;
  const fromFlags = apiKeyFromFlags(flags);
  if (typeof fromFlags === "string") {
    apiKey = fromFlags;
  } else if (fromFlags && "prompt" in fromFlags) {
    apiKey = await deps.readSecret();
  } else if (fromFlags) {
    apiKey = undefined; // explicit keyless
  } else {
    const base = url.replace(/\/$/, "");
    const { stub } = await deps.authConfig(base);
    if (!stub) {
      try {
        apiKey = await deps.browserLogin(base, { openBrowser: flags.flags["no-browser"] !== true });
      } catch (err) {
        if (err instanceof AuthError) {
          printErr(`valet login: ${err.message} Profile not saved.`);
          return ExitCode.AuthFailure;
        }
        throw err;
      }
    }
  }

  // Verify BEFORE persisting.
  const client = deps.makeClient({ url, apiKey });
  try {
    await client.me();
  } catch (err) {
    if (err instanceof AuthError) {
      printErr(`valet login: authentication failed for ${url} — profile not saved`);
      return ExitCode.AuthFailure;
    }
    throw err; // UnreachableError / ApiError propagate to the dispatcher.
  }

  const profile = apiKey !== undefined ? { url, apiKey } : { url };
  const next: ValetConfig = {
    ...config,
    profiles: { ...(config.profiles ?? {}), [name]: profile },
    defaultProfile: name,
  };
  saveConfig(next);

  printLine(`logged in to ${url} as profile "${name}"${apiKey === undefined ? " (keyless)" : ""}`);
  return ExitCode.OK;
}

/**
 * Read a secret from a TTY with the input muted, or from stdin when piped.
 * Lazily imports `node:readline` so non-`login` commands never pay for it and
 * the module stays side-effect-free on import.
 */
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
    authConfig,
    browserLogin: (url, opts) => {
      if (process.env.SSH_CONNECTION) {
        printErr(`On a remote machine, the browser cannot reach this CLI. Press Ctrl-C and run \`valet login ${url} --api-key -\` instead.`);
      }
      return browserLogin({
        url,
        openUrl: opts.openBrowser ? openInBrowser : () => Promise.resolve(false),
        log: printErr,
        timeoutMs: BROWSER_LOGIN_TIMEOUT_MS,
      });
    },
  };
  return runLogin(deps, flags, ctx.config);
}
