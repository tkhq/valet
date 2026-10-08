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
 * endpoint and its token endpoint does not check consent, so Valet checks it
 * in two places. The browser reaches the client's redirect URI with the code
 * only after the person accepts here. Accepting also records a
 * `mcp-consent:` row, and `mcpTokenGate` refuses to exchange a code without
 * one, so a code the plugin issued without this page cannot become a token.
 * A denied code is deleted.
 *
 * Only a browser session can consent, only for a code issued to that same
 * user, and a POST must come from this origin.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { publicUrlFromEnv } from "../channels/host.js";
import type { ValetAuth } from "../auth/index.js";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { readOptionalJsonObject } from "../lib/optional-json-body.js";
import { oauthApplication, verification } from "../schema/index.js";
import type { OAuthConsentDecision, OAuthConsentInfo } from "../wire/types.js";

export const oauthConsentRouter = new Hono<AppEnv>();

const CONSENT_PREFIX = "mcp-consent:";

function consentIdentifier(code: string): string {
  return `${CONSENT_PREFIX}${createHash("sha256").update(code).digest("hex")}`;
}

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
  "Read and write your memory and your teams' memory, and read your skills",
  "Run your workflows, and publish pages that everyone in your organization can open",
  "It cannot approve requests, change policies, or administer your organization or teams",
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
async function loadPending(c: Context<AppEnv>, code: unknown): Promise<{ code: string; pending: PendingCode; expiresAt: Date } | Response> {
  if (c.var.authVia !== "session") {
    return c.json({ error: "Sign in to Valet in your browser to approve an app. API keys and app tokens cannot approve access." }, 403);
  }
  if (typeof code !== "string" || code === "") return c.json({ error: "consent_code is required." }, 400);
  const [row] = await c.var.providers.db.select().from(verification)
    .where(and(eq(verification.identifier, code), gt(verification.expiresAt, new Date()))).limit(1);
  const pending = row ? parsePending(row.value) : undefined;
  // A code for someone else reads as missing, never as forbidden.
  if (!row || !pending || pending.userId !== c.var.user.id) {
    return c.json({ error: "This approval request expired or does not exist. Start the connection again from your app." }, 404);
  }
  return { code, pending, expiresAt: row.expiresAt };
}

/**
 * The origins a consent decision may come from: the public URL people open
 * Valet at, and the request's own origin for a direct connection. Behind a
 * TLS-terminating ingress the server sees `http://<pod>`, while the browser
 * sends `Origin: https://<public host>`, so the request origin alone would
 * refuse every real decision.
 */
export function trustedRequestOrigins(c: Context<AppEnv>): Set<string> {
  const origins = new Set([new URL(c.req.url).origin]);
  for (const configured of [publicUrlFromEnv(process.env), process.env.BETTER_AUTH_URL]) {
    if (!configured) continue;
    try {
      origins.add(new URL(configured).origin);
    } catch {
      // An unparseable setting adds nothing.
    }
  }
  return origins;
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
  if (origin && !trustedRequestOrigins(c).has(origin)) return c.json({ error: "Approve the app from the Valet page." }, 403);
  const body = await readOptionalJsonObject(c);
  if (!body || typeof body.accept !== "boolean") return c.json({ error: "Send { consent_code, accept: true | false }." }, 400);
  const loaded = await loadPending(c, body.consent_code);
  if (loaded instanceof Response) return loaded;
  const { code, pending, expiresAt } = loaded;
  if (!body.accept) {
    await c.var.providers.db.delete(verification).where(eq(verification.identifier, code));
    return c.json({ redirect: withParams(pending.redirectURI, { error: "access_denied", error_description: "The person denied access.", state: pending.state }) } satisfies OAuthConsentDecision);
  }
  await c.var.providers.db.insert(verification).values({
    id: randomUUID(), identifier: consentIdentifier(code), value: pending.userId, expiresAt,
  });
  return c.json({ redirect: withParams(pending.redirectURI, { code, state: pending.state }) } satisfies OAuthConsentDecision);
});

/**
 * Hono handler for `GET /api/auth/mcp/authorize` that runs before
 * better-auth:
 *
 * - A request without `prompt=consent` is redirected to the same URL with
 *   it, so the plugin always sends the browser to the consent page.
 * - A signed-out request is sent to `/login?next=<this authorize URL>`. The
 *   login page loads `next` in the browser after sign-in, which resumes the
 *   authorization with a session. The plugin's own signed-out path replays
 *   the authorization from a sign-in hook instead, and the login form's
 *   background sign-in request swallows that redirect.
 */
export function mcpAuthorizeGate(auth: Pick<ValetAuth, "api">) {
  return async (c: Context<AppEnv>, next: () => Promise<void>): Promise<void | Response> => {
    const url = new URL(c.req.url);
    // Exactly one prompt=consent. better-call reads a repeated key as an
    // array, which the plugin does not treat as consent, so a second
    // prompt would skip this page.
    const prompts = url.searchParams.getAll("prompt");
    if (prompts.length !== 1 || prompts[0] !== "consent") {
      url.searchParams.delete("prompt");
      url.searchParams.set("prompt", "consent");
      return c.redirect(`${url.pathname}${url.search}`, 302);
    }
    let session: Awaited<ReturnType<ValetAuth["api"]["getSession"]>> = null;
    try {
      session = await auth.api.getSession({ headers: c.req.raw.headers });
    } catch {
      session = null;
    }
    if (!session) return c.redirect(`/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`, 302);
    return next();
  };
}

/**
 * Hono handler for `POST /api/auth/mcp/token` that runs before better-auth.
 * An authorization code exchanges only if the person accepted it on the
 * consent page, which wrote its `mcp-consent:` row. The row is deleted on
 * first use. Refresh grants pass: a refresh token comes only from an
 * exchanged code.
 */
export function mcpTokenGate(db: AppDb) {
  return async (c: Context<AppEnv>, next: () => Promise<void>): Promise<void | Response> => {
    const raw = await c.req.raw.clone().text();
    const type = c.req.header("content-type") ?? "";
    let grant: string | undefined;
    let code: string | undefined;
    if (type.includes("application/json")) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          const p = parsed as Record<string, unknown>;
          grant = typeof p.grant_type === "string" ? p.grant_type : undefined;
          code = typeof p.code === "string" ? p.code : undefined;
        }
      } catch {
        // better-auth answers a malformed body itself.
      }
    } else {
      const form = new URLSearchParams(raw);
      if (form.getAll("grant_type").length > 1 || form.getAll("code").length > 1) {
        return c.json({ error: "invalid_request", error_description: "Send grant_type and code once each." }, 400);
      }
      grant = form.get("grant_type") ?? undefined;
      code = form.get("code") ?? undefined;
    }
    if (grant !== "refresh_token") {
      const consented = code
        ? await db.delete(verification)
          .where(and(eq(verification.identifier, consentIdentifier(code)), gt(verification.expiresAt, new Date())))
          .returning({ id: verification.id })
        : [];
      if (consented.length === 0) {
        return c.json({ error: "invalid_grant", error_description: "This code was not approved on the Valet consent page. Connect the app again and choose Allow." }, 400);
      }
    }
    return next();
  };
}
