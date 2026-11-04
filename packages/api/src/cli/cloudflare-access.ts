/**
 * Cloudflare Access support for the CLI.
 *
 * An instance behind a Cloudflare Access app answers a request without an
 * Access session with a 302 to `<team>.cloudflareaccess.com`. `fetch` follows
 * it and gets the HTML login page. Cloudflare's method for a person's CLI is
 * `cloudflared access`: sign in once in a browser, then send the token in a
 * `cf-access-token` header
 * (https://developers.cloudflare.com/cloudflare-one/tutorials/cli/).
 *
 * The CLI gets a token only after a request is blocked, so an instance
 * without Access never runs `cloudflared`. Token sources, in order:
 *   1. `VALET_CF_ACCESS_TOKEN`.
 *   2. `cloudflared access token -app=<origin>`.
 *   3. When stdin and stderr are a terminal: `cloudflared access login
 *      <origin>` (it opens a browser), then step 2 again.
 * The result is kept per origin for the life of the process.
 */
import { execFile, spawn } from "node:child_process";
import { AuthError } from "./exit.js";
import { printErr } from "./output.js";

export const ACCESS_TOKEN_HEADER = "cf-access-token";

const TOKEN_TIMEOUT_MS = 10_000;

/** Resolved tokens, read synchronously when a request builds its headers. */
const tokens = new Map<string, string>();
/** One lookup per origin, shared by concurrent requests. */
const lookups = new Map<string, Promise<string | undefined>>();

function originOf(url: string): string {
  return new URL(url).origin;
}

function isAccessHost(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname.endsWith(".cloudflareaccess.com");
  } catch {
    return false;
  }
}

/** True when Cloudflare Access sent the request to its login page. */
export function isAccessBlock(res: Response): boolean {
  if (res.redirected && isAccessHost(res.url)) return true;
  return res.status >= 300 && res.status < 400 && isAccessHost(res.headers.get("location"));
}

/** The `cf-access-token` header for this origin, when the process has a token. */
export function accessHeaders(url: string): Record<string, string> {
  const token = tokens.get(originOf(url));
  return token ? { [ACCESS_TOKEN_HEADER]: token } : {};
}

/** An error that tells the person how to get an Access token. */
export function accessBlockedMessage(url: string): string {
  const origin = originOf(url);
  return `Cloudflare Access blocked the request to ${origin}. Install cloudflared (brew install cloudflared), run \`cloudflared access login ${origin}\`, then retry.`;
}

function cloudflaredToken(origin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("cloudflared", ["access", "token", `-app=${origin}`], { timeout: TOKEN_TIMEOUT_MS }, (err, stdout) => {
      // Missing binary, no saved token, or timeout: no token.
      const token = err ? "" : String(stdout).trim();
      resolve(token === "" ? undefined : token);
    });
  });
}

function cloudflaredLogin(origin: string): Promise<void> {
  return new Promise((resolve) => {
    // The child's stdout goes to stderr, so piped command output stays clean.
    const child = spawn("cloudflared", ["access", "login", origin], { stdio: ["inherit", 2, "inherit"] });
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
}

async function lookup(origin: string): Promise<string | undefined> {
  const fromEnv = process.env.VALET_CF_ACCESS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const saved = await cloudflaredToken(origin);
  if (saved) return saved;
  if (!process.stdin.isTTY || !process.stderr.isTTY) return undefined;
  printErr(`Cloudflare Access protects ${origin}. Starting \`cloudflared access login\` to sign in.`);
  await cloudflaredLogin(origin);
  return cloudflaredToken(origin);
}

/** An Access token for this origin. Undefined when no source has one. */
export async function accessToken(url: string): Promise<string | undefined> {
  const origin = originOf(url);
  let pending = lookups.get(origin);
  if (!pending) {
    pending = lookup(origin);
    lookups.set(origin, pending);
  }
  const token = await pending;
  if (token) tokens.set(origin, token);
  return token;
}

/**
 * Send a request. If Cloudflare Access blocks it, get a token and send it
 * once more with `cf-access-token`. Throws `AuthError` when no token passes.
 * `send` must build a new request from the headers it gets.
 */
export async function withAccess(url: string, send: (headers: Record<string, string>) => Promise<Response>): Promise<Response> {
  const res = await send(accessHeaders(url));
  if (!isAccessBlock(res)) return res;
  await res.body?.cancel();
  if (await accessToken(url)) {
    const retried = await send(accessHeaders(url));
    if (!isAccessBlock(retried)) return retried;
    await retried.body?.cancel();
  }
  throw new AuthError(accessBlockedMessage(url));
}

/** Forget every token and lookup. For tests. */
export function resetAccessTokens(): void {
  tokens.clear();
  lookups.clear();
}
