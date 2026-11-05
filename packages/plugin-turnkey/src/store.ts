/**
 * Documents the plugin keeps in the plugin store (plugin `turnkey`,
 * `docs/specs/2026-08-29-plugin-store-design.md`). The api reads the same
 * collections through `pluginStore(db, "turnkey")` for the sandbox routes
 * and the cleanup sweep, so the shapes live here and nowhere else.
 */

export const PLUGIN_NAME = "turnkey";

export const COLLECTIONS = {
  /** Scope `user`, key `default`. */
  enrollment: "enrollment",
  /** Scope `session`, key `default`. */
  sessionKey: "session_key",
  /** Scope `user`, key `signingKeyDocKey(...)`; scope `session`, key `current`. */
  signingKeys: "signing_keys",
  /**
   * Scope `global`, key `signingKeyDocKey(...)`: one row per key, so the
   * cleanup sweep and the allowed-signers route can find keys across users.
   * The plugin store lists within one scope only. The row stays after the
   * key closes: the allowed-signers file must keep listing old keys, with
   * their window, for `git verify-commit` on old commits.
   */
  signingKeyIndex: "signing_key_index",
} as const;

export const DEFAULT_KEY = "default";
export const CURRENT_KEY = "current";

/** One Turnkey sub-organization per Valet user, created at enrollment. */
export interface EnrollmentDoc {
  subOrgId: string;
  /** The passkey root user. */
  passkeyUserId: string;
  /** `valet-agent`, holder of the session API keys. */
  agentUserId: string;
  /** User tag on `valet-agent`, named in the allow policy. */
  agentTagId: string;
  /** Private key tag every signing key carries, named in the allow policy. */
  signingTagId: string;
  policyId: string;
  createdAt: number;
}

/** The expiring API key one session holds on `valet-agent`. */
export interface SessionKeyDoc {
  apiKeyId: string;
  publicKey: string;
  createdAt: number;
  expiresAt: number;
}

export type SigningKeyStatus = "active" | "revoked" | "closed";

export interface SigningKeyDoc {
  sessionId: string;
  userId: string;
  orgId: string;
  repo: string;
  branch: string;
  prNumber?: number;
  fingerprint: string;
  /** `ssh-ed25519 AAAA...`. */
  publicKey: string;
  githubKeyId: number;
  turnkeySubOrgId: string;
  turnkeyPrivateKeyId: string;
  turnkeyCreateActivityId: string;
  gateId?: string;
  notBefore: number;
  notAfter: number;
  status: SigningKeyStatus;
  createdAt: number;
  closedAt?: number;
}

/** The global index row: enough to find the user-scope record, decide expiry, and render allowed signers. */
export interface SigningKeyIndexDoc {
  userId: string;
  userEmail?: string;
  orgId: string;
  sessionId: string;
  /** Key of the user-scope `signing_keys` row. */
  userKey: string;
  fingerprint: string;
  publicKey: string;
  githubKeyId: number;
  notBefore: number;
  notAfter: number;
  status: SigningKeyStatus;
}

/** Sorts by creation time; the fingerprint keeps two keys in one millisecond apart. */
export function signingKeyDocKey(createdAt: number, fingerprint: string): string {
  return `${String(createdAt).padStart(15, "0")}-${fingerprint.replace(/[^A-Za-z0-9]/g, "")}`;
}
