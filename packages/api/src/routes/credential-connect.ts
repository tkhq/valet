/**
 * Generic integration OAuth connect (docs/specs/2026-07-20-integration-oauth-design.md).
 * Server-side flow modeled on routes/github-connect.ts: HMAC-signed
 * stateless state (lib/oauth-state.ts) carrying the PKCE verifier, code
 * exchange server-side, tokens straight into the credential store — never
 * through the browser. GitHub is excluded (dedicated App flow).
 *
 * Callback auth model matches github-connect: mounted behind the /api/*
 * auth gate (browser session cookie present), and the state's userId must
 * match the session user as defense against replayed state values.
 * Callback failures redirect to /integrations?error=… rather than JSON —
 * the user arrives via a browser navigation, not fetch.
 *
 * The 503 for a service this deployment cannot connect names the missing
 * environment variables to an org admin only. That is the audience rule
 * `/api/plugins` applies to `missingEnv`, and this route is the other
 * surface that can name them (integration-availability design).
 */
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { buildAuthorizationUrl, exchangeCodePkce, generatePkceChallenge, type TokenResponse } from "@valet/sdk";
import type { AppEnv } from "../env.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { isRecord, signState, verifyState, STATE_TTL_MS } from "../lib/oauth-state.js";
import { publicUrlFromEnv } from "../channels/host.js";
import { loadAuthConfig } from "../auth/config.js";
import type { OAuthIdentity, TokenInterpretation } from "@valet/engine";
import {
  authCodeEnvReady,
  ensureMcpOAuthClient,
  exchangeAuthorizationCode,
  exchangeAuthorizationCodeRaw,
  findOAuthDeclaration,
} from "../services/integration-oauth.js";
import { missingClientEnv } from "../services/integration-availability.js";
import { isOrgAdmin } from "../services/org.js";
import {
  identityForExternal,
  identityForUser,
  linkIdentity,
  unlinkIdentity,
} from "../channels/identity-links.js";

export const credentialConnectRouter = new Hono<AppEnv>();

interface OAuthConnectState {
  userId: string;
  service: string;
  codeVerifier?: string;
  /** Validated web origin to land back on, e.g. "http://localhost:5173".
   * Empty/absent → relative redirect (prod same-origin serving). */
  returnTo?: string;
  nonce: string;
  exp: number;
}

export function verifyOAuthConnectState(state: string, key: Buffer, nowMs: number): OAuthConnectState | null {
  return verifyState<OAuthConnectState>(state, key, (payload) => {
    if (!isRecord(payload)) return null;
    const { userId, service, codeVerifier, returnTo, nonce, exp } = payload;
    if (typeof userId !== "string" || typeof service !== "string") return null;
    if (typeof nonce !== "string" || typeof exp !== "number") return null;
    if (codeVerifier !== undefined && typeof codeVerifier !== "string") return null;
    if (returnTo !== undefined && typeof returnTo !== "string") return null;
    if (exp < nowMs) return null;
    return { userId, service, codeVerifier, returnTo, nonce, exp };
  });
}

function callbackUrl(reqUrl: string): string {
  const base = publicUrlFromEnv(process.env) ?? new URL(reqUrl).origin;
  return `${base.replace(/\/+$/, "")}/api/credentials/oauth/callback`;
}

/**
 * The web origin the flow should land back on, or "" for a relative
 * redirect. In prod the api serves the SPA same-origin so relative is
 * right; in dev the browser sits on the vite origin (:5173) while this
 * route runs on the api origin (:8788), so a relative `/integrations`
 * 404s as JSON (same failure auth-v2 hit with its login callbackURL).
 * Derived from the Referer origin — but only when that origin is
 * allowlisted (request origin, configured public URL, or the auth
 * config's trustedOrigins, which always includes the dev vite origin) so
 * a crafted connect link can't turn the callback into an open redirect.
 */
export function resolveReturnOrigin(reqUrl: string, referer: string | undefined, env: NodeJS.ProcessEnv): string {
  if (!referer) return "";
  let refererOrigin: string;
  try {
    refererOrigin = new URL(referer).origin;
  } catch {
    return "";
  }
  const requestOrigin = new URL(reqUrl).origin;
  if (refererOrigin === requestOrigin) return ""; // same-origin: relative works
  const allowed = new Set(loadAuthConfig(env)?.trustedOrigins ?? ["http://localhost:5173"]);
  const publicUrl = publicUrlFromEnv(env);
  if (publicUrl) {
    try {
      allowed.add(new URL(publicUrl).origin);
    } catch {
      // ignore unparsable configured URL
    }
  }
  return allowed.has(refererOrigin) ? refererOrigin : "";
}

credentialConnectRouter.get("/:service/connect", async (c) => {
  const service = c.req.param("service");
  const user = c.var.user;
  const { plugins, encryptionKey, db } = c.var.providers;

  const found = findOAuthDeclaration(plugins, service);
  if (!found) return c.json({ error: `no OAuth-capable declaration for service "${service}"` }, 404);

  const redirectUri = callbackUrl(c.req.url);
  const key = deriveSecretKey(encryptionKey);
  const returnTo = resolveReturnOrigin(c.req.url, c.req.header("referer"), process.env);
  const base: Omit<OAuthConnectState, "codeVerifier"> = {
    userId: user.id,
    service,
    ...(returnTo ? { returnTo } : {}),
    nonce: randomBytes(16).toString("hex"),
    exp: Date.now() + STATE_TTL_MS,
  };

  if (found.oauth.mode === "mcp") {
    let clientRow;
    try {
      clientRow = await ensureMcpOAuthClient({ db }, service, found.oauth.serverUrl, redirectUri);
    } catch (err) {
      console.error(`oauth connect: MCP client registration failed for ${service}:`, err);
      return c.redirect(`${returnTo}/integrations?error=oauth_failed`, 302);
    }
    const { codeVerifier, codeChallenge } = await generatePkceChallenge();
    const state = signState<OAuthConnectState>({ ...base, codeVerifier }, key);
    const url = buildAuthorizationUrl({
      authorizationEndpoint: clientRow.authorizationEndpoint,
      clientId: clientRow.clientId,
      redirectUri,
      codeChallenge,
      state,
      scopes: found.decl.scopes,
    });
    return c.redirect(url, 302);
  }

  // authorization_code mode
  if (!authCodeEnvReady(found.oauth, process.env)) {
    // The variable names go to a caller who can set them, the same audience
    // rule `/api/plugins` applies to `missingEnv` (integration-availability
    // design). `org_members.role` is the authority, not the global role.
    // Both surfaces read one helper, so they can never name a different set.
    const callerIsOrgAdmin = await isOrgAdmin(db, user.orgId, user.id);
    const missing = callerIsOrgAdmin ? missingClientEnv(plugins, service, process.env) : [];
    return c.json(
      {
        error: "oauth not configured",
        fix: callerIsOrgAdmin
          ? "Set these variables in the server environment. Then restart the server."
          : "Ask an org admin to set the OAuth client for this service.",
        ...(missing.length > 0 ? { missing } : {}),
      },
      503,
    );
  }
  const state = signState<OAuthConnectState>(base, key);
  const scopesKey = found.oauth.scopesParam ?? "scope";
  const query = new URLSearchParams({
    client_id: process.env[found.oauth.clientIdEnv] ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    ...(found.decl.scopes?.length ? { [scopesKey]: found.decl.scopes.join(" ") } : {}),
    ...found.oauth.extraAuthParams,
  });
  return c.redirect(`${found.oauth.authorizationUrl}?${query}`, 302);
});

credentialConnectRouter.get("/oauth/callback", async (c) => {
  const user = c.var.user;
  const { plugins, engineCredentials, encryptionKey, db } = c.var.providers;
  const key = deriveSecretKey(encryptionKey);

  const stateParam = c.req.query("state");
  const verified = stateParam ? verifyOAuthConnectState(stateParam, key, Date.now()) : null;
  if (!verified || verified.userId !== user.id) {
    // No trusted state → no trusted returnTo; relative is the safe fallback.
    return c.redirect("/integrations?error=oauth_state", 302);
  }
  const returnTo = verified.returnTo ?? "";

  const providerError = c.req.query("error");
  if (providerError) {
    return c.redirect(`${returnTo}/integrations?error=${encodeURIComponent(providerError)}`, 302);
  }

  const code = c.req.query("code");
  const found = findOAuthDeclaration(plugins, verified.service);
  if (!code || !found) return c.redirect(`${returnTo}/integrations?error=oauth_failed`, 302);

  const redirectUri = callbackUrl(c.req.url);
  interface SavedCredential {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    metadata: Record<string, string>;
    identity?: OAuthIdentity;
  }
  let saved: SavedCredential;
  const now = Date.now();
  try {
    if (found.oauth.mode === "mcp") {
      if (!verified.codeVerifier) return c.redirect(`${returnTo}/integrations?error=oauth_state`, 302);
      const clientRow = await ensureMcpOAuthClient({ db }, verified.service, found.oauth.serverUrl, redirectUri);
      const tokens = await exchangeCodePkce({
        tokenEndpoint: clientRow.tokenEndpoint,
        clientId: clientRow.clientId,
        code,
        redirectUri,
        codeVerifier: verified.codeVerifier,
      });
      saved = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: typeof tokens.expires_in === "number" ? now + tokens.expires_in * 1000 : undefined,
        scopes: found.decl.scopes,
        metadata: { connectedVia: "oauth" },
      };
    } else if (found.oauth.interpretTokenResponse) {
      const raw = await exchangeAuthorizationCodeRaw({ oauth: found.oauth, env: process.env, code, redirectUri });
      const interp: TokenInterpretation = found.oauth.interpretTokenResponse(raw);
      saved = {
        accessToken: interp.accessToken,
        refreshToken: interp.refreshToken,
        expiresAt: typeof interp.expiresInSec === "number" ? now + interp.expiresInSec * 1000 : undefined,
        scopes: interp.grantedScopes ?? found.decl.scopes,
        metadata: { connectedVia: "oauth", ...interp.metadata },
        identity: interp.identity,
      };
    } else {
      // TokenResponse is a minimal type; providers may also return `scope`
      // per RFC 6749 §5.1 — access it via a widened intersection.
      const tokens = (await exchangeAuthorizationCode({
        oauth: found.oauth,
        env: process.env,
        code,
        redirectUri,
      })) as TokenResponse & { scope?: string };
      saved = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: typeof tokens.expires_in === "number" ? now + tokens.expires_in * 1000 : undefined,
        scopes: typeof tokens.scope === "string" ? tokens.scope.split(" ") : found.decl.scopes,
        metadata: { connectedVia: "oauth" },
      };
    }
  } catch (err) {
    console.error(`oauth callback: token exchange failed for ${verified.service}:`, err);
    return c.redirect(`${returnTo}/integrations?error=oauth_failed`, 302);
  }

  let restoreLink: (() => Promise<void>) | null = null;
  if (saved.identity) {
    const identity = saved.identity;
    const existing = await identityForExternal(db, identity.provider, identity.externalId);
    if (existing && existing.userId !== user.id) {
      return c.redirect(`${returnTo}/integrations?error=identity_conflict`, 302);
    }
    const prior = await identityForUser(db, identity.provider, user.id);
    await linkIdentity(db, { provider: identity.provider, externalId: identity.externalId, userId: user.id });
    restoreLink = prior
      ? () => linkIdentity(db, { provider: identity.provider, externalId: prior.externalId, userId: user.id })
      : () => unlinkIdentity(db, identity.provider, user.id);
  }
  try {
    await engineCredentials.save({ type: "user", id: user.id }, verified.service, {
      type: "oauth2",
      accessToken: saved.accessToken,
      refreshToken: saved.refreshToken,
      expiresAt: saved.expiresAt,
      scopes: saved.scopes,
      metadata: saved.metadata,
    });
  } catch (err) {
    console.error(`oauth callback: credential save failed for ${verified.service}:`, err);
    if (restoreLink) await restoreLink().catch(() => undefined); // best-effort compensation
    return c.redirect(`${returnTo}/integrations?error=oauth_failed`, 302);
  }

  return c.redirect(`${returnTo}/integrations?connected=${encodeURIComponent(verified.service)}`, 302);
});
