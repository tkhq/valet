/**
 * CredentialStore decorator: lazily refreshes near-expiry oauth2
 * credentials on read (integration-OAuth design). Refresh routes by the
 * service's manifest declaration — mcp mode via the stored registered
 * client (mcp_oauth_clients) + refreshTokenPkce, authorization_code mode
 * via the declaration's tokenUrl + env client id/secret. GitHub never
 * routes through here (its refresh lives in services/github-tokens.ts) —
 * findOAuthDeclaration excludes it. Refresh failure stamps
 * metadata.refreshFailedAt (the health field the credential summary
 * already whitelists) and returns the stored credential: the caller gets
 * the provider's own 401 and the UI shows the unhealthy badge.
 */
import { eq } from "drizzle-orm";
import type { CredentialOwner, CredentialStore, StoredCredential, ValetPlugin } from "@valet/engine";
import { refreshTokenPkce, type TokenResponse } from "@valet/sdk";
import type { AppQueryable } from "../lib/drizzle.js";
import { mcpOauthClients } from "../schema/index.js";
import { findOAuthDeclaration, refreshAuthorizationCodeToken } from "../services/integration-oauth.js";

const REFRESH_BUFFER_MS = 60_000;

interface Deps {
  db: AppQueryable;
  plugins: ValetPlugin[];
  env: Record<string, string | undefined>;
  now?: () => number;
}

export class OAuthRefreshingCredentialStore implements CredentialStore {
  constructor(
    private readonly inner: CredentialStore,
    private readonly deps: Deps,
  ) {}

  async get(owner: CredentialOwner, service: string): Promise<StoredCredential | null> {
    const stored = await this.inner.get(owner, service);
    if (!stored) return null;
    if (stored.type !== "oauth2" || !stored.refreshToken || stored.expiresAt === undefined) return stored;
    const now = (this.deps.now ?? Date.now)();
    if (stored.expiresAt - now >= REFRESH_BUFFER_MS) return stored;
    const found = findOAuthDeclaration(this.deps.plugins, service);
    if (!found) return stored;

    let tokens: TokenResponse;
    try {
      if (found.oauth.mode === "mcp") {
        const rows = await this.deps.db.select().from(mcpOauthClients).where(eq(mcpOauthClients.service, service));
        const client = rows[0];
        if (!client) throw new Error(`no registered MCP client for ${service}`);
        tokens = await refreshTokenPkce({
          tokenEndpoint: client.tokenEndpoint,
          clientId: client.clientId,
          refreshToken: stored.refreshToken,
        });
      } else {
        tokens = await refreshAuthorizationCodeToken({
          oauth: found.oauth,
          env: this.deps.env,
          refreshToken: stored.refreshToken,
        });
      }
    } catch (err) {
      console.error(`credential refresh failed for ${service}:`, err);
      const stamped: StoredCredential = {
        ...stored,
        metadata: { ...stored.metadata, refreshFailedAt: now },
      };
      await this.inner.save(owner, service, stamped);
      return stored;
    }

    const { refreshFailedAt: _cleared, ...restMetadata } = stored.metadata ?? {};
    const fresh: StoredCredential = {
      ...stored,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? stored.refreshToken,
      expiresAt: typeof tokens.expires_in === "number" ? now + tokens.expires_in * 1000 : undefined,
      metadata: Object.keys(restMetadata).length > 0 ? restMetadata : undefined,
    };
    await this.inner.save(owner, service, fresh);
    return fresh;
  }

  save(owner: CredentialOwner, service: string, credential: StoredCredential): Promise<void> {
    return this.inner.save(owner, service, credential);
  }
  delete(owner: CredentialOwner, service: string): Promise<void> {
    return this.inner.delete(owner, service);
  }
  list(owner: CredentialOwner): Promise<{ service: string; scopes?: string[]; connectedAt: string }[]> {
    return this.inner.list(owner);
  }
}
