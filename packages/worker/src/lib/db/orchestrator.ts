import type { D1Database } from '@cloudflare/workers-types';
import type { OrchestratorIdentity, AgentSession } from '@valet/shared';
import { eq, and, sql, notInArray } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { toDate } from '../drizzle.js';
import { orchestratorIdentities, sessions } from '../schema/index.js';

function mapSessionRow(row: any): AgentSession {
  return {
    id: row.id,
    userId: row.user_id,
    workspace: row.workspace,
    status: row.status,
    title: row.title || undefined,
    parentSessionId: row.parent_session_id || undefined,
    containerId: row.container_id || undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    errorMessage: row.error_message || undefined,
    personaId: row.persona_id || undefined,
    personaName: row.persona_name || undefined,
    isOrchestrator: !!row.is_orchestrator || undefined,
    purpose: row.purpose || 'interactive',
    createdAt: new Date(row.created_at),
    lastActiveAt: new Date(row.last_active_at),
  };
}

// ─── Row-to-Domain Converters ───────────────────────────────────────────────

function rowToSession(row: typeof sessions.$inferSelect): AgentSession {
  return {
    id: row.id,
    userId: row.userId,
    workspace: row.workspace,
    status: row.status as AgentSession['status'],
    title: row.title || undefined,
    parentSessionId: row.parentSessionId || undefined,
    containerId: row.containerId || undefined,
    metadata: row.metadata || undefined,
    errorMessage: row.errorMessage || undefined,
    personaId: row.personaId || undefined,
    isOrchestrator: row.isOrchestrator || undefined,
    purpose: (row.purpose as AgentSession['purpose']) || 'interactive',
    createdAt: toDate(row.createdAt),
    lastActiveAt: toDate(row.lastActiveAt),
  };
}

function rowToIdentity(row: typeof orchestratorIdentities.$inferSelect): OrchestratorIdentity {
  return {
    id: row.id,
    userId: row.userId || undefined,
    orgId: row.orgId,
    type: row.type as OrchestratorIdentity['type'],
    name: row.name,
    handle: row.handle,
    avatar: row.avatar || undefined,
    customInstructions: row.customInstructions || undefined,
    personaId: row.personaId || undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── Orchestrator Identity Operations ───────────────────────────────────────

export async function getOrchestratorIdentity(db: AppDb, userId: string, orgId: string = 'default'): Promise<OrchestratorIdentity | null> {
  const row = await db
    .select()
    .from(orchestratorIdentities)
    .where(and(eq(orchestratorIdentities.userId, userId), eq(orchestratorIdentities.orgId, orgId)))
    .get();
  return row ? rowToIdentity(row) : null;
}

export async function getOrchestratorIdentityByHandle(db: AppDb, handle: string, orgId: string = 'default'): Promise<OrchestratorIdentity | null> {
  const row = await db
    .select()
    .from(orchestratorIdentities)
    .where(and(eq(orchestratorIdentities.handle, handle), eq(orchestratorIdentities.orgId, orgId)))
    .get();
  return row ? rowToIdentity(row) : null;
}

export async function getOrchestratorIdentityByName(db: AppDb, name: string, orgId: string = 'default'): Promise<OrchestratorIdentity | null> {
  const row = await db
    .select()
    .from(orchestratorIdentities)
    .where(and(sql`lower(${orchestratorIdentities.name}) = lower(${name})`, eq(orchestratorIdentities.orgId, orgId)))
    .get();
  return row ? rowToIdentity(row) : null;
}

export type CreateOrchestratorIdentityResult =
  | { ok: true; identity: OrchestratorIdentity }
  | { ok: false; reason: 'handle_taken' };

export async function createOrchestratorIdentity(
  db: AppDb,
  data: { id: string; userId: string; name: string; handle: string; avatar?: string; customInstructions?: string; personaId?: string; orgId?: string }
): Promise<CreateOrchestratorIdentityResult> {
  const orgId = data.orgId || 'default';

  try {
    // Swallow only the same-user unique index. A concurrent handle collision
    // uses a different index and still throws, so we classify it below from
    // DB state instead of matching Drizzle/D1 error strings.
    await db.insert(orchestratorIdentities).values({
      id: data.id,
      userId: data.userId,
      orgId,
      type: 'personal',
      name: data.name,
      handle: data.handle,
      avatar: data.avatar || null,
      customInstructions: data.customInstructions || null,
      personaId: data.personaId || null,
    }).onConflictDoNothing({
      target: [orchestratorIdentities.orgId, orchestratorIdentities.userId],
    });
  } catch (err) {
    return classifyIdentityInsertConflict(db, data.userId, data.handle, orgId, err);
  }

  const identity = await getOrchestratorIdentity(db, data.userId, orgId);
  if (identity) return { ok: true, identity };
  return classifyIdentityInsertConflict(db, data.userId, data.handle, orgId, new Error('orchestrator identity insert returned no row'));
}

async function classifyIdentityInsertConflict(
  db: AppDb,
  userId: string,
  handle: string,
  orgId: string,
  err: unknown,
): Promise<CreateOrchestratorIdentityResult> {
  const existing = await getOrchestratorIdentity(db, userId, orgId);
  if (existing) return { ok: true, identity: existing };
  const handleOwner = await getOrchestratorIdentityByHandle(db, handle, orgId);
  if (handleOwner) return { ok: false, reason: 'handle_taken' };
  throw err;
}

export async function updateOrchestratorIdentity(
  db: AppDb,
  id: string,
  updates: Partial<Pick<OrchestratorIdentity, 'name' | 'handle' | 'avatar' | 'customInstructions' | 'personaId'>>
): Promise<void> {
  const setValues: Record<string, unknown> = {};

  if (updates.name !== undefined) setValues.name = updates.name;
  if (updates.handle !== undefined) setValues.handle = updates.handle;
  if (updates.avatar !== undefined) setValues.avatar = updates.avatar || null;
  if (updates.customInstructions !== undefined) setValues.customInstructions = updates.customInstructions || null;
  if (updates.personaId !== undefined) setValues.personaId = updates.personaId || null;

  if (Object.keys(setValues).length === 0) return;

  setValues.updatedAt = sql`datetime('now')`;
  await db
    .update(orchestratorIdentities)
    .set(setValues)
    .where(eq(orchestratorIdentities.id, id));
}

// ─── Orchestrator Session Helpers ───────────────────────────────────────────

// Raw SQL: uses mapSession for snake_case row mapping
export async function getOrchestratorSession(db: D1Database, userId: string): Promise<AgentSession | null> {
  // Look up the most recent orchestrator session by flag, not by fixed ID.
  // This supports session ID rotation on refresh (new DO instance = fresh code).
  // Returns the most recent session regardless of status so callers can inspect it.
  const row = await db.prepare(
    `SELECT * FROM sessions WHERE user_id = ? AND is_orchestrator = 1 ORDER BY created_at DESC LIMIT 1`
  ).bind(userId).first();
  if (row) return mapSessionRow(row);
  return null;
}

export async function getCurrentOrchestratorSession(db: D1Database, userId: string): Promise<AgentSession | null> {
  const activeRow = await db.prepare(
    `SELECT * FROM sessions
     WHERE user_id = ? AND is_orchestrator = 1
       AND status NOT IN ('terminated', 'archived', 'error')
     ORDER BY created_at DESC LIMIT 1`
  ).bind(userId).first();
  if (activeRow) return mapSessionRow(activeRow);
  return null;
}

export async function getOccupyingOrchestratorSession(db: AppDb, userId: string): Promise<AgentSession | null> {
  const row = await db
    .select()
    .from(sessions)
    .where(and(
      eq(sessions.userId, userId),
      eq(sessions.isOrchestrator, true),
      notInArray(sessions.status, ['terminated', 'archived', 'error']),
    ))
    .get();
  return row ? rowToSession(row) : null;
}

/** Non-terminal orchestrator row whose generation still matches the identity. */
export async function getLiveOrchestratorSession(db: AppDb, userId: string): Promise<AgentSession | null> {
  const occupying = await getOccupyingOrchestratorSession(db, userId);
  if (!occupying) return null;
  if (!(await isOrchestratorSpawnClaimHeld(db, occupying.id))) return null;
  return occupying;
}

/**
 * Insert the one live orchestrator session for a user. The partial unique
 * index `idx_sessions_one_live_orchestrator` is the claim: a concurrent
 * insert is a no-op, and we return the winner's row instead of spawning another.
 */
export async function insertLiveOrchestratorSession(
  db: AppDb,
  data: { id: string; userId: string; title?: string; personaId?: string },
): Promise<{ inserted: boolean; session: AgentSession }> {
  try {
    // Partial unique index: ON CONFLICT must include the same WHERE as the index.
    // Drizzle's onConflictDoNothing({ where }) emits invalid SQLite.
    await db.run(sql`
      INSERT INTO sessions (id, user_id, workspace, status, title, persona_id, is_orchestrator, purpose, orchestrator_generation)
      VALUES (
        ${data.id},
        ${data.userId},
        'orchestrator',
        'initializing',
        ${data.title ?? null},
        ${data.personaId ?? null},
        1,
        'orchestrator',
        COALESCE((
          SELECT session_generation FROM orchestrator_identities
          WHERE user_id = ${data.userId}
          LIMIT 1
        ), 0)
      )
      ON CONFLICT (user_id) WHERE is_orchestrator = 1 AND status NOT IN ('terminated', 'archived', 'error')
      DO NOTHING
    `);
  } catch (err) {
    const occupying = await getOccupyingOrchestratorSession(db, data.userId);
    if (occupying) return { inserted: false, session: occupying };
    throw err;
  }

  const created = await db.select().from(sessions).where(eq(sessions.id, data.id)).get();
  if (created) return { inserted: true, session: rowToSession(created) };

  const occupying = await getOccupyingOrchestratorSession(db, data.userId);
  if (occupying) return { inserted: false, session: occupying };
  throw new Error(`insertLiveOrchestratorSession: no row for user ${data.userId}`);
}

const TERMINAL_SESSION_STATUSES = new Set(['terminated', 'archived', 'error']);

export async function getOrchestratorSessionGeneration(db: AppDb, userId: string): Promise<number> {
  const row = await db
    .select({ sessionGeneration: orchestratorIdentities.sessionGeneration })
    .from(orchestratorIdentities)
    .where(eq(orchestratorIdentities.userId, userId))
    .get();
  return row?.sessionGeneration ?? 0;
}

/** Rotate-only: invalidate in-flight /start claims for this user's previous live session. */
export async function bumpOrchestratorSessionGeneration(db: AppDb, userId: string): Promise<number> {
  await db.run(sql`
    UPDATE orchestrator_identities
    SET session_generation = session_generation + 1, updated_at = datetime('now')
    WHERE user_id = ${userId}
  `);
  return getOrchestratorSessionGeneration(db, userId);
}

/**
 * True when this orchestrator session may spawn a sandbox. Rotation bumps
 * identity.session_generation; a row stamped with an older value is stale even
 * if /start is already running.
 */
export async function isOrchestratorSpawnClaimHeld(db: AppDb, sessionId: string): Promise<boolean> {
  const session = await db
    .select({
      userId: sessions.userId,
      status: sessions.status,
      isOrchestrator: sessions.isOrchestrator,
      generation: sessions.orchestratorGeneration,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (!session) return false;
  if (!session.isOrchestrator) return true;
  if (TERMINAL_SESSION_STATUSES.has(session.status)) return false;
  const current = await getOrchestratorSessionGeneration(db, session.userId);
  return (session.generation ?? 0) === current;
}

// Raw SQL: NOT EXISTS subquery + JOIN
/**
 * Find orchestrator sessions stuck in terminal state for longer than `minAgeMinutes`.
 * Only returns one per user, and only if no newer healthy session exists.
 */
export async function getTerminatedOrchestratorSessions(
  db: D1Database,
  minAgeMinutes: number
): Promise<{ userId: string; sessionId: string; identityId: string; name: string; handle: string; customInstructions: string | null }[]> {
  const cutoff = new Date(Date.now() - minAgeMinutes * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const rows = await db.prepare(`
    SELECT s.id as session_id, s.user_id, oi.id as identity_id, oi.name, oi.handle, oi.custom_instructions
    FROM sessions s
    JOIN orchestrator_identities oi ON oi.user_id = s.user_id
    WHERE s.is_orchestrator = 1
      AND s.status IN ('terminated', 'error')
      AND s.last_active_at < ?
      AND NOT EXISTS (
        SELECT 1 FROM sessions s2
        WHERE s2.user_id = s.user_id
          AND s2.is_orchestrator = 1
          AND s2.status NOT IN ('terminated', 'archived', 'error')
      )
    ORDER BY s.created_at DESC
  `).bind(cutoff).all();

  // Deduplicate by user_id (keep the most recent session per user)
  const seen = new Set<string>();
  const result: { userId: string; sessionId: string; identityId: string; name: string; handle: string; customInstructions: string | null }[] = [];
  for (const row of rows.results ?? []) {
    const r = row as any;
    if (seen.has(r.user_id)) continue;
    seen.add(r.user_id);
    result.push({
      userId: r.user_id,
      sessionId: r.session_id,
      identityId: r.identity_id,
      name: r.name,
      handle: r.handle,
      customInstructions: r.custom_instructions,
    });
  }
  return result;
}
