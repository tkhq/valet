/**
 * MCP OAuth consent (`docs/specs/2026-10-07-mcp-agent-tools-design.md`,
 * "Sign-in and consent").
 *
 *   GET  /api/oauth/consent?consent_code=   what is asking, for the consent page
 *   POST /api/oauth/consent                 { consent_code, accept }
 *
 * better-auth's `mcp` plugin issues the authorization code at
 * `/api/auth/mcp/authorize` and, when the request carries `prompt=consent`,
 * sends the browser to `/oauth/consent?consent_code=<code>` instead of to
 * the client. `forceMcpConsent` adds `prompt=consent` to every authorize
 * request, so no client can skip this page. The plugin has no consent
 * endpoint and its token endpoint does not check consent, so this router is
 * the gate: the browser reaches the client's redirect URI with the code only
 * after the person accepts here. A denied code is deleted.
 *
 * Only a browser session can consent, only for a code issued to that same
 * user, and a POST must come from this origin.
 */
import { and, eq, gt } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { readOptionalJsonObject } from "../lib/optional-json-body.js";
import { oauthApplication, verification } from "../schema/index.js";
import type { OAuthConsentDecision, OAuthConsentInfo } from "../wire/types.js";

export const oauthConsentRouter = new Hono<AppEnv>();

interface PendingCode {
  clientId: string;
  redirectURI: string;
  scope: string[];
  userId: string;
  state: string | null;
}

/** What an MCP token can do in Valet, shown on the consent page. */
const MCP_ACCESS = [
  "Use your connected integrations (GitHub, Slack, Linear, Google, and others) with Valet's tool policies",
  "Start and continue Valet threads, and answer questions Valet asks",
  "Read and write your Valet memory, and read your skills",
  "Run your workflows and publish artifacts",
];

function isLoopback(uri: string): boolean {
  try {
    const host = new URL(uri).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

function parsePending(value: string): PendingCode | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return undefined;
    const p = parsed as Record<string, unknown>;
    if (typeof p.clientId !== "string" || typeof p.redirectURI !== "string" || typeof p.userId !== "string") return undefined;
    return {
      clientId: p.clientId,
      redirectURI: p.redirectURI,
      scope: Array.isArray(p.scope) ? p.scope.filter((s): s is string => typeof s === "string") : [],
      userId: p.userId,
      state: typeof p.state === "string" ? p.state : null,
    };
  } catch {
    return undefined;
  }
}

/** Load a live code issued to the signed-in browser user, or the response that refuses it. */
async function loadPending(c: Context<AppEnv>, code: unknown): Promise<{ code: string; pending: PendingCode } | Response> {
  if (c.var.authVia !== "session") {
    return c.json({ error: "Sign in to Valet in your browser to approve an app. API keys and app tokens cannot approve access." }, 403);
  }
  if (typeof code !== "string" || code === "") return c.json({ error: "consent_code is required." }, 400);
  const [row] = await c.var.providers.db.select().from(verification)
    .where(and(eq(verification.identifier, code), gt(verification.expiresAt, new Date()))).limit(1);
  const pending = row ? parsePending(row.value) : undefined;
  // A code for someone else reads as missing, never as forbidden.
  if (!pending || pending.userId !== c.var.user.id) {
    return c.json({ error: "This approval request expired or does not exist. Start the connection again from your app." }, 404);
  }
  return { code, pending };
}

function withParams(uri: string, params: Record<string, string | null>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  return url.toString();
}

oauthConsentRouter.get("/", async (c) => {
  const loaded = await loadPending(c, c.req.query("consent_code"));
  if (loaded instanceof Response) return loaded;
  const { pending } = loaded;
  const [client] = await c.var.providers.db.select({ name: oauthApplication.name, icon: oauthApplication.icon })
    .from(oauthApplication).where(eq(oauthApplication.clientId, pending.clientId)).limit(1);
  const redirect = new URL(pending.redirectURI);
  const body: OAuthConsentInfo = {
    client_name: client?.name?.trim() || "An unnamed app",
    redirect_origin: redirect.origin,
    redirect_is_local: isLoopback(pending.redirectURI),
    account: c.var.user.email,
    access: MCP_ACCESS,
  };
  return c.json(body);
});

oauthConsentRouter.post("/", async (c) => {
  // The session cookie is SameSite=Lax, so a cross-site POST arrives signed
  // out. Refuse a foreign Origin anyway, before any state changes.
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "Approve the app from the Valet page." }, 403);
  const body = await readOptionalJsonObject(c);
  if (!body || typeof body.accept !== "boolean") return c.json({ error: "Send { consent_code, accept: true | false }." }, 400);
  const loaded = await loadPending(c, body.consent_code);
  if (loaded instanceof Response) return loaded;
  const { code, pending } = loaded;
  if (!body.accept) {
    await c.var.providers.db.delete(verification).where(eq(verification.identifier, code));
    return c.json({ redirect: withParams(pending.redirectURI, { error: "access_denied", error_description: "The person denied access.", state: pending.state }) } satisfies OAuthConsentDecision);
  }
  return c.json({ redirect: withParams(pending.redirectURI, { code, state: pending.state }) } satisfies OAuthConsentDecision);
});

/**
 * Hono handler for `GET /api/auth/mcp/authorize` that runs before
 * better-auth: a request without `prompt=consent` is redirected to the same
 * URL with it, so the plugin always sends the browser to the consent page.
 */
export function forceMcpConsent(c: Context<AppEnv>, next: () => Promise<void>): Promise<void> | Response {
  const url = new URL(c.req.url);
  if (url.searchParams.get("prompt") === "consent") return next();
  url.searchParams.set("prompt", "consent");
  return c.redirect(`${url.pathname}${url.search}`, 302);
}
