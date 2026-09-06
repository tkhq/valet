/**
 * CredentialStore decorator for team rows (TKAI-205).
 *
 * A direct team credential (the row holds a secret) is returned as stored.
 * A delegated reference (`metadata.delegatedFrom`, no secret) is followed
 * to the delegator's live user row after a membership re-check. A missing
 * source or a lapsed membership throws `CredentialReferenceBrokenError`.
 * There is no fallback to the triggering member.
 *
 * Compose this OUTSIDE `OAuthRefreshingCredentialStore` so a followed
 * reference refreshes under the source user, and a direct team credential
 * refreshes under the team owner.
 */
import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import { onePasswordMeta } from "../services/onepassword.js";
import { refsFromGrantRow } from "../services/team-onepassword-grant.js";

function rowSecret(credential: StoredCredential): string | undefined {
  const value = credential.accessToken ?? credential.apiKey;
  return value === "" ? undefined : value;
}

export class CredentialReferenceBrokenError extends Error {
  readonly code = "credential_reference_broken";

  constructor(service: string) {
    super(
      `This team's ${service} credential no longer resolves. Reconnect ${service}, share it with the team again, or store a direct team credential.`,
    );
    this.name = "CredentialReferenceBrokenError";
  }
}

export interface TeamCredentialStoreDeps {
  isMember(teamId: string, userId: string): Promise<boolean>;
}

function delegatedFrom(row: StoredCredential): string | undefined {
  const raw = row.metadata?.delegatedFrom;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

export class TeamCredentialStore implements CredentialStore {
  constructor(
    private readonly inner: CredentialStore,
    private readonly deps: TeamCredentialStoreDeps,
  ) {}

  async get(owner: CredentialOwner, service: string): Promise<StoredCredential | null> {
    if (owner.type !== "team") return this.inner.get(owner, service);
    const row = await this.inner.get(owner, service);
    if (!row) return null;
    if (rowSecret(row)) return row;
    const from = delegatedFrom(row);
    if (!from) {
      // Empty stub (no secret, no delegation). A 1Password reference still
      // needs to reach `resolveRow`. The team's leased `op://` set lives on
      // the reserved `onepassword` row as `metadata.refs` and must surface
      // so grant reads are not always empty.
      if (onePasswordMeta(row) || refsFromGrantRow(row).length > 0) return row;
      return null;
    }

    if (!(await this.deps.isMember(owner.id, from))) {
      throw new CredentialReferenceBrokenError(service);
    }
    const source = await this.inner.get({ type: "user", id: from }, service);
    if (!source || !rowSecret(source)) {
      throw new CredentialReferenceBrokenError(service);
    }
    return source;
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
