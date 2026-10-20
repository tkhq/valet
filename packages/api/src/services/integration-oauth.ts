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
import {
  discoverAuthServer,
  OAuthTokenError,
  registerClient,
  type AuthServerMetadata,
  type TokenResponse,
} from "@valet/sdk";
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
 * The scopes to request for an entry that declares `declared`: the declared
 * scopes plus every scope the MCP server's protected resource advertises.
 * A declared list is a copy of one server version's scopes, and a server
 * upgrade can gate its tools on new ones (Metabase 1.64 moved every read
 * tool to `agent:content:read`). The advertised set is what the server
 * checks now, so requesting it keeps the token valid across upgrades.
 *
 * When discovery returns no resource scope list (no metadata, or a failed
 * read), the stored set stands in for it. A transient metadata failure
 * then never re-registers the shared client with fewer scopes, which would
 * stop every user's refresh. The cost: without metadata, removing a
 * declared scope does not narrow the stored client.
 *
 * A scopeless entry stays scopeless: those servers grant their default
 * scopes today, and adding scopes would re-register every bundled MCP
 * client and stop every connected user's refresh.
 */
function requestedScopes(
  declared: string[],
  meta: AuthServerMetadata,
  stored: string[] | null | undefined,
): string[] {
  if (declared.length === 0) return declared;
  const advertised = meta.resource_scopes_supported ?? stored ?? [];
  return normalizeScopes([...new Set([...declared, ...advertised])]);
}

/**
 * The stored dynamic client for `service`, registering one when none exists
 * or when the REQUESTED scope set (`requestedScopes`) differs from the
 * registered one. The scope set rides the RFC 7591 registration, not only
 * the authorize request — a server that constrains grants to the registered
 * set would otherwise narrow or refuse authorize-time scopes (TKAI-243).
 *
 * An entry with declared scopes runs discovery on every connect, so a
 * server upgrade that advertises a new scope re-registers the client.
 *
 * Re-registration replaces the stored client_id, so refresh tokens issued
 * to the old client stop refreshing; users reconnect — the same remedy a
 * scope change already requires for the token itself.
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
  let meta: AuthServerMetadata | undefined;
  let requested = declared;
  if (declared.length > 0) {
    try {
      meta = await discoverAuthServer(serverUrl);
    } catch (err) {
      // A discovery outage must not block a connect the stored client can
      // serve. A first registration or a new declared scope needs
      // discovery, so those still fail.
      const stored = existing[0];
      const storedScopes = new Set(stored?.registeredScopes ?? []);
      if (!stored || !declared.every((s) => storedScopes.has(s))) throw err;
      console.warn(
        `MCP OAuth: ${service} discovery failed; connecting with the stored client:`,
        err instanceof Error ? err.message : String(err),
      );
      return toRow(stored);
    }
    requested = requestedScopes(declared, meta, existing[0]?.registeredScopes);
  }
  if (existing[0] && sameScopes(existing[0].registeredScopes, requested)) {
    if (requested.length === 0) {
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

  meta ??= await discoverAuthServer(serverUrl);
  if (!meta.registration_endpoint) {
    throw new Error(`MCP OAuth: ${service} discovery reported no registration_endpoint`);
  }
  if (requested.length === 0 && (meta.scopes_supported?.length ?? 0) > 0) {
    warnScopelessEntry(service, meta.scopes_supported ?? []);
  }
  const client = await registerClient(meta.registration_endpoint, {
    clientName: "Valet",
    redirectUris: [redirectUri],
    ...(requested.length > 0 ? { scope: requested.join(" ") } : {}),
  });
  const now = Date.now();
  const values = {
    clientId: client.client_id,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint,
    registeredScopes: requested,
    scopesSupported: meta.scopes_supported ?? [],
    updatedAt: now,
  };
  if (existing[0]) {
    // Requested scopes changed: replace the stored client in place. Last
    // writer wins on a concurrent scope change — both writers registered
    // with the same requested set, so either row works.
    await deps.db.update(mcpOauthClients).set(values).where(eq(mcpOauthClients.service, service));
    // Refresh tokens were issued to the OLD client_id and stop refreshing
    // now. Nothing repairs that automatically — connected users must
    // disconnect and reconnect, so tell the operator while they are looking.
    console.warn(
      `MCP OAuth: "${service}" re-registered for scope change (client ${existing[0].clientId} → ${client.client_id}, ` +
        `scopes: ${requested.join(" ") || "none"}). ` +
        `Existing ${service} credentials stop refreshing; users must disconnect and reconnect in Integrations.`,
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
    throw new OAuthTokenError(`OAuth token request failed: ${res.status} ${body.slice(0, 200)}`, res.status);
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
