import type { D1Database } from '@cloudflare/workers-types';
import type { OrchestratorIdentity, AgentSession, Principal } from '@valet/shared';
import { orchestratorSessionId, userPrincipal } from '@valet/shared';
import { eq, and, sql } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { orchestratorIdentities } from '../schema/index.js';

function mapSessionRow(row: any): AgentSession {
  return {
    id: row.id,
    userId: row.user_id,
    ownerType: row.owner_type || 'user',
    ownerId: row.owner_id || row.user_id,
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

function rowToIdentity(row: typeof orchestratorIdentities.$inferSelect): OrchestratorIdentity {
  return {
    id: row.id,
    userId: row.userId || undefined,
    ownerType: (row.ownerType as OrchestratorIdentity['ownerType']) || 'user',
    ownerId: row.ownerId || row.userId || undefined,
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

export async function createOrchestratorIdentity(
  db: AppDb,
  data: {
    id: string; userId?: string; owner?: Principal; name: string; handle: string;
    avatar?: string; customInstructions?: string; personaId?: string; orgId?: string;
  }
): Promise<OrchestratorIdentity> {
  const orgId = data.orgId || 'default';
  const owner: Principal = data.owner ?? userPrincipal(data.userId ?? '');
  if (!owner.id) throw new Error('createOrchestratorIdentity requires a userId or owner');
  const type: OrchestratorIdentity['type'] = owner.type === 'user' ? 'personal' : owner.type;
  const userId = owner.type === 'user' ? owner.id : null;

  await db.insert(orchestratorIdentities).values({
    id: data.id,
    userId,
    orgId,
    ownerType: owner.type,
    ownerId: owner.id,
    type,
    name: data.name,
    handle: data.handle,
    avatar: data.avatar || null,
    customInstructions: data.customInstructions || null,
    personaId: data.personaId || null,
  });

  return {
    id: data.id,
    userId: userId ?? undefined,
    ownerType: owner.type,
    ownerId: owner.id,
    orgId,
    type,
    name: data.name,
    handle: data.handle,
    avatar: data.avatar,
    customInstructions: data.customInstructions,
    personaId: data.personaId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function getOrchestratorIdentityByOwner(
  db: AppDb,
  owner: Principal,
  orgId: string = 'default'
): Promise<OrchestratorIdentity | null> {
  const row = await db
    .select()
    .from(orchestratorIdentities)
    .where(
      and(
        eq(orchestratorIdentities.ownerType, owner.type),
        eq(orchestratorIdentities.ownerId, owner.id),
        eq(orchestratorIdentities.orgId, orgId)
      )
    )
    .get();
  return row ? rowToIdentity(row) : null;
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

// Raw SQL: direct stable ID lookup
export async function getOrchestratorSession(db: D1Database, userId: string): Promise<AgentSession | null> {
  const result = await db.prepare(
    `SELECT * FROM sessions WHERE id = ? LIMIT 1`
  ).bind(orchestratorSessionId(userPrincipal(userId))).first();
  return result ? mapSessionRow(result) : null;
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

/**
 * Find all non-terminal orchestrator sessions for a user.
 * Used during restart to clean up stale/legacy sessions (e.g. UUID-based rows
 * from before the stable `orchestrator:{userId}` ID scheme).
 */
export async function getNonTerminalOrchestratorSessions(db: D1Database, userId: string): Promise<AgentSession[]> {
  const rows = await db.prepare(
    `SELECT * FROM sessions
     WHERE user_id = ? AND is_orchestrator = 1
       AND status NOT IN ('terminated', 'archived', 'error')
     ORDER BY created_at DESC`
  ).bind(userId).all();
  return (rows.results ?? []).map(mapSessionRow);
}

// ─── Owner-keyed session helpers (user and team orchestrators) ──────────────

export async function getCurrentOrchestratorSessionByOwner(db: D1Database, owner: Principal): Promise<AgentSession | null> {
  const row = await db.prepare(
    `SELECT * FROM sessions
     WHERE owner_type = ? AND owner_id = ? AND is_orchestrator = 1
       AND status NOT IN ('terminated', 'archived', 'error')
     ORDER BY created_at DESC LIMIT 1`
  ).bind(owner.type, owner.id).first();
  return row ? mapSessionRow(row) : null;
}

export async function getNonTerminalOrchestratorSessionsByOwner(db: D1Database, owner: Principal): Promise<AgentSession[]> {
  const rows = await db.prepare(
    `SELECT * FROM sessions
     WHERE owner_type = ? AND owner_id = ? AND is_orchestrator = 1
       AND status NOT IN ('terminated', 'archived', 'error')
     ORDER BY created_at DESC`
  ).bind(owner.type, owner.id).all();
  return (rows.results ?? []).map(mapSessionRow);
}

