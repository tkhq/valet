/**
 * Per-owner encryption keys for the `credentials` table, held in the secret
 * store.
 *
 * Without a secret store, every OAuth token, refresh token, and API key in
 * `credentials` is encrypted with one instance key (`VALET_ENCRYPTION_KEY`),
 * so the database and that one key together expose all of them. With
 * `VALET_CREDENTIAL_KEYS=secret-store`, each owner (a user, a team, the org)
 * gets its own random 32-byte key. The key is a secret in the deployment
 * space, labeled with its owner, and the provider releases it only to a
 * read whose context names the same owner. Every key read is an audited
 * provider activity. Deleting an owner's key makes their stored tokens
 * unreadable.
 *
 * Tokens stay in Postgres, so a token refresh costs no provider call, and
 * keys are cached in memory for a short time, so a tool call rarely does.
 *
 * Ciphertext written with an owner key starts with `ek1:`. Reads accept both
 * forms whenever a secret store is configured, so turning the setting off
 * later still reads every row; writes then use the instance key again.
 */
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { CredentialOwner } from "@valet/engine";
import type { AppDb } from "../../lib/drizzle.js";
import { decryptSecret, encryptSecret } from "../../lib/secret-crypto.js";
import type { SecretStoreProvider } from "./provider.js";

export const OWNER_KEY_PREFIX = "ek1:";
const KEY_BYTES = 32;

export interface CredentialKeyring {
  keyFor(owner: CredentialOwner): Promise<Buffer>;
}

/** `user:<id>`, `team:<id>`, or `org:<id>`: the label and the read context name it. */
export function keyOwnerLabel(owner: CredentialOwner): string {
  return `${owner.type}:${owner.id}`;
}

/** The secret's name in the deployment space. */
export function ownerKeyName(owner: CredentialOwner): string {
  return `keys/credentials/${owner.type}/${owner.id}`;
}

export function createCredentialKeyring(deps: {
  provider: SecretStoreProvider;
  db: AppDb;
  /** The Valet organization id, stamped on each key and its reads. */
  orgId: () => Promise<string>;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}): CredentialKeyring {
  const ttlMs = deps.ttlMs ?? 10 * 60 * 1000;
  const maxEntries = deps.maxEntries ?? 1000;
  const now = deps.now ?? Date.now;
  /** Bounded: the oldest entry goes first when full. */
  const cache = new Map<string, { key: Buffer; expiresAt: number }>();
  const inflight = new Map<string, Promise<Buffer>>();

  function remember(label: string, key: Buffer): void {
    cache.delete(label);
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(label, { key, expiresAt: now() + ttlMs });
  }

  async function loadOrCreate(owner: CredentialOwner): Promise<Buffer> {
    const space = deps.provider.deploymentSpace();
    const name = ownerKeyName(owner);
    const org = await deps.orgId();
    const label = keyOwnerLabel(owner);
    const context = { valet_company_org_id: org, valet_key_owner: label };
    // One creator per owner across api processes: two first writes wait for
    // each other, and the second reads the key the first stored.
    return deps.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`credential-key:${label}`}))`);
      const existing = await deps.provider.read(space, name, context);
      if (existing !== null) {
        const key = Buffer.from(existing, "base64");
        if (key.length !== KEY_BYTES) throw new Error(`The stored credential key for ${label} is damaged.`);
        return key;
      }
      const key = randomBytes(KEY_BYTES);
      await deps.provider.put(space, {
        name,
        value: key.toString("base64"),
        labels: { scope: "credential_key", valet_company_org_id: org, valet_key_owner: label },
      });
      return key;
    });
  }

  return {
    async keyFor(owner) {
      const label = keyOwnerLabel(owner);
      const hit = cache.get(label);
      if (hit && hit.expiresAt > now()) return hit.key;
      const running = inflight.get(label);
      if (running) return running;
      const loading = loadOrCreate(owner)
        .then((key) => {
          remember(label, key);
          return key;
        })
        .finally(() => inflight.delete(label));
      inflight.set(label, loading);
      return loading;
    },
  };
}

/** Encrypts and decrypts one credential field for its owner. */
export interface CredentialCipher {
  encrypt(owner: CredentialOwner, value: string): Promise<string>;
  decrypt(owner: CredentialOwner, value: string): Promise<string>;
  /** True when `value` is in the form writes use now. */
  isCurrent(value: string): boolean;
}

/**
 * `keyring` set: reads accept owner-key ciphertext. `writeOwnerKeys`: writes
 * use the owner's key. Without a keyring, an `ek1:` value cannot be read and
 * the error names the fix.
 */
export function credentialCipher(instanceKey: Buffer, keyring?: CredentialKeyring, writeOwnerKeys = false): CredentialCipher {
  const useOwnerKeys = writeOwnerKeys && keyring !== undefined;
  return {
    async encrypt(owner, value) {
      if (!useOwnerKeys) return encryptSecret(value, instanceKey);
      return OWNER_KEY_PREFIX + encryptSecret(value, await keyring.keyFor(owner));
    },
    async decrypt(owner, value) {
      if (!value.startsWith(OWNER_KEY_PREFIX)) return decryptSecret(value, instanceKey);
      if (!keyring) {
        throw new Error(
          "This credential is encrypted with a key held in the secret store, and no secret store is configured. Set VALET_SECRET_STORE and its keys again, then retry.",
        );
      }
      return decryptSecret(value.slice(OWNER_KEY_PREFIX.length), await keyring.keyFor(owner));
    },
    isCurrent(value) {
      return value.startsWith(OWNER_KEY_PREFIX) === useOwnerKeys;
    },
  };
}
