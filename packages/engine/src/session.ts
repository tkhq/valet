import { Thread, resolveModelId as resolveSessionModel } from "./thread.js";
import { builtinTools } from "./builtin-tools/index.js";
import { decideReconciliation, type ReconcileContext } from "./submission.js";
import { buildCommandRegistry, type CommandRegistry } from "./commands/registry.js";
import { dispatchCommand } from "./commands/dispatch.js";
import { parseCommandArgs } from "./commands/args.js";
import { executeBuiltin } from "./commands/builtins.js";
import { invokeAction, type InvokeActionResult } from "./plugin-catalog.js";
import { GateManager, fromRequest, isDecisionGateExpired } from "./decision-gate.js";
import type {
  CommandDef,
  CommandSource,
  ResolvedCommand,
} from "./commands/types.js";
import type { SandboxAttachment, AttachmentStatus } from "./sandbox/attachment.js";
import type { PolicySandbox } from "./sandbox/policy.js";
import { NoCredentialsError, StaleAttemptError, ValidationError } from "./errors.js";
import { detachedFromTrace, withSpan } from "./tracing.js";
import { recordCredentialRead } from "./metrics.js";
import type { Model } from "@mariozechner/pi-ai";
import type {
  BusEvent,
  CommandResultEntry,
  MessageEntry,
  CreateSessionOptions,
  CredentialOwner,
  CredentialProvider,
  DecisionGate,
  DecisionGateRequest,
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
  SessionStartRef,
  SkillSource,
  StoredCredential,
  ThreadData,
  ToolContext,
  ToolDef,
  WriteFence,
} from "./types.js";

let nextId = 1;
function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(nextId++).toString(36)}`;
}

/**
 * Extract the plain leading text of a prompt for slash-command detection.
 * String content is itself; object content uses its `text`; a `SignalContent`
 * (kind: "signal") never carries a slash command, so it returns undefined.
 */
function commandText(content: PromptContent): string | undefined {
  if (typeof content === "string") return content;
  if ("kind" in content) return undefined;
  return content.text;
}

/**
 * Replace the leading text of a prompt with `text`, preserving attachments.
 * Only reached for string/object content (a signal never expands).
 */
function withText(content: PromptContent, text: string): PromptContent {
  if (typeof content === "string") return text;
  if ("kind" in content) return content;
  return { ...content, text };
}

/**
 * Render an {@link InvokeActionResult} into the `{ ok, output }` shape a
 * `command_result` entry carries. Error variants name the corrective action,
 * per the repo's user-facing-error rule.
 */
function formatPluginOutcome(
  outcome: InvokeActionResult,
  actionId: string,
): { ok: boolean; output: string } {
  switch (outcome.kind) {
    case "ok": {
      const { result } = outcome;
      if (!result.success) {
        return { ok: false, output: `Action failed. ${result.error ?? "Unknown error."}` };
      }
      if (result.data === undefined) return { ok: true, output: "Done." };
      const body =
        typeof result.data === "string" ? result.data : "```json\n" + stableJson(result.data) + "\n```";
      return { ok: true, output: body };
    }
    case "unknown":
      return {
        ok: false,
        output: `Unknown action "${actionId}". The plugin command points at an action that is not loaded.`,
      };
    case "resolve-failed":
      return {
        ok: false,
        output: `Could not load ${outcome.service} actions. ${outcome.message}`,
      };
    case "denied-policy":
      return {
        ok: false,
        output: "This action is blocked by org policy. Ask an administrator to allow it.",
      };
    case "denied-approval":
      return {
        ok: false,
        output: "Approval was denied. Adjust action policies in Settings to allow this action.",
      };
    case "pending-approval":
      return {
        ok: false,
        output: "Approval is pending. Resolve it from the approvals panel.",
      };
    case "invalid-args":
      return { ok: false, output: `Invalid arguments. ${outcome.error}` };
    case "missing-credential":
      return {
        ok: false,
        output: `Connect the ${outcome.service} integration in Settings.`,
      };
    case "error":
      return { ok: false, output: `Action failed. ${outcome.message}` };
  }
}

/** Stable JSON stringify used for plugin-result rendering. */
function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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
  /** Lazily-built slash-command registry; invalidated by refreshCommandRegistry(). */
  private commandRegistryCache: CommandRegistry | null = null;
  /**
   * Gates opened by approval-requiring plugin commands. Session-level, not
   * thread-level: a command is not a claimed turn, so its gate never
   * suspends a turn. Resolved through the same `resolveDecision` surface
   * the turn gates use. Pending command gates do not survive a process
   * restart — the durable gate row stays pending, and the user re-runs the
   * command.
   */
  private commandGates = new GateManager();
  /** Cached workspace skills from options.workspaceSkillsProvider; null === not
   * yet loaded. */
  private workspaceSkillsCache: SkillSource[] | null = null;
  private destroyed = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * The `PolicySandbox` wrapper when the session's sandbox was constructed via
   * the engine's normal materialization path. `null` when the session was
   * created with a pre-provisioned concrete `Sandbox` (e.g. in tests that pass
   * a bare VirtualSandbox). Used by the run-start reconcile window (spec
   * decision 4) to query pending exec-job count.
   */
  private readonly policySandbox: PolicySandbox | null;

  constructor(
    id: string,
    options: CreateSessionOptions,
    providers: ProviderBundle,
    sandbox: Sandbox,
    attachment: SandboxAttachment,
    policySandbox?: PolicySandbox,
  ) {
    this.id = id;
    this.options = options;
    this.providers = providers;
    this.sandbox = sandbox;
    this.attachment = attachment;
    this.policySandbox = policySandbox ?? null;
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
      // Wake-tag the eventKey so a suspend/resume cycle's re-emitted
      // `provisioning`/`ready` (SAME epoch — a clean wake is not a re-provision)
      // don't collide with the cold-boot status events and get dropped by
      // append's key-dedup (leaving the stale `suspended` as the last durable
      // status on a live sandbox). wake 0 stays byte-identical to the original
      // key for never-suspended sandboxes.
      const wake = status.wake ?? 0;
      const eventKey =
        wake > 0
          ? `sandbox:${status.epoch}:w${wake}:${status.state}`
          : `sandbox:${status.epoch}:${status.state}`;
      void this.emit(
        {
          type: "sandbox_status",
          sandboxId: status.sandboxId,
          state: status.state,
          epoch: status.epoch,
          estimateMs: status.estimateMs,
        },
        { eventKey },
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
        // detachedFromTrace: interval callbacks inherit whatever trace
        // context was active when ensureTimers armed them (a request or
        // turn) — every tick would otherwise attach spans to that long-dead
        // trace forever.
        detachedFromTrace(() =>
          this.heartbeatOnce().catch((err) => {
            console.error(
              `[engine] heartbeat failed (session=${this.id}):`,
              err instanceof Error ? err.message : String(err),
            );
          }),
        );
      }, 10_000);
      this.heartbeatTimer.unref?.();
    }
    if (this.sweepTimer === null) {
      this.sweepTimer = setInterval(() => {
        // sweepOnce grew store reads + fenced gate writes (sweepExpiredGates);
        // a SQLITE_BUSY on a 5s tick must not crash the process. Swallow +
        // log so the next sweep still runs. detachedFromTrace: same
        // stale-context reasoning as the heartbeat above.
        detachedFromTrace(() =>
          this.sweepOnce().catch((err) => {
            console.error(
              `[engine] sweep failed (session=${this.id}):`,
              err instanceof Error ? err.message : String(err),
            );
          }),
        );
      }, 5_000);
      this.sweepTimer.unref?.();
    }
  }

  /**
   * Clear the heartbeat and sweep intervals without tearing anything else
   * down — for host-side cache eviction only. A host that keeps a `Session`
   * instance in an in-process cache and later evicts it (e.g. to force a
   * rebuild on the next `sessionFor` after an identity/config change) must
   * not leave this instance's timers running: `ensureTimers` unref()s them,
   * but unref() only stops them from keeping the *process* alive — it does
   * nothing to stop them from keeping *this object* alive (each closure
   * captures `this`) or from continuing to hit the store every 5-10s.
   * Mirrors exactly what `destroy()` does to the two timer fields, without
   * `destroy()`'s store deletion or thread aborts — this instance's
   * transcript and store rows must survive.
   *
   * The object must not be reused after this without a fresh claim: no
   * caller should hold a reference across an eviction. If one somehow does,
   * `ensureTimers` will restart the timers lazily on the next claim (it
   * checks `this.destroyed`, which `suspendTimers` does not set), so this
   * is not a poison-pill — just an idle instance.
   */
  suspendTimers(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
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
    policySandbox?: PolicySandbox,
  ): Promise<Session> {
    const session = new Session(data.id, options, providers, sandbox, attachment, policySandbox);
    // The host's restore-time options usually don't re-supply `owner` (it's
    // not something callers round-trip through CreateSessionOptions on
    // every restart) — preserve the persisted value in that case rather
    // than falling back to the user-owned default computed in the
    // constructor. An explicit options.owner (host re-asserting ownership)
    // still wins.
    if (options.owner === undefined) session.principal = data.owner;
    if (options.parentSessionId === undefined) session.parentSessionId = data.parentSessionId;
    if (options.parentThreadId === undefined) session.parentThreadId = data.parentThreadId;
    // Preserve the persisted start-ref across generic restores (hosts don't
    // round-trip it through options) so the next `toData()` save can't stomp
    // it back to undefined — and so `setStartRef`'s single-shot guard sees it.
    if (options.startRef === undefined) options.startRef = data.startRef;
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
   * decision tree (spec §Reconciliation). Called only from `restoreSession`
   * (the sweep goes through `reconcileItem` directly, never this method), so
   * the end-of-reconcile kick below runs once per rehydrate. Idempotent —
   * re-running is safe.
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
    // Durable wakeup for still-queued heads. A `queued` item carries no
    // attempt id (admission never sets one; a credential release explicitly
    // clears it), so the decision tree's `resume` action short-circuits in
    // `resumeInterrupted` — and right after a restart no sweep timer is armed
    // yet (`ensureTimers` runs on the first claim). Without this kick a
    // released credential-less item — or any queued-at-crash item — would sit
    // queued forever until an unrelated external prompt. Fire-and-forget: the
    // drive is asynchronous (same contract as submitPrompt's kick); the kick
    // itself arms the timers on claim, so the 5s sweep takes over as the
    // retry backoff.
    const remaining = await this.providers.store.listUnsettledSubmissions(this.id);
    const queuedThreadIds = new Set(
      remaining
        .filter((i) => i.status === "queued" && !i.supersededByItemId)
        .map((i) => i.threadId),
    );
    for (const t of this.threads.values()) {
      if (queuedThreadIds.has(t.id)) void t.kick();
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
      case "resume": {
        // A running item whose attempt never reached the model — NO assistant
        // entry carries its queueItemId (a crashed pre-stream attempt has at
        // most a user entry, e.g. a store throw inside the credential-release
        // path or a settle throw after the cap append) — must not be resumed:
        // `resumeInterrupted` continues the transcript, which is the PREVIOUS
        // turn's, and the prompt would never actually run. Re-queue it for a
        // fresh from-scratch run instead (fenced release, no credential
        // counters — this is not a credential cycle; the idempotent
        // user-entry append means no duplicates); the post-reconcile kick
        // (startup) / sweep kick picks it up. A genuine mid-stream crash HAS
        // assistant entries and still resumes; gate-suspended items are
        // excluded by the `running` status check.
        const hasAssistantEntry = entries.some(
          (e) => e.type === "message" && e.role === "assistant" && e.queueItemId === item.id,
        );
        if (item.status === "running" && item.attemptId !== undefined && !hasAssistantEntry) {
          const released = await store.releaseSubmission(this.id, item.threadId, item.id, {
            itemId: item.id,
            attemptId: item.attemptId,
          });
          if (released) return;
          // CAS refused (superseded / successor) — fall through to resume,
          // whose own fencing resolves ownership safely.
        }
        await thread.resumeInterrupted(item);
        return;
      }
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

  /**
   * Returns true when any thread OTHER than `excludeThreadId` currently has
   * an active run (i.e. is mid-turn). Used by the run-start reconcile window
   * (spec decision 4) to determine whether the session is idle enough for
   * sandbox convergence.
   */
  hasOtherActiveRuns(excludeThreadId: string): boolean {
    for (const t of this.threads.values()) {
      if (t.id !== excludeThreadId && t.hasActiveRun) return true;
    }
    return false;
  }

  /**
   * Number of exec jobs that have been vended to the PolicySandbox but have
   * not yet reached a terminal poll status. Returns 0 when the session was
   * constructed without a PolicySandbox (bare-sandbox test harnesses).
   * Used by the run-start reconcile window (spec decision 4).
   */
  pendingJobCount(): number {
    return this.policySandbox?.pendingJobCount() ?? 0;
  }

  // ── public API ──────────────────────────────────────────────────

  async prompt(content: PromptContent, opts: PromptOptions = {}): Promise<PromptReceipt> {
    const thread = this.resolveTargetThread(opts.threadId);
    const text = commandText(content);
    if (text?.startsWith("/")) {
      const outcome = dispatchCommand(text, this.commandRegistry());
      if (outcome.kind === "expand") {
        return thread.submitPrompt(withText(content, outcome.text), opts);
      }
      if (outcome.kind === "execute") {
        return this.executeCommand(thread, outcome.resolved, outcome.args, text);
      }
      if (outcome.kind === "pass" && outcome.nearMiss !== undefined) {
        const receipt = await thread.submitPrompt(content, opts);
        return { ...receipt, nearMiss: outcome.nearMiss };
      }
    }
    return thread.submitPrompt(content, opts);
  }

  /** Resolve `PromptOptions.threadId` to a thread, or the session default. */
  private resolveTargetThread(threadId?: string): Thread {
    if (threadId === undefined) return this.thread();
    const thread = this.threadById(threadId);
    if (!thread) throw new Error(`prompt: thread ${threadId} not found in session ${this.id}`);
    return thread;
  }

  /**
   * Run a resolved built-in or plugin command against `thread`, persist a
   * `command_result` entry, emit `command_result`, and return a
   * command-shaped receipt. Never touches queue admission — a command runs
   * even while a turn streams.
   *
   * `PromptOptions` other than `threadId` (resolved by the caller) are
   * intentionally not forwarded: they shape queue submissions (author,
   * channel, queueMode, model, ...) and a command takes no queue item. If a
   * future option must reach the command path, add a parameter here so the
   * dependency is explicit.
   */
  private async executeCommand(
    thread: Thread,
    resolved: ResolvedCommand,
    args: string[],
    raw: string,
  ): Promise<PromptReceipt> {
    // Echo the typed command as a persisted user message BEFORE the result.
    // A command takes no queue item, so nothing else persists the user's
    // text — without this echo, clients reorder the result above the
    // command on refetch, and a reload loses the command entirely. Written
    // first (not raced with the plugin grace window) so the echo always
    // precedes its result.
    const echo: MessageEntry = {
      id: uid("e"),
      sessionId: this.id,
      threadId: thread.id,
      parentId: null,
      type: "message",
      role: "user",
      content: raw,
      createdAt: Date.now(),
    };
    await this.providers.store.appendEntries(this.id, thread.id, [echo]);
    let source: CommandSource;
    let name: string;
    let result: { ok: boolean; output: string };
    if (resolved.source === "builtin") {
      source = "builtin";
      name = resolved.name;
      result = await executeBuiltin(name, args, this, this.options.commandContext);
    } else if (resolved.source === "plugin") {
      source = "plugin";
      name = `${resolved.pluginName}:${resolved.def.name}`;
      // An approval-requiring command can wait minutes on its gate. Do not
      // hold the caller (an HTTP request) for that: give the action a short
      // grace window, then let it complete in the background — the
      // command_result entry lands via the same persist+emit path either way.
      const pending = this.executePluginCommand(thread, resolved.pluginName, resolved.def, raw);
      const grace = new Promise<null>((resolve) => {
        const t = setTimeout(() => resolve(null), 500) as { unref?: () => void };
        if (typeof t.unref === "function") t.unref();
      });
      const fast = await Promise.race([pending, grace]);
      if (fast === null) {
        const bgName = name;
        void pending
          .then((r) => this.persistCommandResult(thread, bgName, "plugin", r))
          .catch((err: unknown) =>
            this.persistCommandResult(thread, bgName, "plugin", {
              ok: false,
              output: err instanceof Error ? err.message : String(err),
            }),
          );
        return {
          sessionId: this.id,
          threadId: thread.id,
          queueItemId: "",
          status: "queued",
          command: { name, source },
        };
      }
      result = fast;
    } else {
      // dispatchCommand only yields execute for builtin/plugin sources.
      throw new Error(`executeCommand: unexpected source ${resolved.source}`);
    }

    await this.persistCommandResult(thread, name, source, result);

    return {
      sessionId: this.id,
      threadId: thread.id,
      queueItemId: "",
      status: "queued",
      command: { name, source },
    };
  }

  /** Persist a command_result entry and emit its live event. */
  private async persistCommandResult(
    thread: Thread,
    name: string,
    source: CommandSource,
    result: { ok: boolean; output: string },
  ): Promise<void> {
    const entry: CommandResultEntry = {
      id: uid("e"),
      sessionId: this.id,
      threadId: thread.id,
      parentId: null,
      type: "command_result",
      command: `/${name}`,
      source,
      ok: result.ok,
      output: result.output,
      createdAt: Date.now(),
    };
    await this.providers.store.appendEntries(this.id, thread.id, [entry]);
    await this.emit({ type: "command_result", threadId: thread.id, entry });
  }

  /**
   * Run an action-backed plugin command. Maps the raw arg string through the
   * command's `mapArgs`, then invokes the backing action against the shared
   * plugin catalog via `invokeAction` — the SAME approval + validation core
   * the LLM `call_tool` path uses. Renders the outcome as markdown for a
   * `command_result` entry. A command is not a claimed turn, so approvals
   * route through the host `commandRequestDecision` hook, not the turn gate.
   */
  private async executePluginCommand(
    thread: Thread,
    pluginName: string,
    def: CommandDef,
    raw: string,
  ): Promise<{ ok: boolean; output: string }> {
    const catalog = this.options.pluginCatalog;
    if (!catalog) {
      return {
        ok: false,
        output:
          "Plugin commands are not available in this deployment. No plugin catalog is configured.",
      };
    }
    const mapped = def.mapArgs(parseCommandArgs(raw), raw);
    const ctx = this.buildCommandToolContext(thread);
    const summary = `/${pluginName}:${def.name}${raw ? ` ${raw}` : ""}`;
    try {
      const outcome = await invokeAction(catalog, def.action, mapped, ctx, summary);
      return formatPluginOutcome(outcome, def.action);
    } catch (err) {
      if (isDecisionGateExpired(err)) {
        return {
          ok: false,
          output: "Approval expired before anyone resolved it. Send the command again to retry.",
        };
      }
      throw err;
    }
  }

  /**
   * Build a command-scoped {@link ToolContext} for a plugin command. Unlike
   * the Thread's turn-scoped context it never suspends a turn: `requestDecision`
   * delegates to the host `commandRequestDecision` hook (or denies when none is
   * set), and there is no fence/DAG bookkeeping. Credentials, sandbox, and
   * thread reads mirror the turn context so a plugin action behaves the same
   * whether reached from a slash command or from `call_tool`.
   */
  private buildCommandToolContext(thread: Thread): ToolContext {
    const requestDecision = this.options.commandRequestDecision;
    return {
      userId: this.options.userId,
      orgId: this.options.orgId,
      sessionId: this.id,
      threadId: thread.id,
      sessionPurpose: this.options.purpose,
      cwd: this.options.workspace,
      credentials: this.credentialProvider(),
      sandbox: this.sandbox,
      config: this.options.toolConfig,
      owner: this.principal,
      signal: new AbortController().signal,
      requestDecision: async (req: DecisionGateRequest): Promise<DecisionResolution> => {
        if (requestDecision) return requestDecision(req);
        // No host hook: open a real decision gate on the default thread.
        // The gate persists as a decision_gate entry and emits the same
        // events turn gates do, so the web approvals UI and channel
        // approve/deny buttons render it. Resolution arrives through
        // `resolveDecision`, same as every other gate.
        return this.awaitCommandGate(thread, req);
      },
      threadRead: (key, opts) => this.readEntries(key, opts),
      listThreads: async () => {
        const datas = await this.providers.store.listThreads(this.id);
        return datas.map((d) => ({
          id: d.id,
          key: d.key,
          status: d.status,
          model: d.model,
          summary: d.summary,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
        }));
      },
      setModel: (args) => thread.setModel(args.model),
    };
  }

  /**
   * Lazily-built slash-command registry for this session. Cached across calls
   * within a session; `refreshCommandRegistry()` invalidates it (the host
   * calls that after workspace prep and whenever skills change).
   */
  commandRegistry(): CommandRegistry {
    if (this.commandRegistryCache) return this.commandRegistryCache;
    const registry = buildCommandRegistry({
      skills: [...(this.workspaceSkillsCache ?? []), ...this.skills.values()],
      pluginCommands: this.options.pluginCommands ?? [],
      bareSkillNames: this.options.bareSkillNames ?? false,
    });
    this.commandRegistryCache = registry;
    return registry;
  }

  /**
   * Invalidate the cached command registry and refresh workspace skills from
   * the host `workspaceSkillsProvider` (if any). Call after workspace prep and
   * on any event that also refreshes `Session.skills`. Idempotent.
   */
  async refreshCommandRegistry(): Promise<void> {
    const provider = this.options.workspaceSkillsProvider;
    // Load first, invalidate after: when the provider throws, the previous
    // registry (and its skill list) keeps serving — a stale list beats an
    // empty one mid-session. The rejection still reaches the caller.
    this.workspaceSkillsCache = provider ? await provider() : [];
    this.commandRegistryCache = null;
  }

  /**
   * Settle every never-claimed (queued/collecting) item of a thread as
   * aborted and return how many were removed. Used by `/clear`.
   */
  async clearQueue(threadId: string): Promise<number> {
    const store = this.providers.store;
    const items = await store.listUnsettledSubmissions(this.id);
    let removed = 0;
    for (const it of items) {
      if (it.threadId !== threadId) continue;
      if (it.status === "queued" || it.status === "collecting") {
        const ok = await store.settleUnclaimed(this.id, threadId, it.id, {
          outcome: "aborted",
        });
        if (ok) removed++;
      }
    }
    return removed;
  }

  /**
   * Create and switch to a fresh thread. Returns the new thread. Used by
   * `/new-thread`; mints a unique key so it never re-adopts an existing one.
   */
  async newThread(): Promise<Thread> {
    const key = `web:${uid("t")}`;
    return this.thread(key);
  }

  async resolveDecision(gateId: string, resolution: DecisionResolution): Promise<void> {
    // Command gates first — they are session-level, not owned by any thread.
    if (this.commandGates.isPending(gateId)) {
      const existing = await this.providers.store.getDecisionGate(this.id, gateId);
      this.commandGates.resolve(gateId, resolution);
      if (existing) {
        const resolved: DecisionGate = { ...existing, status: "resolved", updatedAt: Date.now() };
        await this.providers.store.saveDecisionGate(this.id, existing.threadId, resolved);
        await this.providers.store.updateDecisionGateEntry(this.id, existing.threadId, gateId, {
          gate: resolved,
          resolution,
          resolvedAt: new Date(resolution.resolvedAt).toISOString(),
        });
        await this.emit(
          { type: "decision_gate_resolved", threadId: existing.threadId, gateId, resolution },
          { eventKey: `gate:${gateId}:resolved` },
        );
      }
      return;
    }
    for (const t of this.threads.values()) {
      if (t.isPendingGate(gateId)) {
        t.resolveDecision(gateId, resolution);
        return;
      }
    }
    // Fallback: gate may have already been resolved or never registered.
  }

  /**
   * Open a durable decision gate for an approval-requiring plugin command
   * and wait for its resolution. Rejects with DecisionGateExpiredError when
   * the gate's expiry lapses first.
   */
  private async awaitCommandGate(
    thread: Thread,
    req: DecisionGateRequest,
  ): Promise<DecisionResolution> {
    // queueItemId is a fresh nonce: command gates never join an earlier
    // gate the way retried tool calls do — every invocation asks again.
    const gate = fromRequest(req, {
      sessionId: this.id,
      threadId: thread.id,
      queueItemId: uid("cmd"),
      resumeKey: req.resumeKey ?? "command",
      ordinal: 0,
    });
    await this.providers.store.saveDecisionGate(this.id, thread.id, gate);
    const gateEntry: SessionEntry = {
      id: uid("e"),
      sessionId: this.id,
      threadId: thread.id,
      parentId: null,
      type: "decision_gate",
      gate,
      createdAt: Date.now(),
    };
    await this.providers.store.appendEntries(this.id, thread.id, [gateEntry]);
    await this.emit(
      { type: "decision_gate", threadId: thread.id, gate },
      { eventKey: `gate:${gate.id}:pending` },
    );
    return this.commandGates.register(gate, async (gateId) => {
      await this.providers.store.updateDecisionGateEntry(this.id, thread.id, gateId, {
        resolvedAt: new Date().toISOString(),
        gate: { ...gate, status: "expired" },
      });
      await this.emit(
        { type: "decision_gate_expired", threadId: thread.id, gateId },
        { eventKey: `gate:${gateId}:expired` },
      );
    });
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
      // The canonical spec, not the wire id — `modelSpec` differs from
      // `model.id` whenever the host resolver returned a wire-ready model
      // for a namespaced spec (see `ResolvedModel.canonicalId`).
      model: this.options.modelSpec ?? this.options.model.id,
      startRef: this.options.startRef,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * Record the workspace start-ref (engine traces spec, change 2) — host
   * pattern (B), for hosts whose clone happens inside `prepareSandbox`.
   * Idempotent, single-shot: a repeat call with an identical ref is a no-op;
   * a call with a DIFFERENT ref throws `ValidationError` — a session's start
   * conditions are immutable by definition, so divergence indicates a host
   * bug, not a legitimate state change.
   */
  async setStartRef(ref: SessionStartRef): Promise<void> {
    const existing = this.options.startRef;
    if (existing) {
      const same =
        existing.repoUrl === ref.repoUrl &&
        existing.commitSha === ref.commitSha &&
        (existing.branch ?? undefined) === (ref.branch ?? undefined);
      if (same) return;
      throw new ValidationError(
        `session ${this.id} already has a start-ref (${existing.repoUrl}@${existing.commitSha}); refusing to overwrite with ${ref.repoUrl}@${ref.commitSha}`,
      );
    }
    this.options.startRef = ref;
    await this.providers.store.saveSession(await this.toData());
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
    const before = this.options.modelSpec ?? this.options.model.id;
    // With a host resolver present, validate through it (null → same "unknown
    // model id" surface as the internal resolver's undefined). Absent → today's
    // internal `resolveModelId` path, unchanged. NoCredentialsError means the
    // spec IS valid (the model resolved) but no key exists yet — accept it via
    // the attached model: a user must be able to select a model before
    // configuring its key.
    const resolver = this.options.resolveModel;
    let next: Model<any> | undefined;
    try {
      next = resolver ? (await resolver(modelId))?.model : resolveSessionModel(modelId);
    } catch (err) {
      if (!(err instanceof NoCredentialsError)) throw err;
      next = err.model;
    }
    if (!next) throw new Error(`unknown model id: ${modelId}`);
    this.options.model = next;
    // The caller's spec — NOT `next.id` — is the identity the session
    // persists and re-resolves (wire id may differ; ResolvedModel.canonicalId).
    this.options.modelSpec = modelId;
    await this.providers.store.saveSession(await this.toData());
    if (before !== modelId) {
      await this.emit({
        type: "model_switched",
        // session scope — no threadId. Bridge / wire types treat the
        // missing threadId as "session-level switch".
        threadId: undefined,
        fromModel: before,
        toModel: modelId,
        reason,
      });
    }
    return { fromModel: before, toModel: modelId };
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
    // Host-provided resolver (Task 10 fix): when present it REPLACES the raw
    // store read for EVERY service — the host is the single decision point
    // (e.g. resolve `github` through the token service, delegate the rest to
    // the store itself). A resolver return of `null` yields `null`; there is
    // NO store fallback behind a resolver. Absent === byte-identical raw read.
    const resolver = this.options.credentialResolver;
    // Traced (distributed tracing): every credential access — host resolver
    // or raw store read — is one `credentials.get` span, nesting under the
    // running tool/turn span via the active context. Values never land on
    // the span; only the service name and hit/miss.
    const read = (service: string): Promise<StoredCredential | null> =>
      withSpan(
        "credentials.get",
        { "valet.credential.service": service, "valet.credential.via_resolver": !!resolver },
        async (span) => {
          const stored = resolver
            ? await resolver(owner, service)
            : credStore
              ? await credStore.get(owner, service)
              : null;
          span.setAttribute("valet.credential.hit", stored !== null);
          recordCredentialRead(service, stored !== null);
          return stored;
        },
      );
    return {
      async get(service?: string) {
        if (!resolver && !credStore) return null;
        if (!service) return null; // session-level provider has no default service
        const stored = await read(service);
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
        if (!resolver && !credStore) throw new Error(`credential ${service} not available (no store)`);
        const stored = await read(service);
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
