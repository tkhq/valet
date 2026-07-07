import type { D1Database } from '@cloudflare/workers-types';
import type { MemoryFileListing, Principal } from '@valet/shared';
import type { AppDb } from '../lib/drizzle.js';
import {
  listMemoryFiles,
  readMemoryFile,
  writeMemoryFile,
  patchMemoryFile,
  deleteMemoryFile,
  deleteMemoryFilesUnderPath,
  searchMemoryFiles,
  searchMemoryFilesUnion,
  boostMemoryFileRelevance,
  listTeamsForUser,
} from '../lib/db.js';

/**
 * Memory scoping for a running session:
 * - `owner` is the scope the session writes to (its own memory).
 * - `actorUserId` is provenance for writes, and — for user owners — the key
 *   used to resolve the read-union over the user's teams at query time.
 *
 * Team orchestrators read/write their own team scope only. Personal
 * orchestrators write their own scope and read a union of it plus every team
 * they belong to; cross-scope files are addressed with a virtual
 * `team:{teamId}/…` prefix (never stored — path normalization strips colons).
 */
export interface SessionMemoryContext {
  owner: Principal;
  actorUserId: string;
}

const TEAM_PATH_PREFIX = /^team:([^/]+)\/(.*)$/;

function parseTeamPath(path: string): { teamId: string; rest: string } | null {
  const m = TEAM_PATH_PREFIX.exec(path);
  return m ? { teamId: m[1], rest: m[2] } : null;
}

/** Teams the actor may read from, resolved fresh each query (instant revocation). */
async function readableTeamScopes(db: AppDb, ctx: SessionMemoryContext): Promise<Principal[]> {
  if (ctx.owner.type !== 'user') return [];
  const memberTeams = await listTeamsForUser(db, ctx.actorUserId);
  return memberTeams.map((t) => ({ type: 'team' as const, id: t.id }));
}

async function resolveReadScope(db: AppDb, ctx: SessionMemoryContext, teamId: string): Promise<Principal | null> {
  const scopes = await readableTeamScopes(db, ctx);
  return scopes.find((s) => s.id === teamId) ?? null;
}

// ─── memRead ────────────────────────────────────────────────────────────────

export type MemReadResult =
  | { files: MemoryFileListing[]; file?: undefined; error?: undefined }
  | { file: Awaited<ReturnType<typeof readMemoryFile>>; files?: undefined; error?: undefined }
  | { error: string; files?: undefined; file?: undefined };

export async function memRead(
  db: AppDb,
  ctx: SessionMemoryContext,
  path?: string,
): Promise<MemReadResult> {
  const p = path || '';

  // Cross-scope addressing: team:{teamId}/… (read-only, membership-checked).
  const teamPath = parseTeamPath(p);
  if (teamPath) {
    const scope = await resolveReadScope(db, ctx, teamPath.teamId);
    if (!scope) return { error: `Not a member of team ${teamPath.teamId}` };
    if (!teamPath.rest || teamPath.rest.endsWith('/')) {
      const files = await listMemoryFiles(db, scope, teamPath.rest);
      return { files: files.map((f) => ({ ...f, path: `team:${teamPath.teamId}/${f.path}` })) };
    }
    const file = await readMemoryFile(db, scope, teamPath.rest);
    return { file };
  }

  if (!p || p.endsWith('/')) {
    const files = await listMemoryFiles(db, ctx.owner, p);
    // Personal orchestrators listing the root also see their teams' files,
    // tagged with the team prefix so provenance is visible.
    if (!p && ctx.owner.type === 'user') {
      const teamScopes = await readableTeamScopes(db, ctx);
      for (const scope of teamScopes) {
        const teamFiles = await listMemoryFiles(db, scope, '');
        files.push(...teamFiles.map((f) => ({ ...f, path: `team:${scope.id}/${f.path}` })));
      }
    }
    return { files };
  }

  const file = await readMemoryFile(db, ctx.owner, p);
  if (file) {
    boostMemoryFileRelevance(db, ctx.owner, p).catch(() => {});
  }
  return { file };
}

// ─── memWrite ───────────────────────────────────────────────────────────────

export type MemWriteResult =
  | { file: Awaited<ReturnType<typeof writeMemoryFile>>; error?: undefined }
  | { error: string; file?: undefined };

export async function memWrite(
  envDB: D1Database,
  ctx: SessionMemoryContext,
  path: string,
  content: string,
): Promise<MemWriteResult> {
  if (parseTeamPath(path)) {
    return { error: 'Writes never cross scopes — team memory is written only by the team orchestrator' };
  }
  const file = await writeMemoryFile(envDB, ctx.owner, path, content, true, ctx.actorUserId);
  return { file };
}

// ─── memPatch ───────────────────────────────────────────────────────────────

export type MemPatchResult =
  | { result: Awaited<ReturnType<typeof patchMemoryFile>>; error?: undefined }
  | { error: string; result?: undefined };

export async function memPatch(
  envDB: D1Database,
  ctx: SessionMemoryContext,
  path: string,
  operations: Parameters<typeof patchMemoryFile>[3],
): Promise<MemPatchResult> {
  if (parseTeamPath(path)) {
    return { error: 'Writes never cross scopes — team memory is written only by the team orchestrator' };
  }
  const result = await patchMemoryFile(envDB, ctx.owner, path, operations, ctx.actorUserId);
  return { result };
}

// ─── memRm ──────────────────────────────────────────────────────────────────

export type MemRmResult =
  | { deleted: number; error?: undefined }
  | { error: string; deleted?: undefined };

export async function memRm(
  envDB: D1Database,
  ctx: SessionMemoryContext,
  path: string,
): Promise<MemRmResult> {
  if (parseTeamPath(path)) {
    return { error: 'Writes never cross scopes — team memory is written only by the team orchestrator' };
  }
  let deleted: number;
  if (path.endsWith('/')) {
    deleted = await deleteMemoryFilesUnderPath(envDB, ctx.owner, path);
  } else {
    deleted = await deleteMemoryFile(envDB, ctx.owner, path);
  }
  return { deleted };
}

// ─── memSearch ──────────────────────────────────────────────────────────────

export type MemSearchResult =
  | { results: Awaited<ReturnType<typeof searchMemoryFiles>>; error?: undefined }
  | { error: string; results?: undefined };

export async function memSearch(
  envDB: D1Database,
  db: AppDb,
  ctx: SessionMemoryContext,
  query: string,
  path?: string,
  limit?: number,
): Promise<MemSearchResult> {
  // Explicit team prefix: search just that team's scope.
  if (path) {
    const teamPath = parseTeamPath(path);
    if (teamPath) {
      const scope = await resolveReadScope(db, ctx, teamPath.teamId);
      if (!scope) return { error: `Not a member of team ${teamPath.teamId}` };
      const results = await searchMemoryFiles(envDB, scope, query, teamPath.rest || undefined, limit ?? 20);
      return {
        results: results.map((r) => ({ ...r, path: `team:${teamPath.teamId}/${r.path}` })),
      };
    }
    // Path-scoped search stays in the session's own scope.
    const results = await searchMemoryFiles(envDB, ctx.owner, query, path, limit ?? 20);
    return { results };
  }

  // No path filter: personal orchestrators search the union of their own
  // scope and every team they belong to; team orchestrators their own scope.
  const teamScopes = await readableTeamScopes(db, ctx);
  if (teamScopes.length === 0) {
    const results = await searchMemoryFiles(envDB, ctx.owner, query, undefined, limit ?? 20);
    return { results };
  }

  const union = await searchMemoryFilesUnion(envDB, [ctx.owner, ...teamScopes], query, limit ?? 20);
  return {
    results: union.map((r) => ({
      path: r.ownerType === 'team' ? `team:${r.ownerId}/${r.path}` : r.path,
      snippet: r.snippet,
      relevance: r.relevance,
    })),
  };
}
