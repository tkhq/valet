/**
 * CredentialStore decorator for team rows (TKAI-205).
 *
 * A direct team credential (the row holds a secret) is returned as stored.
 * A delegated reference (`metadata.delegatedFrom`, no secret) is followed
 * to the delegator's live user row after a membership re-check. The source
 * row resolves when it holds a secret, or when it is itself a 1Password
 * reference (`metadata.onepassword`): the caller dereferences that on the
 * team's own scopes, so the row is returned with its metadata intact. A
 * missing source, a source with neither, or a lapsed membership throws
 * `CredentialReferenceBrokenError`. There is no fallback to the triggering
 * member.
 *
 * Compose this OUTSIDE `OAuthRefreshingCredentialStore` so a followed
 * reference refreshes under the source user, and a direct team credential
 * refreshes under the team owner.
 */
import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import { onePasswordMeta } from "../services/onepassword.js";

function rowSecret(credential: StoredCredential): string | undefined {
  const value = credential.accessToken ?? credential.apiKey;
  return value === "" ? undefined : value;
}

/** A source row the caller can turn into a secret: one it holds, or one a
 * 1Password reference points at. */
function rowResolvable(credential: StoredCredential): boolean {
  return rowSecret(credential) !== undefined || onePasswordMeta(credential) !== null;
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
      // Only a stored reference needs resolution. Obsolete grant-only rows
      // are empty stubs; metadata.refs no longer controls access.
      if (onePasswordMeta(row)) return row;
      return null;
    }

    if (!(await this.deps.isMember(owner.id, from))) {
      throw new CredentialReferenceBrokenError(service);
    }
    const source = await this.inner.get({ type: "user", id: from }, service);
    if (!source || !rowResolvable(source)) {
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
