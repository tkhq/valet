// ─── MCP OAuth: RFC 8414 Discovery, RFC 7591 Dynamic Registration, RFC 7636 PKCE ───

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

export interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

// ─── RFC 9728 + RFC 8414: Authorization Server Metadata Discovery ───────────

interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
}

/** Well-known URL candidates for an issuer, most-specific first. RFC 8414
 * inserts the well-known segment between the origin and the issuer's path
 * (`https://host/.well-known/<kind>/path`); OIDC's original form appends
 * it after the path instead, so `openid-configuration` probes both. */
function wellKnownUrls(issuer: string, kind: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, '');
  const urls: string[] = [];
  if (path && path !== '/') {
    urls.push(`${u.origin}/.well-known/${kind}${path}`);
    urls.push(`${u.origin}/.well-known/${kind}`);
    if (kind === 'openid-configuration') {
      urls.push(`${u.origin}${path}/.well-known/${kind}`);
    }
  } else {
    urls.push(`${u.origin}/.well-known/${kind}`);
  }
  return urls;
}

/**
 * Fetch a well-known document; null on any non-2xx or non-JSON response.
 * A rejected fetch (socket-level failure, not an HTTP status) retries once
 * after a short delay: a transient ECONNRESET must not read as "this server
 * publishes no metadata" — that false negative fails the whole discovery.
 */
async function fetchWellKnown(url: string): Promise<Record<string, unknown> | null> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      res = await fetch(url);
    } catch {
      return null;
    }
  }
  if (!res.ok) return null;
  try {
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Discover authorization server metadata from an MCP server URL.
 *
 * Follows the MCP authorization spec: first read the server's protected
 * resource metadata (RFC 9728) to find its authorization server, then
 * read that issuer's metadata (RFC 8414, with OpenID Connect discovery
 * as a fallback). Servers that predate the spec and publish metadata
 * only at `<serverUrl>/.well-known/oauth-authorization-server` are
 * still probed, last.
 */
export async function discoverAuthServer(mcpServerUrl: string): Promise<AuthServerMetadata> {
  const base = mcpServerUrl.replace(/\/+$/, '');

  // Step 1: protected resource metadata names the issuer. Absent PRM,
  // the MCP server URL itself is the issuer.
  let issuer = base;
  for (const url of wellKnownUrls(base, 'oauth-protected-resource')) {
    const prm = (await fetchWellKnown(url)) as ProtectedResourceMetadata | null;
    const advertised = prm?.authorization_servers?.[0];
    if (typeof advertised === 'string' && advertised.length > 0) {
      issuer = advertised;
      break;
    }
  }

  // Step 2: issuer metadata. Most-specific compliant forms first, the
  // legacy path-suffix form last.
  const candidates = new Set<string>([
    ...wellKnownUrls(issuer, 'oauth-authorization-server'),
    ...wellKnownUrls(issuer, 'openid-configuration'),
    `${base}/.well-known/oauth-authorization-server`,
  ]);
  for (const url of candidates) {
    const meta = await fetchWellKnown(url);
    if (
      meta &&
      typeof meta.authorization_endpoint === 'string' &&
      typeof meta.token_endpoint === 'string'
    ) {
      return meta as unknown as AuthServerMetadata;
    }
  }

  throw new Error(
    `MCP OAuth discovery failed for ${mcpServerUrl}: no authorization server metadata at ${[...candidates].join(', ')}`,
  );
}

// ─── RFC 7591: Dynamic Client Registration ──────────────────────────────────

/** Register a dynamic OAuth client with the authorization server. */
export async function registerClient(
  registrationEndpoint: string,
  params: { clientName: string; redirectUris: string[] },
): Promise<RegisteredClient> {
  const res = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: params.clientName,
      redirect_uris: params.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MCP client registration failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as RegisteredClient;
}

// ─── RFC 7636: PKCE (S256) ──────────────────────────────────────────────────

/** Generate a PKCE code_verifier and code_challenge (S256). */
export async function generatePkceChallenge(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const codeVerifier = base64UrlEncode(bytes);

  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(codeVerifier));
  const codeChallenge = base64UrlEncode(new Uint8Array(digest));

  return { codeVerifier, codeChallenge };
}

/** Build an authorization URL with PKCE parameters. */
export function buildAuthorizationUrl(params: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scopes?: string[];
}): string {
  const query = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    state: params.state,
  });
  if (params.scopes?.length) {
    query.set('scope', params.scopes.join(' '));
  }
  return `${params.authorizationEndpoint}?${query}`;
}

// ─── Token Exchange & Refresh (Public Client, PKCE) ─────────────────────────

/** Exchange authorization code for tokens using PKCE (public client, no client_secret). */
export async function exchangeCodePkce(params: {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenResponse> {
  const res = await fetch(params.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: params.clientId,
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MCP PKCE token exchange failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as TokenResponse;
}

/** Refresh a token for a public client. */
export async function refreshTokenPkce(params: {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
}): Promise<TokenResponse> {
  const res = await fetch(params.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: params.clientId,
      refresh_token: params.refreshToken,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MCP PKCE token refresh failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as TokenResponse;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
