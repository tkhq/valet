/**
 * The contract between Valet's secret store and the system that holds the
 * values. Valet owns names, scopes, and access rules
 * (`services/secret-store/service.ts`). A provider owns storage, encryption,
 * and the provider-side checks it can apply. Turnkey is one provider
 * (`./turnkey.ts`); another backend implements this interface and registers
 * in `./config.ts`.
 *
 * Secrets live in **spaces**. The deployment space holds company and team
 * secrets; each user has a personal space that holds only that user's
 * secrets, so a lookup there can never return another user's secret. Valet
 * creates a personal space on the user's first save and stores its id in
 * `secret_store_spaces`.
 *
 * Names inside a space carry the scope prefix: `company/NAME`,
 * `team/<teamId>/NAME`, `personal/NAME`. The service builds them.
 */

export interface SecretMeta {
  /** The full name in the space, with its scope prefix. */
  name: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

/** String maps Valet builds. A provider with policy support stores labels
 * with the secret at import and checks the read context against them. */
export type SecretLabels = Readonly<Record<string, string>>;

/**
 * What the browser needs to seal a value for one import, and what it sends
 * back. `kind` selects the sealer (`web/src/lib/secret-seal/`). Everything
 * else is opaque to generic code.
 */
export interface SealEnvelope {
  kind: string;
  [field: string]: unknown;
}
export interface SealedValue {
  kind: string;
  [field: string]: unknown;
}

export interface SecretStoreProvider {
  /** Stable id stored with each personal space row, for example `turnkey`. */
  readonly id: string;
  /** Name shown to users, for example `Turnkey`. */
  readonly label: string;
  /** The space that holds company and team secrets. */
  deploymentSpace(): string;
  /** Create an empty personal space for one user and return its id. Valet
   * calls this once per user, under a lock. */
  createPersonalSpace(owner: { orgId: string; userId: string }): Promise<string>;
  /** Every secret in the space whose name starts with `prefix`. Throw
   * `SecretStoreError("too_many")` rather than return a partial list. */
  list(spaceId: string, prefix: string): Promise<SecretMeta[]>;
  /** Store a value the api holds in memory. Used only where the value
   * already reached the api (a key caught in an inbound message). */
  put(spaceId: string, secret: { name: string; value: string; labels: SecretLabels }): Promise<void>;
  /** Start an import whose value the browser seals. */
  beginImport(spaceId: string): Promise<SealEnvelope>;
  /** Finish an import with the value the browser sealed. */
  finishImport(spaceId: string, secret: { name: string; sealed: SealedValue; labels: SecretLabels }): Promise<void>;
  /** Delete by full name. Return false when no secret has that name. */
  remove(spaceId: string, name: string): Promise<boolean>;
  /** The value, or null when no secret has that name. `context` names the
   * session that asked; a provider with policy support checks it against
   * the secret's labels, and its audit log records it. */
  read(spaceId: string, name: string, context: SecretLabels): Promise<string | null>;
}

export type SecretStoreErrorKind =
  | "disabled"
  | "invalid_name"
  | "invalid_value"
  | "exists"
  | "not_found"
  | "too_many"
  | "forbidden"
  | "provider";

/** A failure with a message safe to show the user. Any other error from a
 * provider is replaced by a fixed message, because provider text can echo
 * request fields. */
export class SecretStoreError extends Error {
  constructor(
    message: string,
    readonly kind: SecretStoreErrorKind,
  ) {
    super(message);
    this.name = "SecretStoreError";
  }
}
