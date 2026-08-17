/**
 * Assistants — the rows behind every `assistant:{id}` session.
 *
 * An assistant is a named agent a principal owns. The principal is its
 * OWNER and SCOPE, not its identity, so one principal owns any number.
 * `docs/specs/2026-08-13-assistants-design.md` is the contract.
 *
 * Two entry points, and no third:
 *
 *   - `resolveDefaultAssistant` turns a principal into its default
 *     assistant, creating that assistant on first use. Every machine-driven
 *     path — a workflow `orchestrator` node, an event subscription, a
 *     channel binding — says "prompt the team's assistant" and has no basis
 *     for choosing between several, so they all resolve through here.
 *   - `ensureDefaultAssistantSession` adds the two things an HTTP caller
 *     needs on top: the woken engine session, and the `agent_sessions` app
 *     row the session routes read.
 *
 * Callers that already hold an assistant id (a session address the client
 * sent back) go to `EngineHost.assistantSessionFor` directly instead.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, or, type SQL } from "drizzle-orm";
import { assistantSessionId, type Principal, type Session } from "@valet/engine";
import type { AppDb, AppQueryable } from "../lib/drizzle.js";
import { agentSessions, assistants, type AssistantRow } from "../schema/index.js";
import type { EngineHost } from "../engine/host.js";
import type { AssistantSummary } from "../wire/types.js";

/** Raised when a request would leave a principal with no default assistant. */
export class DefaultAssistantArchiveError extends Error {
  readonly code = "assistant_is_default";
  readonly statusCode = 409;
  constructor() {
    super(
      "This is the default assistant. Promote another assistant to default first, then archive this one.",
    );
    this.name = "DefaultAssistantArchiveError";
  }
}

/** Raised when a request targets an assistant that is already archived. */
export class ArchivedAssistantError extends Error {
  readonly code = "assistant_archived";
  readonly statusCode = 409;
  constructor() {
    super("This assistant is archived. Create a new assistant instead.");
    this.name = "ArchivedAssistantError";
  }
}

/** The wire shape of one row. `name` is absent until someone sets it. */
export function toAssistantSummary(row: AssistantRow): AssistantSummary {
  return {
    id: row.id,
    owner: { type: row.ownerType, id: row.ownerId },
    ...(row.name !== null ? { name: row.name } : {}),
    sessionId: row.sessionId,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
  };
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
 * The principal's default assistant if it has one, creating nothing. The
 * read half of `resolveDefaultAssistant`, exported for the routes that must
 * stay side-effect-free.
 *
 * Matches the partial unique index exactly: `is_default` alone identifies
 * the row. Archiving the default is refused (`archiveAssistant`), so a
 * default row is always live and no `archived_at` filter is needed here —
 * adding one would hide a row the index still counts, and the resolver
 * below would then try to create a second default and fail.
 */
export async function findDefaultAssistant(
  db: AppQueryable,
  orgId: string,
  principal: Principal,
): Promise<AssistantRow | undefined> {
  const rows = await db
    .select()
    .from(assistants)
    .where(and(ownerMatch(orgId, principal), eq(assistants.isDefault, true)))
    .limit(1);
  return rows[0];
}

function newAssistantRow(args: {
  orgId: string;
  principal: Principal;
  name: string | null;
  isDefault: boolean;
}): AssistantRow {
  const id = `asst_${randomUUID()}`;
  return {
    id,
    orgId: args.orgId,
    ownerType: args.principal.type,
    ownerId: args.principal.id,
    name: args.name,
    sessionId: assistantSessionId(id),
    isDefault: args.isDefault,
    createdAt: Date.now(),
    archivedAt: null,
  };
}

/**
 * The principal's default assistant, created on first use.
 *
 * This is the ONLY way a principal becomes a session address. Nothing
 * derives a session id from a principal any more — a principal owns any
 * number of assistants, so only this lookup can say which one automation
 * means.
 *
 * Concurrent first calls (two tabs, or a workflow racing a human) both see
 * no default and both insert. The partial unique index picks one winner;
 * `onConflictDoNothing` turns the loser's insert into a no-op instead of an
 * uncaught constraint throw, and the re-read returns the winner's row.
 */
export async function resolveDefaultAssistant(
  db: AppDb,
  orgId: string,
  principal: Principal,
): Promise<AssistantRow> {
  const existing = await findDefaultAssistant(db, orgId, principal);
  if (existing) return existing;

  const row = newAssistantRow({ orgId, principal, name: null, isDefault: true });
  const inserted = await db.insert(assistants).values(row).onConflictDoNothing().returning();
  if (inserted[0]) return inserted[0];

  const winner = await findDefaultAssistant(db, orgId, principal);
  if (!winner) {
    throw new Error(
      `assistants: no default assistant for ${principal.type}:${principal.id} after an insert conflict — ` +
        `the partial unique index rejected the insert but no default row exists`,
    );
  }
  return winner;
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

/**
 * Get-or-create the session of ONE assistant, default or not.
 *
 * Creating an assistant writes only the `assistants` row — an assistant with
 * no conversation has no session to hold. The session and its
 * `agent_sessions` app row are materialized here, the first time somebody
 * opens it. Without this an assistant you just created would list fine and
 * 404 the moment you clicked it, because every ordinary session route reads
 * the app row.
 *
 * Deliberately not restricted to the default. The default is only the one a
 * machine picks when nobody chose; nothing about materializing a session
 * depends on it, and a version of this that resolved the default would be
 * unreachable for every other assistant.
 */
export async function ensureAssistantSession(
  deps: { db: AppDb; engineHost: EngineHost },
  assistant: AssistantRow,
  meta: { actorUserId: string; orgId: string },
): Promise<{ assistant: AssistantRow; sessionId: string; session: Session }> {
  const principal: Principal = { type: assistant.ownerType, id: assistant.ownerId };
  const session = await deps.engineHost.assistantSessionFor(assistant.id, meta, {
    sessionId: assistant.sessionId,
  });
  const sessionId = session.id;

  const existingRows = await deps.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
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
        title: assistant.name ?? "Assistant",
        status: "active",
        ownerType: principal.type,
        ownerId: principal.id,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }

  return { assistant, sessionId, session };
}

// ── Listing ───────────────────────────────────────────────────────────────

/**
 * Live assistants owned by any of `owners`, default first, then oldest
 * first, in one query. The unfiltered list passes the caller plus every
 * team the caller belongs to; the filtered list passes the one owner it was
 * asked for.
 */
export async function listAssistantsForOwners(
  db: AppDb,
  orgId: string,
  owners: Principal[],
): Promise<AssistantRow[]> {
  if (owners.length === 0) return [];
  const byOwner = owners.map((p) =>
    and(eq(assistants.ownerType, p.type), eq(assistants.ownerId, p.id)),
  );
  return db
    .select()
    .from(assistants)
    .where(and(eq(assistants.orgId, orgId), isNull(assistants.archivedAt), or(...byOwner)))
    .orderBy(desc(assistants.isDefault), asc(assistants.createdAt));
}

// ── Mutations ─────────────────────────────────────────────────────────────

/**
 * Create an assistant for `principal`.
 *
 * The new assistant becomes the default only when the principal has none —
 * a principal must never hold zero defaults, or every automation targeting
 * it strands. A concurrent creation can take the default slot between the
 * check and the insert; the partial unique index catches that, and the
 * retry re-inserts the SAME id as an ordinary assistant.
 */
export async function createAssistant(
  db: AppDb,
  orgId: string,
  principal: Principal,
  name: string | null,
): Promise<AssistantRow> {
  const hasDefault = (await findDefaultAssistant(db, orgId, principal)) !== undefined;
  const row = newAssistantRow({ orgId, principal, name, isDefault: !hasDefault });

  const inserted = await db.insert(assistants).values(row).onConflictDoNothing().returning();
  if (inserted[0]) return inserted[0];

  const retried = await db
    .insert(assistants)
    .values({ ...row, isDefault: false })
    .returning();
  const created = retried[0];
  if (!created) {
    throw new Error(`assistants: insert of ${row.id} returned no row`);
  }
  return created;
}

/**
 * Rename and/or promote one assistant, atomically.
 *
 * Promotion demotes the previous default in the SAME transaction. Between
 * the two statements the principal briefly holds no default, and that gap
 * must never be visible: a reader that saw it would resolve no assistant
 * and strand the dispatch it was resolving. Demote-then-promote is also the
 * only order the partial unique index accepts — promoting first collides
 * with the row still holding the slot.
 *
 * Promoting the current default is a no-op by construction: the demote
 * clears it and the promote sets it again.
 */
export async function patchAssistant(
  db: AppDb,
  row: AssistantRow,
  patch: { name?: string; isDefault?: true },
): Promise<AssistantRow> {
  if (row.archivedAt !== null) throw new ArchivedAssistantError();

  return db.transaction(async (tx) => {
    if (patch.isDefault === true) {
      await tx
        .update(assistants)
        .set({ isDefault: false })
        .where(
          and(
            ownerMatch(row.orgId, { type: row.ownerType, id: row.ownerId }),
            eq(assistants.isDefault, true),
          ),
        );
      await tx.update(assistants).set({ isDefault: true }).where(eq(assistants.id, row.id));
    }
    if (patch.name !== undefined) {
      await tx.update(assistants).set({ name: patch.name }).where(eq(assistants.id, row.id));
    }

    const updated = await tx.select().from(assistants).where(eq(assistants.id, row.id)).limit(1);
    const result = updated[0];
    if (!result) {
      throw new Error(`assistants: ${row.id} disappeared during its own update`);
    }
    return result;
  });
}

/**
 * Archive one assistant. The conversation it held survives — archiving
 * hides the assistant, it does not destroy it.
 *
 * The default cannot be archived while it is the default, because every
 * automation that targets this principal resolves to it.
 */
export async function archiveAssistant(db: AppDb, row: AssistantRow): Promise<AssistantRow> {
  if (row.isDefault) throw new DefaultAssistantArchiveError();
  if (row.archivedAt !== null) return row;

  const updated = await db
    .update(assistants)
    .set({ archivedAt: Date.now() })
    .where(eq(assistants.id, row.id))
    .returning();
  const result = updated[0];
  if (!result) {
    throw new Error(`assistants: ${row.id} disappeared during its own archive`);
  }
  return result;
}
