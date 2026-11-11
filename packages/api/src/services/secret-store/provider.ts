/**
 * The contract between Valet's secret store and the system that holds the
 * values. Valet owns names, owners, and access rules
 * (`services/secret-store/service.ts`). A provider owns storage and
 * encryption. Turnkey is one provider (`./turnkey.ts`); another backend
 * implements this interface and registers in `./config.ts`.
 *
 * A provider keeps each owner's secrets in one **space**: a Turnkey
 * sub-organization, a path prefix in a key-value store, or a separate
 * account. Valet creates a space on the owner's first save and stores its id
 * in `secret_store_spaces`. A space holds the secrets of one owner only, so a
 * name lookup in it can never return another owner's secret.
 */

/** Who a space belongs to. Only personal spaces exist today. */
export interface SecretOwner {
  orgId: string;
  ownerType: "user";
  ownerId: string;
}

export interface SecretMeta {
  name: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

/** String maps Valet builds and a provider records as it can. A provider
 * that cannot store metadata may ignore them. */
export type SecretLabels = Readonly<Record<string, string>>;

export interface SecretStoreProvider {
  /** Stable id stored with each space row, for example `turnkey`. Changing
   * the provider gives every owner a new, empty space. */
  readonly id: string;
  /** Name shown to users, for example `Turnkey`. */
  readonly label: string;
  /** Create an empty space for one owner and return its id. Valet calls
   * this once per owner, under a lock. */
  createSpace(owner: SecretOwner): Promise<string>;
  /** Every secret in the space. Throw `SecretStoreError("too_many")` rather
   * than return a partial list: a lookup on a short list reports a saved
   * secret as missing. */
  list(spaceId: string): Promise<SecretMeta[]>;
  /** Store a new secret. `labels` name the owner and scope; a provider with
   * policy support can check them on read. */
  put(spaceId: string, secret: { name: string; value: string; labels: SecretLabels }): Promise<void>;
  /** Delete by name. Return false when no secret has that name. */
  remove(spaceId: string, name: string): Promise<boolean>;
  /** The value, or null when no secret has that name. `context` names the
   * session that asked; a provider with an audit log records it. */
  read(spaceId: string, name: string, context: SecretLabels): Promise<string | null>;
}

export type SecretStoreErrorKind =
  | "disabled"
  | "invalid_name"
  | "invalid_value"
  | "exists"
  | "not_found"
  | "too_many"
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
