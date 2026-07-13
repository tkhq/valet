/**
 * Owner-tuple OKF memory service — the `MemoryScope` chokepoint (decision
 * 14). Every helper resolves ownership through `{ owner: Principal;
 * actorUserId: string }`. Writes only ever touch `scope.owner`'s own rows;
 * reads (readFile/searchFiles/listFiles) additionally union in every team
 * the caller belongs to when `scope.owner.type === 'user'`, projected
 * read-time under a virtual `team:{teamId}/` path prefix (never stored —
 * colons are rejected in stored paths, which is also what keeps writes
 * from ever crossing scope: a `team:...` path fails `normalizePath`).
 *
 * Scope fence (decision 12 — do NOT build here): the links graph /
 * `mem_move` / `mem_links`, expiry sweeps (the `expires` column exists and
 * `searchFiles` excludes expired rows — that's the entire expiry story
 * this phase), relevance boosting, shareable-export filtering, reranking,
 * and tag-similarity hints.
 */
import { SqliteError } from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Principal } from "@valet/engine";
import { NotFoundError, ValidationError } from "@valet/shared";
import type { AppDb, AppQueryable } from "../lib/drizzle.js";
import { memoryFiles, teamMembers, type MemoryFileRow } from "../schema/index.js";
import { listTeamsForUser } from "./teams.js";
import {
  assertWritablePath,
  normalizePath,
  parseConcept,
  remapImportPath,
  renderConcept,
  type RenderableConcept,
} from "../lib/okf.js";

export interface MemoryScope {
  owner: Principal;
  actorUserId: string;
}

// ─── Directory type defaults (OKF spec "Type vocabulary") ─────────────────

const DIRECTORY_DEFAULT_TYPE: Record<string, string> = {
  preferences: "preference",
  projects: "project-note",
  workflows: "workflow",
  journal: "journal-entry",
  people: "person",
};

function defaultTypeForPath(path: string): string {
  const first = path.split("/")[0];
  return DIRECTORY_DEFAULT_TYPE[first] ?? "note";
}

function extractTitle(content: string, path: string): string {
  const match = /^#\s+(.+)$/m.exec(content);
  if (match) return match[1].trim();
  const basename = path.split("/").pop() ?? path;
  return basename.replace(/\.md$/i, "");
}

// ─── Row <-> OKF projection ─────────────────────────────────────────────

function rowToRenderable(row: MemoryFileRow): RenderableConcept {
  return {
    type: row.type,
    title: row.title,
    description: row.description,
    resource: row.resource,
    tags: safeParseArray(row.tags),
    updatedAtMs: row.updatedAt,
    sensitivity: row.sensitivity,
    origin: row.origin,
    expiresMs: row.expires,
    extras: safeParseRecord(row.extras),
    content: row.content,
  };
}

function safeParseArray(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function safeParseRecord(json: string): Record<string, string> {
  try {
    const v = JSON.parse(json) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = String(val);
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

/** Renders a stored row through `renderConcept` — the one path every
 * boundary (read, export) shares. */
export function renderFile(row: MemoryFileRow): string {
  return renderConcept(rowToRenderable(row));
}

// ─── FTS sync — the ONE helper every mutation goes through ────────────────

function ftsDescription(row: { description: string; content: string }): string {
  if (row.description !== "") return row.description;
  const firstParagraph = row.content.split(/\n\s*\n/)[0]?.trim() ?? "";
  return firstParagraph;
}

function ftsTags(tagsJson: string): string {
  return safeParseArray(tagsJson).join(" ");
}

/**
 * Deletes any existing `memory_files_fts` row for `rowid`, then (when
 * `row` is non-null) re-inserts it from the current base-row values. Every
 * mutation site (write/patch/delete) calls this — the single fts-sync
 * chokepoint the plan requires.
 */
function syncFts(db: AppQueryable, rowid: number, row: MemoryFileRow | null): void {
  db.run(sql`DELETE FROM memory_files_fts WHERE rowid = ${rowid}`);
  if (row) {
    db.run(
      sql`INSERT INTO memory_files_fts (rowid, path, title, description, tags, content)
          VALUES (${rowid}, ${row.path}, ${row.title}, ${ftsDescription(row)}, ${ftsTags(row.tags)}, ${row.content})`,
    );
  }
}

function getRowid(db: AppQueryable, ownerType: string, ownerId: string, path: string): number | undefined {
  const r = db.get<{ rowid: number }>(
    sql`SELECT rowid as rowid FROM memory_files WHERE owner_type = ${ownerType} AND owner_id = ${ownerId} AND path = ${path}`,
  );
  return r?.rowid;
}

// ─── Read-union resolution (decision 14) ──────────────────────────────────

interface ReadableOwner {
  ownerType: string;
  ownerId: string;
  /** '' for the caller's own scope; `team:{id}/` for a read-time-projected
   * team scope. Never stored — purely a display/routing prefix. */
  prefix: string;
}

async function resolveReadableOwners(db: AppDb, scope: MemoryScope): Promise<ReadableOwner[]> {
  const owners: ReadableOwner[] = [{ ownerType: scope.owner.type, ownerId: scope.owner.id, prefix: "" }];
  if (scope.owner.type === "user") {
    const teams = await listTeamsForUser(db, scope.owner.id);
    for (const team of teams) {
      owners.push({ ownerType: "team", ownerId: team.id, prefix: `team:${team.id}/` });
    }
  }
  return owners;
}

async function isTeamMember(db: AppDb, teamId: string, userId: string): Promise<boolean> {
  const row = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .get();
  return row !== undefined;
}

const TEAM_PREFIX_RE = /^team:([^/]+)\/(.*)$/;

/** Resolves a caller-supplied path (which may carry a `team:{id}/` virtual
 * prefix) to the real `(ownerType, ownerId, realPath)` it maps to, for
 * reads. Re-checks team membership at query time — leaving a team drops
 * read access instantly. Returns `null` when the path isn't accessible
 * (not a member, or a non-user scope trying to use the virtual prefix —
 * team/org scopes only ever read their own scope). */
async function resolveReadTarget(
  db: AppDb,
  scope: MemoryScope,
  path: string,
): Promise<{ ownerType: string; ownerId: string; realPath: string } | null> {
  const m = TEAM_PREFIX_RE.exec(path);
  if (!m) {
    return { ownerType: scope.owner.type, ownerId: scope.owner.id, realPath: path };
  }
  if (scope.owner.type !== "user") return null;
  const [, teamId, rest] = m;
  const member = await isTeamMember(db, teamId, scope.owner.id);
  if (!member) return null;
  return { ownerType: "team", ownerId: teamId, realPath: rest };
}

// ─── writeFile ─────────────────────────────────────────────────────────

export interface WriteFileParams {
  path: string;
  /** Required to create a new file. Omit to update metadata only. An
   * explicit empty string is rejected — use `removeFile` to clear a file. */
  content?: string;
  type?: string;
  description?: string;
  tags?: string[];
  resource?: string;
  sensitivity?: "private" | "shareable";
  origin?: string;
  /** ms epoch; `null` clears an existing expiry; `undefined` leaves it
   * unchanged. */
  expires?: number | null;
  pinned?: boolean;
}

export interface WriteFileResult {
  file: MemoryFileRow;
  warnings: string[];
}

/** Writes never accept `team:...`/`org:...` virtual paths — those contain
 * a colon, which `normalizePath` already rejects, so cross-scope writes
 * fail structurally rather than needing a separate check. */
export async function writeFile(db: AppDb, scope: MemoryScope, params: WriteFileParams): Promise<WriteFileResult> {
  assertWritablePath(params.path);
  const path = normalizePath(params.path);

  if (params.content === "") {
    throw new ValidationError("to clear a file use removeFile; to update metadata only, omit content");
  }

  const existing = await db
    .select()
    .from(memoryFiles)
    .where(and(eq(memoryFiles.ownerType, scope.owner.type), eq(memoryFiles.ownerId, scope.owner.id), eq(memoryFiles.path, path)))
    .get();

  if (!existing && params.content === undefined) {
    throw new ValidationError(`${path} does not exist — provide content to create it`);
  }

  const warnings: string[] = [];

  // Agent/API writes never take OKF content or valet.* metadata from
  // embedded frontmatter — only explicit params set columns (decision-12
  // "right-sized" simplification of the legacy stale-echo mechanics).
  // Embedded frontmatter is still stripped from the stored body, and
  // unknown embedded valet.* keys are reported.
  let bodyContent = params.content;
  if (bodyContent !== undefined) {
    const parsed = parseConcept(bodyContent);
    if (parsed.hasFrontmatter) {
      bodyContent = parsed.body;
      if (parsed.droppedValetKeys.length > 0) {
        warnings.push(`dropped unknown embedded keys: ${parsed.droppedValetKeys.join(", ")}`);
      }
    }
  }

  const now = Date.now();
  const finalContent = bodyContent !== undefined ? bodyContent : (existing?.content ?? "");
  const title = bodyContent !== undefined ? extractTitle(finalContent, path) : (existing?.title ?? "");

  const row: MemoryFileRow = {
    ownerType: scope.owner.type,
    ownerId: scope.owner.id,
    path,
    title,
    content: finalContent,
    type: params.type ?? existing?.type ?? defaultTypeForPath(path),
    description: params.description !== undefined ? params.description : (existing?.description ?? ""),
    tags: JSON.stringify(params.tags ?? (existing ? safeParseArray(existing.tags) : [])),
    resource: params.resource !== undefined ? params.resource : (existing?.resource ?? ""),
    extras: existing?.extras ?? "{}",
    sensitivity: params.sensitivity ?? existing?.sensitivity ?? "private",
    origin: params.origin !== undefined ? params.origin : (existing?.origin ?? ""),
    expires: params.expires !== undefined ? params.expires : (existing?.expires ?? null),
    pinned: params.pinned !== undefined ? (params.pinned ? 1 : 0) : (existing?.pinned ?? 0),
    actorUserId: scope.actorUserId,
    sourceSessionId: existing?.sourceSessionId ?? "",
    orgId: existing?.orgId ?? "",
    version: (existing?.version ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  db.transaction((tx) => {
    if (existing) {
      tx.update(memoryFiles)
        .set(row)
        .where(and(eq(memoryFiles.ownerType, row.ownerType), eq(memoryFiles.ownerId, row.ownerId), eq(memoryFiles.path, row.path)))
        .run();
    } else {
      tx.insert(memoryFiles).values(row).run();
    }
    const rowid = getRowid(tx, row.ownerType, row.ownerId, row.path);
    if (rowid !== undefined) syncFts(tx, rowid, row);
  });

  return { file: row, warnings };
}

// ─── patchFile ─────────────────────────────────────────────────────────

export interface PatchFileParams {
  path: string;
  oldString: string;
  newString: string;
}

/** Exact-replace patch on the body. Patch-created files are allowed
 * (`oldString: ''` against a non-existent file creates it with
 * `newString` as the body) — subject to the same path rules as
 * `writeFile`, since it delegates there. */
export async function patchFile(db: AppDb, scope: MemoryScope, params: PatchFileParams): Promise<WriteFileResult> {
  const path = normalizePath(params.path);
  const existing = await db
    .select()
    .from(memoryFiles)
    .where(and(eq(memoryFiles.ownerType, scope.owner.type), eq(memoryFiles.ownerId, scope.owner.id), eq(memoryFiles.path, path)))
    .get();

  if (!existing) {
    if (params.oldString !== "") {
      throw new NotFoundError("memory file", path);
    }
    return writeFile(db, scope, { path, content: params.newString });
  }

  const idx = existing.content.indexOf(params.oldString);
  if (idx === -1) {
    throw new ValidationError(`oldString not found in ${path}`);
  }
  const newContent =
    existing.content.slice(0, idx) + params.newString + existing.content.slice(idx + params.oldString.length);

  return writeFile(db, scope, { path, content: newContent });
}

// ─── removeFile ────────────────────────────────────────────────────────

export async function removeFile(db: AppDb, scope: MemoryScope, path: string): Promise<void> {
  const normalized = normalizePath(path);
  const rowid = getRowid(db, scope.owner.type, scope.owner.id, normalized);
  if (rowid === undefined) {
    throw new NotFoundError("memory file", normalized);
  }
  db.transaction((tx) => {
    tx.delete(memoryFiles)
      .where(
        and(
          eq(memoryFiles.ownerType, scope.owner.type),
          eq(memoryFiles.ownerId, scope.owner.id),
          eq(memoryFiles.path, normalized),
        ),
      )
      .run();
    syncFts(tx, rowid, null);
  });
}

// ─── readFile (file or virtual directory index) ───────────────────────

export interface ReadFileResult {
  kind: "file";
  path: string;
  rendered: string;
  file: MemoryFileRow;
}

export interface ReadDirectoryResult {
  kind: "directory";
  path: string;
  rendered: string;
}

interface DirEntry {
  path: string;
  title: string;
  description: string;
}

function isDirectoryPath(path: string): boolean {
  return path === "" || path === "/" || path.endsWith("/");
}

/** Groups `rows` under `dirPrefix` (already normalized, `''` for root, or
 * ending in `/`) into direct-child subdirectory names and direct-child
 * files. Shared by `readDirectory` and `exportFiles`. */
function groupEntries(rows: MemoryFileRow[], dirPrefix: string): { subdirs: string[]; files: DirEntry[] } {
  const subdirSet = new Set<string>();
  const files: DirEntry[] = [];
  for (const row of rows) {
    if (dirPrefix !== "" && !row.path.startsWith(dirPrefix)) continue;
    const rel = row.path.slice(dirPrefix.length);
    if (rel === "") continue;
    const slashIdx = rel.indexOf("/");
    if (slashIdx === -1) {
      files.push({ path: row.path, title: row.title, description: row.description });
    } else {
      subdirSet.add(rel.slice(0, slashIdx));
    }
  }
  return { subdirs: [...subdirSet], files };
}

function renderIndex(opts: { isRoot: boolean; subdirs: string[]; files: DirEntry[] }): string {
  const lines: string[] = [];
  if (opts.isRoot) {
    lines.push("---", 'okf_version: "0.1"', "---", "");
  }

  const subdirs = [...opts.subdirs].sort();
  const files = [...opts.files].sort((a, b) => a.path.localeCompare(b.path));

  if (subdirs.length > 0) {
    lines.push("# Subdirectories", "");
    for (const d of subdirs) lines.push(`* [${d}](/${d}/)`);
    lines.push("");
  }

  if (files.length > 0) {
    lines.push("# Files", "");
    for (const f of files) {
      const suffix = f.description ? ` - ${f.description}` : "";
      lines.push(`* [${f.title || f.path}](/${f.path})${suffix}`);
    }
    lines.push("");
  }

  return lines.join("\n").replace(/\n+$/, "\n");
}

async function readDirectory(db: AppDb, scope: MemoryScope, path: string): Promise<ReadDirectoryResult> {
  const dirPath = path === "/" ? "" : path;

  // Resolve the `team:{id}/…` virtual prefix (if any) against the RAW
  // path first — normalizePath rejects colons, so it must never see the
  // prefix itself, only the real path underneath it.
  const target = await resolveReadTarget(db, scope, dirPath);
  if (!target) {
    return { kind: "directory", path, rendered: renderIndex({ isRoot: false, subdirs: [], files: [] }) };
  }
  const normalizedReal =
    target.realPath === "" ? "" : normalizePath(target.realPath.endsWith("/") ? target.realPath : `${target.realPath}/`);

  const rows = await db
    .select()
    .from(memoryFiles)
    .where(and(eq(memoryFiles.ownerType, target.ownerType), eq(memoryFiles.ownerId, target.ownerId)))
    .all();

  const { subdirs: subdirSet0, files } = groupEntries(rows, normalizedReal);

  const isOwnRoot =
    normalizedReal === "" && dirPath === "" && target.ownerType === scope.owner.type && target.ownerId === scope.owner.id;

  const subdirs = [...subdirSet0];
  if (isOwnRoot && scope.owner.type === "user") {
    const teams = await listTeamsForUser(db, scope.owner.id);
    for (const team of teams) subdirs.push(`team:${team.id}`);
  }

  return {
    kind: "directory",
    path,
    rendered: renderIndex({ isRoot: dirPath === "", subdirs, files }),
  };
}

export async function readFile(
  db: AppDb,
  scope: MemoryScope,
  path: string,
): Promise<ReadFileResult | ReadDirectoryResult> {
  if (isDirectoryPath(path)) {
    return readDirectory(db, scope, path);
  }

  // Resolve the virtual `team:{id}/…` prefix against the raw path before
  // normalizing — same reasoning as `readDirectory`.
  const target = await resolveReadTarget(db, scope, path);
  if (!target) {
    throw new NotFoundError("memory file", path);
  }
  const normalized = normalizePath(target.realPath);

  const row = await db
    .select()
    .from(memoryFiles)
    .where(and(eq(memoryFiles.ownerType, target.ownerType), eq(memoryFiles.ownerId, target.ownerId), eq(memoryFiles.path, normalized)))
    .get();

  if (!row) {
    // Fall back to a directory read: a path prefix that matches existing
    // files but has no exact-match row is treated as an implicit directory.
    const rows = await db
      .select({ path: memoryFiles.path })
      .from(memoryFiles)
      .where(and(eq(memoryFiles.ownerType, target.ownerType), eq(memoryFiles.ownerId, target.ownerId)))
      .all();
    const prefix = `${normalized}/`;
    if (rows.some((r) => r.path.startsWith(prefix))) {
      return readDirectory(db, scope, `${path}/`);
    }
    throw new NotFoundError("memory file", path);
  }

  return { kind: "file", path, rendered: renderFile(row), file: row };
}

// ─── listFiles ─────────────────────────────────────────────────────────

export interface MemoryFileSummary {
  /** Caller-facing path, including any `team:{id}/` virtual prefix. */
  path: string;
  title: string;
  description: string;
  type: string;
  pinned: boolean;
  updatedAt: number;
}

/** Flat listing across the read-union (own scope + accessible teams),
 * each row projected under its virtual prefix. Optional `prefix` filters
 * by caller-facing path prefix. */
export async function listFiles(db: AppDb, scope: MemoryScope, opts?: { prefix?: string }): Promise<MemoryFileSummary[]> {
  const owners = await resolveReadableOwners(db, scope);
  const out: MemoryFileSummary[] = [];
  for (const owner of owners) {
    const rows = await db
      .select()
      .from(memoryFiles)
      .where(and(eq(memoryFiles.ownerType, owner.ownerType), eq(memoryFiles.ownerId, owner.ownerId)))
      .all();
    for (const row of rows) {
      const virtualPath = `${owner.prefix}${row.path}`;
      if (opts?.prefix && !virtualPath.startsWith(opts.prefix)) continue;
      out.push({
        path: virtualPath,
        title: row.title,
        description: row.description,
        type: row.type,
        pinned: row.pinned === 1,
        updatedAt: row.updatedAt,
      });
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

// ─── searchFiles ───────────────────────────────────────────────────────

export interface SearchFilesParams {
  query: string;
  limit?: number;
}

export interface SearchResult {
  path: string;
  title: string;
  description: string;
  type: string;
  rank: number;
}

interface RawSearchRow {
  path: string;
  title: string;
  description: string;
  type: string;
  owner_type: string;
  owner_id: string;
  rank: number;
}

/** FTS5 MATCH with bm25 weights `path 5, title 10, description 8, tags 6,
 * content 1` (fts5's `bm25()` takes weights in COLUMN ORDER — the
 * fts5(path, title, description, tags, content) declaration order, not
 * named). Expired rows (`expires < now`) are excluded. Read-union applies:
 * results from team scopes carry the virtual `team:{id}/` prefix. */
export async function searchFiles(db: AppDb, scope: MemoryScope, params: SearchFilesParams): Promise<SearchResult[]> {
  const owners = await resolveReadableOwners(db, scope);
  const limit = params.limit ?? 20;
  const now = Date.now();

  const ownerConditions = owners.map(
    (o) => sql`(mf.owner_type = ${o.ownerType} AND mf.owner_id = ${o.ownerId})`,
  );
  const ownerClause = sql.join(ownerConditions, sql` OR `);

  let rows: RawSearchRow[];
  try {
    rows = db.all<RawSearchRow>(sql`
      SELECT mf.path as path, mf.title as title, mf.description as description, mf.type as type,
             mf.owner_type as owner_type, mf.owner_id as owner_id,
             bm25(memory_files_fts, 5, 10, 8, 6, 1) as rank
      FROM memory_files_fts
      JOIN memory_files mf ON mf.rowid = memory_files_fts.rowid
      WHERE memory_files_fts MATCH ${params.query}
        AND (${ownerClause})
        AND (mf.expires IS NULL OR mf.expires > ${now})
      ORDER BY rank
      LIMIT ${limit}
    `);
  } catch (err) {
    if (err instanceof SqliteError && err.code === "SQLITE_ERROR") {
      throw new ValidationError(`invalid search query: ${err.message}`);
    }
    throw err;
  }

  const prefixByOwner = new Map(owners.map((o) => [`${o.ownerType}:${o.ownerId}`, o.prefix]));

  return rows.map((r) => ({
    path: `${prefixByOwner.get(`${r.owner_type}:${r.owner_id}`) ?? ""}${r.path}`,
    title: r.title,
    description: r.description,
    type: r.type,
    rank: r.rank,
  }));
}

// ─── Export / Import (OKF bundle) ──────────────────────────────────────

export interface ExportEntry {
  content: string;
  hash: string;
}

/** `{ path → { content: renderedDoc, hash: sha256(rendered) } }` for every
 * concept in the caller's own scope (export is not read-union — it's a
 * backup/portability operation over exactly one owner tuple), plus a
 * generated `index.md` at every directory level (root included). Only
 * `include=all` is supported this phase (shareable-export filtering is
 * out of scope — decision 12). */
export async function exportFiles(db: AppDb, scope: MemoryScope): Promise<Record<string, ExportEntry>> {
  const rows = await db
    .select()
    .from(memoryFiles)
    .where(and(eq(memoryFiles.ownerType, scope.owner.type), eq(memoryFiles.ownerId, scope.owner.id)))
    .all();

  const manifest: Record<string, ExportEntry> = {};
  for (const row of rows) {
    const rendered = renderFile(row);
    manifest[row.path] = { content: rendered, hash: sha256Hex(rendered) };
  }

  for (const dirPrefix of collectDirectories(rows.map((r) => r.path))) {
    const { subdirs, files } = groupEntries(rows, dirPrefix);
    const indexPath = dirPrefix === "" ? "index.md" : `${dirPrefix}index.md`;
    const rendered = renderIndex({ isRoot: dirPrefix === "", subdirs, files });
    manifest[indexPath] = { content: rendered, hash: sha256Hex(rendered) };
  }

  return manifest;
}

/** Every ancestor directory (as a `'' | 'a/' | 'a/b/'`-style prefix,
 * including the root `''`) that contains at least one file. */
function collectDirectories(paths: string[]): string[] {
  const dirs = new Set<string>([""]);
  for (const p of paths) {
    const segments = p.split("/");
    let acc = "";
    for (let i = 0; i < segments.length - 1; i++) {
      acc += `${segments[i]}/`;
      dirs.add(acc);
    }
  }
  return [...dirs];
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface ImportFilesParams {
  /** path → raw document text (frontmatter optional). */
  files: Record<string, string>;
  /** User-asserted, not cryptographically verified (decision: dev→prod is
   * an operator-driven move). Trusted imports honor embedded OKF content
   * keys and `valet.*` metadata; untrusted (foreign) imports honor content
   * keys but force `sensitivity: 'private'` / `origin: 'imported'`. */
  trusted: boolean;
}

export interface ImportSkip {
  path: string;
  reason: string;
}

export interface ImportRemap {
  from: string;
  to: string;
}

export interface ImportResult {
  imported: string[];
  skipped: ImportSkip[];
  remapped: ImportRemap[];
  warnings: string[];
}

/**
 * Imports an OKF bundle into `scope`'s own storage. Never rejects on path
 * shape (`lib/` remaps to `imported-lib/`, over-deep paths flatten,
 * reserved basenames get a suffix — see `remapImportPath`); `index.md`
 * entries are skipped outright (they're regenerated, never stored);
 * normalization collisions (two source paths mapping to the same stored
 * path) skip every entry after the first.
 */
export async function importFiles(db: AppDb, scope: MemoryScope, params: ImportFilesParams): Promise<ImportResult> {
  const imported: string[] = [];
  const skipped: ImportSkip[] = [];
  const remapped: ImportRemap[] = [];
  const warnings: string[] = [];
  const claimedBy = new Map<string, string>();

  for (const [rawPath, content] of Object.entries(params.files)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      decoded = rawPath;
    }

    let normalized: string;
    try {
      normalized = normalizePath(decoded);
    } catch {
      skipped.push({ path: rawPath, reason: "invalid path" });
      continue;
    }

    const basename = normalized.split("/").pop() ?? normalized;
    if (basename === "index.md") {
      skipped.push({ path: rawPath, reason: "index.md is auto-generated — skipped on import" });
      continue;
    }

    const finalPath = remapImportPath(normalized);
    if (finalPath !== normalized) remapped.push({ from: rawPath, to: finalPath });

    const claimant = claimedBy.get(finalPath);
    if (claimant !== undefined) {
      skipped.push({ path: rawPath, reason: `collision with '${claimant}' — both normalize to '${finalPath}'` });
      continue;
    }
    claimedBy.set(finalPath, rawPath);

    const parsed = parseConcept(content);
    if (parsed.droppedValetKeys.length > 0) {
      warnings.push(`${finalPath}: dropped unknown valet keys: ${parsed.droppedValetKeys.join(", ")}`);
    }

    const existing = await db
      .select()
      .from(memoryFiles)
      .where(and(eq(memoryFiles.ownerType, scope.owner.type), eq(memoryFiles.ownerId, scope.owner.id), eq(memoryFiles.path, finalPath)))
      .get();

    const sensitivity = params.trusted ? (parsed.valet.sensitivity ?? existing?.sensitivity ?? "private") : "private";
    const origin = params.trusted ? (parsed.valet.origin ?? existing?.origin ?? "") : "imported";

    let expires: number | null = params.trusted ? (existing?.expires ?? null) : null;
    if (params.trusted && parsed.valet.expires) {
      const t = Date.parse(parsed.valet.expires);
      if (!Number.isNaN(t)) expires = t;
    }

    let updatedAt = Date.now();
    if (parsed.timestamp) {
      const t = Date.parse(parsed.timestamp);
      if (!Number.isNaN(t)) updatedAt = t;
    }

    const title = parsed.title !== "" ? parsed.title : extractTitle(parsed.body, finalPath);

    const row: MemoryFileRow = {
      ownerType: scope.owner.type,
      ownerId: scope.owner.id,
      path: finalPath,
      title,
      content: parsed.body,
      type: parsed.type !== "" ? parsed.type : (existing?.type ?? defaultTypeForPath(finalPath)),
      description: parsed.description,
      tags: JSON.stringify(parsed.tags),
      resource: parsed.resource,
      extras: JSON.stringify(parsed.extras),
      sensitivity,
      origin,
      expires,
      pinned: existing?.pinned ?? 0,
      actorUserId: scope.actorUserId,
      sourceSessionId: params.trusted ? (existing?.sourceSessionId ?? "") : "",
      orgId: existing?.orgId ?? "",
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? updatedAt,
      updatedAt,
    };

    db.transaction((tx) => {
      if (existing) {
        tx.update(memoryFiles)
          .set(row)
          .where(and(eq(memoryFiles.ownerType, row.ownerType), eq(memoryFiles.ownerId, row.ownerId), eq(memoryFiles.path, row.path)))
          .run();
      } else {
        tx.insert(memoryFiles).values(row).run();
      }
      const rowid = getRowid(tx, row.ownerType, row.ownerId, row.path);
      if (rowid !== undefined) syncFts(tx, rowid, row);
    });

    imported.push(finalPath);
  }

  return { imported, skipped, remapped, warnings };
}
