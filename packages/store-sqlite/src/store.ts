import Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, eq, asc } from "drizzle-orm";
import {
  engineSessions,
  engineThreads,
  engineEntries,
  engineQueueItems,
  engineDecisionGates,
  engineDecisionGateRefs,
  engineSuspendedTurns,
  engineAttemptMarkers,
} from "./schema.js";
import { ConflictError, NotFoundError, StaleAttemptError } from "@valet/engine";
import type {
  DecisionGate,
  DecisionGateEntry,
  DecisionGateRef,
  ListOpts,
  MessageQuery,
  Principal,
  PromptAuthor,
  PromptContent,
  QueueItem,
  SessionData,
  SessionEntry,
  SessionStatus,
  SessionStore,
  SubmissionClaim,
  SubmissionOutcome,
  SuspendedTurnState,
  ThreadData,
  WriteFence,
} from "@valet/engine";
import { entryToRow, jsonOrNull, parseJson, parseJsonRequired, rowToEntry, type EntryRow } from "./helpers.js";

const DEFAULT_LEASE_MS = 30_000;

/** Raw column shape of a `SELECT * FROM engine_queue_items` row (better-sqlite3, no ORM mapping). */
interface QueueItemRow {
  id: string;
  session_id: string;
  thread_id: string;
  dispatch_id: string | null;
  status: string;
  outcome: string | null;
  error: string | null;
  superseded_by_item_id: string | null;
  merged_into_item_id: string | null;
  content: string;
  author: string | null;
  channel: string | null;
  reply_target: string | null;
  model: string | null;
  role: string | null;
  metadata: string | null;
  attempt_id: string | null;
  attempt_count: number;
  max_attempts: number;
  timeout_at: number;
  abort_requested_at: number | null;
  owner_id: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

function queueItemRowToItem(row: QueueItemRow): QueueItem {
  return {
    id: row.id,
    threadId: row.thread_id,
    dispatchId: row.dispatch_id ?? undefined,
    content: parseJsonRequired<PromptContent>(row.content),
    author: parseJson<PromptAuthor>(row.author),
    channel: parseJson(row.channel),
    replyTarget: parseJson(row.reply_target),
    model: row.model ?? undefined,
    role: row.role ?? undefined,
    metadata: parseJson(row.metadata),
    status: row.status as QueueItem["status"],
    outcome: row.outcome
      ? { outcome: row.outcome as SubmissionOutcome["outcome"], error: row.error ?? undefined }
      : undefined,
    supersededByItemId: row.superseded_by_item_id ?? undefined,
    mergedIntoItemId: row.merged_into_item_id ?? undefined,
    attemptId: row.attempt_id ?? undefined,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    timeoutAt: row.timeout_at,
    abortRequestedAt: row.abort_requested_at ?? undefined,
    ownerId: row.owner_id ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface QueueItemInsertParams {
  id: string;
  sessionId: string;
  threadId: string;
  dispatchId: string | null;
  status: string;
  outcome: string | null;
  error: string | null;
  supersededByItemId: string | null;
  mergedIntoItemId: string | null;
  content: string;
  author: string | null;
  channel: string | null;
  replyTarget: string | null;
  model: string | null;
  role: string | null;
  metadata: string | null;
  attemptId: string | null;
  attemptCount: number;
  maxAttempts: number;
  timeoutAt: number;
  abortRequestedAt: number | null;
  ownerId: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function queueItemInsertParams(
  sessionId: string,
  threadId: string,
  item: QueueItem,
): QueueItemInsertParams {
  return {
    id: item.id,
    sessionId,
    threadId,
    dispatchId: item.dispatchId ?? null,
    status: item.status,
    outcome: item.outcome?.outcome ?? null,
    error: item.outcome?.error ?? null,
    supersededByItemId: item.supersededByItemId ?? null,
    mergedIntoItemId: item.mergedIntoItemId ?? null,
    content: JSON.stringify(item.content),
    author: jsonOrNull(item.author),
    channel: jsonOrNull(item.channel),
    replyTarget: jsonOrNull(item.replyTarget),
    model: item.model ?? null,
    role: item.role ?? null,
    metadata: jsonOrNull(item.metadata),
    attemptId: item.attemptId ?? null,
    attemptCount: item.attemptCount,
    maxAttempts: item.maxAttempts,
    timeoutAt: item.timeoutAt,
    abortRequestedAt: item.abortRequestedAt ?? null,
    ownerId: item.ownerId ?? null,
    leaseExpiresAt: item.leaseExpiresAt ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

const INSERT_QUEUE_ITEM_SQL = `
  INSERT INTO engine_queue_items (
    id, session_id, thread_id, dispatch_id, status, outcome, error,
    superseded_by_item_id, merged_into_item_id, content, author, channel,
    reply_target, model, role, metadata, attempt_id, attempt_count,
    max_attempts, timeout_at, abort_requested_at, owner_id, lease_expires_at,
    created_at, updated_at
  ) VALUES (
    @id, @sessionId, @threadId, @dispatchId, @status, @outcome, @error,
    @supersededByItemId, @mergedIntoItemId, @content, @author, @channel,
    @replyTarget, @model, @role, @metadata, @attemptId, @attemptCount,
    @maxAttempts, @timeoutAt, @abortRequestedAt, @ownerId, @leaseExpiresAt,
    @createdAt, @updatedAt
  )
`;

// Steer supersession: stamp every unsettled, not-yet-superseded item of the
// thread admitted at or before the steering item's createdAt (matches
// InMemorySessionStore.admitSubmission's steer loop exactly).
const STEER_CANDIDATES_SQL = `
  SELECT id FROM engine_queue_items
  WHERE session_id = ? AND thread_id = ? AND id != ?
    AND status != 'settled'
    AND superseded_by_item_id IS NULL
    AND created_at <= ?
`;

// claimSubmission: single-statement CAS. Succeeds only when itemId IS the
// thread's runnable head (oldest 'queued', not-superseded item) — the
// subquery re-derives the head so a concurrent claim of a different item
// (or of a non-head item) loses (changes=0).
const CLAIM_SQL = `
  UPDATE engine_queue_items
  SET status = 'running', attempt_id = @attemptId, owner_id = @ownerId,
      lease_expires_at = @leaseExpiresAt, attempt_count = attempt_count + 1,
      updated_at = @updatedAt
  WHERE id = @itemId AND session_id = @sessionId AND thread_id = @threadId
    AND status = 'queued' AND superseded_by_item_id IS NULL
    AND id = (
      SELECT id FROM engine_queue_items
      WHERE session_id = @sessionId AND thread_id = @threadId
        AND status = 'queued' AND superseded_by_item_id IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    )
`;

// replaceSubmissionAttempt: CAS install a new attempt. No lease-expiry
// condition here — callers (reconciliation) decide whether a lease is
// expired via listExpiredSubmissions before calling this; the store only
// enforces status + prior-attempt identity (matches InMemorySessionStore).
const REPLACE_ATTEMPT_SQL = `
  UPDATE engine_queue_items
  SET attempt_id = @attemptId, owner_id = @ownerId, lease_expires_at = @leaseExpiresAt,
      attempt_count = attempt_count + 1, updated_at = @updatedAt
  WHERE id = @itemId AND session_id = @sessionId AND thread_id = @threadId
    AND status IN ('running', 'blocked_on_decision_gate')
    AND attempt_id = @expectedAttemptId
`;

function isUniqueConstraintError(err: unknown): err is InstanceType<typeof Database.SqliteError> {
  return err instanceof Database.SqliteError && err.code === "SQLITE_CONSTRAINT_UNIQUE";
}

export class SqliteSessionStore implements SessionStore {
  private readonly sqlite: Database.Database;

  constructor(private readonly db: BetterSQLite3Database & { $client: Database.Database }) {
    this.sqlite = db.$client;
  }

  async saveSession(session: SessionData): Promise<void> {
    this.db
      .insert(engineSessions)
      .values({
        id: session.id,
        ownerType: session.owner.type,
        ownerId: session.owner.id,
        userId: session.userId,
        orgId: session.orgId,
        workspace: session.workspace,
        purpose: session.purpose,
        status: session.status,
        sandboxId: session.sandboxId ?? null,
        snapshotId: session.snapshotId ?? null,
        parentSessionId: session.parentSessionId ?? null,
        parentThreadId: session.parentThreadId ?? null,
        model: session.model ?? null,
        metadata: jsonOrNull(session.metadata),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      })
      .onConflictDoUpdate({
        target: engineSessions.id,
        set: {
          ownerType: session.owner.type,
          ownerId: session.owner.id,
          status: session.status,
          sandboxId: session.sandboxId ?? null,
          snapshotId: session.snapshotId ?? null,
          parentThreadId: session.parentThreadId ?? null,
          model: session.model ?? null,
          metadata: jsonOrNull(session.metadata),
          updatedAt: session.updatedAt,
        },
      })
      .run();
  }

  async saveThread(_sessionId: string, thread: ThreadData): Promise<void> {
    this.db
      .insert(engineThreads)
      .values({
        id: thread.id,
        sessionId: thread.sessionId,
        key: thread.key,
        status: thread.status,
        activeLeafEntryId: thread.activeLeafEntryId ?? null,
        queueMode: thread.queueMode,
        paused: thread.paused === undefined ? null : thread.paused ? 1 : 0,
        model: thread.model ?? null,
        summary: thread.summary ?? null,
        metadata: jsonOrNull(thread.metadata),
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      })
      .onConflictDoUpdate({
        target: engineThreads.id,
        set: {
          status: thread.status,
          activeLeafEntryId: thread.activeLeafEntryId ?? null,
          queueMode: thread.queueMode,
          paused: thread.paused === undefined ? null : thread.paused ? 1 : 0,
          model: thread.model ?? null,
          summary: thread.summary ?? null,
          updatedAt: thread.updatedAt,
        },
      })
      .run();
  }

  private checkFence(fence?: WriteFence): void {
    if (!fence) return;
    const row = this.sqlite
      .prepare("SELECT attempt_id FROM engine_queue_items WHERE id = ?")
      .get(fence.itemId) as { attempt_id: string | null } | undefined;
    if (!row || row.attempt_id !== fence.attemptId) {
      throw new StaleAttemptError(fence.itemId, fence.attemptId, row?.attempt_id ?? undefined);
    }
  }

  /**
   * Fence check + full row lookup, scoped to (sessionId, threadId, itemId).
   * Mirrors InMemorySessionStore's `fencedItem`: the fence must name the
   * item's current attempt AND the item identified by itemId must be the
   * same item the fence names, in the given thread.
   */
  private fencedRow(sessionId: string, threadId: string, itemId: string, fence: WriteFence): QueueItemRow {
    this.checkFence(fence);
    const row = this.sqlite
      .prepare("SELECT * FROM engine_queue_items WHERE id = ?")
      .get(itemId) as QueueItemRow | undefined;
    if (!row || row.session_id !== sessionId || row.thread_id !== threadId || row.id !== fence.itemId) {
      throw new StaleAttemptError(fence.itemId, fence.attemptId, row?.attempt_id ?? undefined);
    }
    return row;
  }

  async appendEntries(
    _sessionId: string,
    threadId: string,
    entries: SessionEntry[],
    fence?: WriteFence,
  ): Promise<void> {
    const run = this.sqlite.transaction(() => {
      this.checkFence(fence);
      for (const e of entries) {
        const row = entryToRow(e);
        this.db.insert(engineEntries).values(row).run();
      }
      if (entries.length > 0) {
        const lastId = entries[entries.length - 1].id;
        this.db
          .update(engineThreads)
          .set({ activeLeafEntryId: lastId, updatedAt: Date.now() })
          .where(eq(engineThreads.id, threadId))
          .run();
      }
    });
    run();
  }

  async updateEntry(sessionId: string, threadId: string, entry: SessionEntry, fence?: WriteFence): Promise<void> {
    const run = this.sqlite.transaction(() => {
      this.checkFence(fence);
      const row = entryToRow(entry);
      const result = this.db
        .update(engineEntries)
        .set(row)
        .where(
          and(
            eq(engineEntries.sessionId, sessionId),
            eq(engineEntries.threadId, threadId),
            eq(engineEntries.id, entry.id),
          ),
        )
        .run();
      if ((result as { changes?: number }).changes === 0) {
        throw new NotFoundError("entry", { sessionId, threadId, id: entry.id });
      }
    });
    run();
  }

  async saveDecisionGate(sessionId: string, threadId: string, gate: DecisionGate): Promise<void> {
    this.db
      .insert(engineDecisionGates)
      .values({
        id: gate.id,
        sessionId,
        threadId,
        type: gate.type,
        status: gate.status,
        title: gate.title,
        body: gate.body ?? null,
        actions: JSON.stringify(gate.actions),
        origin: jsonOrNull(gate.origin),
        context: jsonOrNull(gate.context),
        resolution: null,
        expiresAt: gate.expiresAt ?? null,
        createdAt: gate.createdAt,
        updatedAt: gate.updatedAt,
      })
      .onConflictDoUpdate({
        target: engineDecisionGates.id,
        set: {
          status: gate.status,
          title: gate.title,
          body: gate.body ?? null,
          actions: JSON.stringify(gate.actions),
          context: jsonOrNull(gate.context),
          updatedAt: gate.updatedAt,
        },
      })
      .run();
  }

  async saveDecisionGateRef(
    _sessionId: string,
    _threadId: string,
    gateId: string,
    ref: { channelType: string; ref: DecisionGateRef },
  ): Promise<void> {
    this.db
      .insert(engineDecisionGateRefs)
      .values({
        id: `${gateId}:${ref.channelType}:${ref.ref.messageId}`,
        gateId,
        channelType: ref.channelType,
        ref: JSON.stringify(ref.ref),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
  }

  async updateDecisionGateEntry(
    sessionId: string,
    threadId: string,
    gateId: string,
    patch: Partial<DecisionGateEntry>,
  ): Promise<void> {
    const rows = this.db
      .select()
      .from(engineEntries)
      .where(
        and(
          eq(engineEntries.sessionId, sessionId),
          eq(engineEntries.threadId, threadId),
          eq(engineEntries.gateId, gateId),
        ),
      )
      .all() as EntryRow[];
    for (const row of rows) {
      const current = rowToEntry(row);
      if (current.type !== "decision_gate") continue;
      const merged: DecisionGateEntry = {
        ...current,
        ...patch,
        gate: patch.gate ?? current.gate,
      };
      const newRow = entryToRow(merged);
      this.db
        .update(engineEntries)
        .set({
          metadata: newRow.metadata,
          resolvedAt: newRow.resolvedAt,
          resolution: newRow.resolution,
          withdrawnReason: newRow.withdrawnReason,
        })
        .where(eq(engineEntries.id, row.id))
        .run();
    }
  }

  async saveSuspendedTurn(
    sessionId: string,
    threadId: string,
    s: SuspendedTurnState,
    fence?: WriteFence,
  ): Promise<void> {
    const run = this.sqlite.transaction(() => {
      this.checkFence(fence);
      this.db
        .insert(engineSuspendedTurns)
        .values({
          sessionId,
          threadId,
          queueItemId: s.queueItemId,
          gateId: s.gateId,
          model: s.model,
          leafEntryId: s.leafMessageId ?? null,
          toolCallId: s.toolCallId,
          toolName: s.toolName,
          toolArgs: JSON.stringify(s.toolArgs),
          resumeKey: s.resumeKey,
          attempt: s.attempt,
          createdAt: s.createdAt,
        })
        .onConflictDoUpdate({
          target: [engineSuspendedTurns.sessionId, engineSuspendedTurns.threadId],
          set: {
            queueItemId: s.queueItemId,
            gateId: s.gateId,
            model: s.model,
            leafEntryId: s.leafMessageId ?? null,
            toolCallId: s.toolCallId,
            toolName: s.toolName,
            toolArgs: JSON.stringify(s.toolArgs),
            resumeKey: s.resumeKey,
            attempt: s.attempt,
          },
        })
        .run();
    });
    run();
  }

  async clearSuspendedTurn(sessionId: string, threadId: string, fence?: WriteFence): Promise<void> {
    const run = this.sqlite.transaction(() => {
      this.checkFence(fence);
      this.db
        .delete(engineSuspendedTurns)
        .where(
          and(
            eq(engineSuspendedTurns.sessionId, sessionId),
            eq(engineSuspendedTurns.threadId, threadId),
          ),
        )
        .run();
    });
    run();
  }

  async updateSessionStatus(
    id: string,
    status: SessionStatus,
    metadata?: Partial<SessionData>,
  ): Promise<void> {
    this.db
      .update(engineSessions)
      .set({
        status,
        sandboxId: metadata?.sandboxId ?? undefined,
        snapshotId: metadata?.snapshotId ?? undefined,
        updatedAt: Date.now(),
      })
      .where(eq(engineSessions.id, id))
      .run();
  }

  async getSession(id: string): Promise<SessionData | null> {
    const row = this.db.select().from(engineSessions).where(eq(engineSessions.id, id)).get();
    if (!row) return null;
    return rowToSession(row);
  }

  async listSessions(userId: string, opts?: ListOpts): Promise<SessionData[]> {
    const rows = this.db
      .select()
      .from(engineSessions)
      .where(eq(engineSessions.userId, userId))
      .all();
    let result: SessionData[] = rows.map(rowToSession);
    if (opts?.status) result = result.filter((s) => s.status === opts.status);
    return result;
  }

  async getThread(sessionId: string, threadId: string): Promise<ThreadData | null> {
    const row = this.db
      .select()
      .from(engineThreads)
      .where(and(eq(engineThreads.sessionId, sessionId), eq(engineThreads.id, threadId)))
      .get();
    if (!row) return null;
    return rowToThread(row);
  }

  async listThreads(sessionId: string): Promise<ThreadData[]> {
    const rows = this.db
      .select()
      .from(engineThreads)
      .where(eq(engineThreads.sessionId, sessionId))
      .all();
    return rows.map(rowToThread);
  }

  async getEntries(
    sessionId: string,
    threadId: string,
    opts?: MessageQuery,
  ): Promise<SessionEntry[]> {
    let rows = this.db
      .select()
      .from(engineEntries)
      .where(and(eq(engineEntries.sessionId, sessionId), eq(engineEntries.threadId, threadId)))
      .orderBy(asc(engineEntries.createdAt))
      .all() as EntryRow[];
    if (opts?.includeCompacted === false) rows = rows.filter((r) => r.entryType !== "compaction");
    if (opts?.limit && opts.limit > 0) rows = rows.slice(-opts.limit);
    return rows.map(rowToEntry);
  }

  async listDecisionGates(sessionId: string, threadId?: string): Promise<DecisionGate[]> {
    const rows = threadId
      ? this.db
          .select()
          .from(engineDecisionGates)
          .where(
            and(
              eq(engineDecisionGates.sessionId, sessionId),
              eq(engineDecisionGates.threadId, threadId),
            ),
          )
          .all()
      : this.db
          .select()
          .from(engineDecisionGates)
          .where(eq(engineDecisionGates.sessionId, sessionId))
          .all();
    return rows.map(rowToGate);
  }

  async getDecisionGate(sessionId: string, gateId: string): Promise<DecisionGate | null> {
    const row = this.db
      .select()
      .from(engineDecisionGates)
      .where(
        and(eq(engineDecisionGates.sessionId, sessionId), eq(engineDecisionGates.id, gateId)),
      )
      .get();
    return row ? rowToGate(row) : null;
  }

  async getSuspendedTurn(
    sessionId: string,
    threadId: string,
  ): Promise<SuspendedTurnState | null> {
    const row = this.db
      .select()
      .from(engineSuspendedTurns)
      .where(
        and(
          eq(engineSuspendedTurns.sessionId, sessionId),
          eq(engineSuspendedTurns.threadId, threadId),
        ),
      )
      .get();
    if (!row) return null;
    return {
      sessionId: row.sessionId,
      threadId: row.threadId,
      queueItemId: row.queueItemId,
      gateId: row.gateId,
      model: row.model,
      leafMessageId: row.leafEntryId ?? undefined,
      toolCallId: row.toolCallId,
      toolName: row.toolName,
      toolArgs: parseJson(row.toolArgs) ?? {},
      resumeKey: row.resumeKey,
      attempt: row.attempt,
      createdAt: row.createdAt,
    };
  }

  // === Submission lifecycle (durable execution) ===

  async admitSubmission(
    sessionId: string,
    threadId: string,
    item: QueueItem,
    opts?: { steer?: boolean },
  ): Promise<{ item: QueueItem; admitted: boolean; supersededItemIds: string[] }> {
    const supersededItemIds: string[] = [];
    try {
      const run = this.sqlite.transaction(() => {
        this.sqlite.prepare(INSERT_QUEUE_ITEM_SQL).run(queueItemInsertParams(sessionId, threadId, item));
        if (opts?.steer) {
          const candidates = this.sqlite
            .prepare(STEER_CANDIDATES_SQL)
            .all(sessionId, threadId, item.id, item.createdAt) as { id: string }[];
          if (candidates.length > 0) {
            const placeholders = candidates.map(() => "?").join(",");
            this.sqlite
              .prepare(
                `UPDATE engine_queue_items SET superseded_by_item_id = ?, updated_at = ? WHERE id IN (${placeholders})`,
              )
              .run(item.id, Date.now(), ...candidates.map((c) => c.id));
            supersededItemIds.push(...candidates.map((c) => c.id));
          }
        }
      });
      run();
    } catch (err) {
      if (item.dispatchId && isUniqueConstraintError(err)) {
        const existingRow = this.sqlite
          .prepare("SELECT * FROM engine_queue_items WHERE session_id = ? AND dispatch_id = ?")
          .get(sessionId, item.dispatchId) as QueueItemRow | undefined;
        if (!existingRow) throw err;
        const existingItem = queueItemRowToItem(existingRow);
        const sameContent = JSON.stringify(existingItem.content) === JSON.stringify(item.content);
        if (sameContent) {
          return { item: existingItem, admitted: false, supersededItemIds: [] };
        }
        throw new ConflictError(
          `dispatchId ${item.dispatchId} already admitted with different content`,
          { dispatchId: item.dispatchId, existingItemId: existingItem.id },
        );
      }
      throw err;
    }
    return { item: { ...item }, admitted: true, supersededItemIds };
  }

  async claimSubmission(claim: SubmissionClaim): Promise<QueueItem | null> {
    const now = Date.now();
    const result = this.sqlite.prepare(CLAIM_SQL).run({
      itemId: claim.itemId,
      sessionId: claim.sessionId,
      threadId: claim.threadId,
      attemptId: claim.attemptId,
      ownerId: claim.ownerId,
      leaseExpiresAt: now + (claim.leaseDurationMs ?? DEFAULT_LEASE_MS),
      updatedAt: now,
    });
    if (result.changes === 0) return null;
    return this.getQueueItem(claim.sessionId, claim.itemId);
  }

  async replaceSubmissionAttempt(
    sessionId: string,
    threadId: string,
    itemId: string,
    claim: SubmissionClaim,
    opts: { expectedAttemptId: string },
  ): Promise<QueueItem | null> {
    const now = Date.now();
    const result = this.sqlite.prepare(REPLACE_ATTEMPT_SQL).run({
      itemId,
      sessionId,
      threadId,
      attemptId: claim.attemptId,
      ownerId: claim.ownerId,
      leaseExpiresAt: now + (claim.leaseDurationMs ?? DEFAULT_LEASE_MS),
      updatedAt: now,
      expectedAttemptId: opts.expectedAttemptId,
    });
    if (result.changes === 0) return null;
    return this.getQueueItem(sessionId, itemId);
  }

  async insertAttemptMarker(itemId: string, attemptId: string): Promise<void> {
    this.db
      .insert(engineAttemptMarkers)
      .values({ itemId, attemptId, createdAt: Date.now() })
      .onConflictDoNothing()
      .run();
  }

  async deleteAttemptMarker(itemId: string, attemptId: string): Promise<void> {
    this.db
      .delete(engineAttemptMarkers)
      .where(and(eq(engineAttemptMarkers.itemId, itemId), eq(engineAttemptMarkers.attemptId, attemptId)))
      .run();
  }

  async renewLeases(ownerId: string, itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return;
    const now = Date.now();
    const placeholders = itemIds.map(() => "?").join(",");
    this.sqlite
      .prepare(
        `UPDATE engine_queue_items SET lease_expires_at = ?, updated_at = ? WHERE owner_id = ? AND id IN (${placeholders})`,
      )
      .run(now + DEFAULT_LEASE_MS, now, ownerId, ...itemIds);
  }

  async listExpiredSubmissions(now: number): Promise<QueueItem[]> {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM engine_queue_items
         WHERE status IN ('running', 'blocked_on_decision_gate')
           AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
      )
      .all(now) as QueueItemRow[];
    return rows.map(queueItemRowToItem);
  }

  async listUnsettledSubmissions(sessionId: string): Promise<QueueItem[]> {
    const rows = this.sqlite
      .prepare(`SELECT * FROM engine_queue_items WHERE session_id = ? AND status != 'settled'`)
      .all(sessionId) as QueueItemRow[];
    return rows.map(queueItemRowToItem);
  }

  async getQueueItem(sessionId: string, itemId: string): Promise<QueueItem | null> {
    const row = this.sqlite
      .prepare("SELECT * FROM engine_queue_items WHERE session_id = ? AND id = ?")
      .get(sessionId, itemId) as QueueItemRow | undefined;
    return row ? queueItemRowToItem(row) : null;
  }

  async requestAbort(sessionId: string, threadId?: string): Promise<void> {
    const now = Date.now();
    if (threadId) {
      this.sqlite
        .prepare(
          `UPDATE engine_queue_items SET abort_requested_at = ?, updated_at = ?
           WHERE session_id = ? AND thread_id = ? AND status != 'settled' AND abort_requested_at IS NULL`,
        )
        .run(now, now, sessionId, threadId);
    } else {
      this.sqlite
        .prepare(
          `UPDATE engine_queue_items SET abort_requested_at = ?, updated_at = ?
           WHERE session_id = ? AND status != 'settled' AND abort_requested_at IS NULL`,
        )
        .run(now, now, sessionId);
    }
  }

  async reserveSettlement(
    sessionId: string,
    threadId: string,
    itemId: string,
    outcome: SubmissionOutcome,
    fence: WriteFence,
  ): Promise<void> {
    const run = this.sqlite.transaction(() => {
      const row = this.fencedRow(sessionId, threadId, itemId, fence);
      if (row.status === "terminalizing" || row.status === "settled") {
        const existing: SubmissionOutcome | undefined = row.outcome
          ? { outcome: row.outcome as SubmissionOutcome["outcome"], error: row.error ?? undefined }
          : undefined;
        const sameOutcome = JSON.stringify(existing) === JSON.stringify(outcome);
        if (sameOutcome) return; // idempotent re-reserve
        throw new ConflictError(`queue item ${itemId} already reserved with a different outcome`, {
          itemId,
          existingOutcome: existing,
          newOutcome: outcome,
        });
      }
      this.sqlite
        .prepare(
          `UPDATE engine_queue_items SET status = 'terminalizing', outcome = ?, error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(outcome.outcome, outcome.error ?? null, Date.now(), itemId);
    });
    run();
  }

  async finalizeSettlement(
    sessionId: string,
    threadId: string,
    itemId: string,
    fence: WriteFence,
  ): Promise<void> {
    const run = this.sqlite.transaction(() => {
      const row = this.fencedRow(sessionId, threadId, itemId, fence);
      if (row.status === "settled") return; // idempotent
      this.sqlite
        .prepare(`UPDATE engine_queue_items SET status = 'settled', updated_at = ? WHERE id = ?`)
        .run(Date.now(), itemId);
    });
    run();
  }

  async settleUnclaimed(
    sessionId: string,
    threadId: string,
    itemId: string,
    outcome: SubmissionOutcome,
    opts?: { mergedIntoItemId?: string },
  ): Promise<boolean> {
    const mergedIntoItemId = outcome.outcome === "merged" ? (opts?.mergedIntoItemId ?? null) : null;
    const result = this.sqlite
      .prepare(
        `UPDATE engine_queue_items
         SET status = 'settled', outcome = ?, error = ?,
             merged_into_item_id = COALESCE(?, merged_into_item_id), updated_at = ?
         WHERE id = ? AND session_id = ? AND thread_id = ? AND status IN ('collecting', 'queued')`,
      )
      .run(outcome.outcome, outcome.error ?? null, mergedIntoItemId, Date.now(), itemId, sessionId, threadId);
    return result.changes > 0;
  }

  async setSubmissionBlocked(
    sessionId: string,
    threadId: string,
    itemId: string,
    blocked: boolean,
    fence: WriteFence,
  ): Promise<void> {
    const run = this.sqlite.transaction(() => {
      const row = this.fencedRow(sessionId, threadId, itemId, fence);
      const expected: QueueItem["status"] = blocked ? "running" : "blocked_on_decision_gate";
      if (row.status !== expected) {
        throw new ConflictError(
          `cannot set blocked=${blocked} on queue item ${itemId} in status '${row.status}' (requires '${expected}')`,
          { itemId, status: row.status, blocked },
        );
      }
      const nextStatus: QueueItem["status"] = blocked ? "blocked_on_decision_gate" : "running";
      this.sqlite
        .prepare(`UPDATE engine_queue_items SET status = ?, updated_at = ? WHERE id = ?`)
        .run(nextStatus, Date.now(), itemId);
    });
    run();
  }

  async deleteSession(id: string): Promise<void> {
    const run = this.sqlite.transaction(() => {
      this.sqlite
        .prepare("DELETE FROM engine_attempt_markers WHERE item_id IN (SELECT id FROM engine_queue_items WHERE session_id = ?)")
        .run(id);
      this.db.delete(engineEntries).where(eq(engineEntries.sessionId, id)).run();
      this.db.delete(engineQueueItems).where(eq(engineQueueItems.sessionId, id)).run();
      this.db.delete(engineDecisionGates).where(eq(engineDecisionGates.sessionId, id)).run();
      this.db.delete(engineSuspendedTurns).where(eq(engineSuspendedTurns.sessionId, id)).run();
      this.db.delete(engineThreads).where(eq(engineThreads.sessionId, id)).run();
      this.db.delete(engineSessions).where(eq(engineSessions.id, id)).run();
    });
    run();
  }
}

function rowToSession(r: typeof engineSessions.$inferSelect): SessionData {
  return {
    id: r.id,
    owner: { type: r.ownerType as Principal["type"], id: r.ownerId },
    userId: r.userId,
    orgId: r.orgId,
    workspace: r.workspace,
    purpose: r.purpose as SessionData["purpose"],
    status: r.status as SessionData["status"],
    sandboxId: r.sandboxId ?? undefined,
    snapshotId: r.snapshotId ?? undefined,
    parentSessionId: r.parentSessionId ?? undefined,
    parentThreadId: r.parentThreadId ?? undefined,
    model: r.model ?? undefined,
    metadata: parseJson(r.metadata),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function rowToThread(r: typeof engineThreads.$inferSelect): ThreadData {
  return {
    id: r.id,
    sessionId: r.sessionId,
    key: r.key,
    status: r.status as ThreadData["status"],
    activeLeafEntryId: r.activeLeafEntryId ?? undefined,
    queueMode: r.queueMode as ThreadData["queueMode"],
    paused: r.paused === null || r.paused === undefined ? undefined : Boolean(r.paused),
    model: r.model ?? undefined,
    summary: r.summary ?? undefined,
    metadata: parseJson(r.metadata),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function rowToGate(row: typeof engineDecisionGates.$inferSelect): DecisionGate {
  return {
    id: row.id,
    sessionId: row.sessionId,
    threadId: row.threadId,
    type: row.type as DecisionGate["type"],
    status: row.status as DecisionGate["status"],
    title: row.title,
    body: row.body ?? undefined,
    actions: parseJson(row.actions) ?? [],
    origin: parseJson(row.origin),
    context: parseJson(row.context),
    expiresAt: row.expiresAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
