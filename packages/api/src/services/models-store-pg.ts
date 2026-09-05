/**
 * Postgres-backed pi-ai `ModelsStore` (TKAI-327).
 *
 * pi-ai's default store is `InMemoryModelsStore`, which loses the fetched
 * catalog at every process exit. Each api replica would then refetch the
 * upstream registry on boot, and a restart loop would hammer the upstream.
 * This store keeps the catalog in `model_registry_cache` instead, so the
 * fetched models and their HTTP validators survive a restart and are shared
 * by every replica: the second replica to check sends the first replica's
 * `etag` and gets a 304.
 *
 * The table is deployment-wide, keyed by pi-ai provider id. It is NOT
 * org-scoped — the upstream registry is the same catalog for every org.
 * Per-org exposure stays where it already lives: `llm_providers` rows and
 * the org catalog (`services/model-catalog.ts`).
 *
 * Every method degrades instead of throwing. A read failure returns
 * `undefined`, which pi-ai treats as "nothing cached" and which
 * `services/model-registry.ts` turns into the bundled compile-time
 * fallback. A write failure is logged and dropped: losing a cache write
 * costs one refetch, and must never fail the turn that triggered it.
 */
import { eq } from "drizzle-orm";
import type { ModelsStore, ModelsStoreEntry, ModelsStoreOperationOptions } from "@earendil-works/pi-ai";
import type { AppDb } from "../lib/drizzle.js";
import { modelRegistryCache } from "../schema/index.js";
import { isRegistryModel, type RegistryModel } from "./model-registry-parse.js";

/** Rows older than this are ignored on read, so a catalog whose refresh
 * stopped cannot be served forever. The bundled list takes over instead —
 * stale-but-plausible model metadata is worse than the known-good baseline.
 * Sized well above the refresh interval so an ordinary 304 cycle never
 * trips it. */
const MAX_ENTRY_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Write options. Extends pi-ai's own options, so this store stays a
 * `ModelsStore` and pi-ai can keep calling `write` with just a signal. */
export interface ModelsStoreWriteOptions extends ModelsStoreOperationOptions {
  /**
   * Set the stored `etag` and `lastModified` to NULL.
   *
   * A write that merely omits the validators keeps them, which rule 2 in
   * `write` needs. Clearing them is a different intent, so it needs its own
   * flag: `services/model-registry.ts` sets it when upstream answers 404 or
   * 501, where no cached body will ever be revalidated again.
   */
  clearValidators?: boolean;
}

export class PgModelsStore implements ModelsStore {
  constructor(
    private readonly db: AppDb,
    private readonly now: () => number = Date.now,
  ) {}

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    let rows;
    try {
      rows = await this.db
        .select()
        .from(modelRegistryCache)
        .where(eq(modelRegistryCache.providerId, providerId))
        .limit(1);
    } catch (err) {
      // A cache read must never fail a catalog build. Degrade to "nothing
      // stored" and let the bundled list serve this request.
      console.error(`model-registry: cache read failed for ${providerId}:`, err);
      return undefined;
    }

    const row = rows[0];
    if (!row) return undefined;

    if (this.now() - row.updatedAt > MAX_ENTRY_AGE_MS) return undefined;

    // Validate on read, not just on write. The row is a cache of a remote
    // payload, so a schema change upstream (or a hand-edited row) must not
    // reach the model picker as a half-built model object.
    const models: RegistryModel[] = [];
    for (const candidate of row.models) {
      if (isRegistryModel(candidate)) models.push(candidate);
    }
    if (models.length === 0) return undefined;

    return {
      models,
      etag: row.etag ?? undefined,
      lastModified: row.lastModified ?? undefined,
      checkedAt: row.checkedAt ?? undefined,
    };
  }

  /**
   * Upsert a provider's catalog.
   *
   * Two rules keep a bad write from destroying a good cache:
   *
   * 1. An entry with no well-formed model does not touch the models column.
   *    pi-ai calls `write` directly, so this method cannot assume the
   *    registry service already screened the payload.
   * 2. `etag` and `lastModified` are written only when the entry carries
   *    them. pi-ai's `createProvider` persists `{ models, checkedAt }` with
   *    no validators right after `fetchModels` resolves. Clearing the
   *    columns there would erase the ETag the fetch just captured and make
   *    every later check unconditional.
   *
   * Omitting a key from the `onConflictDoUpdate` set leaves that column at
   * its stored value, which is how both rules are expressed below.
   *
   * `options.clearValidators` overrides rule 2 for the caller that means to
   * stop revalidating. Rule 1 still holds, so clearing the validators does
   * not throw away the cached models.
   */
  async write(
    providerId: string,
    entry: ModelsStoreEntry,
    options: ModelsStoreWriteOptions = {},
  ): Promise<void> {
    // Keep only well-formed models, so a half-built record never reaches the
    // model picker.
    const models = entry.models.filter((m): m is RegistryModel => isRegistryModel(m));
    const now = this.now();
    const clear = options.clearValidators === true;
    const etag = clear ? null : (entry.etag ?? null);
    const lastModified = clear ? null : (entry.lastModified ?? null);
    const checkedAt = entry.checkedAt ?? now;
    // Rule 2 keeps a stored validator when the write omits it. A clearing
    // write means the opposite, so it sets the columns to NULL explicitly.
    const validatorSet = clear
      ? { etag: null, lastModified: null }
      : {
          ...(etag === null ? {} : { etag }),
          ...(lastModified === null ? {} : { lastModified }),
        };
    try {
      await this.db
        .insert(modelRegistryCache)
        .values({ providerId, models, etag, lastModified, checkedAt, updatedAt: now })
        .onConflictDoUpdate({
          target: modelRegistryCache.providerId,
          set: {
            // Rule 1: an empty result keeps the stored catalog. The check
            // still happened, so `checkedAt` advances either way.
            ...(models.length === 0 ? {} : { models }),
            ...validatorSet,
            checkedAt,
            updatedAt: now,
          },
        });
    } catch (err) {
      // Losing a cache write costs one refetch on the next check.
      console.error(`model-registry: cache write failed for ${providerId}:`, err);
    }
  }

  async delete(providerId: string): Promise<void> {
    try {
      await this.db.delete(modelRegistryCache).where(eq(modelRegistryCache.providerId, providerId));
    } catch (err) {
      console.error(`model-registry: cache delete failed for ${providerId}:`, err);
    }
  }
}
