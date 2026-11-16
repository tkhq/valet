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
import { discoverAuthServer, OAuthTokenError, registerClient, retryAfterMs, type TokenResponse } from "@valet/sdk";
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
  /** The scopes the client registered with, sorted. The authorize request
   * names exactly these; [] sends no scope parameter. */
  scopes: string[];
  /** The MCP server's resource identifier (RFC 9728). Authorize, code
   * exchange, and refresh name it as the RFC 8707 `resource`. A server that
   * separates MCP tokens from its other tokens grants MCP scopes only to a
   * request that names it. Absent when the server describes no resource. */
  resource?: string;
}

/**
 * The MCP client that issued a credential's tokens. The connect records it on
 * the credential's metadata, and a refresh uses it, because a refresh token
 * belongs to the client it was issued to: a later re-registration (a scope
 * change) must not strand connections made before it.
 */
export interface IssuingClient {
  clientId: string;
  tokenEndpoint: string;
  /** The `resource` the connect named. A refresh names the same one. */
  resource?: string;
}

/** Metadata keys that hold the issuing client. Only the server writes them. */
export const ISSUING_CLIENT_METADATA_KEYS = ["oauthClientId", "oauthTokenEndpoint", "oauthResource"] as const;

export function issuingClientMetadata(
  client: IssuingClient,
): { oauthClientId: string; oauthTokenEndpoint: string; oauthResource?: string } {
  return {
    oauthClientId: client.clientId,
    oauthTokenEndpoint: client.tokenEndpoint,
    ...(client.resource ? { oauthResource: client.resource } : {}),
  };
}

/** The recorded issuing client, or null for a credential connected before
 * the connect recorded one. */
export function readIssuingClient(metadata: Record<string, unknown> | undefined): IssuingClient | null {
  const clientId = metadata?.oauthClientId;
  const tokenEndpoint = metadata?.oauthTokenEndpoint;
  if (typeof clientId !== "string" || typeof tokenEndpoint !== "string" || !clientId || !tokenEndpoint) return null;
  const resource = metadata?.oauthResource;
  return { clientId, tokenEndpoint, ...(typeof resource === "string" && resource ? { resource } : {}) };
}

/** The GitHub service keeps its dedicated App flow (the GitHub plugin's connection routes). */
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

/** Sorted copy for order-insensitive compares and stable storage. */
function normalizeScopes(scopes: string[] | undefined): string[] {
  return [...(scopes ?? [])].sort();
}

/** Order-insensitive equality; a null stored set reads as "no scopes". */
function sameScopes(stored: string[] | null | undefined, declared: string[]): boolean {
  const a = normalizeScopes(stored ?? undefined);
  const b = normalizeScopes(declared);
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/**
 * The TKAI-242 failure shape: a scope-gated server + a scope-less authorize
 * request = a token with no scopes and zero tools, with no error anywhere.
 * Fires on every connect for a scopeless entry, so the misconfiguration
 * stays visible, not just on first registration.
 */
function warnScopelessEntry(service: string, scopesSupported: string[]): void {
  console.warn(
    `MCP OAuth: "${service}" declares no scopes but its server advertises scopes_supported ` +
      `(${scopesSupported.join(", ")}). A scope-gated server grants a token with no ` +
      `scopes and lists zero tools. Add the scopes this instance needs to the mcpServers "${service}" entry.`,
  );
}

/**
 * A declared entry can drift from its server: Metabase 1.64 moved every
 * read tool to `agent:content:read`, a scope the deployed list never named,
 * and each reconnect minted a token those tools refused. Valet requests only
 * the declared scopes, so name the advertised ones the entry lacks when it
 * registers a client (a first connect, or a scope change). A reused client
 * makes no network call, so a slow discovery endpoint cannot stall the
 * connect. The protected resource's list (RFC 9728) is what the server
 * checks; the issuer's own list can name scopes for other resources.
 */
function warnUndeclaredResourceScopes(service: string, declared: string[], advertised: string[] | undefined): void {
  const missing = (advertised ?? []).filter((s) => !declared.includes(s));
  if (missing.length === 0) return;
  console.warn(
    `MCP OAuth: "${service}" does not declare scopes its server advertises (${missing.join(", ")}). ` +
      `Tools that need one fail with insufficient_scope. If this instance needs them, add them to the ` +
      `mcpServers "${service}" entry's scopes, then reconnect ${service}.`,
  );
}

/**
 * The stored dynamic client for `service`, registering one when none exists
 * or when the DECLARED scope set differs from the registered one. The scope
 * set rides the RFC 7591 registration, not only the authorize request —
 * a server that constrains grants to the registered set would otherwise
 * narrow or refuse authorize-time scopes (TKAI-243).
 *
 * Re-registration replaces the stored client_id for NEW connections only.
 * Each credential records the client that issued its tokens and refreshes
 * with it, so existing connections keep working with their old scopes; a
 * member reconnects (or steps up) only to get the new ones. A credential
 * connected before that record existed refreshes with the stored client
 * and records it on its first good refresh.
 */
export async function ensureMcpOAuthClient(
  deps: OAuthDeps,
  service: string,
  serverUrl: string,
  redirectUri: string,
  scopes?: string[],
): Promise<McpClientRow> {
  const declared = normalizeScopes(scopes);
  const existing = await deps.db.select().from(mcpOauthClients).where(eq(mcpOauthClients.service, service));
  if (existing[0] && sameScopes(existing[0].registeredScopes, declared)) {
    if (existing[0].resource === null) {
      // Row from before the resource column: one discovery fills it in.
      // Fail-soft, like the scopes_supported backfill below: the connect
      // continues without a resource and the next connect tries again.
      try {
        const meta = await discoverAuthServer(serverUrl);
        const resource = meta.resource ?? "";
        await deps.db
          .update(mcpOauthClients)
          .set({ resource, updatedAt: Date.now() })
          .where(eq(mcpOauthClients.service, service));
        existing[0] = { ...existing[0], resource };
      } catch (err) {
        console.warn(
          `MCP OAuth: ${service} resource backfill failed (connect continues):`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    if (declared.length === 0) {
      let advertised = existing[0].scopesSupported;
      if (advertised === null) {
        // Row from before the scopes_supported column: backfill it with one
        // discovery, fail-soft — a dead discovery endpoint must not block a
        // connect that only needs the stored client.
        try {
          const meta = await discoverAuthServer(serverUrl);
          advertised = meta.scopes_supported ?? [];
          await deps.db
            .update(mcpOauthClients)
            .set({ scopesSupported: advertised, updatedAt: Date.now() })
            .where(eq(mcpOauthClients.service, service));
        } catch (err) {
          console.warn(
            `MCP OAuth: ${service} scopes_supported backfill failed (connect continues):`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      if (advertised && advertised.length > 0) warnScopelessEntry(service, advertised);
    }
    return toRow(existing[0]);
  }

  const meta = await discoverAuthServer(serverUrl);
  if (!meta.registration_endpoint) {
    throw new Error(`MCP OAuth: ${service} discovery reported no registration_endpoint`);
  }
  if (declared.length === 0 && (meta.scopes_supported?.length ?? 0) > 0) {
    warnScopelessEntry(service, meta.scopes_supported ?? []);
  }
  if (declared.length > 0) warnUndeclaredResourceScopes(service, declared, meta.resource_scopes_supported);
  const client = await registerClient(meta.registration_endpoint, {
    clientName: "Valet",
    redirectUris: [redirectUri],
    ...(declared.length > 0 ? { scope: declared.join(" ") } : {}),
  });
  const now = Date.now();
  const values = {
    clientId: client.client_id,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint,
    registeredScopes: declared,
    scopesSupported: meta.scopes_supported ?? [],
    resource: meta.resource ?? "",
    updatedAt: now,
  };
  if (existing[0]) {
    // Declared scopes changed: replace the stored client in place. Last
    // writer wins on a concurrent scope change — both writers registered
    // with the same declared set, so either row works.
    await deps.db.update(mcpOauthClients).set(values).where(eq(mcpOauthClients.service, service));
    // Credentials that recorded their issuing client keep refreshing with
    // it. One with no record still refreshes with the stored client, which
    // is now the new one, and the provider refuses it: that member reconnects.
    console.warn(
      `MCP OAuth: "${service}" re-registered for scope change (client ${existing[0].clientId} → ${client.client_id}). ` +
        `New connections get the new scopes. Existing ${service} connections keep their scopes until the member reconnects; ` +
        `a connection that never recorded its client stops refreshing.`,
    );
  } else {
    await deps.db
      .insert(mcpOauthClients)
      .values({ service, ...values, createdAt: now })
      .onConflictDoNothing();
  }
  // Re-read: a concurrent registration may have won the insert race — both
  // callers must converge on the single stored client.
  const stored = await deps.db.select().from(mcpOauthClients).where(eq(mcpOauthClients.service, service));
  if (!stored[0]) throw new Error(`MCP OAuth: ${service} client row missing after insert`);
  return toRow(stored[0]);
}

/**
 * The stored client for `service`, with no discovery or registration. The
 * OAuth callback uses it: the authorization code belongs to the client the
 * connect started with, so the callback must not register a replacement.
 */
export async function getMcpOAuthClient(deps: OAuthDeps, service: string): Promise<McpClientRow> {
  const stored = await deps.db.select().from(mcpOauthClients).where(eq(mcpOauthClients.service, service));
  if (!stored[0]) throw new Error(`MCP OAuth: ${service} has no registered client. Start the connect again.`);
  return toRow(stored[0]);
}

function toRow(r: typeof mcpOauthClients.$inferSelect): McpClientRow {
  return {
    service: r.service,
    clientId: r.clientId,
    authorizationEndpoint: r.authorizationEndpoint,
    tokenEndpoint: r.tokenEndpoint,
    scopes: normalizeScopes(r.registeredScopes ?? undefined),
    ...(r.resource ? { resource: r.resource } : {}),
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

/** The form fields and headers that authenticate the client at a token
 * endpoint, per the declaration's `tokenAuth`. */
function clientAuth(
  oauth: AuthCodeDecl,
  env: Record<string, string | undefined>,
): { form: Record<string, string>; headers: Record<string, string> } {
  const { clientId, clientSecret } = resolveClientEnv(oauth, env);
  if (oauth.tokenAuth === "client_secret_basic") {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    return { form: {}, headers: { Authorization: `Basic ${basic}` } };
  }
  return { form: { client_id: clientId, client_secret: clientSecret }, headers: {} };
}

async function tokenPostRaw(tokenUrl: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...headers },
    body: new URLSearchParams(form),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new OAuthTokenError(`OAuth token request failed: ${res.status} ${body.slice(0, 200)}`, res.status, retryAfterMs(res.headers.get("retry-after")));
  }
  return res.json();
}

async function tokenPost(tokenUrl: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<TokenResponse> {
  const payload = await tokenPostRaw(tokenUrl, form, headers);
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
  const auth = clientAuth(params.oauth, params.env);
  return tokenPostRaw(params.oauth.tokenUrl, {
    grant_type: "authorization_code",
    ...auth.form,
    code: params.code,
    redirect_uri: params.redirectUri,
  }, auth.headers);
}

export async function exchangeAuthorizationCode(params: {
  oauth: AuthCodeDecl;
  env: Record<string, string | undefined>;
  code: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const auth = clientAuth(params.oauth, params.env);
  return tokenPost(params.oauth.tokenUrl, {
    grant_type: "authorization_code",
    ...auth.form,
    code: params.code,
    redirect_uri: params.redirectUri,
  }, auth.headers);
}

export async function refreshAuthorizationCodeToken(params: {
  oauth: AuthCodeDecl;
  env: Record<string, string | undefined>;
  refreshToken: string;
}): Promise<TokenResponse> {
  const auth = clientAuth(params.oauth, params.env);
  return tokenPost(params.oauth.refreshUrl ?? params.oauth.tokenUrl, {
    grant_type: "refresh_token",
    ...auth.form,
    refresh_token: params.refreshToken,
  }, auth.headers);
}
