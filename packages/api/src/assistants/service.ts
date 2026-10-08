/** Workspace runtime identities. Each personal or team workspace owns one
 * assistant; all channels, workflow threads and subscriptions resolve it by
 * ownership. Retired identities keep separate tombstone owner keys.
 */
import { assistantSessionId, type Principal, type Session } from "@valet/engine";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { isLegacyAssistantConversation, isLegacyAssistantRuntime } from "../services/legacy-runtime.js";
import { randomUUID } from "node:crypto";
import { lockTeamForOwnership } from "../services/teams.js";
import type { EngineHost } from "../engine/host.js";
import type { AppDb, AppQueryable } from "../lib/drizzle.js";
import { legacyAssistantConversations, legacyAssistantRuntimes, agentSessions, assistantExecutions, assistants, orgs, teams, users, type AssistantRow } from "../schema/index.js";

/** Raised when a request targets an assistant that is already archived. */
export class ArchivedAssistantError extends Error {
  readonly code = "assistant_archived";
  readonly statusCode = 409;
  constructor() {
    super("This workspace assistant has been retired.");
    this.name = "ArchivedAssistantError";
  }
}

function ownerMatch(orgId: string, principal: Principal): SQL | undefined {
  return and(
    eq(assistants.orgId, orgId),
    eq(assistants.ownerType, principal.type),
    eq(assistants.ownerId, principal.id),
  );
}

/** Restore original ownership only for a live identity retired by the singleton migration. */
async function legacyAssistantRow(db: AppQueryable, row: AssistantRow | undefined): Promise<AssistantRow | undefined> {
  if (!row || row.archivedAt === null || !await isLegacyAssistantRuntime(db, row.sessionId, row.orgId)) return row;
  const [legacy] = await db.select().from(legacyAssistantRuntimes).where(eq(legacyAssistantRuntimes.sessionId, row.sessionId)).limit(1);
  if (!legacy?.ownerType || !legacy.ownerId || !await ownerExists(db, row.orgId, { type: legacy.ownerType, id: legacy.ownerId })) return row;
  return { ...row, ownerType: legacy.ownerType, ownerId: legacy.ownerId, archivedAt: null };
}

/** One row by id. Returns undefined for an id that does not exist. */
export async function loadAssistant(db: AppQueryable, assistantId: string): Promise<AssistantRow | undefined> {
  const rows = await db.select().from(assistants).where(eq(assistants.id, assistantId)).limit(1);
  return legacyAssistantRow(db, rows[0]);
}

/**
 * The assistant that owns `sessionId`, if any. The assistants table is the
 * authority on which session ids are assistant sessions (the
 * `assistants_session` unique index): rows migrated from
 * `orchestrator_identities` keep legacy `orchestrator:*` ids that a
 * `parseAssistantSessionId` prefix parse cannot recognize. Callers deciding
 * "is this session an assistant's?" must use this lookup, not the prefix.
 */
export async function loadAssistantBySessionId(
  db: AppQueryable,
  sessionId: string,
): Promise<AssistantRow | undefined> {
  const rows = await db
    .select()
    .from(assistants)
    .where(eq(assistants.sessionId, sessionId))
    .limit(1);
  if (rows[0]) return legacyAssistantRow(db, rows[0]);
  const [execution] = await db.select({ assistant: assistants }).from(assistantExecutions)
    .innerJoin(assistants, eq(assistants.id, assistantExecutions.assistantId))
    .where(eq(assistantExecutions.sessionId, sessionId)).limit(1);
  // The logical assistant stays the same; callers restore the addressed execution.
  return execution ? { ...execution.assistant, sessionId } : undefined;
}

/** Find the workspace identity without creating it. Retired rows remain
 * visible here so the resolver can replace the entry point transactionally. */
export async function findDefaultAssistant(
  db: AppQueryable,
  orgId: string,
  principal: Principal,
): Promise<AssistantRow | undefined> {
  const rows = await db
    .select()
    .from(assistants)
    .where(ownerMatch(orgId, principal))
    .limit(1);
  return rows[0];
}

function newAssistantRow(args: {
  orgId: string;
  principal: Principal;
}): AssistantRow {
  const id = `asst_${randomUUID()}`;
  return {
    id,
    orgId: args.orgId,
    ownerType: args.principal.type,
    ownerId: args.principal.id,
    sessionId: assistantSessionId(id),
    createdAt: Date.now(),
    archivedAt: null,
  };
}

/** True while the user, team, or org that owns a workspace still exists.
 * Team teardown deletes the team row in the transaction that retires its
 * assistant, so a retired assistant of a live owner is a deleted profile
 * left by the earlier multi-assistant model, not a teardown. */
async function ownerExists(db: AppQueryable, orgId: string, principal: Principal): Promise<boolean> {
  const rows = principal.type === "team"
    ? await db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, principal.id), eq(teams.orgId, orgId))).limit(1)
    : principal.type === "user"
      ? await db.select({ id: users.id }).from(users).where(eq(users.id, principal.id)).limit(1)
      : await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, principal.id)).limit(1);
  return rows.length > 0;
}

/** Resolve a workspace entry point without reviving a retired runtime.
 * Old profile deletion can leave a retired row in a live owner's only slot.
 * Move that tombstone aside and create a new identity in one transaction.
 * Direct access to the old identity still rejects it; its data is retained.
 */
export async function resolveDefaultAssistant(
  db: AppQueryable,
  orgId: string,
  principal: Principal,
): Promise<AssistantRow> {
  return db.transaction(async tx => {
    // Match team teardown's lock order before changing its runtime identity.
    if (principal.type === "team") await lockTeamForOwnership(tx, principal.id);
    const [existing] = await tx.select().from(assistants)
      .where(ownerMatch(orgId, principal)).limit(1).for("update");
    if (existing) {
      const [app] = await tx.select({ status: agentSessions.status }).from(agentSessions)
        .where(eq(agentSessions.id, existing.sessionId)).limit(1);
      if (existing.archivedAt === null && app?.status !== "deleted") return existing;
      if (!await ownerExists(tx, orgId, principal)) throw new ArchivedAssistantError();
      // This is explicit retirement, not a live duplicate moved by migration.
      // Remove the continuity proof so the old identity cannot become live.
      await tx.delete(legacyAssistantRuntimes).where(eq(legacyAssistantRuntimes.assistantId, existing.id));
      await tx.update(assistants).set({
        ownerId: `${principal.id}:retired:${existing.id}`,
        archivedAt: existing.archivedAt ?? Date.now(),
      }).where(eq(assistants.id, existing.id));
    }
    const row = newAssistantRow({ orgId, principal });
    const [inserted] = await tx.insert(assistants).values(row).onConflictDoNothing().returning();
    if (inserted) {
      if (existing) {
        // The legacy allow-list belongs to the workspace, not the retired profile.
        await tx.execute(sql`UPDATE assistants SET behavior = old.behavior FROM assistants old
          WHERE assistants.id = ${inserted.id} AND old.id = ${existing.id}`);
      }
      return inserted;
    }
    const winner = await findDefaultAssistant(tx, orgId, principal);
    if (!winner || winner.archivedAt !== null) throw new ArchivedAssistantError();
    return winner;
  });
}

/**
 * Get-or-create the session of `principal`'s DEFAULT assistant.
 *
 * Returns the engine session plus the assistant row it belongs to. Also
 * backfills the `agent_sessions` app row, which is what makes the ordinary
 * session routes (messages, threads, decisions, the WS) work against this
 * session id. Idempotent: a second call finds the row from the first.
 * Concurrent first calls can both see no row and both insert, so the insert
 * is `onConflictDoNothing` on the primary key.
 */
export async function ensureDefaultAssistantSession(
  deps: { db: AppDb; engineHost: EngineHost },
  principal: Principal,
  meta: { actorUserId: string; orgId: string },
): Promise<{ assistant: AssistantRow; sessionId: string; session: Session }> {
  const assistant = await resolveDefaultAssistant(deps.db, meta.orgId, principal);
  return ensureAssistantSession(deps, assistant, meta);
}

/** Team conversations use independent execution state with the existing reader boundary. */
export async function ensureAssistantExecution(
  deps: { db: AppDb; engineHost: EngineHost },
  principal: Principal,
  meta: { actorUserId: string; orgId: string },
  conversationKey: string,
): Promise<{ assistant: AssistantRow; sessionId: string; session: Session }> {
  if (principal.type !== "team") return ensureDefaultAssistantSession(deps, principal, meta);
  const root = await ensureDefaultAssistantSession(deps, principal, meta);
  const [existingExecution] = await deps.db.select({ id: assistantExecutions.sessionId }).from(assistantExecutions)
    .where(and(eq(assistantExecutions.assistantId, root.assistant.id), eq(assistantExecutions.conversationKey, conversationKey))).limit(1);
  if (!existingExecution && await isLegacyAssistantConversation(deps.db, root.sessionId, conversationKey, meta.orgId)) return root;
  if (!existingExecution) {
    const retained = await deps.db.select({ sessionId: legacyAssistantRuntimes.sessionId }).from(legacyAssistantRuntimes)
      .innerJoin(legacyAssistantConversations, eq(legacyAssistantConversations.sessionId, legacyAssistantRuntimes.sessionId))
      .where(and(eq(legacyAssistantRuntimes.orgId, meta.orgId), eq(legacyAssistantRuntimes.ownerType, principal.type),
        eq(legacyAssistantRuntimes.ownerId, principal.id), eq(legacyAssistantConversations.conversationKey, conversationKey)));
    for (const candidate of retained) {
      if (await isLegacyAssistantConversation(deps.db, candidate.sessionId, conversationKey, meta.orgId)) {
        const assistant = await loadAssistantBySessionId(deps.db, candidate.sessionId);
        if (assistant?.archivedAt === null) return ensureAssistantSession(deps, assistant, meta);
      }
    }
  }
  const data = await root.session.toData();
  const governing = await deps.engineHost.ensureFreshThread(root.session, conversationKey,
    { userId: data.userId, orgId: data.orgId, workspace: data.workspace }, meta.actorUserId);
  const execution = await deps.db.transaction(async tx => {
    await lockTeamForOwnership(tx, principal.id);
    if (!await ownerExists(tx, meta.orgId, principal)) throw new ArchivedAssistantError();
    const candidate = { sessionId: `execution:${randomUUID()}`, assistantId: root.assistant.id,
      conversationKey, governingThreadId: governing.id, createdAt: Date.now() };
    await tx.insert(assistantExecutions).values(candidate).onConflictDoNothing();
    const [row] = await tx.select().from(assistantExecutions)
      .where(and(eq(assistantExecutions.assistantId, root.assistant.id), eq(assistantExecutions.conversationKey, conversationKey))).limit(1);
    const [app] = row ? await tx.select({ status: agentSessions.status }).from(agentSessions).where(eq(agentSessions.id, row.sessionId)).limit(1) : [];
    if (app?.status === "deleted") {
      // Explicitly deleting a helper must not reserve its owner's entry point
      // forever. Allocate fresh state; never restore the deleted execution.
      if (conversationKey !== `app-assistant:${meta.actorUserId}`) throw new ArchivedAssistantError();
      const [replacement] = await tx.update(assistantExecutions)
        .set({ sessionId: candidate.sessionId, createdAt: candidate.createdAt })
        .where(eq(assistantExecutions.sessionId, row.sessionId)).returning();
      return replacement;
    }
    return row;
  });
  if (!execution) throw new Error("The conversation could not be created. Try opening it again.");
  return ensureAssistantSession(deps, { ...root.assistant, sessionId: execution.sessionId }, meta);
}

/** Materialize the workspace runtime and its API session record on first use.
 * Exported as `ensureAssistantRuntime` for callers that already hold the row,
 * such as a workflow Thread step. */
export { ensureAssistantSession as ensureAssistantRuntime };
async function ensureAssistantSession(
  deps: { db: AppDb; engineHost: EngineHost },
  assistant: AssistantRow,
  meta: { actorUserId: string; orgId: string },
): Promise<{ assistant: AssistantRow; sessionId: string; session: Session }> {
  const principal: Principal = { type: assistant.ownerType, id: assistant.ownerId };
  const session = await deps.engineHost.assistantSessionFor(assistant.id, meta, {
    sessionId: assistant.sessionId,
  });
  const sessionId = session.id;
  // Every caller of this function intends USE (channel delivery, event
  // dispatch, workflow orchestrator node, the explicit open-conversation
  // route) — never a passive read. A hibernated row heals to active here;
  // chat-only assistant turns make no ready transition, so the
  // attachment-side hooks cannot.
  await deps.engineHost.markSessionUsed(sessionId);

  const existingRows = await deps.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (existingRows[0]?.status === "deleted") {
    deps.engineHost.evictCache(sessionId);
    throw new ArchivedAssistantError();
  }
  if (!existingRows[0]) {
    const now = Date.now();
    const data = await session.toData();
    await deps.db
      .insert(agentSessions)
      .values({
        id: sessionId,
        userId: meta.actorUserId,
        orgId: meta.orgId,
        workspace: data.workspace,
        title: "Assistant",
        status: "active",
        ownerType: principal.type,
        ownerId: principal.id,
        // A new team assistant resolves credentials as the team (team
        // credentials design, deviation 13).
        credentialOwnerMode: "owner",
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
      })
      .onConflictDoNothing();
  }

  return { assistant, sessionId, session };
}

export async function retireAssistant(db: AppQueryable, assistantId: string): Promise<void> {
  await db.delete(legacyAssistantRuntimes).where(eq(legacyAssistantRuntimes.assistantId, assistantId));
  const updated = await db
    .update(assistants)
    .set({
      // Preserve the first retirement timestamp; the workspace slot stays reserved.
      archivedAt: sql`COALESCE(${assistants.archivedAt}, ${Date.now()})`,
    })
    .where(eq(assistants.id, assistantId))
    .returning();
  if (!updated[0]) {
    throw new Error(`assistants: ${assistantId} disappeared during its own retire`);
  }
}

/** The logical workspace runtime and its execution sessions. Authorize the caller before use. */
export async function workspaceSessionIds(db: AppDb, orgId: string, rootSessionId: string): Promise<string[]> {
  const rows = await db.select({ id: assistantExecutions.sessionId }).from(assistantExecutions)
    .innerJoin(assistants, eq(assistants.id, assistantExecutions.assistantId))
    .where(and(eq(assistants.sessionId, rootSessionId), eq(assistants.orgId, orgId)));
  return [rootSessionId, ...rows.map(row => row.id)];
}
