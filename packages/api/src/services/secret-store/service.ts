/**
 * Personal secrets: values a user saves in Settings, Secrets and reads in a
 * session they own with `valet-secrets run --env NAME=secret://personal/<name>`.
 *
 * This file holds the rules that do not depend on the backend: the reference
 * grammar, name and value limits, one space per owner, the labels and read
 * context sent to the provider, and error text. The backend is a
 * `SecretStoreProvider` (`./provider.ts`).
 *
 * No route returns a value. `/api/sandbox-secrets/resolve` is the one reader,
 * and it checks the session owner before it calls `readPersonal`.
 */
import { and, eq, sql } from "drizzle-orm";
import type { AppDb, AppQueryable } from "../../lib/drizzle.js";
import { secretStoreSpaces } from "../../schema/index.js";
import { SecretStoreError, type SecretMeta, type SecretOwner, type SecretStoreProvider } from "./provider.js";

/** `secret://personal/<name>` names a personal secret. */
export const SECRET_REFERENCE_PREFIX = "secret://";
const PERSONAL_PREFIX = `${SECRET_REFERENCE_PREFIX}personal/`;

/** Segments of letters, digits, dot, dash, and underscore, joined by `/`.
 * `granola/api-key` and `GITHUB_TOKEN` are both names. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
export const MAX_SECRET_NAME_LENGTH = 100;
/** A development credential larger than this is a file. */
export const MAX_SECRET_VALUE_BYTES = 16 * 1024;

export function isSecretReference(reference: string): boolean {
  return reference.startsWith(SECRET_REFERENCE_PREFIX);
}

export function validSecretName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_SECRET_NAME_LENGTH && NAME_RE.test(name);
}

/** The personal secret a reference names, or null for any other shape. */
export function parsePersonalReference(reference: string): { name: string } | null {
  if (!reference.startsWith(PERSONAL_PREFIX)) return null;
  const name = reference.slice(PERSONAL_PREFIX.length);
  return validSecretName(name) ? { name } : null;
}

export function personalReference(name: string): string {
  return `${PERSONAL_PREFIX}${name}`;
}

export interface SecretUser {
  orgId: string;
  userId: string;
}

/** Who asked for a value. Every field comes from the sandbox principal and
 * the session row, never from the request body. */
export interface SecretReadContext extends SecretUser {
  sessionId: string;
  sessionOwnerType: "user";
  sessionOwnerId: string;
}

export interface SecretStoreService {
  readonly enabled: boolean;
  /** The provider's name for users, or null when the store is off. */
  readonly providerLabel: string | null;
  list(user: SecretUser): Promise<SecretMeta[]>;
  save(user: SecretUser, name: string, value: string): Promise<SecretMeta>;
  remove(user: SecretUser, name: string): Promise<void>;
  /** The value of the caller's own personal secret, or null when no secret
   * has that name. The caller has already checked that the session is the
   * user's own. */
  readPersonal(ctx: SecretReadContext, name: string): Promise<string | null>;
}

const DISABLED_MESSAGE = "The secret store is not set up on this Valet. Ask an operator to set VALET_SECRET_STORE.";

export function disabledSecretStore(): SecretStoreService {
  const refuse = async (): Promise<never> => {
    throw new SecretStoreError(DISABLED_MESSAGE, "disabled");
  };
  return { enabled: false, providerLabel: null, list: refuse, save: refuse, remove: refuse, readPersonal: refuse };
}

function personalOwner(user: SecretUser): SecretOwner {
  return { orgId: user.orgId, ownerType: "user", ownerId: user.userId };
}

export function createSecretStoreService(deps: {
  db: AppDb;
  provider: SecretStoreProvider;
  now?: () => number;
  log?: (msg: string, err: unknown) => void;
}): SecretStoreService {
  const { db, provider } = deps;
  const now = deps.now ?? Date.now;
  const log =
    deps.log ?? ((msg, err) => console.warn(`[secret-store:${provider.id}] ${msg}`, err instanceof Error ? err.message : err));

  /** A `SecretStoreError` passes through. Any other provider error is logged
   * and replaced: its text can echo request fields. */
  async function guarded<T>(action: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof SecretStoreError) throw err;
      log(`${action} failed`, err);
      throw new SecretStoreError(
        `${provider.label} could not ${action}. Try again. If it repeats, check the api logs.`,
        "provider",
      );
    }
  }

  async function existingSpace(q: AppQueryable, owner: SecretOwner): Promise<string | null> {
    const rows = await q
      .select({ spaceId: secretStoreSpaces.spaceId })
      .from(secretStoreSpaces)
      .where(
        and(
          eq(secretStoreSpaces.orgId, owner.orgId),
          eq(secretStoreSpaces.ownerType, owner.ownerType),
          eq(secretStoreSpaces.ownerId, owner.ownerId),
          eq(secretStoreSpaces.provider, provider.id),
        ),
      )
      .limit(1);
    return rows[0]?.spaceId ?? null;
  }

  /** One space per owner and provider. The advisory lock makes two first
   * saves wait for each other, so the second reads the row the first wrote.
   * If the provider created a space but the response was lost, the next save
   * creates another; the orphan holds no secret. */
  async function ensureSpace(owner: SecretOwner): Promise<string> {
    const found = await existingSpace(db, owner);
    if (found) return found;
    return db.transaction(async (tx) => {
      const lockKey = `secret-store-space:${provider.id}:${owner.orgId}:${owner.ownerType}:${owner.ownerId}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
      const raced = await existingSpace(tx, owner);
      if (raced) return raced;
      const spaceId = await guarded("create your secret space", () => provider.createSpace(owner));
      await tx.insert(secretStoreSpaces).values({ ...owner, provider: provider.id, spaceId, createdAt: now() });
      return spaceId;
    });
  }

  return {
    enabled: true,
    providerLabel: provider.label,

    async list(user) {
      const spaceId = await existingSpace(db, personalOwner(user));
      if (!spaceId) return [];
      return guarded("list your secrets", () => provider.list(spaceId));
    },

    async save(user, name, value) {
      if (!validSecretName(name)) {
        throw new SecretStoreError(
          `Name a secret with letters, digits, dot, dash, and underscore, in segments joined by "/", up to ${MAX_SECRET_NAME_LENGTH} characters.`,
          "invalid_name",
        );
      }
      if (value.length === 0) throw new SecretStoreError("Enter a value to save.", "invalid_value");
      if (Buffer.byteLength(value, "utf8") > MAX_SECRET_VALUE_BYTES) {
        throw new SecretStoreError(`A secret can be at most ${MAX_SECRET_VALUE_BYTES / 1024} KB.`, "invalid_value");
      }
      const owner = personalOwner(user);
      const spaceId = await ensureSpace(owner);
      // A value never changes in place. Checking first turns a provider's
      // duplicate refusal into an answer that says what to do.
      const existing = await guarded("check the name", () => provider.list(spaceId));
      if (existing.some((s) => s.name === name)) {
        throw new SecretStoreError(`A secret named ${name} already exists. Delete it first to replace it.`, "exists");
      }
      await guarded("save the secret", () =>
        provider.put(spaceId, {
          name,
          value,
          labels: {
            scope: "personal",
            valet_org_id: owner.orgId,
            valet_owner_type: owner.ownerType,
            valet_owner_id: owner.ownerId,
            valet_created_by_user_id: user.userId,
          },
        }),
      );
      return { name, createdAt: now() };
    },

    async remove(user, name) {
      const notFound = new SecretStoreError(`No secret named ${name}.`, "not_found");
      const spaceId = await existingSpace(db, personalOwner(user));
      if (!spaceId) throw notFound;
      const removed = await guarded("delete the secret", () => provider.remove(spaceId, name));
      if (!removed) throw notFound;
    },

    async readPersonal(ctx, name) {
      const spaceId = await existingSpace(db, personalOwner(ctx));
      if (!spaceId) return null;
      return guarded("read the secret", () =>
        provider.read(spaceId, name, {
          valet_org_id: ctx.orgId,
          valet_user_id: ctx.userId,
          valet_session_id: ctx.sessionId,
          valet_session_owner_type: ctx.sessionOwnerType,
          valet_session_owner_id: ctx.sessionOwnerId,
        }),
      );
    },
  };
}
