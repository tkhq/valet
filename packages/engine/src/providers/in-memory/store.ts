import { ConflictError, NotFoundError, PendingCapError, StaleAttemptError } from "../../errors.js";
import { countPendingForCap } from "../../submission.js";
import type {
  DecisionGate,
  DecisionGateEntry,
  DecisionGateRef,
  ListOpts,
  MessageQuery,
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
} from "../../types.js";

const DEFAULT_LEASE_MS = 30_000;

interface SessionRow {
  data: SessionData;
  threads: Map<string, ThreadData>;
  entriesByThread: Map<string, SessionEntry[]>;
  gates: Map<string, DecisionGate>;
  gateRefs: Map<string, Array<{ channelType: string; ref: DecisionGateRef }>>;
  suspendedByThread: Map<string, SuspendedTurnState>;
  /** Durable submissions, keyed by item id. Iteration order == admission order. */
  queueItems: Map<string, QueueItem>;
  /** dispatchId -> itemId, unique per session. */
  dispatchIndex: Map<string, string>;
}

export class InMemorySessionStore implements SessionStore {
  private rows = new Map<string, SessionRow>();
  /** Attempt markers are global evidence keyed by `${itemId}:${attemptId}`; no sessionId in the contract. */
  private attemptMarkers = new Set<string>();

  private row(sessionId: string): SessionRow {
    const row = this.rows.get(sessionId);
    if (!row) throw new Error(`session not found: ${sessionId}`);
    return row;
  }

  async saveSession(session: SessionData): Promise<void> {
    const existing = this.rows.get(session.id);
    if (existing) {
      existing.data = session;
      return;
    }
    this.rows.set(session.id, {
      data: session,
      threads: new Map(),
      entriesByThread: new Map(),
      gates: new Map(),
      gateRefs: new Map(),
      suspendedByThread: new Map(),
      queueItems: new Map(),
      dispatchIndex: new Map(),
    });
  }

  async saveThread(sessionId: string, thread: ThreadData): Promise<void> {
    const r = this.row(sessionId);
    r.threads.set(thread.id, thread);
    if (!r.entriesByThread.has(thread.id)) r.entriesByThread.set(thread.id, []);
  }

  // ── fencing helper ─────────────────────────────────────────────

  private checkFence(sessionId: string, fence: WriteFence | undefined): void {
    if (!fence) return;
    const r = this.row(sessionId);
    const item = r.queueItems.get(fence.itemId);
    const currentAttemptId = item?.attemptId;
    if (!item || item.attemptId !== fence.attemptId) {
      throw new StaleAttemptError(fence.itemId, fence.attemptId, currentAttemptId);
    }
  }

  async appendEntries(
    sessionId: string,
    threadId: string,
    entries: SessionEntry[],
    fence?: WriteFence,
  ): Promise<void> {
    this.checkFence(sessionId, fence);
    const r = this.row(sessionId);
    const list = r.entriesByThread.get(threadId) ?? [];
    list.push(...entries);
    r.entriesByThread.set(threadId, list);
    // Update activeLeafEntryId for convenience
    const t = r.threads.get(threadId);
    if (t && entries.length > 0) {
      t.activeLeafEntryId = entries[entries.length - 1].id;
      t.updatedAt = Date.now();
    }
  }

  async updateEntry(
    sessionId: string,
    threadId: string,
    entry: SessionEntry,
    fence?: WriteFence,
  ): Promise<void> {
    this.checkFence(sessionId, fence);
    const r = this.row(sessionId);
    const list = r.entriesByThread.get(threadId) ?? [];
    const idx = list.findIndex((e) => e.id === entry.id);
    if (idx < 0) {
      throw new NotFoundError("entry", { sessionId, threadId, id: entry.id });
    }
    list[idx] = entry;
  }

  async saveDecisionGate(sessionId: string, _threadId: string, gate: DecisionGate): Promise<void> {
    this.row(sessionId).gates.set(gate.id, { ...gate });
  }

  async saveDecisionGateRef(
    sessionId: string,
    _threadId: string,
    gateId: string,
    ref: { channelType: string; ref: DecisionGateRef },
  ): Promise<void> {
    const r = this.row(sessionId);
    const refs = r.gateRefs.get(gateId) ?? [];
    refs.push(ref);
    r.gateRefs.set(gateId, refs);
  }

  async updateDecisionGateEntry(
    sessionId: string,
    threadId: string,
    gateId: string,
    patch: Partial<DecisionGateEntry>,
  ): Promise<void> {
    const r = this.row(sessionId);
    const entries = r.entriesByThread.get(threadId) ?? [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.type === "decision_gate" && e.gate.id === gateId) {
        entries[i] = { ...e, ...patch, gate: patch.gate ?? e.gate };
      }
    }
  }

  async saveSuspendedTurn(
    sessionId: string,
    threadId: string,
    suspended: SuspendedTurnState,
    fence?: WriteFence,
  ): Promise<void> {
    this.checkFence(sessionId, fence);
    this.row(sessionId).suspendedByThread.set(threadId, suspended);
  }

  async clearSuspendedTurn(sessionId: string, threadId: string, fence?: WriteFence): Promise<void> {
    this.checkFence(sessionId, fence);
    this.row(sessionId).suspendedByThread.delete(threadId);
  }

  async updateSessionStatus(
    id: string,
    status: SessionStatus,
    metadata?: Partial<SessionData>,
  ): Promise<void> {
    const r = this.rows.get(id);
    if (!r) return;
    r.data = { ...r.data, ...metadata, status, updatedAt: Date.now() };
  }

  async getSession(id: string): Promise<SessionData | null> {
    return this.rows.get(id)?.data ?? null;
  }

  async listSessions(userId: string, opts?: ListOpts): Promise<SessionData[]> {
    const all = [...this.rows.values()].map((r) => r.data).filter((s) => s.userId === userId);
    if (opts?.status) return all.filter((s) => s.status === opts.status);
    return all;
  }

  async getThread(sessionId: string, threadId: string): Promise<ThreadData | null> {
    return this.row(sessionId).threads.get(threadId) ?? null;
  }

  async listThreads(sessionId: string): Promise<ThreadData[]> {
    return [...this.row(sessionId).threads.values()];
  }

  async getEntries(
    sessionId: string,
    threadId: string,
    opts?: MessageQuery,
  ): Promise<SessionEntry[]> {
    const all = this.row(sessionId).entriesByThread.get(threadId) ?? [];
    let result = all;
    if (opts?.includeCompacted === false) {
      result = result.filter((e) => e.type !== "compaction");
    }
    if (opts?.limit && opts.limit > 0) {
      result = result.slice(-opts.limit);
    }
    return [...result];
  }

  async listDecisionGates(sessionId: string, threadId?: string): Promise<DecisionGate[]> {
    const all = [...this.row(sessionId).gates.values()];
    if (threadId) return all.filter((g) => g.threadId === threadId);
    return all;
  }

  async getDecisionGate(sessionId: string, gateId: string): Promise<DecisionGate | null> {
    return this.row(sessionId).gates.get(gateId) ?? null;
  }

  async getLatestGateForResume(
    sessionId: string,
    threadId: string,
    queueItemId: string,
    resumeKey: string,
  ): Promise<DecisionGate | null> {
    const matches = [...this.row(sessionId).gates.values()].filter(
      (g) =>
        g.threadId === threadId &&
        g.queueItemId === queueItemId &&
        g.resumeKey === resumeKey,
    );
    if (matches.length === 0) return null;
    matches.sort((a, b) => b.ordinal - a.ordinal);
    return { ...matches[0] };
  }

  async getSuspendedTurn(
    sessionId: string,
    threadId: string,
  ): Promise<SuspendedTurnState | null> {
    return this.row(sessionId).suspendedByThread.get(threadId) ?? null;
  }

  async deleteSession(id: string): Promise<void> {
    this.rows.delete(id);
  }

  // ── submission lifecycle ───────────────────────────────────────

  async admitSubmission(
    sessionId: string,
    threadId: string,
    item: QueueItem,
    opts?: { steer?: boolean; maxPending?: number },
  ): Promise<{ item: QueueItem; admitted: boolean; supersededItemIds: string[] }> {
    const r = this.row(sessionId);

    // Normalize an empty-string dispatchId to "absent" so it never dedups — the
    // SQLite backend's partial unique index treats "" as a present value, so
    // both backends must agree that "" means no idempotency key.
    const dispatchId = item.dispatchId || undefined;

    if (dispatchId) {
      const existingId = r.dispatchIndex.get(dispatchId);
      if (existingId) {
        const existing = r.queueItems.get(existingId);
        if (existing) {
          const sameContent = JSON.stringify(existing.content) === JSON.stringify(item.content);
          if (sameContent) {
            return { item: { ...existing }, admitted: false, supersededItemIds: [] };
          }
          throw new ConflictError(
            `dispatchId ${dispatchId} already admitted with different content`,
            { dispatchId, existingItemId: existing.id },
          );
        }
      }
    }

    // Pending-cap enforcement (in-process JS has no true concurrency within
    // this synchronous section, but the check still lives here — between
    // dispatchId dedup resolution and the actual insert — so this store's
    // admission semantics mirror the sqlite backend's in-transaction check
    // exactly: idempotent replays never trip the cap, and the count reflects
    // state as of immediately before this item lands.
    if (opts?.maxPending !== undefined) {
      const unsettled = [...r.queueItems.values()].filter((i) => i.status !== "settled");
      if (countPendingForCap(unsettled, threadId) >= opts.maxPending) {
        throw new PendingCapError(threadId, opts.maxPending);
      }
    }

    const stored: QueueItem = { ...item, dispatchId };
    r.queueItems.set(stored.id, stored);
    if (stored.dispatchId) {
      r.dispatchIndex.set(stored.dispatchId, stored.id);
    }

    const supersededItemIds: string[] = [];
    if (opts?.steer) {
      for (const other of r.queueItems.values()) {
        if (other.id === stored.id) continue;
        if (other.threadId !== threadId) continue;
        if (other.status === "settled") continue;
        if (other.supersededByItemId) continue;
        // "Admitted before this one" is approximated by createdAt ordering;
        // callers construct items with monotonic timestamps in practice, and
        // Map insertion order (== admission order) breaks any tie the same
        // way the SQL backends' insertion-ordered scan will.
        if (other.createdAt > stored.createdAt) continue;
        other.supersededByItemId = stored.id;
        other.updatedAt = Date.now();
        supersededItemIds.push(other.id);
      }
    }

    return { item: { ...stored }, admitted: true, supersededItemIds };
  }

  private threadItemsInOrder(r: SessionRow, threadId: string): QueueItem[] {
    return [...r.queueItems.values()]
      .filter((i) => i.threadId === threadId)
      // Lexicographic id tiebreaker mirrors SQLite's `ORDER BY created_at, id`
      // (CLAIM_SQL) so same-createdAt items claim in a deterministic order that
      // matches across backends, regardless of Map insertion order.
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // Per-thread FIFO gating (spec: "Only the oldest non-superseded unsettled
  // submission of a thread is claimable"). The head is the oldest item that
  // is neither settled nor collecting and has not been superseded; a
  // running/blocked/terminalizing head blocks every later item in the
  // thread from being claimed until it resolves.
  private runnableHead(r: SessionRow, threadId: string): QueueItem | undefined {
    return this.threadItemsInOrder(r, threadId).find(
      (i) => i.status !== "settled" && i.status !== "collecting" && !i.supersededByItemId,
    );
  }

  async claimSubmission(claim: SubmissionClaim): Promise<QueueItem | null> {
    const r = this.row(claim.sessionId);
    const item = r.queueItems.get(claim.itemId);
    if (!item) return null;
    if (item.threadId !== claim.threadId) return null;
    if (item.status !== "queued") return null;
    const head = this.runnableHead(r, claim.threadId);
    if (!head || head.id !== item.id || head.status !== "queued") return null;

    const now = Date.now();
    item.status = "running";
    item.attemptId = claim.attemptId;
    item.ownerId = claim.ownerId;
    item.leaseExpiresAt = now + (claim.leaseDurationMs ?? DEFAULT_LEASE_MS);
    item.attemptCount += 1;
    item.updatedAt = now;
    return { ...item };
  }

  async replaceSubmissionAttempt(
    sessionId: string,
    threadId: string,
    itemId: string,
    claim: SubmissionClaim,
    opts: { expectedAttemptId: string },
  ): Promise<QueueItem | null> {
    const r = this.row(sessionId);
    const item = r.queueItems.get(itemId);
    if (!item) return null;
    if (item.threadId !== threadId) return null;
    if (item.status !== "running" && item.status !== "blocked_on_decision_gate") return null;
    if (item.attemptId !== opts.expectedAttemptId) return null;

    const now = Date.now();
    item.attemptId = claim.attemptId;
    item.ownerId = claim.ownerId;
    item.leaseExpiresAt = now + (claim.leaseDurationMs ?? DEFAULT_LEASE_MS);
    item.attemptCount += 1;
    item.updatedAt = now;
    return { ...item };
  }

  async insertAttemptMarker(itemId: string, attemptId: string): Promise<void> {
    this.attemptMarkers.add(`${itemId}:${attemptId}`);
  }

  async deleteAttemptMarker(itemId: string, attemptId: string): Promise<void> {
    this.attemptMarkers.delete(`${itemId}:${attemptId}`);
  }

  async hasAttemptMarker(itemId: string, attemptId: string): Promise<boolean> {
    return this.attemptMarkers.has(`${itemId}:${attemptId}`);
  }

  async renewLeases(ownerId: string, itemIds: string[]): Promise<void> {
    const now = Date.now();
    const wanted = new Set(itemIds);
    for (const r of this.rows.values()) {
      for (const item of r.queueItems.values()) {
        if (!wanted.has(item.id)) continue;
        if (item.ownerId !== ownerId) continue; // replaced attempts change owner; skip silently
        item.leaseExpiresAt = now + DEFAULT_LEASE_MS;
        item.updatedAt = now;
      }
    }
  }

  async listExpiredSubmissions(now: number): Promise<QueueItem[]> {
    const out: QueueItem[] = [];
    for (const r of this.rows.values()) {
      for (const item of r.queueItems.values()) {
        if (
          (item.status === "running" || item.status === "blocked_on_decision_gate") &&
          item.leaseExpiresAt !== undefined &&
          item.leaseExpiresAt < now
        ) {
          out.push({ ...item });
        }
      }
    }
    return out;
  }

  async listUnsettledSubmissions(sessionId: string): Promise<QueueItem[]> {
    const r = this.row(sessionId);
    return [...r.queueItems.values()].filter((i) => i.status !== "settled").map((i) => ({ ...i }));
  }

  async listSessionIdsWithUnsettledSubmissions(): Promise<string[]> {
    const out: string[] = [];
    for (const [sessionId, r] of this.rows) {
      for (const item of r.queueItems.values()) {
        if (item.status !== "settled") {
          out.push(sessionId);
          break;
        }
      }
    }
    return out;
  }

  async listSettledSubmissionsBefore(sessionId: string, cutoff: number): Promise<QueueItem[]> {
    const r = this.rows.get(sessionId);
    if (!r) return [];
    return [...r.queueItems.values()]
      .filter((i) => i.status === "settled" && i.updatedAt < cutoff)
      .map((i) => ({ ...i }));
  }

  async getQueueItem(sessionId: string, itemId: string): Promise<QueueItem | null> {
    const r = this.row(sessionId);
    const item = r.queueItems.get(itemId);
    return item ? { ...item } : null;
  }

  async latestActivityAt(sessionId: string): Promise<number | null> {
    const r = this.rows.get(sessionId);
    if (!r || r.queueItems.size === 0) return null;
    let max: number | null = null;
    for (const item of r.queueItems.values()) {
      if (max === null || item.updatedAt > max) max = item.updatedAt;
    }
    return max;
  }

  /**
   * Sync fence check for wiring into InMemoryEventStream's fenceCheck opt
   * (decision 12). Item ids are unique across sessions (uid-based), so this
   * searches every row rather than requiring a sessionId.
   */
  isCurrentAttempt(itemId: string, attemptId: string): boolean {
    for (const r of this.rows.values()) {
      const item = r.queueItems.get(itemId);
      if (item) return item.attemptId === attemptId;
    }
    return false;
  }

  async listAllUnsettledSubmissions(): Promise<(QueueItem & { sessionId: string })[]> {
    const out: (QueueItem & { sessionId: string })[] = [];
    for (const [sessionId, r] of this.rows) {
      for (const item of r.queueItems.values()) {
        if (item.status !== "settled") out.push({ ...item, sessionId });
      }
    }
    return out;
  }

  async forceSettle(
    sessionId: string,
    itemId: string,
    outcome: "failed" | "aborted",
    error?: string,
  ): Promise<QueueItem> {
    const r = this.row(sessionId);
    const item = r.queueItems.get(itemId);
    if (!item) throw new NotFoundError("queue item", { sessionId, itemId });
    if (item.status === "settled") {
      throw new ConflictError(`queue item ${itemId} is already settled`, { sessionId, itemId });
    }
    item.status = "settled";
    item.outcome = { outcome, error };
    item.updatedAt = Date.now();
    const prefix = `${itemId}:`;
    for (const key of this.attemptMarkers) {
      if (key.startsWith(prefix)) this.attemptMarkers.delete(key);
    }
    return { ...item };
  }

  async requestAbort(sessionId: string, threadId?: string): Promise<void> {
    const r = this.row(sessionId);
    const now = Date.now();
    for (const item of r.queueItems.values()) {
      if (threadId && item.threadId !== threadId) continue;
      if (item.status === "settled") continue;
      if (item.abortRequestedAt !== undefined) continue; // first write wins
      item.abortRequestedAt = now;
      item.updatedAt = now;
    }
  }

  /**
   * Shared lookup for the fenced lifecycle methods: enforce the fence via
   * checkFence, then resolve the target item, treating any identity mismatch
   * (unknown item, wrong thread, fence naming a different item) as a stale
   * write the same way the fence rejection is.
   */
  private fencedItem(
    sessionId: string,
    threadId: string,
    itemId: string,
    fence: WriteFence,
  ): QueueItem {
    this.checkFence(sessionId, fence);
    const item = this.row(sessionId).queueItems.get(itemId);
    if (!item || item.threadId !== threadId || item.id !== fence.itemId) {
      throw new StaleAttemptError(fence.itemId, fence.attemptId, item?.attemptId);
    }
    return item;
  }

  async reserveSettlement(
    sessionId: string,
    threadId: string,
    itemId: string,
    outcome: SubmissionOutcome,
    fence: WriteFence,
  ): Promise<void> {
    const item = this.fencedItem(sessionId, threadId, itemId, fence);
    if (item.status === "terminalizing" || item.status === "settled") {
      const sameOutcome = JSON.stringify(item.outcome) === JSON.stringify(outcome);
      if (sameOutcome) return; // idempotent re-reserve
      throw new ConflictError(`queue item ${itemId} already reserved with a different outcome`, {
        itemId,
        existingOutcome: item.outcome,
        newOutcome: outcome,
      });
    }
    item.status = "terminalizing";
    item.outcome = outcome;
    item.updatedAt = Date.now();
  }

  async finalizeSettlement(
    sessionId: string,
    threadId: string,
    itemId: string,
    fence: WriteFence,
  ): Promise<void> {
    const item = this.fencedItem(sessionId, threadId, itemId, fence);
    if (item.status === "settled") return; // idempotent
    item.status = "settled";
    item.updatedAt = Date.now();
  }

  async settleUnclaimed(
    sessionId: string,
    threadId: string,
    itemId: string,
    outcome: SubmissionOutcome,
    opts?: { mergedIntoItemId?: string },
  ): Promise<boolean> {
    const r = this.row(sessionId);
    const item = r.queueItems.get(itemId);
    if (!item || item.threadId !== threadId) return false;
    if (item.status !== "collecting" && item.status !== "queued") return false;
    item.status = "settled";
    item.outcome = outcome;
    if (outcome.outcome === "merged" && opts?.mergedIntoItemId) {
      item.mergedIntoItemId = opts.mergedIntoItemId;
    }
    item.updatedAt = Date.now();
    return true;
  }

  async releaseSubmission(
    sessionId: string,
    threadId: string,
    itemId: string,
    fence: WriteFence,
    credential?: { attempts: number; lastReleaseAt: number },
  ): Promise<boolean> {
    const r = this.row(sessionId);
    const item = r.queueItems.get(itemId);
    if (!item || item.threadId !== threadId) return false;
    // CAS: only the owning attempt may release, only from `running`, only
    // when NOT superseded (a superseded item re-queued would be an orphan —
    // skipped by the claim head) and NOT abort-stamped (an abort landed
    // mid-window must settle `aborted` under the current attempt, never
    // flicker running→queued→aborted) — otherwise refuse and report the miss.
    if (item.status !== "running" || item.attemptId !== fence.attemptId) return false;
    if (item.supersededByItemId) return false;
    if (item.abortRequestedAt !== undefined) return false;
    item.status = "queued";
    item.attemptId = undefined;
    item.ownerId = undefined;
    item.leaseExpiresAt = undefined;
    // A released claim never consumed run budget: hand the claim's
    // attempt_count increment back (floor 0), matching the PG CAS.
    item.attemptCount = Math.max(0, item.attemptCount - 1);
    if (credential) {
      // Durable credential budget: written only when the CAS matched.
      item.credentialAttempts = credential.attempts;
      item.lastCredentialReleaseAt = credential.lastReleaseAt;
    }
    item.updatedAt = Date.now();
    this.attemptMarkers.delete(`${itemId}:${fence.attemptId}`);
    return true;
  }

  async setSubmissionBlocked(
    sessionId: string,
    threadId: string,
    itemId: string,
    blocked: boolean,
    fence: WriteFence,
  ): Promise<void> {
    const item = this.fencedItem(sessionId, threadId, itemId, fence);
    // Strict transition precondition: only running↔blocked_on_decision_gate.
    // A settled/terminalizing item carrying its old attemptId must never be
    // resurrected into a live status by a late blocked-toggle.
    const expected: QueueItem["status"] = blocked ? "running" : "blocked_on_decision_gate";
    if (item.status !== expected) {
      throw new ConflictError(
        `cannot set blocked=${blocked} on queue item ${itemId} in status '${item.status}' (requires '${expected}')`,
        { itemId, status: item.status, blocked },
      );
    }
    item.status = blocked ? "blocked_on_decision_gate" : "running";
    item.updatedAt = Date.now();
  }
}
