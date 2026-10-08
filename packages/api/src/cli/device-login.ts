/**
 * Device sign-in for `valet login` (`docs/specs/2026-07-14-auth-v2-design.md`,
 * "CLI device sign-in"). The server half is `routes/cli-device.ts`.
 *
 * 1. Ask the instance for a device code and a user code.
 * 2. Show the user code, and open `<instance>/cli/device` in a browser.
 * 3. Poll until the person enters the code there and chooses Allow.
 * 4. Receive a CLI token pair. No API key is created.
 *
 * Nothing listens on this computer, so the browser can be on any computer.
 */
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { ApiError, AuthError, UnreachableError } from "./exit.js";
import type { PendingLogin } from "./config.js";
import type { CliDeviceCodeResponse, CliTokenResponse } from "../wire/types.js";

export interface DeviceLoginOpts {
  /** Instance base URL, trailing slash stripped. */
  url: string;
  /** Open a URL in the person's browser. Returns false when nothing could open it. */
  openUrl(url: string): Promise<boolean>;
  /** Write a line for the person (stderr in the real CLI). */
  log(line: string): void;
  /** Computer name shown on the approval page. */
  device?: string;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

async function post<T>(url: string, body: unknown): Promise<{ status: number; body: T | { error?: string; error_description?: string } }> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (err) {
    throw new UnreachableError(`could not reach ${url}: ${(err as Error).message}`);
  }
  const text = await res.text();
  try {
    // The routes answer JSON; a non-JSON body is a proxy or a wrong URL.
    return { status: res.status, body: JSON.parse(text) as T };
  } catch {
    throw new ApiError(res.status, `${url} did not answer as a Valet instance. Check the URL.`);
  }
}

function errorOf(body: unknown): { error?: string; description?: string } {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  return {
    error: typeof b.error === "string" ? b.error : undefined,
    description: typeof b.error_description === "string" ? b.error_description : undefined,
  };
}

/** Ask the instance for a device code and a user code. */
export async function startDeviceLogin(url: string, device: string = hostname(), now: () => number = Date.now): Promise<PendingLogin> {
  const started = await post<CliDeviceCodeResponse>(`${url}/api/cli/device/code`, { device });
  if (started.status !== 200 || !("device_code" in started.body)) {
    throw new ApiError(started.status, errorOf(started.body).description ?? "the instance could not start a sign-in");
  }
  const code = started.body;
  return {
    url,
    deviceCode: code.device_code,
    userCode: code.user_code,
    verificationPath: code.verification_path,
    expiresAt: now() + code.expires_in * 1000,
    interval: code.interval,
  };
}

/** The lines that tell the person where to enter the code. */
export function deviceCodeInstructions(pending: PendingLogin, opened: boolean): string[] {
  const pageUrl = `${pending.url}${pending.verificationPath}`;
  return [
    `To sign in, ${opened ? "use the browser page that opened" : `open ${pageUrl} in a browser on any computer`}, and enter this code:`,
    "",
    `    ${pending.userCode}`,
    "",
  ];
}

/**
 * Poll until the person allows or denies the sign-in, or it expires. The
 * first poll is immediate, so resuming a sign-in the person already allowed
 * finishes at once.
 */
export async function pollDeviceLogin(
  pending: PendingLogin,
  opts: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<CliTokenResponse> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  let intervalMs = pending.interval * 1000;
  let first = true;
  while (now() < pending.expiresAt) {
    if (!first) await sleep(intervalMs);
    first = false;
    const polled = await post<CliTokenResponse>(`${pending.url}/api/cli/device/token`, { device_code: pending.deviceCode });
    if (polled.status === 200 && "access_token" in polled.body) return polled.body;
    const { error, description } = errorOf(polled.body);
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    if (error === "access_denied") throw new AuthError("the sign-in was denied in the browser. To try again, run `valet login` again.");
    if (error === "expired_token") throw new AuthError(`${description ?? "the sign-in code expired."} Run \`valet login\` again.`);
    throw new ApiError(polled.status, description ?? error ?? "the sign-in failed");
  }
  throw new AuthError("the sign-in code expired before anyone chose Allow. Run `valet login` again, and enter the new code in the browser.");
}

/** Start a sign-in, show the code, and wait for it. Returns a CLI token pair. */
export async function deviceLogin(opts: DeviceLoginOpts): Promise<CliTokenResponse> {
  const pending = await startDeviceLogin(opts.url, opts.device, opts.now);
  const opened = await opts.openUrl(`${pending.url}${pending.verificationPath}`);
  for (const line of deviceCodeInstructions(pending, opened)) opts.log(line);
  opts.log("Waiting for approval...");
  // The first poll waits one interval, so the person has time to act.
  if (opts.sleep) await opts.sleep(pending.interval * 1000);
  else await new Promise<void>((resolve) => setTimeout(resolve, pending.interval * 1000));
  return pollDeviceLogin(pending, { sleep: opts.sleep, now: opts.now });
}

/** Replace a CLI token pair. Undefined when the sign-in expired or was disconnected. */
export async function refreshDeviceLogin(url: string, refreshToken: string): Promise<CliTokenResponse | undefined> {
  const res = await post<CliTokenResponse>(`${url}/api/cli/token/refresh`, { refresh_token: refreshToken });
  return res.status === 200 && "access_token" in res.body ? res.body : undefined;
}

/** Sign a CLI out on the server. Errors are ignored: the token then expires on its own. */
export async function revokeDeviceLogin(url: string, token: string): Promise<void> {
  try {
    await post(`${url}/api/cli/token/revoke`, { token });
  } catch {
    // Unreachable or not Valet: nothing more to do.
  }
}

/**
 * Open a URL with the platform's default handler. Resolves false if none
 * started, or if this Linux session has no display, where `xdg-open` would
 * start but show nothing.
 */
export function openInBrowser(url: string): Promise<boolean> {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return Promise.resolve(false);
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
