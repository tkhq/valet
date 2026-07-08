/**
 * Derived-store maintenance for orchestrator memory: the FTS index and the
 * `memory_links` graph. Extracted into its own module (from `memory-files.ts`)
 * so the link-backfill pass can reuse `syncDerivedStores` without importing
 * `memory-files.ts` as a value — which would form an import cycle once
 * `memory-files.ts` triggers the backfill from its prune/delete paths.
 */
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { extractLinks, deriveFtsDescription, tagsToFtsText } from '../memory-okf-helpers.js';

/** Files written per D1 batch. One batch = one network round-trip. */
export const IMPORT_CHUNK = 50;
/** memory_links rows per INSERT statement. Each row binds 4 params
 * (user_id, from_path, to_path, context); kept under D1's 100-bound-param limit. */
export const LINK_INSERT_CHUNK = 24;

/**
 * The ownership chokepoint. Every helper resolves ownership through this rather
 * than a bare positional `userId`, so a follow-on shared-library feature can add
 * a new scope shape in one place.
 */
export interface MemoryScope {
  userId: string;
}

/** A row whose derived stores (FTS + outgoing links) need rebuilding. */
export interface DerivedRow {
  path: string;
  title: string;
  description: string; // authored description column
  tags: string;        // JSON-encoded tag array
  content: string;     // stored body
}

/**
 * The single owner of derived-store maintenance. For each row it emits:
 *   - FTS delete (by rowid subquery on path) + insert (5 columns; tag join and
 *     description derivation applied JS-side, rowid pulled from the base table so
 *     freshly-upserted rows in the same batch are covered).
 *   - memory_links delete (outgoing rows) + chunked insert from extractLinks.
 *
 * Every write/patch/import/prune/backfill path composes these into one atomic
 * db.batch().
 */
export function syncDerivedStores(
  rawDb: D1Database,
  scope: MemoryScope,
  rows: DerivedRow[],
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];

  for (const row of rows) {
    const ftsDescription = deriveFtsDescription(row.description, row.content);
    const ftsTags = tagsToFtsText(row.tags);

    stmts.push(
      rawDb
        .prepare(
          `DELETE FROM orchestrator_memory_files_fts WHERE rowid IN (
             SELECT rowid FROM orchestrator_memory_files WHERE user_id = ? AND path = ?)`,
        )
        .bind(scope.userId, row.path),
    );
    stmts.push(
      rawDb
        .prepare(
          `INSERT INTO orchestrator_memory_files_fts(rowid, path, title, description, tags, content)
           SELECT rowid, ?, ?, ?, ?, ? FROM orchestrator_memory_files WHERE user_id = ? AND path = ?`,
        )
        .bind(row.path, row.title, ftsDescription, ftsTags, row.content, scope.userId, row.path),
    );

    // Rebuild outgoing link rows.
    stmts.push(
      rawDb
        .prepare('DELETE FROM memory_links WHERE user_id = ? AND from_path = ?')
        .bind(scope.userId, row.path),
    );
    const links = extractLinks(row.path, row.content);
    for (let i = 0; i < links.length; i += LINK_INSERT_CHUNK) {
      const chunk = links.slice(i, i + LINK_INSERT_CHUNK);
      const placeholders = chunk.map(() => '(?, ?, ?, ?)').join(', ');
      const binds: string[] = [];
      for (const link of chunk) {
        binds.push(scope.userId, row.path, link.toPath, link.context);
      }
      stmts.push(
        rawDb
          .prepare(
            `INSERT OR REPLACE INTO memory_links (user_id, from_path, to_path, context) VALUES ${placeholders}`,
          )
          .bind(...binds),
      );
    }
  }

  return stmts;
}
