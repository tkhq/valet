/**
 * `valet login <url>` — verify a credential against an instance, then persist
 * it as a named profile and make it the default.
 *
 * Structure (mirrors `sessions`/`send`): `run` is a thin shell that builds the
 * real deps (an `InstanceClient` factory + an interactive hidden-input reader)
 * and delegates to the pure, injectable `runLogin`. Tests pass a stub client
 * factory and a scripted `readSecret` — no live server, no TTY, no casts.
 *
 * Credential precedence:
 *   1. `--api-key <key>` flag (non-interactive / scriptable / testable).
 *      An empty value (`--api-key=` or a bare `--api-key`) means "keyless" —
 *      used for local stub instances that need no credential.
 *   2. Otherwise `readSecret()`: hidden prompt on a TTY, or stdin when piped.
 *
 * The key is verified via `client.me()` BEFORE anything is written: an
 * `AuthError` prints a failure and returns `AuthFailure` with NO config write.
 * The key is never echoed back to the user.
 */
import { InstanceClient } from "../client.js";
import type { ValetConfig } from "../config.js";
import { saveConfig } from "../config.js";
import { AuthError, ExitCode } from "../exit.js";
import { parseGlobalFlags, printErr, printLine, type ParsedFlags } from "../output.js";
import type { CliContext } from "../types.js";
import type { MeResponse } from "../../wire/types.js";

/** The subset of `InstanceClient` the `login` command needs. */
export interface LoginClient {
  me(): Promise<MeResponse>;
}

/** Injectable dependencies for `runLogin`. */
export interface LoginDeps {
  /** Build a client for a url + optional key (real: `new InstanceClient`). */
  makeClient(opts: { url: string; apiKey?: string }): LoginClient;
  /** Read a secret interactively (hidden TTY) or from stdin; `undefined` = keyless. */
  readSecret(): Promise<string | undefined>;
}

/**
 * Resolve the api key from the parsed flags, WITHOUT prompting.
 *
 * - a non-empty `--api-key` string → that key.
 * - `--api-key` present but empty (`--api-key=` or bare `--api-key` → boolean) →
 *   the sentinel `{ keyless: true }` (verify + save a keyless profile).
 * - the flag absent → `undefined` (caller should prompt via `readSecret`).
 */
export function apiKeyFromFlags(flags: ParsedFlags): string | { keyless: true } | undefined {
  const raw = flags.flags["api-key"];
  if (raw === undefined) return undefined;
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
    printErr("usage: valet login <url> [--api-key <key>] [--name <name>]");
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

  // Resolve the credential: flag first, else prompt/stdin. An explicit keyless
  // flag skips the prompt entirely.
  let apiKey: string | undefined;
  const fromFlags = apiKeyFromFlags(flags);
  if (typeof fromFlags === "string") {
    apiKey = fromFlags;
  } else if (fromFlags !== undefined) {
    apiKey = undefined; // explicit keyless
  } else {
    apiKey = await deps.readSecret();
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
  const raw = (await promptHidden("API key (blank for none): ")).trim();
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

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const flags = parseGlobalFlags(args);
  const deps: LoginDeps = {
    makeClient: (opts) => new InstanceClient(opts),
    readSecret,
  };
  return runLogin(deps, flags, ctx.config);
}
