/**
 * Integration OAuth mechanics (docs/specs/2026-07-20-integration-oauth-design.md):
 * manifest lookup, MCP dynamic client registration (RFC 8414/7591 via
 * @valet/sdk), and confidential-client code exchange/refresh for
 * authorization_code-mode declarations. Route handling lives in
 * routes/credential-connect.ts; refresh-on-read in
 * plugins/oauth-refreshing-credential-store.ts.
 */
import { eq } from "drizzle-orm";
import type { CredentialDeclaration, OAuthDeclaration, ValetPlugin } from "@valet/engine";
import { discoverAuthServer, registerClient, type TokenResponse } from "@valet/sdk";
import { mcpOauthClients } from "../schema/index.js";

import type { AppQueryable } from "../lib/drizzle.js";

// Same dep typing as services/github-app.ts's GithubAppDeps.db.
export interface OAuthDeps {
  db: AppQueryable;
}

export interface McpClientRow {
  service: string;
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

/** The GitHub service keeps its dedicated App flow (routes/github-connect.ts). */
export const OAUTH_EXCLUDED_SERVICES = new Set(["github"]);

export function findOAuthDeclaration(
  plugins: ValetPlugin[],
  service: string,
): { decl: CredentialDeclaration; oauth: OAuthDeclaration } | null {
  if (OAUTH_EXCLUDED_SERVICES.has(service)) return null;
  for (const plugin of plugins) {
    for (const decl of plugin.credentials ?? []) {
      if ((decl.service ?? plugin.name) !== service) continue;
      if (decl.oauth) return { decl, oauth: decl.oauth };
    }
  }
  return null;
}

export async function ensureMcpOAuthClient(
  deps: OAuthDeps,
  service: string,
  serverUrl: string,
  redirectUri: string,
): Promise<McpClientRow> {
  const existing = await deps.db.select().from(mcpOauthClients).where(eq(mcpOauthClients.service, service));
  if (existing[0]) return toRow(existing[0]);

  const meta = await discoverAuthServer(serverUrl);
  if (!meta.registration_endpoint) {
    throw new Error(`MCP OAuth: ${service} discovery reported no registration_endpoint`);
  }
  const client = await registerClient(meta.registration_endpoint, {
    clientName: "Valet",
    redirectUris: [redirectUri],
  });
  const now = Date.now();
  await deps.db
    .insert(mcpOauthClients)
    .values({
      service,
      clientId: client.client_id,
      authorizationEndpoint: meta.authorization_endpoint,
      tokenEndpoint: meta.token_endpoint,
      registrationEndpoint: meta.registration_endpoint,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  // Re-read: a concurrent registration may have won the insert race — both
  // callers must converge on the single stored client.
  const stored = await deps.db.select().from(mcpOauthClients).where(eq(mcpOauthClients.service, service));
  if (!stored[0]) throw new Error(`MCP OAuth: ${service} client row missing after insert`);
  return toRow(stored[0]);
}

function toRow(r: typeof mcpOauthClients.$inferSelect): McpClientRow {
  return {
    service: r.service,
    clientId: r.clientId,
    authorizationEndpoint: r.authorizationEndpoint,
    tokenEndpoint: r.tokenEndpoint,
  };
}

type AuthCodeDecl = Extract<OAuthDeclaration, { mode: "authorization_code" }>;

function resolveClientEnv(
  oauth: AuthCodeDecl,
  env: Record<string, string | undefined>,
): { clientId: string; clientSecret: string } {
  const clientId = env[oauth.clientIdEnv];
  const clientSecret = env[oauth.clientSecretEnv];
  if (!clientId || !clientSecret) {
    const missing = [!clientId && oauth.clientIdEnv, !clientSecret && oauth.clientSecretEnv].filter(
      (v): v is string => typeof v === "string",
    );
    throw new Error(`OAuth client env vars not set: ${missing.join(", ")}`);
  }
  return { clientId, clientSecret };
}

export function authCodeEnvReady(oauth: AuthCodeDecl, env: Record<string, string | undefined>): boolean {
  return Boolean(env[oauth.clientIdEnv] && env[oauth.clientSecretEnv]);
}

async function tokenPostRaw(tokenUrl: string, form: Record<string, string>): Promise<unknown> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OAuth token request failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function tokenPost(tokenUrl: string, form: Record<string, string>): Promise<TokenResponse> {
  const payload = await tokenPostRaw(tokenUrl, form);
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as { access_token?: unknown }).access_token !== "string"
  ) {
    throw new Error("OAuth token response missing access_token");
  }
  return payload as TokenResponse;
}

export async function exchangeAuthorizationCodeRaw(params: {
  oauth: AuthCodeDecl;
  env: Record<string, string | undefined>;
  code: string;
  redirectUri: string;
}): Promise<unknown> {
  const { clientId, clientSecret } = resolveClientEnv(params.oauth, params.env);
  return tokenPostRaw(params.oauth.tokenUrl, {
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
  });
}

export async function exchangeAuthorizationCode(params: {
  oauth: AuthCodeDecl;
  env: Record<string, string | undefined>;
  code: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const { clientId, clientSecret } = resolveClientEnv(params.oauth, params.env);
  return tokenPost(params.oauth.tokenUrl, {
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
  });
}

export async function refreshAuthorizationCodeToken(params: {
  oauth: AuthCodeDecl;
  env: Record<string, string | undefined>;
  refreshToken: string;
}): Promise<TokenResponse> {
  const { clientId, clientSecret } = resolveClientEnv(params.oauth, params.env);
  return tokenPost(params.oauth.tokenUrl, {
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: params.refreshToken,
  });
}
