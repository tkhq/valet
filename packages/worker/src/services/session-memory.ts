import type { MemoryFileSearchResult, MemoryWriteMeta as WsMemoryWriteMeta, PatchOperation } from '@valet/shared';
import type { AppDb } from '../lib/drizzle.js';
import { buildMemoryReadEnvelope, type MemoryReadEnvelope } from '../lib/memory-read-envelope.js';
import {
  listMemoryFiles,
  readMemoryFile,
  writeMemoryFile,
  moveMemoryFile,
  patchMemoryFile,
  deleteMemoryFile,
  deleteMemoryFilesUnderPath,
  searchMemoryFiles,
  queryLinks,
} from '../lib/db.js';

// ─── memRead ────────────────────────────────────────────────────────────────
// Mirrors the Task 11 HTTP envelope (`GET /api/me/memory`): a file read returns
// the rendered document plus fenced-block decorations as structured fields
// (document/backlinks/notices); a directory read returns the listing plus the
// virtual OKF index. Both this function and the HTTP route in
// routes/orchestrator.ts are thin adapters over
// `lib/memory-read-envelope.ts#buildMemoryReadEnvelope` — the shared
// assembly logic lives there.

export type MemReadResult =
  | {
      files: Awaited<ReturnType<typeof listMemoryFiles>>;
      listing: Awaited<ReturnType<typeof listMemoryFiles>>;
      index: string;
      file?: undefined;
      error?: undefined;
    }
  | {
      file: Awaited<ReturnType<typeof readMemoryFile>>;
      document: string;
      backlinks: unknown[];
      notices: string[];
      files?: undefined;
      error?: undefined;
    }
  | { error: string; files?: undefined; file?: undefined };

function toMemReadResult(envelope: MemoryReadEnvelope): MemReadResult {
  if (envelope.kind === 'dir') {
    return { files: envelope.listing, listing: envelope.listing, index: envelope.index };
  }
  return { file: envelope.file, document: envelope.document, backlinks: envelope.backlinks, notices: envelope.notices };
}

export async function memRead(
  db: AppDb,
  envDB: D1Database,
  userId: string,
  path?: string,
): Promise<MemReadResult> {
  const envelope = await buildMemoryReadEnvelope(db, envDB, { userId }, path || '');
  return toMemReadResult(envelope);
}

// ─── memWrite ───────────────────────────────────────────────────────────────

export type MemWriteResult =
  | { file: Awaited<ReturnType<typeof writeMemoryFile>>['file']; warnings: string[]; error?: undefined }
  | { error: string; file?: undefined };

export async function memWrite(
  envDB: D1Database,
  userId: string,
  path: string,
  content: string | undefined,
  meta: WsMemoryWriteMeta = {},
  sourceSessionId = '',
): Promise<MemWriteResult> {
  const { file, warnings } = await writeMemoryFile(envDB, { userId }, path, content, meta, sourceSessionId);
  return { file, warnings };
}

// ─── memMove ────────────────────────────────────────────────────────────────

export type MemMoveResult =
  | { result: Awaited<ReturnType<typeof moveMemoryFile>>; error?: undefined }
  | { error: string; result?: undefined };

export async function memMove(
  envDB: D1Database,
  userId: string,
  from: string,
  to: string,
): Promise<MemMoveResult> {
  const result = await moveMemoryFile(envDB, { userId }, from, to);
  return { result };
}

// ─── memLinks ───────────────────────────────────────────────────────────────

export type MemLinksResult =
  | { neighbors: Awaited<ReturnType<typeof queryLinks>>['neighbors']; truncated: boolean; error?: undefined }
  | { error: string; neighbors?: undefined; truncated?: undefined };

export async function memLinks(
  envDB: D1Database,
  userId: string,
  path: string,
  direction: 'out' | 'in' | 'both' = 'both',
  depth: 1 | 2 | 3 = 1,
  includeJournal = false,
): Promise<MemLinksResult> {
  const { neighbors, truncated } = await queryLinks(envDB, { userId }, path, direction, depth, includeJournal);
  return { neighbors, truncated };
}

// ─── memPatch ───────────────────────────────────────────────────────────────

const PATCH_OP_KINDS = new Set([
  'append',
  'prepend',
  'replace',
  'replace_all',
  'insert_after',
  'delete_section',
]);

/**
 * Narrows the WS-boundary `operations: unknown[]` payload (runner-protocol.ts
 * keeps it loose since it originates from an HTTP tool-call body) into
 * `PatchOperation[]` before it reaches `patchMemoryFile`. Throws on malformed
 * entries — callers (the DO's mem-patch handler) already wrap this in a
 * try/catch that reports the error back over the WS.
 */
export function toPatchOperations(operations: unknown[]): PatchOperation[] {
  return operations.map((op, i) => {
    if (!op || typeof op !== 'object' || typeof (op as { op?: unknown }).op !== 'string' || !PATCH_OP_KINDS.has((op as { op: string }).op)) {
      throw new Error(`mem-patch: invalid operation at index ${i}`);
    }
    return op as PatchOperation;
  });
}

export type MemPatchResult =
  | { result: Awaited<ReturnType<typeof patchMemoryFile>>; error?: undefined }
  | { error: string; result?: undefined };

export async function memPatch(
  envDB: D1Database,
  userId: string,
  path: string,
  operations: PatchOperation[],
  sourceSessionId = '',
): Promise<MemPatchResult> {
  const result = await patchMemoryFile(envDB, { userId }, path, operations, sourceSessionId);
  return { result };
}

// ─── memRm ──────────────────────────────────────────────────────────────────

export type MemRmResult =
  | { deleted: number; inboundWarning: string | null; error?: undefined }
  | { error: string; deleted?: undefined; inboundWarning?: undefined };

export async function memRm(
  envDB: D1Database,
  userId: string,
  path: string,
): Promise<MemRmResult> {
  let deleted: number;
  let inboundWarning: string | null = null;
  if (path.endsWith('/')) {
    deleted = await deleteMemoryFilesUnderPath(envDB, { userId }, path);
  } else {
    ({ deleted, inboundWarning } = await deleteMemoryFile(envDB, { userId }, path));
  }
  return { deleted, inboundWarning };
}

// ─── memSearch ──────────────────────────────────────────────────────────────

export type MemSearchResult =
  | { results: MemoryFileSearchResult[]; suppressedExpired: number; error?: undefined }
  | { error: string; results?: undefined };

export async function memSearch(
  envDB: D1Database,
  userId: string,
  query: string,
  path?: string,
  limit?: number,
  includeExpired?: boolean,
): Promise<MemSearchResult> {
  const { results, suppressedExpired } = await searchMemoryFiles(envDB, { userId }, query, { pathPrefix: path, limit: limit ?? 20, includeExpired });
  return { results, suppressedExpired };
}
