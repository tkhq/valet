import type { AppDb } from './drizzle.js';
import { renderConcept, fromIso } from './okf.js';
import { renderIndex } from './memory-okf-helpers.js';
import {
  listMemoryFiles,
  readMemoryFile,
  boostMemoryFileRelevance,
  queryLinks,
  fileToConceptMeta,
  normalizePath,
  ensureLinksIndexed,
} from './db.js';

/**
 * Shared memory-read envelope assembly, used by both the WS path
 * (`services/session-memory.ts` `memRead`) and the HTTP path
 * (`routes/orchestrator.ts` `GET /memory`). A directory read returns the
 * listing plus the virtual OKF index.md text; a file read returns the
 * rendered OKF document plus fenced-block decorations as structured fields
 * (document/backlinks/notices). Keep both call sites as thin adapters over
 * this function — do not re-duplicate the partitioning/title-backfill logic
 * at either call site.
 */
export type MemoryReadEnvelope =
  | {
      kind: 'dir';
      listing: Awaited<ReturnType<typeof listMemoryFiles>>;
      index: string;
    }
  | {
      kind: 'file';
      file: Awaited<ReturnType<typeof readMemoryFile>>;
      document: string;
      backlinks: unknown[];
      notices: string[];
    };

export async function buildMemoryReadEnvelope(
  db: AppDb,
  envDB: D1Database,
  scope: { userId: string },
  path: string,
): Promise<MemoryReadEnvelope> {
  if (!path || path.endsWith('/')) {
    await ensureLinksIndexed(envDB, scope);

    const normalizedDir = normalizePath(path);
    const listing = await listMemoryFiles(db, scope, path);

    const prefix = normalizedDir ? normalizedDir + '/' : '';
    const subdirSet = new Set<string>();
    const directPaths: string[] = [];
    const descByPath = new Map(listing.map((entry) => [entry.path, entry.description]));

    for (const entry of listing) {
      const rel = entry.path.slice(prefix.length);
      const slashIdx = rel.indexOf('/');
      if (slashIdx === -1) {
        directPaths.push(entry.path);
      } else {
        subdirSet.add(prefix + rel.slice(0, slashIdx));
      }
    }

    // listMemoryFiles doesn't select `title` (it isn't part of the listing
    // envelope); fetch it for direct children only — the index needs it.
    let titleByPath = new Map<string, string>();
    if (directPaths.length > 0) {
      const placeholders = directPaths.map(() => '?').join(',');
      const rows = await envDB
        .prepare(`SELECT path, title FROM orchestrator_memory_files WHERE user_id = ? AND path IN (${placeholders})`)
        .bind(scope.userId, ...directPaths)
        .all<{ path: string; title: string }>();
      titleByPath = new Map((rows.results ?? []).map((r) => [r.path, r.title]));
    }

    const directFiles = directPaths.map((entryPath) => ({
      path: entryPath,
      title: titleByPath.get(entryPath) ?? '',
      description: descByPath.get(entryPath) ?? '',
    }));

    const index = renderIndex(normalizedDir, [...subdirSet], directFiles, normalizedDir === '');
    return { kind: 'dir', listing, index };
  }

  const file = await readMemoryFile(db, scope, path);
  if (!file) {
    return { kind: 'file', file: null, document: '', backlinks: [], notices: [] };
  }

  // Boost relevance on read (fire-and-forget; never blocks the response).
  boostMemoryFileRelevance(db, scope, path).catch(() => {});

  const document = renderConcept(fileToConceptMeta(file), file.content);
  const { neighbors } = await queryLinks(envDB, scope, path, 'in', 1, false);
  const backlinks = neighbors[0] ?? [];

  const notices: string[] = [];
  if (file.expires !== null && file.expires <= fromIso(new Date().toISOString())) {
    notices.push(`⚠ expired ${file.expires}`);
  }

  return { kind: 'file', file, document, backlinks, notices };
}
