/**
 * CredentialStore decorator for team rows (TKAI-205).
 *
 * A team's own credential (the row holds a secret) is returned as stored,
 * and so is a 1Password reference row: the caller dereferences that on the
 * team's own scopes. Any other secretless team row is an empty stub and
 * reads as absent. A member's shared account is not a team row; the team
 * read follows it (`services/credential-shares.ts`).
 */
import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import { onePasswordMeta } from "../services/onepassword.js";

function rowSecret(credential: StoredCredential): string | undefined {
  const value = credential.accessToken ?? credential.apiKey;
  return value === "" ? undefined : value;
}

/** A member shares an account whose own credential no longer resolves. */
export class CredentialReferenceBrokenError extends Error {
  readonly code = "credential_reference_broken";

  constructor(service: string) {
    super(
      `The ${service} account shared with this team no longer resolves. The member who shared it should reconnect ${service}, or the team can store its own ${service} connection.`,
    );
    this.name = "CredentialReferenceBrokenError";
  }
}

export class TeamCredentialStore implements CredentialStore {
  constructor(private readonly inner: CredentialStore) {}

  async get(owner: CredentialOwner, service: string): Promise<StoredCredential | null> {
    const row = await this.inner.get(owner, service);
    if (owner.type !== "team" || !row || rowSecret(row)) return row;
    return onePasswordMeta(row) ? row : null;
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
