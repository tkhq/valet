/** Workspace runtime identities. Each personal or team workspace owns one
 * assistant; all channels, workflow threads and subscriptions resolve it by
 * ownership. The database enforces this invariant, including retired rows.
 */
import { assistantSessionId, type Principal, type Session } from "@valet/engine";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { EngineHost } from "../engine/host.js";
import type { AppDb, AppQueryable } from "../lib/drizzle.js";
import { agentSessions, assistants, orgs, teams, users, type AssistantRow } from "../schema/index.js";

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

/** One row by id. Returns undefined for an id that does not exist. */
export async function loadAssistant(db: AppQueryable, assistantId: string): Promise<AssistantRow | undefined> {
  const rows = await db.select().from(assistants).where(eq(assistants.id, assistantId)).limit(1);
  return rows[0];
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
  return rows[0];
}

/** Find the workspace identity without creating it. Retired rows remain
 * visible here so callers cannot create a replacement for the same owner. */
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

/** Returns a live row. An archived row stays retired (and throws) only when
 * its owner is gone; otherwise it is restored, so a workspace cannot be left
 * with a retired identity and no way to replace it. */
async function liveOrRestored(db: AppQueryable, orgId: string, principal: Principal, row: AssistantRow): Promise<AssistantRow> {
  if (row.archivedAt === null) return row;
  if (!(await ownerExists(db, orgId, principal))) throw new ArchivedAssistantError();
  // Restore the legacy default flag too: after a rollback, dev-v2 finds the
  // workspace's assistant by it and cannot insert another under the unique index.
  const [restored] = await db.update(assistants).set({ archivedAt: null })
    .where(eq(assistants.id, row.id)).returning();
  await db.execute(sql`UPDATE assistants SET is_default = true WHERE id = ${row.id}`);
  return restored ?? { ...row, archivedAt: null };
}

/** Resolve the sole workspace identity. Concurrent first use converges via
 * the unconditional owner unique index. Accepts transactions so team creation
 * and its runtime identity commit or roll back together. */
export async function resolveDefaultAssistant(
  db: AppQueryable,
  orgId: string,
  principal: Principal,
): Promise<AssistantRow> {
  const existing = await findDefaultAssistant(db, orgId, principal);
  if (existing) return liveOrRestored(db, orgId, principal, existing);

  const row = newAssistantRow({ orgId, principal });
  const inserted = await db.insert(assistants).values(row).onConflictDoNothing().returning();
  if (inserted[0]) return inserted[0];

  const winner = await findDefaultAssistant(db, orgId, principal);
  if (!winner) {
    throw new Error(
      `assistants: no default assistant for ${principal.type}:${principal.id} after an insert conflict — ` +
        `the workspace unique index rejected the insert but no owner row exists`,
    );
  }
  return liveOrRestored(db, orgId, principal, winner);
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
    // A live assistant's session is never deleted by this version. During a
    // rolling deploy an older pod can still mark it deleted; the boot sweep
    // (syncAssistantSessionStatus) repairs that only on restart, so use does it now.
    await deps.db.update(agentSessions).set({ status: "active", updatedAt: Date.now() })
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.status, "deleted")));
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
