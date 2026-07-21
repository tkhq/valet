/**
 * Lazy link-index backfill and expiry sweep for orchestrator memory.
 *
 * The `memory_links` graph and the derived FTS description/tags fields were
 * added by migration 0026, which left existing rows unindexed. `ensureLinksIndexed`
 * walks a user's files once (idempotent) and rebuilds their derived stores,
 * recording a per-user sentinel (`orchestrator_identities.links_indexed_at`) so
 * the walk runs at most once. It is called from every link-consuming path so a
 * consumer that fails *silently* against an empty link table (prune treating a
 * hub as unlinked is a deletion-class failure) can never run pre-backfill.
 *
 * Imports only `memory-derived-stores.ts` (never `memory-files.ts`) so that
 * `memory-files.ts` may call `ensureLinksIndexed` from its prune/delete paths
 * without an import cycle. It never calls the snapshot builder (recursion trap).
 */
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import {
  syncDerivedStores,
  IMPORT_CHUNK,
  LINK_INSERT_CHUNK,
  type DerivedRow,
  type MemoryScope,
} from './memory-derived-stores.js';

// In-isolate cache: if backfill ran in this Worker isolate, skip the sentinel read.
// Cleared on cold start; safe because backfill is idempotent. This also covers
// the case where a user has no `orchestrator_identities` row to persist the
// sentinel in (HTTP-API-first users) — without this cache, such users would
// re-run the full backfill on every single call within the isolate's lifetime.
const backfilledThisBoot = new Set<string>();

/** Test-only: clear the in-isolate backfill cache so tests can exercise
 * `ensureLinksIndexed` fresh without cross-test bleed. */
export function _resetBackfillCacheForTests(): void {
  backfilledThisBoot.clear();
}

/**
 * Ensure a user's `memory_links` + FTS derived stores are backfilled.
 *
 * Checks the in-isolate cache first (cheapest possible path — no DB round trip).
 * Otherwise reads the `links_indexed_at` sentinel (one indexed row). When unset,
 * walks every file and rebuilds its derived stores in chunked atomic batches,
 * then stamps the sentinel. Returns `true` iff a backfill ran.
 *
 * Idempotent and safe under concurrent first-triggers: the rebuild is
 * DELETE+INSERT / INSERT-OR-REPLACE, so overlapping runs converge. A user with
 * no `orchestrator_identities` row (orchestrator never provisioned) has nowhere
 * to store the sentinel, so the in-isolate cache is what prevents re-backfilling
 * on every call for the rest of this isolate's lifetime; it self-corrects (picks
 * up the real sentinel) once the identity is created and a new isolate boots.
 */
export async function ensureLinksIndexed(rawDb: D1Database, scope: MemoryScope): Promise<boolean> {
  if (backfilledThisBoot.has(scope.userId)) return false;

  const identity = await rawDb
    .prepare('SELECT id, links_indexed_at FROM orchestrator_identities WHERE user_id = ? LIMIT 1')
    .bind(scope.userId)
    .first<{ id: string; links_indexed_at: string | null }>();

  if (identity && identity.links_indexed_at) {
    backfilledThisBoot.add(scope.userId);
    return false;
  }

  const rows = await rawDb
    .prepare('SELECT path, title, description, tags, content FROM orchestrator_memory_files WHERE user_id = ?')
    .bind(scope.userId)
    .all<DerivedRow>();
  const files = rows.results ?? [];

  for (let i = 0; i < files.length; i += IMPORT_CHUNK) {
    const chunk = files.slice(i, i + IMPORT_CHUNK);
    await rawDb.batch(syncDerivedStores(rawDb, scope, chunk));
  }

  if (identity) {
    await rawDb
      .prepare("UPDATE orchestrator_identities SET links_indexed_at = datetime('now') WHERE id = ?")
      .bind(identity.id)
      .run();
  }

  backfilledThisBoot.add(scope.userId);
  return true;
}

/**
 * Delete every expired file (and its FTS + link rows in both directions) across
 * all users. Called from the nightly cron. Returns the number of files deleted.
 *
 * Expiry eviction only ever happens in write-path operations (prune + this
 * sweep) — reads and searches never delete (see the design's expiry section).
 */
export async function sweepExpiredMemories(rawDb: D1Database): Promise<number> {
  const userRows = await rawDb
    .prepare(
      "SELECT DISTINCT user_id FROM orchestrator_memory_files WHERE expires IS NOT NULL AND expires <= datetime('now')",
    )
    .all<{ user_id: string }>();

  let total = 0;
  for (const { user_id } of userRows.results ?? []) {
    total += await sweepExpiredForUser(rawDb, { userId: user_id });
  }
  return total;
}

async function sweepExpiredForUser(rawDb: D1Database, scope: MemoryScope): Promise<number> {
  const rows = await rawDb
    .prepare(
      "SELECT path FROM orchestrator_memory_files WHERE user_id = ? AND expires IS NOT NULL AND expires <= datetime('now')",
    )
    .bind(scope.userId)
    .all<{ path: string }>();
  const paths = (rows.results ?? []).map((r) => r.path);
  if (paths.length === 0) return 0;

  const stmts: D1PreparedStatement[] = [
    // FTS: delete by rowid before the base rows disappear.
    rawDb
      .prepare(
        `DELETE FROM orchestrator_memory_files_fts WHERE rowid IN (
           SELECT rowid FROM orchestrator_memory_files
           WHERE user_id = ? AND expires IS NOT NULL AND expires <= datetime('now'))`,
      )
      .bind(scope.userId),
    rawDb
      .prepare(
        `DELETE FROM orchestrator_memory_files
         WHERE user_id = ? AND expires IS NOT NULL AND expires <= datetime('now')`,
      )
      .bind(scope.userId),
  ];
  // Link rows in both directions for the expired set (bounded, chunked).
  for (let i = 0; i < paths.length; i += LINK_INSERT_CHUNK) {
    const chunk = paths.slice(i, i + LINK_INSERT_CHUNK);
    const ph = chunk.map(() => '?').join(',');
    stmts.push(
      rawDb
        .prepare(
          `DELETE FROM memory_links WHERE user_id = ? AND (from_path IN (${ph}) OR to_path IN (${ph}))`,
        )
        .bind(scope.userId, ...chunk, ...chunk),
    );
  }

  await rawDb.batch(stmts);
  return paths.length;
}
