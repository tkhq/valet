import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type { MemoryExportEntry, MemoryExportManifest, MemoryFile, MemoryFileListing, MemoryFileSearchResult, MemoryImportResult, MemoryMoveResult, MemorySearchOptions, PatchOperation, PatchResult } from '@valet/shared';
import { eq, and, sql } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { orchestratorMemoryFiles, memoryLinks } from '../schema/memory-files.js';
import { extractTitle, buildFTS5Query, normalizeBM25, extractSnippet, pathBoost } from './memory-search-helpers.js';
import {
  renderConcept,
  parseConcept,
  sanitizeBody,
  applyDisposition,
  fromIso,
  OKF_VERSION,
  type ConceptMeta,
  type ParsedConcept,
} from '../okf.js';
import {
  normalizeResource,
  resolveLinkTarget,
  renderIndex,
} from '../memory-okf-helpers.js';
import { normalizePath as normalizePathLeaf } from './memory-path.js';
import {
  syncDerivedStores,
  IMPORT_CHUNK,
  LINK_INSERT_CHUNK,
  type DerivedRow,
  type MemoryScope,
} from './memory-derived-stores.js';
import { ensureLinksIndexed } from './memory-link-backfill.js';

export type { MemoryScope };

const MEMORY_CAP = 200;

/** One file-size limit, enforced identically on every write channel. */
export const MAX_MEMORY_FILE_SIZE = 262144;
/** Max path depth (segments). Reserved for future `lib/<library>/…` mounts. */
export const MAX_MEMORY_PATH_DEPTH = 5;

/** Metadata a write may set. Omission = unchanged (stickiness); `''` clears. */
export interface MemoryWriteMeta {
  type?: string;
  description?: string;
  tags?: string[];
  resource?: string;
  sensitivity?: 'private' | 'shareable';
  origin?: string;
  expires?: string; // '' clears; ISO or D1 form sets
}

export interface MemoryWriteResult {
  file: MemoryFile;
  warnings: string[];
}

// ─── Path Normalization & Validation ─────────────────────────────────────────

// normalizePath lives in the dependency-free leaf `memory-path.ts`; re-exported
// here so existing importers (and the `db.ts` barrel) keep working unchanged.
export const normalizePath = normalizePathLeaf;

/**
 * Validate a normalized path for agent/API writes. Returns an error string with
 * verbatim remediation (per spec), or null when valid. Imports remap rather than
 * reject (that remap lands in Task 8 — today import still goes through here).
 */
export function validatePath(path: string): string | null {
  if (!path || path.length === 0) return 'Path is required';
  if (path.length > 256) return 'Path too long (max 256 chars)';
  const segments = path.split('/').filter(Boolean);
  if (segments.length > MAX_MEMORY_PATH_DEPTH) {
    return 'path exceeds 5 levels — flatten under projects/<name>/';
  }
  const basename = segments[segments.length - 1] ?? '';
  if (basename === 'index.md' || basename === 'log.md') {
    return 'index.md is auto-generated for directories — use overview.md instead';
  }
  if (segments[0] === 'lib') {
    return 'lib/ is reserved for mounted libraries — write under notes/ or projects/';
  }
  return null;
}

// ─── Type & pin defaults ─────────────────────────────────────────────────────

const DIRECTORY_DEFAULT_TYPE: Record<string, string> = {
  preferences: 'preference',
  projects: 'project-note',
  workflows: 'workflow',
  journal: 'journal-entry',
  people: 'person',
  notes: 'note',
};

function defaultTypeForPath(path: string): string {
  const first = path.split('/')[0] ?? '';
  return DIRECTORY_DEFAULT_TYPE[first] ?? 'note';
}

function pinnedForPath(path: string): 0 | 1 {
  return path.startsWith('preferences/') ? 1 : 0;
}

// ─── Row shapes & converters ─────────────────────────────────────────────────

/** Full base-table row as returned by raw D1 SELECT * (snake_case columns). */
interface RawMemRow {
  id: string;
  user_id: string;
  org_id: string;
  path: string;
  content: string;
  title: string;
  type: string;
  description: string;
  tags: string;
  resource: string;
  extras: string;
  sensitivity: string;
  origin: string;
  source_session_id: string;
  expires: string | null;
  relevance: number;
  pinned: number;
  version: number;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
}

function rowToMemoryFile(row: typeof orchestratorMemoryFiles.$inferSelect): MemoryFile {
  return {
    id: row.id,
    userId: row.userId,
    orgId: row.orgId,
    path: row.path,
    content: row.content,
    title: row.title,
    type: row.type,
    description: row.description,
    tags: safeParseJsonArray(row.tags),
    resource: row.resource,
    extras: safeParseJsonRecord(row.extras),
    sensitivity: row.sensitivity === 'shareable' ? 'shareable' : 'private',
    origin: parseOrigin(row.origin),
    sourceSessionId: row.sourceSessionId,
    expires: row.expires ?? null,
    relevance: row.relevance,
    pinned: row.pinned === 1,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastAccessedAt: row.lastAccessedAt,
  };
}

function rawRowToMemoryFile(row: RawMemRow): MemoryFile {
  return {
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    path: row.path,
    content: row.content,
    title: row.title,
    type: row.type,
    description: row.description,
    tags: safeParseJsonArray(row.tags),
    resource: row.resource,
    extras: safeParseJsonRecord(row.extras),
    sensitivity: row.sensitivity === 'shareable' ? 'shareable' : 'private',
    origin: parseOrigin(row.origin),
    sourceSessionId: row.source_session_id,
    expires: row.expires ?? null,
    relevance: row.relevance,
    pinned: row.pinned === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
  };
}

/** Project a MemoryFile onto the OKF ConceptMeta shape (columns → frontmatter). */
export function fileToConceptMeta(file: MemoryFile): ConceptMeta {
  return {
    type: file.type,
    title: file.title,
    description: file.description,
    resource: file.resource,
    tags: file.tags,
    sensitivity: file.sensitivity,
    origin: file.origin,
    expires: file.expires,
    updatedAt: file.updatedAt,
    extras: file.extras,
  };
}

function safeParseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function safeParseJsonRecord(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        result[k] = String(v);
      }
      return result;
    }
    return {};
  } catch {
    return {};
  }
}

type MemoryOrigin = '' | 'user-stated' | 'inferred' | 'imported';
const VALID_ORIGINS: ReadonlySet<string> = new Set(['', 'user-stated', 'inferred', 'imported']);

function parseOrigin(value: string): MemoryOrigin {
  return VALID_ORIGINS.has(value) ? (value as MemoryOrigin) : '';
}

// ─── Read Operations ────────────────────────────────────────────────────────

export async function readMemoryFile(db: AppDb, scope: MemoryScope, path: string): Promise<MemoryFile | null> {
  const normalized = normalizePath(path);
  const row = await db
    .select()
    .from(orchestratorMemoryFiles)
    .where(and(eq(orchestratorMemoryFiles.userId, scope.userId), eq(orchestratorMemoryFiles.path, normalized)))
    .get();
  return row ? rowToMemoryFile(row) : null;
}

export async function listMemoryFiles(db: AppDb, scope: MemoryScope, pathPrefix: string): Promise<MemoryFileListing[]> {
  const normalized = normalizePath(pathPrefix);
  const prefix = normalized.endsWith('/') ? normalized : (normalized ? normalized + '/' : '');

  const rows = await db
    .select({
      path: orchestratorMemoryFiles.path,
      updatedAt: orchestratorMemoryFiles.updatedAt,
      contentLength: sql<number>`LENGTH(${orchestratorMemoryFiles.content})`,
      pinned: orchestratorMemoryFiles.pinned,
      type: orchestratorMemoryFiles.type,
      description: orchestratorMemoryFiles.description,
      tags: orchestratorMemoryFiles.tags,
      resource: orchestratorMemoryFiles.resource,
      sensitivity: orchestratorMemoryFiles.sensitivity,
      expires: orchestratorMemoryFiles.expires,
    })
    .from(orchestratorMemoryFiles)
    .where(
      prefix
        ? and(eq(orchestratorMemoryFiles.userId, scope.userId), sql`${orchestratorMemoryFiles.path} LIKE ${prefix + '%'}`)
        : eq(orchestratorMemoryFiles.userId, scope.userId)
    )
    .orderBy(orchestratorMemoryFiles.path);

  return rows.map((r) => ({
    path: r.path,
    size: r.contentLength,
    updatedAt: r.updatedAt,
    pinned: r.pinned === 1,
    type: r.type,
    description: r.description,
    tags: safeParseJsonArray(r.tags),
    resource: r.resource,
    sensitivity: r.sensitivity === 'shareable' ? 'shareable' : 'private',
    expires: r.expires ?? null,
  }));
}

// ─── Write Operations ───────────────────────────────────────────────────────

/** Map a caller's write-meta onto explicit ConceptMeta params for disposition. */
function metaToExplicit(meta: MemoryWriteMeta): Partial<ConceptMeta> {
  const explicit: Partial<ConceptMeta> = {};
  if (meta.type !== undefined) explicit.type = meta.type;
  if (meta.description !== undefined) explicit.description = meta.description;
  if (meta.tags !== undefined) explicit.tags = meta.tags;
  if (meta.resource !== undefined) explicit.resource = meta.resource;
  if (meta.sensitivity !== undefined) explicit.sensitivity = meta.sensitivity;
  if (meta.origin !== undefined) explicit.origin = meta.origin;
  if (meta.expires !== undefined) explicit.expires = meta.expires === '' ? null : fromIso(meta.expires);
  return explicit;
}

const EMPTY_PARSED: ParsedConcept = {
  body: '',
  meta: {},
  rawValet: {},
  unknownValetKeys: [],
  hadFrontmatter: false,
};

/**
 * Create or update a memory file.
 *
 * `content === undefined` ⇒ metadata-only update (body untouched; the file must
 * already exist). `content === ''` is rejected (use mem_rm). Embedded frontmatter
 * in `content` is stripped and routed through the agent-channel disposition table;
 * metadata omitted from `meta` is left unchanged (stickiness). Base row + FTS +
 * links are written in one atomic batch.
 */
export async function writeMemoryFile(
  rawDb: D1Database,
  scope: MemoryScope,
  path: string,
  content: string | undefined,
  meta: MemoryWriteMeta,
  sourceSessionId: string,
  // Bulk callers set this false to defer cap enforcement to a single pass.
  enforceCap = true,
): Promise<MemoryWriteResult> {
  const normalized = normalizePath(path);
  const pathError = validatePath(normalized);
  if (pathError) throw new Error(pathError);

  if (content === '') {
    throw new Error('to clear a file use mem_rm; to update metadata only, omit content');
  }
  if (content !== undefined && content.length > MAX_MEMORY_FILE_SIZE) {
    throw new Error(`content exceeds max size (${MAX_MEMORY_FILE_SIZE} bytes)`);
  }

  // Fetch existing row (full columns for disposition + return mapping).
  const existingRow = await rawDb
    .prepare('SELECT * FROM orchestrator_memory_files WHERE user_id = ? AND path = ?')
    .bind(scope.userId, normalized)
    .first<RawMemRow>();

  if (content === undefined && !existingRow) {
    throw new Error(`${normalized} does not exist — provide content to create it`);
  }

  const existingFile = existingRow ? rawRowToMemoryFile(existingRow) : null;
  const existingMeta = existingFile ? fileToConceptMeta(existingFile) : null;

  // Sanitize incoming body (strips embedded frontmatter + fenced blocks).
  const warnings: string[] = [];
  let body: string;
  let parsed: ParsedConcept;
  if (content !== undefined) {
    const sanitized = sanitizeBody(content);
    body = sanitized.body;
    warnings.push(...sanitized.warnings);
    parsed = sanitized.embedded ?? EMPTY_PARSED;
  } else {
    body = existingFile!.content;
    parsed = EMPTY_PARSED;
  }

  // Disposition: agent channel — merge embedded content keys on fresh echo,
  // explicit params always win, valet keys warn on divergence.
  const disposition = applyDisposition({
    channel: 'agent',
    parsed,
    explicit: metaToExplicit(meta),
    existing: existingMeta,
  });
  warnings.push(...disposition.warnings);
  if (disposition.droppedValetKeys.length > 0) {
    warnings.push(`⚠ dropped unknown valet keys: ${disposition.droppedValetKeys.join(', ')}`);
  }

  // Resolve final column values (create defaults vs. stickiness).
  const base = existingFile
    ? {
        type: existingFile.type,
        description: existingFile.description,
        tags: existingFile.tags,
        resource: existingFile.resource,
        sensitivity: existingFile.sensitivity,
        origin: existingFile.origin,
        expires: existingFile.expires,
        extras: existingFile.extras,
      }
    : {
        type: defaultTypeForPath(normalized),
        description: '',
        tags: [] as string[],
        resource: '',
        sensitivity: 'private' as 'private' | 'shareable',
        origin: 'inferred',
        expires: null as string | null,
        extras: {} as Record<string, string>,
      };

  const dm = disposition.meta;
  const finalType = dm.type ?? base.type;
  const finalDescription = dm.description ?? base.description;
  const finalTags = dm.tags ?? base.tags;
  const finalSensitivity = dm.sensitivity ?? base.sensitivity;
  const finalOrigin = dm.origin ?? base.origin;
  const finalExpires = 'expires' in dm ? (dm.expires ?? null) : base.expires;
  const finalExtras = base.extras; // agent channel never mutates extras
  const finalTitle = extractTitle(body, normalized); // body-derived

  // Resource normalization + same-resource collision warning.
  let finalResource = dm.resource ?? base.resource;
  if (finalResource) finalResource = normalizeResource(finalResource);
  if (finalResource) {
    const collision = await rawDb
      .prepare('SELECT path FROM orchestrator_memory_files WHERE user_id = ? AND resource = ? AND path != ?')
      .bind(scope.userId, finalResource, normalized)
      .first<{ path: string }>();
    if (collision) {
      warnings.push(`⚠ ${collision.path} already covers this resource — consider merging there and mem_rm'ing this file`);
    }
  }

  const pinned = pinnedForPath(normalized);
  const tagsJson = JSON.stringify(finalTags);
  const extrasJson = JSON.stringify(finalExtras);
  const derived: DerivedRow = {
    path: normalized,
    title: finalTitle,
    description: finalDescription,
    tags: tagsJson,
    content: body,
  };

  if (existingRow) {
    const upsert = rawDb
      .prepare(
        `UPDATE orchestrator_memory_files SET
           content = ?, title = ?, type = ?, description = ?, tags = ?, resource = ?,
           extras = ?, sensitivity = ?, origin = ?,
           source_session_id = CASE WHEN ? != '' THEN ? ELSE source_session_id END,
           expires = ?, pinned = ?, version = version + 1, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(
        body, finalTitle, finalType, finalDescription, tagsJson, finalResource,
        extrasJson, finalSensitivity, finalOrigin,
        sourceSessionId, sourceSessionId,
        finalExpires, pinned, existingRow.id,
      );
    await rawDb.batch([upsert, ...syncDerivedStores(rawDb, scope, [derived])]);
  } else {
    const id = crypto.randomUUID();
    const insert = rawDb
      .prepare(
        `INSERT INTO orchestrator_memory_files
           (id, user_id, path, content, title, type, description, tags, resource, extras,
            sensitivity, origin, source_session_id, expires, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id, scope.userId, normalized, body, finalTitle, finalType, finalDescription, tagsJson, finalResource, extrasJson,
        finalSensitivity, finalOrigin, sourceSessionId, finalExpires, pinned,
      );
    await rawDb.batch([insert, ...syncDerivedStores(rawDb, scope, [derived])]);
  }

  const savedRow = await rawDb
    .prepare('SELECT * FROM orchestrator_memory_files WHERE user_id = ? AND path = ?')
    .bind(scope.userId, normalized)
    .first<RawMemRow>();

  if (!existingRow && enforceCap) await enforceMemoryCap(rawDb, scope);

  // savedRow is always present (we just wrote it); the throw satisfies the type
  // narrowing without an unsafe assertion.
  if (!savedRow) throw new Error(`writeMemoryFile: row vanished after write (${normalized})`);
  return { file: rawRowToMemoryFile(savedRow), warnings };
}

// ─── Patch Operations ───────────────────────────────────────────────────────

export async function patchMemoryFile(
  rawDb: D1Database,
  scope: MemoryScope,
  path: string,
  operations: PatchOperation[],
  sourceSessionId: string,
): Promise<PatchResult> {
  const normalized = normalizePath(path);
  const pathError = validatePath(normalized);
  if (pathError) throw new Error(pathError);

  const existing = await rawDb
    .prepare('SELECT * FROM orchestrator_memory_files WHERE user_id = ? AND path = ?')
    .bind(scope.userId, normalized)
    .first<RawMemRow>();

  const existingFile = existing ? rawRowToMemoryFile(existing) : null;
  // Rendered frontmatter region (body-less) for targeted skip diagnostics.
  const renderedMeta = existingFile ? renderConcept(fileToConceptMeta(existingFile), '') : '';

  let content = existing?.content ?? '';
  let applied = 0;
  const skipped: string[] = [];
  const warnings: string[] = [];
  const fileExists = !!existing;

  // A needle that would only match rendered (non-stored) frontmatter or the
  // auto-generated backlinks block is un-patchable — return a targeted message.
  const diagnoseNeedle = (needle: string, fallback: string): string => {
    if (needle && renderedMeta.includes(needle)) {
      return `'${needle.slice(0, 40)}' is rendered metadata — update it via mem_write params`;
    }
    if (needle.includes('# Linked from') || needle.includes('valet:backlinks')) {
      return `'${needle.slice(0, 40)}' is auto-generated and cannot be edited`;
    }
    return fallback;
  };

  for (const op of operations) {
    switch (op.op) {
      case 'append': {
        content += op.content;
        applied++;
        break;
      }
      case 'prepend': {
        content = op.content + content;
        applied++;
        break;
      }
      case 'replace': {
        if (!fileExists && !content) {
          skipped.push(`replace '${op.old.slice(0, 40)}' — file not found`);
          break;
        }
        if (!op.old) {
          skipped.push(`replace — empty search string`);
          break;
        }
        const idx = content.indexOf(op.old);
        if (idx === -1) {
          skipped.push(diagnoseNeedle(op.old, `replace '${op.old.slice(0, 40)}' — not found`));
        } else {
          content = content.slice(0, idx) + op.new + content.slice(idx + op.old.length);
          applied++;
        }
        break;
      }
      case 'replace_all': {
        if (!fileExists && !content) {
          skipped.push(`replace_all '${op.old.slice(0, 40)}' — file not found`);
          break;
        }
        if (!op.old) {
          skipped.push(`replace_all — empty search string`);
          break;
        }
        if (!content.includes(op.old)) {
          skipped.push(diagnoseNeedle(op.old, `replace_all '${op.old.slice(0, 40)}' — 0 matches`));
        } else {
          content = content.split(op.old).join(op.new);
          applied++;
        }
        break;
      }
      case 'insert_after': {
        if (!fileExists && !content) {
          skipped.push(`insert_after '${op.anchor.slice(0, 40)}' — file not found`);
          break;
        }
        const lines = content.split('\n');
        const lineIdx = lines.findIndex((l) => l.includes(op.anchor));
        if (lineIdx === -1) {
          skipped.push(diagnoseNeedle(op.anchor, `insert_after '${op.anchor.slice(0, 40)}' — anchor not found`));
        } else {
          lines.splice(lineIdx + 1, 0, op.content);
          content = lines.join('\n');
          applied++;
        }
        break;
      }
      case 'delete_section': {
        if (!fileExists && !content) {
          skipped.push(`delete_section '${op.heading.slice(0, 40)}' — file not found`);
          break;
        }
        const headingLevel = op.heading.match(/^#+/)?.[0]?.length ?? 0;
        if (headingLevel === 0) {
          skipped.push(`delete_section '${op.heading.slice(0, 40)}' — must be a markdown heading (e.g. ## Section)`);
          break;
        }
        const sectionLines = content.split('\n');
        const startIdx = sectionLines.findIndex((l) => l.trim() === op.heading.trim());
        if (startIdx === -1) {
          skipped.push(diagnoseNeedle(op.heading, `delete_section '${op.heading.slice(0, 40)}' — heading not found`));
        } else {
          let endIdx = sectionLines.length;
          for (let i = startIdx + 1; i < sectionLines.length; i++) {
            const lineHeadingMatch = sectionLines[i].match(/^(#+)\s/);
            if (lineHeadingMatch && lineHeadingMatch[1].length <= headingLevel) {
              endIdx = i;
              break;
            }
          }
          sectionLines.splice(startIdx, endIdx - startIdx);
          content = sectionLines.join('\n');
          applied++;
        }
        break;
      }
    }
  }

  if (applied === 0) {
    if (fileExists) {
      return { content: existing!.content, version: existing!.version, applied: 0, skipped, warnings };
    }
    return { content: '', version: 0, applied: 0, skipped, warnings };
  }

  // Impostor-block prevention: a patched body that now begins with a parseable
  // frontmatter block gets that block stripped (it is not stored metadata).
  if (content.startsWith('---\n')) {
    const sanitized = sanitizeBody(content);
    if (sanitized.embedded) {
      content = sanitized.body;
      warnings.push(...sanitized.warnings);
      warnings.push('⚠ leading frontmatter block stripped — set metadata via mem_write params');
    }
  }

  if (fileExists) {
    if (content.length > MAX_MEMORY_FILE_SIZE) {
      throw new Error(`content exceeds max size (${MAX_MEMORY_FILE_SIZE} bytes)`);
    }
    const newVersion = existing!.version + 1;
    const title = extractTitle(content, normalized);
    const update = rawDb
      .prepare(
        `UPDATE orchestrator_memory_files SET content = ?, title = ?, version = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .bind(content, title, newVersion, existing!.id);
    const derived: DerivedRow = {
      path: normalized,
      title,
      description: existing!.description,
      tags: existing!.tags,
      content,
    };
    await rawDb.batch([update, ...syncDerivedStores(rawDb, scope, [derived])]);
    return { content, version: newVersion, applied, skipped, warnings };
  }

  // Patch-created file (append/prepend only): route through writeMemoryFile so
  // reserved rules, defaults, FTS derivation, and links all apply.
  const { file, warnings: writeWarnings } = await writeMemoryFile(rawDb, scope, normalized, content, {}, sourceSessionId);
  return { content, version: file.version, applied, skipped, warnings: [...warnings, ...writeWarnings] };
}

// ─── Delete Operations ──────────────────────────────────────────────────────

export async function deleteMemoryFile(
  rawDb: D1Database,
  scope: MemoryScope,
  path: string,
): Promise<{ deleted: number; inboundWarning: string | null }> {
  const normalized = normalizePath(path);

  // The inbound-link warning depends on a populated link table (lazy trigger).
  await ensureLinksIndexed(rawDb, scope);

  const existed = await rawDb
    .prepare('SELECT 1 AS x FROM orchestrator_memory_files WHERE user_id = ? AND path = ?')
    .bind(scope.userId, normalized)
    .first<{ x: number }>();

  const inbound = await rawDb
    .prepare('SELECT from_path FROM memory_links WHERE user_id = ? AND to_path = ? AND from_path != ?')
    .bind(scope.userId, normalized, normalized)
    .all<{ from_path: string }>();
  const inboundPaths = (inbound.results ?? []).map((r) => r.from_path);

  await rawDb.batch([
    rawDb
      .prepare(
        `DELETE FROM orchestrator_memory_files_fts WHERE rowid IN (
           SELECT rowid FROM orchestrator_memory_files WHERE user_id = ? AND path = ?)`,
      )
      .bind(scope.userId, normalized),
    rawDb
      .prepare('DELETE FROM orchestrator_memory_files WHERE user_id = ? AND path = ?')
      .bind(scope.userId, normalized),
    rawDb
      .prepare('DELETE FROM memory_links WHERE user_id = ? AND (from_path = ? OR to_path = ?)')
      .bind(scope.userId, normalized, normalized),
  ]);

  const deleted = existed ? 1 : 0;
  const inboundWarning =
    deleted > 0 && inboundPaths.length > 0
      ? `⚠ ${inboundPaths.length} file(s) still link here: ${inboundPaths.join(', ')}`
      : null;
  return { deleted, inboundWarning };
}

export async function deleteMemoryFilesUnderPath(rawDb: D1Database, scope: MemoryScope, pathPrefix: string): Promise<number> {
  const normalized = normalizePath(pathPrefix);
  const prefix = normalized.endsWith('/') ? normalized : normalized + '/';

  const rows = await rawDb
    .prepare('SELECT path FROM orchestrator_memory_files WHERE user_id = ? AND path LIKE ?')
    .bind(scope.userId, prefix + '%')
    .all<{ path: string }>();
  const paths = (rows.results ?? []).map((r) => r.path);
  if (paths.length === 0) return 0;

  const stmts: D1PreparedStatement[] = [
    rawDb
      .prepare(
        `DELETE FROM orchestrator_memory_files_fts WHERE rowid IN (
           SELECT rowid FROM orchestrator_memory_files WHERE user_id = ? AND path LIKE ?)`,
      )
      .bind(scope.userId, prefix + '%'),
    rawDb
      .prepare('DELETE FROM orchestrator_memory_files WHERE user_id = ? AND path LIKE ?')
      .bind(scope.userId, prefix + '%'),
    // Outgoing links from any deleted file.
    rawDb
      .prepare('DELETE FROM memory_links WHERE user_id = ? AND from_path LIKE ?')
      .bind(scope.userId, prefix + '%'),
  ];
  // Inbound links to the deleted files (bounded to the deleted path set).
  for (let i = 0; i < paths.length; i += LINK_INSERT_CHUNK) {
    const chunk = paths.slice(i, i + LINK_INSERT_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    stmts.push(
      rawDb
        .prepare(`DELETE FROM memory_links WHERE user_id = ? AND to_path IN (${placeholders})`)
        .bind(scope.userId, ...chunk),
    );
  }

  await rawDb.batch(stmts);
  return paths.length;
}

// ─── Move Operations ────────────────────────────────────────────────────────

/**
 * Rewrite every occurrence of a link target in a markdown body.
 *
 * Handles two forms produced by extractLinks normalization:
 *   - Bundle-relative: `(/notes/old.md` → `(/notes/new.md`
 *   - Without leading slash: `(notes/old.md` → `(notes/new.md`
 *
 * Fragments are preserved: `(/notes/old.md#sec)` → `(/notes/new.md#sec)`.
 * Uses split/join to avoid regex-escaping the path string.
 */
function rewriteLinksInBody(body: string, from: string, to: string): string {
  // Bundle-relative form (leading slash)
  let result = body.split('(/' + from).join('(/' + to);
  // Non-slash form
  result = result.split('(' + from).join('(' + to);
  return result;
}

/**
 * Move a memory file from `from` to `to`.
 *
 * Churn semantics (per spec):
 *   - Moved file: `updated_at` preserved (move is not a knowledge change), `version` bumped.
 *   - Referencing files (link rewrites): `updated_at` NOT bumped, `version` bumped.
 *
 * Each referencer rewrite is guarded (`WHERE id = ? AND version = ?`). Losers (version
 * changed between read and write) are reported in `referencersSkipped` — documented RMW race.
 *
 * Batch 1: base-row path update + memory_links rewrites + guarded referencer content updates.
 * After batch 1: check which referencers actually changed via result.meta.changes.
 * Batch 2: syncDerivedStores for the moved file + successfully updated referencers only.
 * (Including failed referencers in syncDerivedStores would corrupt their link rows since
 * their bodies still contain the old link text.)
 *
 * Link-rewrite caveat (accepted, spec-documented):
 *   Only INBOUND referencers' bodies are rewritten. The moved file's own body is NOT
 *   rewritten. Bundle-relative links within it (e.g. `/notes/sibling.md`) remain correct
 *   because they are absolute within the bundle. However, RELATIVE links (e.g.
 *   `./sibling.md`) will resolve against the new directory after a directory-changing
 *   move and may break. Callers that know the moved file contains relative links should
 *   patch them explicitly after the move.
 */
export async function moveMemoryFile(
  rawDb: D1Database,
  scope: MemoryScope,
  from: string,
  to: string,
): Promise<MemoryMoveResult> {
  const normalizedFrom = normalizePath(from);
  const normalizedTo = normalizePath(to);

  // Validate destination path
  const pathError = validatePath(normalizedTo);
  if (pathError) throw new Error(pathError);

  // Check collision at destination
  const destExists = await rawDb
    .prepare('SELECT 1 AS x FROM orchestrator_memory_files WHERE user_id = ? AND path = ?')
    .bind(scope.userId, normalizedTo)
    .first<{ x: number }>();
  if (destExists) throw new Error(`${normalizedTo} already exists`);

  // Read source row
  const srcRow = await rawDb
    .prepare('SELECT * FROM orchestrator_memory_files WHERE user_id = ? AND path = ?')
    .bind(scope.userId, normalizedFrom)
    .first<RawMemRow>();
  if (!srcRow) throw new Error(`${normalizedFrom} does not exist`);

  // Read referencing files (files that contain an outgoing link to this file)
  const refResult = await rawDb
    .prepare(
      `SELECT m.* FROM orchestrator_memory_files m
       JOIN memory_links l ON l.from_path = m.path AND l.user_id = m.user_id
       WHERE l.user_id = ? AND l.to_path = ?`,
    )
    .bind(scope.userId, normalizedFrom)
    .all<RawMemRow>();
  const referencers = refResult.results ?? [];

  const pinnedBefore = srcRow.pinned === 1;
  const pinnedAfter = pinnedForPath(normalizedTo) === 1;

  // ── Batch 1: move row + link rewrites + guarded referencer content updates ──

  const batch1: D1PreparedStatement[] = [];

  // Update moved row: new path, recomputed pin, version+1. updated_at is intentionally
  // omitted from SET — a move is not a knowledge change (spec churn table).
  batch1.push(
    rawDb
      .prepare(
        `UPDATE orchestrator_memory_files SET path = ?, pinned = ?, version = version + 1
         WHERE user_id = ? AND path = ?`,
      )
      .bind(normalizedTo, pinnedAfter ? 1 : 0, scope.userId, normalizedFrom),
  );

  // Rewrite memory_links: rows that pointed at the old path now point at the new path
  batch1.push(
    rawDb
      .prepare('UPDATE memory_links SET to_path = ? WHERE user_id = ? AND to_path = ?')
      .bind(normalizedTo, scope.userId, normalizedFrom),
  );

  // Rewrite memory_links: outgoing rows from the moved file itself
  batch1.push(
    rawDb
      .prepare('UPDATE memory_links SET from_path = ? WHERE user_id = ? AND from_path = ?')
      .bind(normalizedTo, scope.userId, normalizedFrom),
  );

  // Guarded content updates for each referencer
  const refStartIdx = batch1.length;
  for (const ref of referencers) {
    const rewritten = rewriteLinksInBody(ref.content, normalizedFrom, normalizedTo);
    batch1.push(
      rawDb
        .prepare(
          `UPDATE orchestrator_memory_files SET content = ?, version = version + 1
           WHERE id = ? AND version = ?`,
        )
        .bind(rewritten, ref.id, ref.version),
    );
  }

  const batch1Results = (await rawDb.batch(batch1)) as D1Result<unknown>[];

  // Determine which referencer updates actually landed
  const succeededRefs: RawMemRow[] = [];
  const skippedPaths: string[] = [];

  for (let i = 0; i < referencers.length; i++) {
    const resultIdx = refStartIdx + i;
    const changes = batch1Results[resultIdx]?.meta?.changes ?? 0;
    const ref = referencers[i];
    if (changes > 0) {
      succeededRefs.push(ref);
    } else {
      skippedPaths.push(ref.path);
    }
  }

  // ── Batch 2: syncDerivedStores for moved file + succeeded referencers ──

  // Build derived row for the moved file using its (now-updated) new path and original content.
  const movedDerived: DerivedRow = {
    path: normalizedTo,
    title: srcRow.title,
    description: srcRow.description,
    tags: srcRow.tags,
    content: srcRow.content,
  };

  // syncDerivedStores for the moved file handles the FTS delete + re-insert for normalizedTo.
  const batch2: D1PreparedStatement[] = [
    ...syncDerivedStores(rawDb, scope, [movedDerived]),
  ];

  // syncDerivedStores for succeeded referencers (with their rewritten content)
  for (const ref of succeededRefs) {
    const rewrittenContent = rewriteLinksInBody(ref.content, normalizedFrom, normalizedTo);
    batch2.push(
      ...syncDerivedStores(rawDb, scope, [{
        path: ref.path,
        title: ref.title,
        description: ref.description,
        tags: ref.tags,
        content: rewrittenContent,
      }]),
    );
  }

  await rawDb.batch(batch2);

  return {
    from: normalizedFrom,
    to: normalizedTo,
    pinnedBefore,
    pinnedAfter,
    type: srcRow.type,
    typeDefaultForDest: defaultTypeForPath(normalizedTo),
    referencersUpdated: succeededRefs.length,
    referencersSkipped: skippedPaths,
  };
}

// ─── Search Operations ──────────────────────────────────────────────────────

interface SearchRow {
  path: string;
  title: string;
  content: string;
  bm25_score: number;
  type: string;
  description: string;
  tags: string;
  resource: string;
  expires: string | null;
  inbound: number;
}

export async function searchMemoryFiles(
  rawDb: D1Database,
  scope: MemoryScope,
  query: string,
  opts?: MemorySearchOptions,
): Promise<{ results: MemoryFileSearchResult[]; suppressedExpired: number }> {
  const limit = opts?.limit ?? 20;
  const includeExpired = opts?.includeExpired ?? false;
  const pathPrefix = opts?.pathPrefix;
  const resource = opts?.resource;

  const ftsQuery = buildFTS5Query(query);
  if (!ftsQuery) return { results: [], suppressedExpired: 0 };

  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .map((t) => t.replace(/[^\w]/g, ''));

  const normalizedResource = resource ? normalizeResource(resource) : null;

  // Build the scope predicates (pathPrefix + resource) shared between the main
  // query and the suppressedExpired COUNT so the two can never drift.
  const buildScopePredicates = (): { sql: string; params: (string | number | null)[] } => {
    let sql = '';
    const params: (string | number | null)[] = [];

    if (pathPrefix) {
      const normalized = normalizePath(pathPrefix);
      const prefix = normalized.endsWith('/') ? normalized : normalized + '/';
      sql += ' AND m.path LIKE ?';
      params.push(prefix + '%');
    }

    if (normalizedResource) {
      // Escape LIKE metacharacters in the resource value (% and _ are meaningful;
      // \ is the chosen escape char). Paths are normalized to [a-z0-9-./] so _ is
      // impossible there, but resource URIs may contain it.
      const escapedResource = normalizedResource.replace(/[\\%_]/g, '\\$&');
      sql += " AND (m.resource = ? OR m.resource LIKE ? || '/%' ESCAPE '\\')";
      params.push(normalizedResource, escapedResource);
    }

    return { sql, params };
  };

  const runSearch = async (q: string): Promise<SearchRow[]> => {
    let sqlStr = `
      SELECT m.path, m.title, m.content,
             bm25(orchestrator_memory_files_fts, 5, 10, 8, 6, 1) as bm25_score,
             m.type, m.description, m.tags, m.resource, m.expires,
             (SELECT COUNT(*) FROM memory_links l WHERE l.user_id = m.user_id AND l.to_path = m.path) AS inbound
      FROM orchestrator_memory_files m
      JOIN orchestrator_memory_files_fts ON orchestrator_memory_files_fts.rowid = m.rowid
      WHERE orchestrator_memory_files_fts MATCH ? AND m.user_id = ?`;
    const params: (string | number | null)[] = [q, scope.userId];

    if (!includeExpired) {
      sqlStr += ` AND (m.expires IS NULL OR m.expires > datetime('now'))`;
    }

    const scope_ = buildScopePredicates();
    sqlStr += scope_.sql;
    params.push(...scope_.params);

    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 200));
    sqlStr += ` ORDER BY bm25_score LIMIT ${safeLimit}`;
    const result = await rawDb.prepare(sqlStr).bind(...params).all<SearchRow>();
    return result.results ?? [];
  };

  let effectiveQuery = ftsQuery;
  let rows = await runSearch(ftsQuery);
  if (rows.length === 0 && ftsQuery.includes(' AND ')) {
    // Fallback: try OR instead of AND, but strip NOT clauses to avoid precedence issues.
    effectiveQuery = ftsQuery.replace(/ NOT (\([^)]+\)|"[^"]*"\*?)/, '').replace(/ AND /g, ' OR ');
    rows = await runSearch(effectiveQuery);
  }

  // Stored `expires` is D1 datetime form (`YYYY-MM-DD HH:MM:SS`, UTC) — compare
  // against `now` in the same form so string comparison matches SQL's datetime('now').
  const now = fromIso(new Date().toISOString());
  const scored = rows.map((row) => {
    const bm25 = normalizeBM25(row.bm25_score);
    const boost = pathBoost(row.path, queryTerms);
    const isExpired = row.expires !== null && row.expires <= now;
    const baseRelevance = Math.min(bm25 + boost, 1.0);
    const relevance = isExpired ? baseRelevance * 0.1 : baseRelevance;
    const tagsArr: string[] = (() => {
      if (!row.tags) return [];
      try { return JSON.parse(row.tags) as string[]; } catch { return []; }
    })();
    return {
      path: row.path,
      snippet: extractSnippet(row.content, queryTerms),
      relevance,
      title: row.title ?? '',
      type: row.type ?? '',
      description: row.description ?? '',
      tags: tagsArr,
      resource: row.resource ?? '',
      inboundLinks: row.inbound ?? 0,
      expired: isExpired,
    };
  });

  scored.sort((a, b) => b.relevance - a.relevance);

  // Count suppressed expired files when the default filter is active and results < limit.
  // Must use the same MATCH query form (AND or OR fallback) and the same scope predicates
  // (pathPrefix / resource) that the main query used — otherwise it can report expired
  // files outside the search scope, prompting futile include_expired retries.
  let suppressedExpired = 0;
  if (!includeExpired && scored.length < limit) {
    const scopeForCount = buildScopePredicates();
    let countSql = `
      SELECT COUNT(*) as cnt
      FROM orchestrator_memory_files m
      JOIN orchestrator_memory_files_fts ON orchestrator_memory_files_fts.rowid = m.rowid
      WHERE orchestrator_memory_files_fts MATCH ? AND m.user_id = ?
        AND m.expires IS NOT NULL AND m.expires <= datetime('now')`;
    countSql += scopeForCount.sql;
    const countParams: (string | number | null)[] = [effectiveQuery, scope.userId, ...scopeForCount.params];
    const countRow = await rawDb.prepare(countSql).bind(...countParams).first<{ cnt: number }>();
    suppressedExpired = countRow?.cnt ?? 0;
  }

  return { results: scored, suppressedExpired };
}

// ─── Import / Export ────────────────────────────────────────────────────────

/** SHA-256 of a UTF-8 string as lowercase hex. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Manifest key for a directory's generated index. `''` (root) → `index.md`. */
function indexPathForDir(dir: string): string {
  return dir === '' ? 'index.md' : `${dir}/index.md`;
}

/**
 * Export the user's memory as a deterministic OKF manifest.
 *
 * Every concept is rendered via renderConcept (frontmatter projection + stored
 * body) and hashed (SHA-256 hex). Generated `index.md` entries are added per
 * directory level over the exported set, path-lexicographic. Keys are sorted.
 *
 * `include: 'shareable'` filters to `sensitivity: 'shareable'`, omits the
 * `valet:` block and `valetState` sidecar, prunes empty directories (indexes
 * derive from the filtered set only), and flags shareable files whose bodies
 * link to private paths in `leakFlags`.
 */
export async function exportMemoryFiles(
  db: AppDb,
  scope: MemoryScope,
  include: 'all' | 'shareable' = 'all',
): Promise<MemoryExportManifest> {
  const rows = await db
    .select()
    .from(orchestratorMemoryFiles)
    .where(eq(orchestratorMemoryFiles.userId, scope.userId))
    .orderBy(orchestratorMemoryFiles.path);
  const allFiles = rows.map(rowToMemoryFile);
  const exported = include === 'shareable' ? allFiles.filter((f) => f.sensitivity === 'shareable') : allFiles;

  const omitValet = include === 'shareable';
  const entries = new Map<string, MemoryExportEntry>();

  for (const f of exported) {
    const rendered = renderConcept(fileToConceptMeta(f), f.content, { omitValet });
    const entry: MemoryExportEntry = { content: rendered, hash: await sha256Hex(rendered) };
    if (include === 'all') {
      entry.valetState = {
        pinned: f.pinned,
        relevance: f.relevance,
        version: f.version,
        sourceSessionId: f.sourceSessionId,
      };
    }
    entries.set(f.path, entry);
  }

  // Directory tree over the exported set only — empty dirs are implicitly pruned
  // because directories exist solely as ancestors of exported files.
  const dirContents = new Map<string, { subdirs: Set<string>; files: { path: string; title: string; description: string }[] }>();
  const ensureDir = (dir: string) => {
    let d = dirContents.get(dir);
    if (!d) {
      d = { subdirs: new Set(), files: [] };
      dirContents.set(dir, d);
    }
    return d;
  };
  if (include === 'all' || exported.length > 0) ensureDir(''); // root index (skipped entirely for an empty shareable set)
  for (const f of exported) {
    const segs = f.path.split('/');
    for (let i = 0; i < segs.length - 1; i++) {
      const parent = segs.slice(0, i).join('/');
      const child = segs.slice(0, i + 1).join('/');
      ensureDir(parent).subdirs.add(child);
      ensureDir(child);
    }
    const dir = segs.slice(0, -1).join('/');
    ensureDir(dir).files.push({ path: f.path, title: f.title, description: f.description });
  }

  for (const [dir, contents] of dirContents) {
    const rendered = renderIndex(dir, [...contents.subdirs], contents.files, dir === '');
    entries.set(indexPathForDir(dir), { content: rendered, hash: await sha256Hex(rendered) });
  }

  // Leak flags: shareable files whose bodies link to private paths.
  let leakFlags: string[] = [];
  if (include === 'shareable' && exported.length > 0) {
    const shareableSet = new Set(exported.map((f) => f.path));
    const privateSet = new Set(allFiles.filter((f) => f.sensitivity !== 'shareable').map((f) => f.path));
    const linkRows = await db
      .select({ fromPath: memoryLinks.fromPath, toPath: memoryLinks.toPath })
      .from(memoryLinks)
      .where(eq(memoryLinks.userId, scope.userId));
    const flagged = new Set<string>();
    for (const l of linkRows) {
      if (shareableSet.has(l.fromPath) && privateSet.has(l.toPath)) flagged.add(l.fromPath);
    }
    leakFlags = [...flagged].sort();
  }

  const files: Record<string, MemoryExportEntry> = {};
  for (const key of [...entries.keys()].sort()) {
    files[key] = entries.get(key)!;
  }

  return { okfVersion: OKF_VERSION, include, files, leakFlags };
}

// ─── Import ──────────────────────────────────────────────────────────────────

/** Fully resolved column values for one import row. */
interface ImportRow {
  path: string;
  content: string;      // body (frontmatter stripped, links rewritten)
  title: string;
  type: string;
  description: string;
  tags: string;         // JSON-encoded
  resource: string;
  extras: string;       // JSON-encoded
  sensitivity: string;
  origin: string;
  expires: string | null;
  pinned: number;
  updatedAt: string;    // D1 form — incoming timestamp or import-time now
}

const INDEX_BASENAMES = new Set(['index.md', 'index.okf.md']);

/**
 * Statements for one import chunk in a single db.batch(): upsert each row with
 * all metadata columns bound (updated_at from the row, never datetime('now')),
 * then rebuild FTS + links for exactly those paths via syncDerivedStores.
 */
function buildImportChunk(rawDb: D1Database, scope: MemoryScope, chunk: ImportRow[]): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = chunk.map((r) =>
    rawDb
      .prepare(
        `INSERT INTO orchestrator_memory_files
           (id, user_id, path, content, title, type, description, tags, resource, extras,
            sensitivity, origin, source_session_id, expires, pinned, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)
         ON CONFLICT(user_id, path) DO UPDATE SET
           content = excluded.content, title = excluded.title, type = excluded.type,
           description = excluded.description, tags = excluded.tags, resource = excluded.resource,
           extras = excluded.extras, sensitivity = excluded.sensitivity, origin = excluded.origin,
           source_session_id = '', expires = excluded.expires, pinned = excluded.pinned,
           version = version + 1, updated_at = excluded.updated_at`,
      )
      .bind(
        crypto.randomUUID(), scope.userId, r.path, r.content, r.title, r.type, r.description,
        r.tags, r.resource, r.extras, r.sensitivity, r.origin, r.expires, r.pinned, r.updatedAt,
      ),
  );

  stmts.push(
    ...syncDerivedStores(
      rawDb,
      scope,
      chunk.map((r) => ({ path: r.path, title: r.title, description: r.description, tags: r.tags, content: r.content })),
    ),
  );

  return stmts;
}

const LINK_SCAN_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * Compute the rewritten link target for an imported body, or null when the
 * link should be left byte-identical.
 *
 * - External URLs and anchor-only links: untouched.
 * - Bundle-relative targets: canonicalized to `/<finalPath>` when the written
 *   form differs (covers percent-encoding + normalization + remaps).
 * - Relative targets: untouched while they still resolve correctly from the
 *   file's final location; rewritten to bundle-relative only when a remap
 *   broke them (preserves the export→import→export identity for canonical bundles).
 */
function remapImportTarget(
  fromOrig: string,
  fromFinal: string,
  target: string,
  pathMap: Map<string, string>,
): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    decoded = target;
  }
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(decoded)) return null;
  const hashIdx = decoded.indexOf('#');
  if (hashIdx === 0) return null;
  const frag = hashIdx > 0 ? decoded.slice(hashIdx) : '';

  const resolved = resolveLinkTarget(fromOrig, target);
  if (resolved === null || resolved === '') return null;
  const finalTarget = pathMap.get(resolved);
  if (finalTarget === undefined) return null;

  const canonical = `/${finalTarget}${frag}`;
  if (target.startsWith('/')) {
    return target === canonical ? null : canonical;
  }
  // Relative link: still correct from the new location? Leave the bytes alone.
  if (resolveLinkTarget(fromFinal, target) === finalTarget) return null;
  return canonical;
}

/** Rewrite internal markdown links in an imported body through the path map. */
function rewriteImportedLinks(
  fromOrig: string,
  fromFinal: string,
  body: string,
  pathMap: Map<string, string>,
): string {
  const lines = body.split('\n');
  let inFence = false;
  const out: string[] = [];

  for (const rawLine of lines) {
    if (rawLine.startsWith('```') || rawLine.startsWith('~~~')) {
      inFence = !inFence;
      out.push(rawLine);
      continue;
    }
    if (inFence) {
      out.push(rawLine);
      continue;
    }

    // Scan on a copy with inline code blanked so code spans are never rewritten;
    // splice replacements into the raw line by index.
    const scanLine = rawLine.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
    let result = '';
    let last = 0;
    LINK_SCAN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LINK_SCAN_RE.exec(scanLine)) !== null) {
      const target = match[2];
      const newTarget = remapImportTarget(fromOrig, fromFinal, target, pathMap);
      if (newTarget === null) continue;
      // The target sits at the end of the match, just before the closing ')'.
      const targetStart = match.index + match[0].length - 1 - target.length;
      result += rawLine.slice(last, targetStart) + newTarget;
      last = targetStart + target.length;
    }
    out.push(result + rawLine.slice(last));
  }

  return out.join('\n');
}

/** Read `okf_version` from a root index document's frontmatter, if present. */
function readOkfVersion(content: string): string | null {
  const m = content.match(/^okf_version:\s*"?([^"\n]+?)"?\s*$/m);
  return m ? m[1] : null;
}

/**
 * Import a memory bundle.
 *
 * Accepts the manifest map form (`path → rendered document`) or the legacy
 * array form. `trusted` selects the disposition channel: trusted imports honor
 * all OKF + valet keys; foreign imports reset `sensitivity` to private, force
 * `origin: 'imported'`, and clear `source_session_id`. The legacy array form
 * gets trusted semantics only with the same explicit flag.
 *
 * Mechanics (per the design spec):
 * - Percent-decoded, normalized path map; bundle-relative links rewritten.
 * - Normalization collisions → skipped (first wins, never silent last-wins).
 * - `lib/` → `imported-lib/`, `log.md` → `log-imported.md` (type `log`), and
 *   over-deep paths flattened — all recorded in `renamed` (links follow).
 * - Root index: `okf_version` recorded, then skipped; other index files skipped.
 * - No-op entries (identical rendered document) skipped entirely — the
 *   determinism identity law. Missing `timestamp` ⇒ import-time now.
 */
export async function importMemoryFiles(
  rawDb: D1Database,
  scope: MemoryScope,
  files: Record<string, string> | { path: string; content: string }[],
  trusted = false,
): Promise<MemoryImportResult> {
  const entries: { origPath: string; content: string }[] = Array.isArray(files)
    ? files.map((f) => ({ origPath: f.path, content: f.content }))
    : Object.entries(files).map(([path, content]) => ({ origPath: path, content }));

  const skipped: { path: string; reason: string }[] = [];
  const renamed: Record<string, string> = {};
  const droppedValetKeys = new Set<string>();
  let okfVersion: string | null = null;

  // ── Pass 1: build the original→final path map ─────────────────────────────
  const pathMap = new Map<string, string>(); // normalized original → final stored path
  const accepted = new Map<string, { origPath: string; origNormalized: string; content: string; isLog: boolean }>();

  for (const e of entries) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(e.origPath);
    } catch {
      decoded = e.origPath;
    }
    const normalized = normalizePath(decoded);
    const segs = normalized.split('/').filter(Boolean);
    const basename = segs[segs.length - 1] ?? '';

    // Index files are generated, never imported. Root index carries okf_version.
    if (normalized === '' || INDEX_BASENAMES.has(basename)) {
      if (segs.length <= 1) {
        okfVersion = readOkfVersion(e.content) ?? okfVersion;
      }
      continue;
    }

    if (e.content.length === 0) {
      skipped.push({ path: e.origPath, reason: 'empty content' });
      continue;
    }
    if (e.content.length > MAX_MEMORY_FILE_SIZE) {
      skipped.push({ path: e.origPath, reason: `content exceeds max size (${MAX_MEMORY_FILE_SIZE} bytes)` });
      continue;
    }
    if (normalized.length > 256) {
      skipped.push({ path: e.origPath, reason: 'Path too long (max 256 chars)' });
      continue;
    }

    let finalPath = normalized;
    let isLog = false;

    // lib/ is reserved for mounted libraries — imports remap, never reject.
    if (segs[0] === 'lib') {
      finalPath = ['imported-lib', ...segs.slice(1)].join('/');
    }

    // Foreign log.md is authored history, not regenerable — preserve it renamed.
    if (basename === 'log.md') {
      const fsegs = finalPath.split('/');
      fsegs[fsegs.length - 1] = 'log-imported.md';
      finalPath = fsegs.join('/');
      isLog = true;
    }

    // Over-deep paths flatten (first depth-1 segments + basename).
    const fsegs = finalPath.split('/').filter(Boolean);
    if (fsegs.length > MAX_MEMORY_PATH_DEPTH) {
      finalPath = [...fsegs.slice(0, MAX_MEMORY_PATH_DEPTH - 1), fsegs[fsegs.length - 1]].join('/');
    }

    if (accepted.has(finalPath)) {
      skipped.push({ path: e.origPath, reason: `path collision after normalization (${finalPath})` });
      continue;
    }

    if (finalPath !== normalized) renamed[normalized] = finalPath;
    pathMap.set(normalized, finalPath);
    accepted.set(finalPath, { origPath: e.origPath, origNormalized: normalized, content: e.content, isLog });
  }

  // ── Pass 2: parse, disposition, link rewrite, no-op skip ──────────────────
  const existingRes = await rawDb
    .prepare('SELECT * FROM orchestrator_memory_files WHERE user_id = ?')
    .bind(scope.userId)
    .all<RawMemRow>();
  const existingByPath = new Map<string, MemoryFile>();
  for (const r of existingRes.results ?? []) existingByPath.set(r.path, rawRowToMemoryFile(r));

  const nowD1 = fromIso(new Date().toISOString());
  const rows: ImportRow[] = [];

  for (const [finalPath, item] of accepted) {
    const parsed = parseConcept(item.content);
    const existing = existingByPath.get(finalPath) ?? null;
    const existingMeta = existing ? fileToConceptMeta(existing) : null;

    const disposition = applyDisposition({
      channel: trusted ? 'trusted-import' : 'foreign-import',
      parsed,
      explicit: {},
      existing: existingMeta,
    });
    for (const k of disposition.droppedValetKeys) droppedValetKeys.add(k);

    const body = rewriteImportedLinks(item.origNormalized, finalPath, parsed.body, pathMap);
    const dm = disposition.meta;

    const base = existing
      ? {
          type: existing.type,
          description: existing.description,
          tags: existing.tags,
          resource: existing.resource,
          sensitivity: existing.sensitivity,
          origin: existing.origin,
          expires: existing.expires,
        }
      : {
          type: defaultTypeForPath(finalPath),
          description: '',
          tags: [] as string[],
          resource: '',
          sensitivity: 'private' as 'private' | 'shareable',
          origin: '',
          expires: null as string | null,
        };

    let resource = dm.resource ?? base.resource;
    if (resource) resource = normalizeResource(resource);

    const meta: ConceptMeta = {
      type: item.isLog ? 'log' : (dm.type ?? base.type),
      // Imports honor the document title; never body-derived, empty stays empty.
      title: dm.title ?? existing?.title ?? '',
      description: dm.description ?? base.description,
      resource,
      tags: dm.tags ?? base.tags,
      sensitivity: dm.sensitivity ?? base.sensitivity,
      origin: dm.origin ?? base.origin,
      expires: 'expires' in dm ? (dm.expires ?? null) : base.expires,
      // Missing timestamp ⇒ import-time now (defeats the no-op comparison by design).
      updatedAt: dm.updatedAt ?? nowD1,
      // The imported document is the whole truth for extras.
      extras: parsed.meta.extras ?? {},
    };

    // No-op skip: identical rendered document ⇒ the import must not touch the row.
    if (existing && renderConcept(meta, body) === renderConcept(fileToConceptMeta(existing), existing.content)) {
      skipped.push({ path: item.origPath, reason: 'unchanged' });
      continue;
    }

    rows.push({
      path: finalPath,
      content: body,
      title: meta.title,
      type: meta.type,
      description: meta.description,
      tags: JSON.stringify(meta.tags),
      resource: meta.resource,
      extras: JSON.stringify(meta.extras),
      sensitivity: meta.sensitivity,
      origin: meta.origin,
      expires: meta.expires,
      pinned: pinnedForPath(finalPath),
      updatedAt: meta.updatedAt,
    });
  }

  // ── Pass 3: chunked atomic batches with per-file replay fallback ──────────
  let imported = 0;
  for (let i = 0; i < rows.length; i += IMPORT_CHUNK) {
    const chunk = rows.slice(i, i + IMPORT_CHUNK);
    try {
      await rawDb.batch(buildImportChunk(rawDb, scope, chunk));
      imported += chunk.length;
    } catch (batchErr) {
      // The atomic batch rolled back; replay per-file so one bad row doesn't sink
      // its chunk-mates. Each replay is its own single-row batch so base row, FTS,
      // and links stay consistent (and timestamps stay preserved).
      console.warn(
        `importMemoryFiles: batch of ${chunk.length} failed, replaying per-file:`,
        batchErr instanceof Error ? batchErr.message : batchErr,
      );
      for (const r of chunk) {
        try {
          await rawDb.batch(buildImportChunk(rawDb, scope, [r]));
          imported++;
        } catch (err) {
          skipped.push({ path: r.path, reason: err instanceof Error ? err.message : 'write failed' });
        }
      }
    }
  }

  let pruned = 0;
  try {
    pruned = await enforceMemoryCap(rawDb, scope);
  } catch {
    // A prune failure must not lose the import tally; the cap self-heals on the next write.
  }

  return { imported, skipped, pruned, renamed, droppedValetKeys: [...droppedValetKeys], okfVersion };
}

// ─── Relevance Boost ────────────────────────────────────────────────────────

// Relevance boost and last_accessed_at never bump updated_at/version (they are
// instance-local, not knowledge changes — see the churn table in the spec).
export async function boostMemoryFileRelevance(db: AppDb, scope: MemoryScope, path: string): Promise<void> {
  const normalized = normalizePath(path);
  await db
    .update(orchestratorMemoryFiles)
    .set({
      relevance: sql`MIN(${orchestratorMemoryFiles.relevance} + 0.1, 2.0)`,
      lastAccessedAt: sql`datetime('now')`,
    })
    .where(and(eq(orchestratorMemoryFiles.userId, scope.userId), eq(orchestratorMemoryFiles.path, normalized)));
}

// ─── Journal Auto-Creation ──────────────────────────────────────────────────

export async function ensureTodayJournal(rawDb: D1Database, scope: MemoryScope): Promise<void> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const path = `journal/${today}.md`;
  const normalized = normalizePath(path);
  const existing = await rawDb
    .prepare('SELECT id FROM orchestrator_memory_files WHERE user_id = ? AND path = ?')
    .bind(scope.userId, normalized)
    .first();
  if (existing) return;
  try {
    await writeMemoryFile(rawDb, scope, path, `# ${today}\n\n`, {}, '');
  } catch {
    // Unique constraint race — another concurrent restart created it first. Safe to ignore.
  }
}

// ─── Journal Pruning ────────────────────────────────────────────────────────

/**
 * Delete previous-day journal stubs that were never written to (still just the
 * auto-created "# YYYY-MM-DD" header). Scoped to a single user.
 */
export async function pruneEmptyJournals(rawDb: D1Database, scope: MemoryScope): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const todayPath = normalizePath(`journal/${today}.md`);

  const toDelete = await rawDb
    .prepare(
      `SELECT id, path, content FROM orchestrator_memory_files
       WHERE user_id = ?
         AND path LIKE 'journal/%.md'
         AND path != ?
         AND pinned = 0
         AND LENGTH(TRIM(content)) <= 14`,
    )
    .bind(scope.userId, todayPath)
    .all<{ id: string; path: string; content: string }>();

  let pruned = 0;
  for (const row of toDelete.results ?? []) {
    const trimmed = row.content.trim();
    if (!/^#\s+\d{4}-\d{2}-\d{2}\s*$/.test(trimmed)) continue;

    await rawDb.batch([
      rawDb
        .prepare(
          `DELETE FROM orchestrator_memory_files_fts WHERE rowid IN (
             SELECT rowid FROM orchestrator_memory_files WHERE user_id = ? AND path = ?)`,
        )
        .bind(scope.userId, row.path),
      rawDb.prepare('DELETE FROM orchestrator_memory_files WHERE id = ?').bind(row.id),
      rawDb
        .prepare('DELETE FROM memory_links WHERE user_id = ? AND (from_path = ? OR to_path = ?)')
        .bind(scope.userId, row.path, row.path),
    ]);
    pruned++;
  }

  return pruned;
}

// ─── Cap Enforcement ────────────────────────────────────────────────────────

/**
 * Evict non-pinned files down to the cap. Eviction order is expired-first, then
 * lowest relevance, then least-recently-accessed. A first pass excludes files
 * with ≥3 inbound links (a keep signal); if that pass can't cover the excess it
 * falls back to plain order (hubs included).
 */
async function enforceMemoryCap(rawDb: D1Database, scope: MemoryScope): Promise<number> {
  // Prune's keep-signal (inbound-link count) and expired-first ordering read the
  // link table — backfill it first so a hub is never treated as unlinked.
  await ensureLinksIndexed(rawDb, scope);

  const countResult = await rawDb
    .prepare('SELECT COUNT(*) as cnt FROM orchestrator_memory_files WHERE user_id = ? AND pinned = 0')
    .bind(scope.userId)
    .first<{ cnt: number }>();

  if (!countResult || countResult.cnt <= MEMORY_CAP) return 0;
  const excess = countResult.cnt - MEMORY_CAP;

  const ORDER = `ORDER BY (expires IS NOT NULL AND expires <= datetime('now')) DESC, relevance ASC, last_accessed_at ASC`;

  const firstPass = await rawDb
    .prepare(
      `SELECT id, path FROM orchestrator_memory_files
       WHERE user_id = ? AND pinned = 0
         AND path NOT IN (SELECT to_path FROM memory_links WHERE user_id = ? GROUP BY to_path HAVING COUNT(*) >= 3)
       ${ORDER} LIMIT ?`,
    )
    .bind(scope.userId, scope.userId, excess)
    .all<{ id: string; path: string }>();

  let victims = firstPass.results ?? [];
  if (victims.length < excess) {
    // Keep-signal pass couldn't cover the excess — fall back to plain order.
    const plain = await rawDb
      .prepare(
        `SELECT id, path FROM orchestrator_memory_files WHERE user_id = ? AND pinned = 0 ${ORDER} LIMIT ?`,
      )
      .bind(scope.userId, excess)
      .all<{ id: string; path: string }>();
    victims = plain.results ?? [];
  }

  if (victims.length === 0) return 0;

  const ids = victims.map((v) => v.id);
  const paths = victims.map((v) => v.path);
  const idPlaceholders = ids.map(() => '?').join(',');

  const stmts: D1PreparedStatement[] = [];
  // FTS: delete by rowid before the base rows disappear.
  for (let i = 0; i < paths.length; i += LINK_INSERT_CHUNK) {
    const chunk = paths.slice(i, i + LINK_INSERT_CHUNK);
    const ph = chunk.map(() => '?').join(',');
    stmts.push(
      rawDb
        .prepare(
          `DELETE FROM orchestrator_memory_files_fts WHERE rowid IN (
             SELECT rowid FROM orchestrator_memory_files WHERE user_id = ? AND path IN (${ph}))`,
        )
        .bind(scope.userId, ...chunk),
    );
  }
  stmts.push(
    rawDb.prepare(`DELETE FROM orchestrator_memory_files WHERE id IN (${idPlaceholders})`).bind(...ids),
  );
  // Links in both directions for the evicted set.
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
  return victims.length;
}
