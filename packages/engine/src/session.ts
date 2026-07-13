import { Thread, resolveModelId as resolveSessionModel } from "./thread.js";
import { builtinTools } from "./builtin-tools/index.js";
import { decideReconciliation, type ReconcileContext } from "./submission.js";
import type { SandboxAttachment, AttachmentStatus } from "./sandbox/attachment.js";
import { StaleAttemptError } from "./errors.js";
import type {
  BusEvent,
  CreateSessionOptions,
  CredentialOwner,
  CredentialProvider,
  DecisionGate,
  DecisionResolution,
  DecisionWithdrawReason,
  EngineEvent,
  MessageQuery,
  Principal,
  PromptContent,
  PromptOptions,
  PromptReceipt,
  ProviderBundle,
  QueueItem,
  QueueMode,
  RoleSpec,
  Sandbox,
  SessionData,
  SessionEntry,
  SkillSource,
  ThreadData,
  ToolDef,
  WriteFence,
} from "./types.js";

let nextId = 1;
function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(nextId++).toString(36)}`;
}

/** Options for {@link Session.emit}. */
export interface EmitOptions {
  /**
   * Idempotency key for the durable append; defaults to `uid("ev")`.
   * Re-runnable paths (settlement, gate lifecycle) pass a deterministic key so
   * a double-emission across restart/reconcile paths dedupes to a single row.
   */
  eventKey?: string;
  /**
   * Submission linkage for retention. Threads pass their running/settling item
   * id so retention can truncate a session's log per submission.
   */
  queueItemId?: string;
  /**
   * Decision 12: attempt fence for live-execution events emitted inside a
   * claimed turn. When present, a superseded/zombie attempt's append is
   * rejected with StaleAttemptError — which `emit` rethrows (unlike every
   * other append failure) so the caller's in-flight turn stops. Fence-less
   * emits (the default — settlement, gate lifecycle, queue_state, and
   * anything outside a claimed attempt) NEVER reject on append failure.
   */
  fence?: WriteFence;
}

export class Session {
  readonly id: string;
  readonly providers: ProviderBundle;
  readonly options: CreateSessionOptions;
  readonly sandbox: Sandbox;
  readonly attachment: SandboxAttachment;
  readonly builtinTools: ToolDef[] = builtinTools;
  /**
   * Opaque per-instance owner id for lease ownership. Claims taken by this
   * running Session carry it; `renewLeases` extends only leases we still own,
   * and a replaced attempt (reconciliation, Task 5) changes the owner so our
   * heartbeat stops touching it.
   */
  readonly ownerId = uid("owner");
  /**
   * Who this session belongs to (Phase 4 decision 8). Defaults from
   * `options.owner`, falling back to `{ type: 'user', id: options.userId }`.
   * Mutable (not derived fresh from `options` on every read) so
   * `rehydrate` can restore a persisted owner the host's restore-time
   * options didn't re-supply, without that persisted value being stomped
   * back to the default on the session's next `toData()`/save.
   */
  private principal: Principal;
  /**
   * Parent session id (Phase 4 decision 11/16), mirrored from
   * `options.parentSessionId`. Mutable for the same reason `principal` is:
   * `rehydrate` restores it from persisted `SessionData` when the host's
   * restore-time options don't re-supply it (hosts route ordinary restores
   * through generic `{ userId, orgId, workspace }` options — see
   * `EngineHost.sessionFor` — so a child session's linkage would otherwise
   * be lost on the very first restart). This is what makes the app-layer
   * signal edge ACL (`packages/api/src/orchestrator/signals.ts`) able to
   * trust `SessionStore.getSession(id).parentSessionId` as durable truth.
   */
  private parentSessionId: string | undefined;
  /**
   * Parent thread id (Phase 4 decision 11/16), mirrored from
   * `options.parentThreadId`. Mutable for the same reason `parentSessionId`
   * is: `rehydrate` restores it from persisted `SessionData` when the
   * host's restore-time options don't re-supply it, so a child session's
   * thread linkage isn't stomped back to undefined on the next
   * `toData()`/save after a generic restore.
   */
  private parentThreadId: string | undefined;
  /** Indexed copies of options.roles / options.skills for fast lookup. */
  readonly roles = new Map<string, RoleSpec>();
  readonly skills = new Map<string, SkillSource>();
  private threads = new Map<string, Thread>();
  private threadsByKey = new Map<string, Thread>();
  private destroyed = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    id: string,
    options: CreateSessionOptions,
    providers: ProviderBundle,
    sandbox: Sandbox,
    attachment: SandboxAttachment,
  ) {
    this.id = id;
    this.options = options;
    this.providers = providers;
    this.sandbox = sandbox;
    this.attachment = attachment;
    this.principal = options.owner ?? { type: "user", id: options.userId };
    this.parentSessionId = options.parentSessionId;
    this.parentThreadId = options.parentThreadId;
    for (const role of options.roles ?? []) this.roles.set(role.name, role);
    for (const skill of options.skills ?? []) this.skills.set(skill.name, skill);
    // sandbox_status emissions (spec decision 8): deterministic eventKey so
    // re-provision loops / re-emits dedupe to a single durable row per
    // epoch+state. Emit failures must never throw into the attachment —
    // Session.emit already log-and-continues, and onStatus listeners are
    // isolated by the attachment itself.
    this.attachment.onStatus((status: AttachmentStatus) => {
      // "detached" is never actually emitted by SandboxAttachment (its
      // status callbacks only fire from doProvision/destroy), but the type
      // includes it — narrow it away so the assignment to EngineEvent's
      // (slightly different) state union type-checks.
      if (status.state === "detached") return;
      void this.emit(
        {
          type: "sandbox_status",
          sandboxId: status.sandboxId,
          state: status.state,
          epoch: status.epoch,
          estimateMs: status.estimateMs,
        },
        { eventKey: `sandbox:${status.epoch}:${status.state}` },
      );
    });
  }

  // ── durable-execution timers ────────────────────────────────────

  /**
   * Lazily start the heartbeat (10s lease renewal) and sweep (5s claim retry)
   * intervals. Called by a thread on its first successful claim so idle
   * sessions carry no timers. Both intervals are `unref()`d so they never keep
   * the process alive, and are cleared in `destroy()`.
   */
  ensureTimers(): void {
    if (this.destroyed) return;
    if (this.heartbeatTimer === null) {
      this.heartbeatTimer = setInterval(() => {
        // A transient store error inside the tick must not become an
        // unhandled rejection that kills the process — log and let the next
        // interval retry. Same idiom as the emit-append failure path.
        this.heartbeatOnce().catch((err) => {
          console.error(
            `[engine] heartbeat failed (session=${this.id}):`,
            err instanceof Error ? err.message : String(err),
          );
        });
      }, 10_000);
      this.heartbeatTimer.unref?.();
    }
    if (this.sweepTimer === null) {
      this.sweepTimer = setInterval(() => {
        // sweepOnce grew store reads + fenced gate writes (sweepExpiredGates);
        // a SQLITE_BUSY on a 5s tick must not crash the process. Swallow +
        // log so the next sweep still runs.
        this.sweepOnce().catch((err) => {
          console.error(
            `[engine] sweep failed (session=${this.id}):`,
            err instanceof Error ? err.message : String(err),
          );
        });
      }, 5_000);
      this.sweepTimer.unref?.();
    }
  }

  /** Renew leases for every submission this instance is currently running. */
  async heartbeatOnce(): Promise<void> {
    const ids = this.runningItemIds();
    if (ids.length === 0) return;
    await this.providers.store.renewLeases(this.ownerId, ids);
  }

  /**
   * One sweep pass: flush any collect window whose deadline has already
   * passed (safety net for a missed/never-armed in-process timer), then
   * re-kick every thread so missed wakeups can't strand queued work.
   */
  async sweepOnce(): Promise<void> {
    // Reclaim expired leases: any running/blocked item of this session whose
    // lease has lapsed is reconciled through the tree (Task 5 lease-expiry
    // reclaim). QueueItem carries no sessionId, so we scan this session's own
    // unsettled items and filter on the lease rather than the global
    // listExpiredSubmissions scan — equivalent for one session, and avoids
    // touching other sessions' work.
    const now = Date.now();
    const mine = await this.providers.store.listUnsettledSubmissions(this.id);
    for (const item of mine) {
      const claimed = item.status === "running" || item.status === "blocked_on_decision_gate";
      const leaseExpired = item.leaseExpiresAt !== undefined && item.leaseExpiresAt < now;
      if (claimed && leaseExpired) {
        await this.reconcileItem(item);
      }
    }
    for (const t of this.threads.values()) {
      // Durable expiry backstop for pending decision gates whose in-process
      // timer was lost (e.g. across restart). Runs before the kick so an
      // expired gate terminalizes and unblocks the thread's queued work.
      await t.sweepExpiredGates();
      await t.checkCollectDeadline();
      await t.kick();
    }
  }

  private runningItemIds(): string[] {
    const ids: string[] = [];
    for (const t of this.threads.values()) {
      const id = t.runningItemId();
      if (id) ids.push(id);
    }
    return ids;
  }

  /**
   * Rebuild a Session from persisted state. Called by Engine.restoreSession.
   * The caller re-supplies tools/sandbox/model in options.
   */
  static async rehydrate(
    data: SessionData,
    options: CreateSessionOptions,
    providers: ProviderBundle,
    sandbox: Sandbox,
    attachment: SandboxAttachment,
  ): Promise<Session> {
    const session = new Session(data.id, options, providers, sandbox, attachment);
    // The host's restore-time options usually don't re-supply `owner` (it's
    // not something callers round-trip through CreateSessionOptions on
    // every restart) — preserve the persisted value in that case rather
    // than falling back to the user-owned default computed in the
    // constructor. An explicit options.owner (host re-asserting ownership)
    // still wins.
    if (options.owner === undefined) session.principal = data.owner;
    if (options.parentSessionId === undefined) session.parentSessionId = data.parentSessionId;
    if (options.parentThreadId === undefined) session.parentThreadId = data.parentThreadId;
    const threadDatas = await providers.store.listThreads(data.id);
    for (const td of threadDatas) {
      const thread = new Thread(session, td);
      session.attachThread(thread);
      const entries = await providers.store.getEntries(data.id, td.id);
      thread.rehydrateTranscript(entries);
    }
    // Startup reconciliation (Task 5): every unsettled submission passes through
    // the normative decision tree. Awaited so callers can rely on gate re-arming
    // (and settlement of finished/aborted/superseded/exhausted work) having been
    // applied before they resolve gates or read queue state. The actual
    // gate-replay / resume drive kicked off here is still asynchronous.
    await session.reconcile();
    return session;
  }

  /**
   * Reconcile every unsettled submission of this session through the normative
   * decision tree (spec §Reconciliation). Called on rehydrate and, for
   * expired-lease items, from the sweep. Idempotent — re-running is safe.
   */
  async reconcile(): Promise<void> {
    const items = await this.providers.store.listUnsettledSubmissions(this.id);
    for (const item of items) {
      // startup: this instance is the definitive new owner (restoreSession's
      // single-owner contract), so an unexpired prior lease is not evidence of a
      // live attempt — reclaim eagerly. Fencing (fresh attemptId) makes a slow
      // zombie's late writes fail, so eager takeover stays safe.
      await this.reconcileItem(item, { startup: true });
    }
  }

  /**
   * Gather the ReconcileContext from the store, consult the pure decision
   * function, and apply the resulting action via the owning Thread. Also
   * observes the stuck-head condition for the attention signal.
   */
  private async reconcileItem(item: QueueItem, opts?: { startup?: boolean }): Promise<void> {
    if (item.status === "settled") return;
    const thread = this.threads.get(item.threadId);
    if (!thread) return; // thread not hydrated — nothing to drive it with

    const store = this.providers.store;

    // A live in-process turn owns this item (we're actively running it): never
    // yank it out from under ourselves via reconciliation.
    if (thread.runningItemId() === item.id) return;

    // Terminalizing: the outcome is already durably reserved — re-run the
    // finalize half on the item's stored current attempt (never a fresh one).
    if (item.status === "terminalizing") {
      await thread.retryFinalize(item);
      return;
    }

    const now = Date.now();
    const entries = await store.getEntries(this.id, item.threadId);
    const hasTerminalAssistantEntry = entries.some(
      (e) =>
        e.type === "message" &&
        e.role === "assistant" &&
        e.queueItemId === item.id &&
        e.stopReason === "end_turn",
    );
    const markerLive = item.attemptId
      ? await store.hasAttemptMarker(item.id, item.attemptId)
      : false;
    // On startup the prior owner is gone by contract, so its lease never counts
    // as "live". On the sweep only already-expired-lease items reach here, so
    // this is false there too — the guard's live-attempt branch is exercised by
    // the pure tests, defensive here.
    const leaseUnexpired =
      !opts?.startup && item.leaseExpiresAt !== undefined && item.leaseExpiresAt > now;
    const suspended = await store.getSuspendedTurn(this.id, item.threadId);
    let gateStatus: ReconcileContext["gateStatus"] = null;
    if (suspended) {
      const gate = await store.getDecisionGate(this.id, suspended.gateId);
      gateStatus = gate?.status ?? null;
    }
    const ctx: ReconcileContext = {
      now,
      hasTerminalAssistantEntry,
      attemptLive: markerLive && leaseUnexpired,
      suspended,
      gateStatus,
    };

    const action = decideReconciliation(item, ctx);
    // Stuck-head observation only for items reconciliation actually acts on —
    // a `wait` item is owned by a live attempt or a collect window, not a
    // wedged head.
    if (action.kind !== "wait") {
      this.maybeEmitStuck(item, now);
    }
    switch (action.kind) {
      case "wait":
        return;
      case "settle":
        await thread.settleReconciled(item, action.outcome, suspended);
        return;
      case "rearm_gate":
        if (suspended) await thread.reconcileGate(item, suspended, "rearm");
        return;
      case "replay_gate":
        if (suspended) await thread.reconcileGate(item, suspended, "replay");
        return;
      case "resume":
        await thread.resumeInterrupted(item);
        return;
    }
  }

  /**
   * Emit the stuck-head attention event (spec §Reconciliation) when an unsettled
   * submission crosses the retry threshold or wall-clock bound. Gate-blocked
   * items are excluded (their bound is the gate's own expiry). Once per
   * observation pass — no dedup in Phase 1.
   */
  private maybeEmitStuck(item: QueueItem, now: number): void {
    if (item.status === "blocked_on_decision_gate") return;
    const ageMs = now - item.createdAt;
    const stuck = item.attemptCount >= 3 || ageMs > 15 * 60_000;
    if (!stuck) return;
    void this.emit({
      type: "submission_stuck",
      sessionId: this.id,
      threadId: item.threadId,
      queueItemId: item.id,
      attemptCount: item.attemptCount,
      ageMs,
    });
  }

  private attachThread(thread: Thread): void {
    this.threads.set(thread.id, thread);
    this.threadsByKey.set(thread.key, thread);
  }

  async ensureDefaultThread(): Promise<Thread> {
    return this.thread("web:default");
  }

  thread(key?: string): Thread {
    const k = key ?? "web:default";
    const existing = this.threadsByKey.get(k);
    if (existing) return existing;
    const data: ThreadData = {
      id: uid("th"),
      sessionId: this.id,
      key: k,
      status: "active",
      queueMode: this.options.queueMode ?? "followup",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const thread = new Thread(this, data);
    this.threads.set(thread.id, thread);
    this.threadsByKey.set(k, thread);
    void this.providers.store.saveThread(this.id, data);
    return thread;
  }

  threadById(id: string): Thread | null {
    return this.threads.get(id) ?? null;
  }

  async threadByKey(key: string): Promise<Thread | null> {
    return this.threadsByKey.get(key) ?? null;
  }

  listThreads(): Thread[] {
    return [...this.threads.values()];
  }

  // ── public API ──────────────────────────────────────────────────

  async prompt(content: PromptContent, opts: PromptOptions = {}): Promise<PromptReceipt> {
    return this.thread().submitPrompt(content, opts);
  }

  async resolveDecision(gateId: string, resolution: DecisionResolution): Promise<void> {
    for (const t of this.threads.values()) {
      if (t.isPendingGate(gateId)) {
        t.resolveDecision(gateId, resolution);
        return;
      }
    }
    // Fallback: gate may have already been resolved or never registered.
  }

  async withdrawDecision(gateId: string, reason: DecisionWithdrawReason): Promise<void> {
    for (const t of this.threads.values()) {
      if (t.isPendingGate(gateId)) {
        t.withdrawDecision(gateId, reason);
        return;
      }
    }
  }

  async abort(opts: { threadId?: string } = {}): Promise<void> {
    if (opts.threadId) {
      await this.threads.get(opts.threadId)?.abort();
      return;
    }
    await Promise.all([...this.threads.values()].map((t) => t.abort()));
  }

  async pause(opts: { threadId?: string } = {}): Promise<void> {
    if (opts.threadId) {
      await this.threads.get(opts.threadId)?.pause();
      return;
    }
    await Promise.all([...this.threads.values()].map((t) => t.pause()));
  }

  async resume(opts: { threadId?: string } = {}): Promise<void> {
    if (opts.threadId) {
      await this.threads.get(opts.threadId)?.resume();
      return;
    }
    await Promise.all([...this.threads.values()].map((t) => t.resume()));
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    await Promise.all([...this.threads.values()].map((t) => t.abort()));
    await this.attachment.destroy();
    await this.providers.store.deleteSession(this.id);
  }

  async pendingDecisionGates(): Promise<DecisionGate[]> {
    return this.providers.store.listDecisionGates(this.id);
  }

  async readEntries(threadKey: string, opts?: MessageQuery): Promise<SessionEntry[]> {
    const t = await this.threadByKey(threadKey);
    if (!t) return [];
    return t.readEntries(opts);
  }

  /** Owning principal (Phase 4 decision 8). See `principal` field doc. */
  get owner(): Principal {
    return this.principal;
  }

  async toData(): Promise<SessionData> {
    return {
      id: this.id,
      owner: this.principal,
      userId: this.options.userId,
      orgId: this.options.orgId,
      workspace: this.options.workspace,
      purpose: this.options.purpose ?? "interactive",
      status: "running",
      sandboxId: this.attachment.sandboxId,
      parentSessionId: this.parentSessionId,
      parentThreadId: this.parentThreadId,
      model: this.options.model.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * Set this session's default model. Threads without their own override
   * pick this up on their next turn. Persists via `store.saveSession` and
   * emits `model_switched` (threadId omitted to indicate session scope).
   *
   * Pass a model id like "claude-opus-4-7" or "anthropic/claude-haiku-4-5".
   * Throws if the id can't be resolved.
   */
  async setModel(
    modelId: string,
    reason: string = "set_via_api",
  ): Promise<{ fromModel: string; toModel: string }> {
    const before = this.options.model.id;
    const next = resolveSessionModel(modelId);
    if (!next) throw new Error(`unknown model id: ${modelId}`);
    this.options.model = next;
    await this.providers.store.saveSession(await this.toData());
    if (before !== next.id) {
      await this.emit({
        type: "model_switched",
        // session scope — no threadId. Bridge / wire types treat the
        // missing threadId as "session-level switch".
        threadId: undefined,
        fromModel: before,
        toModel: next.id,
        reason,
      });
    }
    return { fromModel: before, toModel: next.id };
  }

  async emit(event: EngineEvent, opts?: EmitOptions): Promise<void> {
    const busEvent: BusEvent = {
      sessionId: this.id,
      threadId: "threadId" in event ? (event.threadId as string | undefined) : undefined,
      queueItemId: opts?.queueItemId,
      userId: this.options.userId,
      event,
      timestamp: Date.now(),
    };
    // text_delta is the high-frequency streaming plane — never durable.
    if (event.type === "text_delta") {
      this.providers.stream.publishEphemeral(busEvent);
      return;
    }
    // Events are the wakeup/UX plane; the store is truth. A durable append
    // failure on a non-critical path must not kill the turn — log and continue.
    // EXCEPTION (decision 12): a fenced append that rejects with
    // StaleAttemptError means a superseded/zombie attempt tried to land a
    // live-execution event — that's the attempt's stop signal, so it
    // rethrows. Every other failure (including a fenced append that fails
    // for some other reason) stays log-and-continue; a fence-less emit never
    // rejects.
    try {
      await this.providers.stream.append(busEvent, opts?.eventKey ?? uid("ev"), opts?.fence);
    } catch (err) {
      if (err instanceof StaleAttemptError) throw err;
      console.error(
        `[engine] event append failed (session=${this.id}, type=${event.type}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ── credential provider for tools ───────────────────────────────

  credentialProvider(): CredentialProvider {
    const owner: CredentialOwner = { type: "user", id: this.options.userId };
    const credStore = this.providers.credentials;
    const session = this;
    return {
      async get(service?: string) {
        if (!credStore) return null;
        if (!service) return null; // session-level provider has no default service
        const stored = await credStore.get(owner, service);
        if (!stored) return null;
        return {
          accessToken: stored.accessToken ?? stored.apiKey ?? "",
          refreshToken: stored.refreshToken,
          expiresAt: stored.expiresAt,
          scopes: stored.scopes,
          metadata: stored.metadata,
        };
      },
      async request(service: string, reason: string) {
        // V1 prototype: credential request is a decision gate too — but the
        // ToolContext.requestDecision in Thread is the canonical mechanism.
        // Here we only attempt to read; if missing, we throw.
        if (!credStore) throw new Error(`credential ${service} not available (no store)`);
        const stored = await credStore.get(owner, service);
        if (!stored) throw new Error(`credential ${service} not connected: ${reason}`);
        return {
          accessToken: stored.accessToken ?? stored.apiKey ?? "",
          refreshToken: stored.refreshToken,
          expiresAt: stored.expiresAt,
          scopes: stored.scopes,
          metadata: stored.metadata,
        };
      },
    };
  }
}
