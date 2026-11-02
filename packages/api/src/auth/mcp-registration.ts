/**
 * MCP dynamic client registration (`POST /api/auth/mcp/register`), checked
 * before better-auth's `mcp` plugin. Registration stays open: MCP clients
 * such as Claude Code and claude.ai register before anyone signs in, as the
 * MCP authorization spec expects. The plugin itself stores any redirect URI
 * from any caller, so this gate adds two rules. Every number and list below
 * is a setting (`McpRegistrationConfig`, from the `AUTH_MCP_*` variables),
 * and `AUTH_MCP_REGISTRATION=off` refuses every registration:
 *
 * 1. Redirect URIs: `https://` with a full host name, `http://` loopback
 *    (`localhost`, `127.0.0.1`, `[::1]`) with any port, or
 *    `<app scheme>://<host>` for a scheme in `AUTH_MCP_APP_SCHEMES` (the
 *    Claude app registers `claude://claude.ai/mcp-auth-callback/sdk`). No
 *    wildcards, user names, fragments, or commas (the plugin stores the list
 *    comma-joined). At most `maxRedirectUris`. `mcpAuthorizeGate` applies
 *    the same check, so a client stored before this gate gets no code.
 * 2. Limits: each address may register `ratePerHour` clients an hour (in
 *    memory, for each api process). Clients from the last day that nobody
 *    approved (no consent and no token) count toward `unconsentedCap`. 0
 *    turns either limit off. Over a limit, the gate returns 429. Nothing
 *    deletes unapproved clients: the `valet.mcp.client_registration` counter
 *    and a log line make refusals visible, and the auth spec ("MCP client
 *    registration") has a query that lists unapproved clients.
 */
import { and, eq, gt, notExists, sql } from "drizzle-orm";
import { metrics } from "@opentelemetry/api";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { clientKey, peerAddress } from "../routes/cli-device.js";
import { oauthAccessToken, oauthApplication, oauthConsent } from "../schema/index.js";
import type { McpRegistrationConfig } from "./config.js";

const MAX_REDIRECT_URI_LENGTH = 2048;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Lowercase DNS labels with at least one dot. `new URL` already lowercases
// the host and converts IDN names to punycode.
const DNS_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export type RedirectCheck = { ok: true; uris: string[] } | { ok: false; error: string };

/** Validates a registration's `redirect_uris`. Each entry must pass `redirectUriProblem`. */
export function checkRedirectUris(value: unknown, appSchemes: readonly string[], maxUris: number): RedirectCheck {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: "Send redirect_uris as a list with at least one URI." };
  }
  if (value.length > maxUris) {
    return { ok: false, error: `Send at most ${maxUris} redirect URI${maxUris === 1 ? "" : "s"}.` };
  }
  const uris: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return { ok: false, error: "Each redirect URI must be a string." };
    const problem = redirectUriProblem(entry, appSchemes);
    if (problem) return { ok: false, error: `Redirect URI ${JSON.stringify(entry.slice(0, 200))} is not allowed: ${problem}` };
    uris.push(entry);
  }
  return { ok: true, uris };
}

/** Why `uri` cannot be a redirect URI, or undefined when it can. */
export function redirectUriProblem(uri: string, appSchemes: readonly string[]): string | undefined {
  if (uri.length > MAX_REDIRECT_URI_LENGTH) return `use at most ${MAX_REDIRECT_URI_LENGTH} characters.`;
  // Checked on the raw text: `new URL` encodes or drops some of these.
  if (/[\s\u0000-\u001f\u007f]/.test(uri)) return "remove spaces and control characters.";
  if (uri.includes("*")) return "wildcards are not supported. Register the exact URI.";
  if (uri.includes(",")) return "remove the comma.";
  if (uri.includes("#")) return "remove the fragment (#).";
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return "send an absolute URI, such as https://app.example.com/callback.";
  }
  if (url.username || url.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?]*@/i.test(uri)) return "remove the user name (user@host).";
  if (url.protocol === "http:") {
    return LOOPBACK_HOSTS.has(url.hostname) ? undefined : "http:// is allowed only for localhost, 127.0.0.1, and [::1]. Use https://.";
  }
  if (url.protocol === "https:") {
    return DNS_NAME.test(url.hostname) ? undefined : "use a full host name, such as app.example.com.";
  }
  // A native app's own scheme (RFC 8252 section 7.1), such as
  // claude://claude.ai/mcp-auth-callback/sdk. Only listed schemes pass.
  const scheme = url.protocol.slice(0, -1);
  if (appSchemes.includes(scheme) && uri.toLowerCase().startsWith(`${scheme}://`) && url.host) return undefined;
  const apps = appSchemes.length ? `, or an app scheme this Valet allows (${appSchemes.map((s) => `${s}://`).join(", ")})` : "";
  return `use https://, http:// on a loopback address${apps}.`;
}

type Counter = ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
let registrationCounter: Counter | undefined;

type Outcome = "registered" | "off" | "bad_request" | "redirect_rejected" | "rate_limited" | "unapproved_limit";

function recordRegistration(outcome: Outcome): void {
  registrationCounter ??= metrics.getMeter("@valet/api").createCounter("valet.mcp.client_registration", {
    description: "MCP dynamic client registrations, by outcome",
  });
  registrationCounter.add(1, { outcome });
}

const addressWindows = new Map<string, { windowStart: number; count: number }>();

function allowAddress(key: string, now: number, perHour: number): boolean {
  const entry = addressWindows.get(key);
  if (!entry || now - entry.windowStart >= HOUR_MS) {
    // Drop finished windows now and then, so the map stays small.
    if (addressWindows.size > 10_000) for (const [k, v] of addressWindows) if (now - v.windowStart >= HOUR_MS) addressWindows.delete(k);
    addressWindows.set(key, { windowStart: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= perHour;
}

/** Test seam: forget the per-address windows. */
export function clearMcpRegistrationLimits(): void {
  addressWindows.clear();
}

/** Clients registered in the last day that have no consent and no token. */
async function countRecentUnapproved(db: AppDb): Promise<number> {
  const since = new Date(Date.now() - DAY_MS);
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(oauthApplication).where(and(
    gt(oauthApplication.createdAt, since),
    notExists(db.select({ one: sql`1` }).from(oauthConsent).where(eq(oauthConsent.clientId, oauthApplication.clientId))),
    notExists(db.select({ one: sql`1` }).from(oauthAccessToken).where(eq(oauthAccessToken.clientId, oauthApplication.clientId))),
  ));
  return Number(row?.n ?? 0);
}

function refuse(c: Context<AppEnv>, status: 400 | 403 | 429, error: string, description: string) {
  return c.json({ error, error_description: description }, status);
}

/**
 * Hono handler for `POST /api/auth/mcp/register` that runs before
 * better-auth. It reads the body as JSON, the only form RFC 7591 defines,
 * and refuses any other media type, so the plugin cannot read a body this
 * gate did not check.
 */
export function mcpRegisterGate(db: AppDb, cfg: McpRegistrationConfig) {
  return async (c: Context<AppEnv>, next: () => Promise<void>): Promise<void | Response> => {
    if (!cfg.open) {
      recordRegistration("off");
      return refuse(c, 403, "access_denied", "This Valet does not accept new MCP app registrations (AUTH_MCP_REGISTRATION=off). Ask your Valet administrator to set AUTH_MCP_REGISTRATION=open, or connect with an API key (valet mcp setup --token).");
    }
    const media = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    let body: unknown;
    try {
      body = media === "application/json" ? JSON.parse(await c.req.raw.clone().text()) : undefined;
    } catch {
      body = undefined;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      recordRegistration("bad_request");
      return refuse(c, 400, "invalid_client_metadata", "Send the registration as a JSON object with Content-Type: application/json.");
    }
    const check = checkRedirectUris((body as Record<string, unknown>).redirect_uris, cfg.appSchemes, cfg.maxRedirectUris);
    if (!check.ok) {
      recordRegistration("redirect_rejected");
      return refuse(c, 400, "invalid_redirect_uri", check.error);
    }
    if (cfg.ratePerHour > 0 && !allowAddress(clientKey(peerAddress(c), c.req.header("x-forwarded-for")), Date.now(), cfg.ratePerHour)) {
      recordRegistration("rate_limited");
      return refuse(c, 429, "slow_down", "Too many MCP apps registered from this address. Wait an hour, then connect again.");
    }
    if (cfg.unconsentedCap > 0 && await countRecentUnapproved(db) >= cfg.unconsentedCap) {
      recordRegistration("unapproved_limit");
      console.warn(`[mcp-register] refused: ${cfg.unconsentedCap} MCP clients registered in the last day have no consent or token`);
      return refuse(c, 429, "slow_down", "Valet has too many new MCP apps that were never approved. Try again later. If this continues, ask your Valet administrator to check MCP registrations.");
    }
    recordRegistration("registered");
    return next();
  };
}
