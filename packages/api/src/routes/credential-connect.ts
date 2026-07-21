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
 */
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { buildAuthorizationUrl, exchangeCodePkce, generatePkceChallenge } from "@valet/sdk";
import type { AppEnv } from "../env.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { isRecord, signState, verifyState, STATE_TTL_MS } from "../lib/oauth-state.js";
import { publicUrlFromEnv } from "../channels/host.js";
import {
  authCodeEnvReady,
  ensureMcpOAuthClient,
  exchangeAuthorizationCode,
  findOAuthDeclaration,
} from "../services/integration-oauth.js";

export const credentialConnectRouter = new Hono<AppEnv>();

interface OAuthConnectState {
  userId: string;
  service: string;
  codeVerifier?: string;
  nonce: string;
  exp: number;
}

export function verifyOAuthConnectState(state: string, key: Buffer, nowMs: number): OAuthConnectState | null {
  return verifyState<OAuthConnectState>(state, key, (payload) => {
    if (!isRecord(payload)) return null;
    const { userId, service, codeVerifier, nonce, exp } = payload;
    if (typeof userId !== "string" || typeof service !== "string") return null;
    if (typeof nonce !== "string" || typeof exp !== "number") return null;
    if (codeVerifier !== undefined && typeof codeVerifier !== "string") return null;
    if (exp < nowMs) return null;
    return { userId, service, codeVerifier, nonce, exp };
  });
}

function callbackUrl(reqUrl: string): string {
  const base = publicUrlFromEnv(process.env) ?? new URL(reqUrl).origin;
  return `${base.replace(/\/+$/, "")}/api/credentials/oauth/callback`;
}

credentialConnectRouter.get("/:service/connect", async (c) => {
  const service = c.req.param("service");
  const user = c.var.user;
  const { plugins, encryptionKey, db } = c.var.providers;

  const found = findOAuthDeclaration(plugins, service);
  if (!found) return c.json({ error: `no OAuth-capable declaration for service "${service}"` }, 404);

  const redirectUri = callbackUrl(c.req.url);
  const key = deriveSecretKey(encryptionKey);
  const base: Omit<OAuthConnectState, "codeVerifier"> = {
    userId: user.id,
    service,
    nonce: randomBytes(16).toString("hex"),
    exp: Date.now() + STATE_TTL_MS,
  };

  if (found.oauth.mode === "mcp") {
    let clientRow;
    try {
      clientRow = await ensureMcpOAuthClient({ db }, service, found.oauth.serverUrl, redirectUri);
    } catch (err) {
      console.error(`oauth connect: MCP client registration failed for ${service}:`, err);
      return c.redirect("/integrations?error=oauth_failed", 302);
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
    const missing = [found.oauth.clientIdEnv, found.oauth.clientSecretEnv].filter((name) => !process.env[name]);
    return c.json({ error: "oauth not configured", missing }, 503);
  }
  const state = signState<OAuthConnectState>(base, key);
  const query = new URLSearchParams({
    client_id: process.env[found.oauth.clientIdEnv] ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    ...(found.decl.scopes?.length ? { scope: found.decl.scopes.join(" ") } : {}),
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
    return c.redirect("/integrations?error=oauth_state", 302);
  }

  const providerError = c.req.query("error");
  if (providerError) {
    return c.redirect(`/integrations?error=${encodeURIComponent(providerError)}`, 302);
  }

  const code = c.req.query("code");
  const found = findOAuthDeclaration(plugins, verified.service);
  if (!code || !found) return c.redirect("/integrations?error=oauth_failed", 302);

  const redirectUri = callbackUrl(c.req.url);
  let tokens;
  try {
    if (found.oauth.mode === "mcp") {
      if (!verified.codeVerifier) return c.redirect("/integrations?error=oauth_state", 302);
      const clientRow = await ensureMcpOAuthClient({ db }, verified.service, found.oauth.serverUrl, redirectUri);
      tokens = await exchangeCodePkce({
        tokenEndpoint: clientRow.tokenEndpoint,
        clientId: clientRow.clientId,
        code,
        redirectUri,
        codeVerifier: verified.codeVerifier,
      });
    } else {
      tokens = await exchangeAuthorizationCode({
        oauth: found.oauth,
        env: process.env,
        code,
        redirectUri,
      });
    }
  } catch (err) {
    console.error(`oauth callback: token exchange failed for ${verified.service}:`, err);
    return c.redirect("/integrations?error=oauth_failed", 302);
  }

  const now = Date.now();
  await engineCredentials.save({ type: "user", id: user.id }, verified.service, {
    type: "oauth2",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: typeof tokens.expires_in === "number" ? now + tokens.expires_in * 1000 : undefined,
    scopes: found.decl.scopes,
    metadata: { connectedVia: "oauth" },
  });

  return c.redirect(`/integrations?connected=${encodeURIComponent(verified.service)}`, 302);
});
