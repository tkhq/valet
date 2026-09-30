/**
 * CredentialStore decorator: renews the organization's Linear app-actor
 * token on read. The org `linear` row holds a `client_credentials` token,
 * which Linear issues for 30 days with no refresh token. Valet holds the
 * app's client ID and secret (`linear_app`), so it mints a replacement when
 * the stored token is within `RENEW_BUFFER_MS` of `metadata.tokenExpiresAt`.
 *
 * Renewal is normal operation, not a repair: every token expires. A failed
 * renewal stamps `metadata.refreshFailedAt` and returns the stored row, the
 * same contract as `OAuthRefreshingCredentialStore`, so the caller gets
 * Linear's own 401. Reads skip renewal for `RETRY_AFTER_FAILURE_MS` after a
 * failure, and saving the app again in settings clears the stamp.
 *
 * Only org-owned rows marked `metadata.grant = "client_credentials"` are
 * touched. Personal and team `linear` rows are MCP OAuth credentials and
 * refresh through `OAuthRefreshingCredentialStore`.
 */
import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import { createLinearService } from "../services/linear.js";
import {
  loadLinearAppConfig,
  LINEAR_CLIENT_CREDENTIALS_GRANT,
  LINEAR_CREDENTIAL_SERVICE,
} from "../services/linear-app.js";

/** Renew a day early: the token lasts 30 days, and a day of margin keeps a
 * slow or failed renewal from reaching callers as an expired token. */
const RENEW_BUFFER_MS = 24 * 60 * 60 * 1000;

/** After a failed renewal, reads return the stored row without calling Linear
 * until this window passes. Without it, every credential read during a Linear
 * outage or after a bad secret made another token request. */
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;

interface Deps {
  env: NodeJS.ProcessEnv;
  now?: () => number;
}

function needsRenewal(owner: CredentialOwner, service: string, stored: StoredCredential | null, now: number): boolean {
  if (!stored || owner.type !== "org" || service !== LINEAR_CREDENTIAL_SERVICE) return false;
  if (stored.metadata?.grant !== LINEAR_CLIENT_CREDENTIALS_GRANT) return false;
  const failedAt = stored.metadata.refreshFailedAt;
  if (typeof failedAt === "number" && now - failedAt < RETRY_AFTER_FAILURE_MS) return false;
  const expiresAt = stored.metadata.tokenExpiresAt;
  return typeof expiresAt !== "number" || expiresAt - now < RENEW_BUFFER_MS;
}

export class LinearAppTokenStore implements CredentialStore {
  private readonly inFlight = new Map<string, Promise<StoredCredential | null>>();

  constructor(
    private readonly inner: CredentialStore,
    private readonly deps: Deps,
  ) {}

  async get(owner: CredentialOwner, service: string): Promise<StoredCredential | null> {
    const stored = await this.inner.get(owner, service);
    const now = (this.deps.now ?? Date.now)();
    if (!needsRenewal(owner, service, stored, now)) return stored;

    const existing = this.inFlight.get(owner.id);
    if (existing) return existing;
    const renewal = this.renew(owner, now).finally(() => this.inFlight.delete(owner.id));
    this.inFlight.set(owner.id, renewal);
    return renewal;
  }

  private async renew(owner: CredentialOwner, now: number): Promise<StoredCredential | null> {
    // Re-read: another caller may have renewed while this one queued.
    const stored = await this.inner.get(owner, LINEAR_CREDENTIAL_SERVICE);
    if (!stored || !needsRenewal(owner, LINEAR_CREDENTIAL_SERVICE, stored, now)) return stored;
    const config = await loadLinearAppConfig(this.inner, owner.id);
    if (!config) return stored;

    let token: { accessToken: string; expiresAt: number };
    try {
      token = await createLinearService(config, this.deps.env).clientCredentialsToken();
    } catch (err) {
      console.error(`linear app token renewal failed for org ${owner.id}:`, err);
      const stamped: StoredCredential = { ...stored, metadata: { ...stored.metadata, refreshFailedAt: now } };
      return (await this.saveIfUnchanged(owner, stored, stamped)) === stamped ? stored : this.inner.get(owner, LINEAR_CREDENTIAL_SERVICE);
    }
    const { refreshFailedAt: _cleared, ...metadata } = stored.metadata ?? {};
    const fresh: StoredCredential = {
      ...stored,
      accessToken: token.accessToken,
      metadata: { ...metadata, tokenExpiresAt: token.expiresAt },
    };
    return this.saveIfUnchanged(owner, stored, fresh);
  }

  /**
   * Saves a renewal only if the stored credential is still the one it renewed.
   * An admin can disconnect or reconnect Linear while the token request is in
   * flight; saving then would bring back a revoked installation. Returns what
   * callers should use: `next` when saved, otherwise the current row, or null
   * after a disconnect. The store offers no compare-and-swap, so a write that
   * lands between this read and the save can still lose to it.
   */
  private async saveIfUnchanged(owner: CredentialOwner, expected: StoredCredential, next: StoredCredential): Promise<StoredCredential | null> {
    const current = await this.inner.get(owner, LINEAR_CREDENTIAL_SERVICE);
    if (!current || current.accessToken !== expected.accessToken) return current;
    await this.inner.save(owner, LINEAR_CREDENTIAL_SERVICE, next);
    return next;
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
