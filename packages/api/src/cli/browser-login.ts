/**
 * Browser sign-in for `valet login` (`docs/specs/2026-07-14-auth-v2-design.md`,
 * "CLI browser sign-in"). The server half is `routes/cli-login.ts`.
 *
 * 1. Listen on a random loopback port.
 * 2. Open `<instance>/cli/login` with a PKCE challenge and a random state.
 * 3. Wait for the browser to bring a one-time code to `/callback`.
 * 4. Exchange the code and the PKCE verifier for a personal API key.
 *
 * The key travels only in the exchange response, never through the browser.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import type { AddressInfo } from "node:net";
import { ApiError, AuthError, UnreachableError } from "./exit.js";
import type { CliLoginTokenResponse } from "../wire/types.js";

/** How long `valet login` waits for the person to approve in the browser. */
export const BROWSER_LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface BrowserLoginOpts {
  /** Instance base URL, trailing slash stripped. */
  url: string;
  /** Open a URL in the person's browser. Returns false when nothing could open it. */
  openUrl(url: string): Promise<boolean>;
  /** Write a line for the person (stderr in the real CLI). */
  log(line: string): void;
  timeoutMs?: number;
  /** Computer name shown on the approval page. */
  device?: string;
}

interface Callback {
  code?: string;
  error?: string;
}

const PAGE_STYLE = "font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5;color:#222";

function page(title: string, text: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="${PAGE_STYLE}"><h1 style="font-size:1.25rem">${title}</h1><p>${text}</p></body></html>`;
}

/** Sign in through the browser and return a new personal API key. */
export async function browserLogin(opts: BrowserLoginOpts): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");

  let settle: (cb: Callback) => void = () => undefined;
  const callback = new Promise<Callback>((resolve) => {
    settle = resolve;
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    // Ignore favicon probes and anything that is not this sign-in's callback.
    if (reqUrl.pathname !== "/callback" || reqUrl.searchParams.get("state") !== state) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    const error = reqUrl.searchParams.get("error") ?? undefined;
    const code = reqUrl.searchParams.get("code") ?? undefined;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(error || !code
      ? page("Sign-in canceled", "The Valet CLI was not signed in. You can close this tab.")
      : page("Valet CLI signed in", "You can close this tab and return to your terminal."));
    settle({ code, error: error ?? (code ? undefined : "missing_code") });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const { port } = server.address() as AddressInfo; // listen() on a TCP port always reports AddressInfo.
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const approveUrl = new URL(`${opts.url}/cli/login`);
    approveUrl.searchParams.set("redirect_uri", redirectUri);
    approveUrl.searchParams.set("code_challenge", challenge);
    approveUrl.searchParams.set("state", state);
    approveUrl.searchParams.set("device", opts.device ?? hostname());

    const opened = await opts.openUrl(approveUrl.toString());
    opts.log(opened
      ? "Opened your browser to sign in to Valet. Approve the sign-in there."
      : "Open this URL in a browser on this computer and approve the sign-in:");
    opts.log(`  ${approveUrl.toString()}`);
    opts.log("Waiting for approval...");

    const timeoutMs = opts.timeoutMs ?? BROWSER_LOGIN_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      callback,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));

    if (result === "timeout") {
      throw new AuthError(`no approval within ${Math.round(timeoutMs / 60_000)} minutes. Run \`valet login\` again.`);
    }
    if (result.error === "access_denied") throw new AuthError("the sign-in was denied in the browser.");
    if (!result.code) throw new AuthError("the browser returned no sign-in code. Run `valet login` again.");
    return await exchange(opts.url, result.code, verifier, redirectUri);
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

async function exchange(base: string, code: string, verifier: string, redirectUri: string): Promise<string> {
  const url = `${base}/api/cli/login/token`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirectUri }),
    });
  } catch (err) {
    throw new UnreachableError(`could not reach ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new ApiError(res.status, await res.text());
  const body = (await res.json()) as CliLoginTokenResponse; // The route's typed response (routes/cli-login.ts).
  if (typeof body.key !== "string" || body.key === "") throw new ApiError(res.status, "the sign-in returned no key");
  return body.key;
}

/** Open a URL with the platform's default handler. Resolves false if none started. */
export function openInBrowser(url: string): Promise<boolean> {
  const [cmd, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
