import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { getModel, isContextOverflow, streamSimple } from "@earendil-works/pi-ai/compat";
import type { Api, Message, Model, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai/compat";

type PiModel = Model<Api>;
import type { Session, EmitOptions } from "./session.js";
import { toAgentTool } from "./tool-bridge.js";
import {
  DecisionGateExpiredError,
  DecisionGateWithdrawnError,
  findStickyTerminalGate,
  fromRequest,
  GateManager,
  isDecisionGateExpired,
  isDecisionGateWithdrawn,
  latestGateForResume,
  persistTerminalGate,
  shouldShortCircuit,
  type GateContext,
} from "./decision-gate.js";
import { renderTemplate } from "./roles-skills/index.js";
import {
  deriveQueueState,
  formatSenderLine,
  MAX_PENDING_PER_THREAD,
  namespaceInternalDispatchId,
  renderSignalEnvelope,
  resolvePartialSubmissionText,
  resolveSubmissionText,
  SIGNAL_HOP_BUDGET,
  validateSignalAttributeKeys,
  validateSignalTagName,
} from "./submission.js";
import { NoCredentialsError, NotFoundError, StaleAttemptError, TimeoutError, ValidationError } from "./errors.js";
import { extractStructuredOutput } from "./result-schema.js";
import { buildRepoInstructionsFragment } from "./repo-instructions.js";
import { formatFileAttachmentsNote } from "./file-attachment-formatter.js";
import { capturePatch } from "./patch-capture.js";
import { recordGateUnownedExpired, recordSettlement, recordTurn } from "./metrics.js";
import {
  TRACEPARENT_METADATA_KEY,
  activeTraceparent,
  attrTruncate,
  engineTracer,
  linkFromTraceparent,
  markSpanError,
  withSpan,
} from "./tracing.js";
import { context as otelContext, trace as otelTrace, type Span } from "@opentelemetry/api";
import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import {
  applyPrune,
  estimateTokens,
  estimateTotalTokens,
  extractFileContext,
  planPrune,
  selectCutPoint,
  summarize,
  usableTokens,
  type PruneResult,
  type SummarizeResult,
} from "./compaction.js";
import type {
  AwaitResultOptions,
  CompactionEntry,
  DecisionGate,
  DecisionGateRequest,
  DecisionResolution,
  DecisionWithdrawReason,
  EngineEvent,
  EngineEventStatus,
  MessageCost,
  MessagePart,
  MessageEntry,
  MessageQuery,
  MessageUsage,
  Principal,
  PromptAuthor,
  PromptContent,
  PromptOptions,
  PromptReceipt,
  QueueItem,
  QueueMode,
  QueueState,
  ResolvedModel,
  SessionEntry,
  SignalContent,
  SkillInvokeOptions,
  SettlePatchRef,
  SubmissionOutcome,
  SubmissionResult,
  SuspendedTurnState,
  ThreadData,
  ToolContext,
  ToolDef,
  WriteFence,
} from "./types.js";

/** Bound on `awaitResult`'s merged-constituent delegation chain (Task 6). */
const MAX_MERGE_DELEGATION_DEPTH = 5;

/**
 * Credential-less claim attempts before settling `failed` (2 releases + 1
 * terminal). Each attempt that hits the host resolver's `NoCredentialsError`
 * releases the claim back to `queued` until this cap; the capping attempt
 * settles the submission `failed` with the host's own error message. Keeps a
 * racing abort inside its window (the abort settles the item well inside the
 * first cycle) while bounding retries for a session whose LLM key is
 * genuinely missing. Tracked per-Thread in `credentialAttempts` (NOT the
 * store's `attemptCount`, which is shared with lease-expiry reconciliation —
 * a lease recycle must not burn the credential budget).
 */
const MAX_CREDENTIAL_ATTEMPTS = 3;

/**
 * Minimum spacing between COUNTED credential-release cycles. External kicks
 * (submitPrompt, resume, submitDecision, abort) fire `void this.kick()`
 * unconditionally, so without a floor a burst of user actions would burn all
 * MAX_CREDENTIAL_ATTEMPTS in milliseconds — the "5s sweep is the backoff"
 * intent would never be enforced. Releases landing inside this window still
 * release (the claim never sticks) but count as the SAME cycle: the budget
 * then meaningfully spans ~3 sweep cycles. Kept just under the sweep interval
 * so each 5s sweep tick counts. Tests override via
 * `CreateSessionOptions.credentialReleaseBackoffMs`.
 */
const CREDENTIAL_RELEASE_BACKOFF_MS = 4_000;

const AUTO_CONTINUE_PROMPT =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";

let nextId = 1;
function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(nextId++).toString(36)}`;
}

/**
 * One Thread per (session, key). Owns its own pi-agent-core Agent instance,
 * its own queue, its own active leaf in the DAG, and its own GateManager.
 *
 * The queue is implemented at the engine level (not via pi-agent-core's
 * steeringQueue/followUpQueue): we want to control queueing across the
 * entire prompt lifecycle, including suspended states.
 */
export class Thread {
  readonly id: string;
  readonly key: string;
  private readonly session: Session;
  private agent: Agent;
  /** Persisted pause flag — the only stored piece of queue state. */
  private paused = false;
  private blockedGateId: string | undefined;
  /**
   * The most recent `status` event this instance emitted. In-memory only —
   * feeds `currentAgentStatus` so a client that connects mid-turn can seed
   * its status view without waiting for the next transition event.
   */
  private lastEmittedStatus: EngineEventStatus = "idle";
  /**
   * The submission currently being run by this instance (claimed → settled).
   * Set by the claim loop, held across the whole turn (including a gate block),
   * cleared when the turn settles. Replaces the old in-memory `activeItem`.
   */
  private runningItem: QueueItem | null = null;
  /** Write fence for the claimed turn — `{ itemId, attemptId }`. Every store write during the turn carries it. */
  private fence: WriteFence | undefined;
  /**
   * Set when a fenced write throws StaleAttemptError mid-turn: a successor owns
   * the item, so the turn aborts and skips settlement (zombie self-fencing).
   */
  private staleFenceDetected = false;
  /** Serializes the claim loop; a second `kick()` while one is running joins the in-flight tail. */
  private kicking = false;
  private kickTail: Promise<void> = Promise.resolve();
  /** In-process collect-window flush timer; armed by the first item of a window. */
  private collectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guards against the in-process timer and the session sweep both flushing the same window. */
  private flushingCollect = false;
  private gates = new GateManager();
  /**
   * Serializes gate open/wait cycles for this thread. pi-agent-core runs a
   * block's tool calls in parallel, so two gated calls race the strict
   * running↔blocked_on_decision_gate toggle and the single suspended-turn
   * checkpoint slot; the loser's gate persists as a pending row with no
   * waiter — an approval card no resolve can clear (TKAI-238).
   */
  private gateCycleTail: Promise<void> = Promise.resolve();
  private mode: QueueMode;
  private aborted = false;
  /**
   * Set by `runItem` when the host resolver threw `NoCredentialsError` at
   * turn start (the turn never appended a user entry or reached the model).
   * The claim loop reads it (`credentialError !== undefined`) to release the
   * claim back to `queued` rather than settling the submission `failed` — so
   * it stays abortable and re-runs once credentials resolve; the cap-path
   * settlement surfaces this exact HOST message, never a fabricated generic
   * one. Set ONLY by that explicit throw; reset at the start of every turn.
   * The bounded budget itself is DURABLE on the queue item
   * (`credentialAttempts`/`lastCredentialReleaseAt`), not Thread state.
   */
  private credentialError: NoCredentialsError | undefined;
  /**
   * The agent-run throw for the current turn, recorded independently of the
   * transcript: a stream that fails before its first `message_start` leaves
   * NO assistant message for this turn, and decideTurnOutcome deliberately
   * ignores stale trailing messages — without this field such a failure
   * would settle `completed`. Reset at the start of every turn; the claim
   * loop folds it into the turn failure after runItem returns.
   */
  private turnAgentError: unknown;
  private currentAssistantMessageId: string | undefined;
  private currentAssistantParts: MessagePart[] = [];
  private currentToolCalls = new Map<string, MessagePart>();
  /**
   * The persisted assistant entry for the current turn. Held so we can
   * `updateEntry` after each tool completes — without this, tool_call parts
   * stay frozen at status="running" in the store and reload shows them
   * stuck mid-execution.
   */
  private currentAssistantEntry: MessageEntry | undefined;
  private toolCtxOverlay: { gateId?: string } = {};
  private suspendedDecisionForReplay:
    | { gateId: string; ordinal: number; resolution?: DecisionResolution }
    | undefined;
  /** Token usage from the most recent assistant message, captured at turn_end. */
  private lastAssistantUsage:
    | { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
    | undefined;
  /** Wall clock at claim/resume — feeds `turn_end`'s `turnDurationMs`. */
  private turnStartedAt: number | undefined;
  /**
   * Live `submission.run` span for the currently-claimed item (distributed
   * tracing): started at claim, ended when the claim clears. Children
   * (`agent.turn`, `submission.settle`) parent under it via
   * `inSubmissionContext`. No-op Span when no SDK is registered.
   */
  private submissionSpan: Span | undefined;
  /** The running turn's `agent.turn` span — turn_end stamps usage/cost onto it. */
  private turnSpan: Span | undefined;
  /**
   * Live `llm.generate` span for the current assistant round (distributed
   * tracing). The engine doesn't own pi-ai's HTTP call, so the span is
   * synthesized from the agent's message lifecycle: started at
   * `message_start` with `llmRoundStartedAt` as the start time (pinned to
   * when the previous round's work finished, so request setup +
   * time-to-first-token are inside the span), ended at `message_end`.
   */
  private llmSpan: Span | undefined;
  /** When the current LLM round's request effectively began (turn start, or
   * the previous message/tool completion). */
  private llmRoundStartedAt: number | undefined;
  /** Tool calls across ALL rounds of the running turn (currentToolCalls is
   * per-round — it clears on each assistant message_start). */
  private turnToolCallCount = 0;
  /** True while a reactive (overflow) compaction is rerunning the failed turn. */
  private overflowRetryInProgress = false;
  /**
   * Set after compactThread runs; cleared by the next runItem before
   * checking shouldCompactProactive. Prevents recursive compaction loops
   * where each compaction's auto-continue immediately re-triggers
   * compaction (e.g. when the summary itself plus the system prompt
   * still exceeds usable on a small-context model).
   */
  private skipNextProactiveCheck = false;
  /**
   * Per-thread model override (id string, e.g. "claude-opus-4-7"). When set,
   * overlays the session-default at turn start and is restored after.
   * Persisted via toThreadData → store.saveThread.
   */
  private modelOverride?: string;
  /**
   * Per-turn API key from the host `resolveModel` seam. Resolved at turn start
   * (fresh turns and resume/replay), read by the Agent's `getApiKey`, cleared
   * at turn end. Never cached across turns — key rotation applies next turn.
   * Always undefined when the session has no resolver (the Agent has no
   * `getApiKey` in that case, so this is never read).
   */
  private turnApiKey?: string;
  private readonly threadCreatedAt: number;

  constructor(session: Session, data: ThreadData) {
    this.session = session;
    this.id = data.id;
    this.key = data.key;
    this.mode = data.queueMode;
    this.modelOverride = data.model;
    this.paused = data.paused ?? false;
    this.threadCreatedAt = data.createdAt || Date.now();
    this.agent = this.buildAgent();
  }

  /** Currently configured model id for this thread (or undefined to use session default). */
  modelId(): string | undefined {
    return this.modelOverride;
  }

  // ── public API ──────────────────────────────────────────────────

  pendingDecisionGates(): DecisionGate[] {
    return this.gates.pendingForThread(this.id);
  }

  isPendingGate(gateId: string): boolean {
    return this.gates.isPending(gateId);
  }

  resolveDecision(gateId: string, resolution: DecisionResolution): boolean {
    const ok = this.gates.resolve(gateId, resolution);
    if (ok) {
      // Persist the resolved status + DAG entry update. Both the live and
      // replay code paths short-circuit before the requestDecision
      // continuation; doing it here means the store is consistent for both.
      void this.persistGateResolution(gateId, resolution);
      void this.session.emit(
        {
          type: "decision_gate_resolved",
          threadId: this.id,
          gateId,
          resolution,
        },
        { eventKey: `gate:${gateId}:resolved` },
      );
    }
    return ok;
  }

  private async persistGateResolution(
    gateId: string,
    resolution: DecisionResolution,
  ): Promise<void> {
    const store = this.session.providers.store;
    const existing = await store.getDecisionGate(this.session.id, gateId);
    if (!existing) return;
    await persistTerminalGate(store, this.session.id, this.id, existing, {
      status: "resolved",
      resolution,
    });
  }

  withdrawDecision(gateId: string, reason: DecisionWithdrawReason): boolean {
    const ok = this.gates.withdraw(gateId, reason);
    if (ok) {
      void this.session.emit(
        {
          type: "decision_gate_withdrawn",
          threadId: this.id,
          gateId,
          reason,
        },
        { eventKey: `gate:${gateId}:withdrawn` },
      );
    }
    return ok;
  }

  async submitPrompt(content: PromptContent, opts: PromptOptions): Promise<PromptReceipt> {
    if (opts.promoteItemId) {
      throw new ValidationError(
        "submitPrompt does not accept promoteItemId. Call Thread.promoteQueuedItem to promote a queued item.",
      );
    }
    const effectiveMode: QueueMode = opts.queueMode ?? this.mode;

    if (effectiveMode === "collect") {
      return this.submitCollect(content, opts);
    }

    const prepared = this.prepareSubmissionContent(content, opts);

    const item = this.buildQueueItem(prepared.content, {
      dispatchId: prepared.dispatchId,
      author: opts.author,
      channel: opts.channel,
      replyTarget: opts.replyTarget,
      model: opts.model,
      role: opts.role,
      metadata: prepared.metadata,
    });

    // Steer admissions are exempt from the pending cap: the same atomic
    // `admitSubmission({ steer: true })` call supersedes every prior
    // unsettled item on the thread in the same transaction, so the count
    // they'd leave behind is always ~0-1 regardless of how many were pending
    // beforehand. For every other mode, the cap is enforced by the store
    // INSIDE the admission transaction (opts.maxPending) rather than via a
    // separate pre-check, so concurrent admissions can't race past it.
    const store = this.session.providers.store;
    const cap = this.session.options.maxPendingPerThread ?? MAX_PENDING_PER_THREAD;
    const { item: admitted, supersededItemIds } = await store.admitSubmission(
      this.session.id,
      this.id,
      item,
      effectiveMode === "steer" ? { steer: true } : { maxPending: cap },
    );
    if (supersededItemIds.length > 0) {
      await this.handleSteerSupersession(supersededItemIds);
    }
    await this.emitQueueState();
    void this.kick();
    return {
      sessionId: this.session.id,
      threadId: this.id,
      queueItemId: admitted.id,
      status: receiptStatus(admitted.status),
    };
  }

  /**
   * Promote a queued followup into a steer. Admits a new item with the same
   * content and `steer: true` so the running turn and the original queued
   * row are superseded together. The original item is never claimed, so it
   * does not write a second user entry. The caller remaps the optimistic
   * bubble onto the returned `queueItemId`.
   */
  async promoteQueuedItem(itemId: string): Promise<PromptReceipt> {
    const store = this.session.providers.store;
    const existing = await store.getQueueItem(this.session.id, itemId);
    if (!existing || existing.threadId !== this.id) {
      throw new NotFoundError("queue item", itemId);
    }
    if (existing.status !== "queued" || existing.supersededByItemId) {
      throw new ValidationError(
        "That message is no longer queued. Send a new message, or wait for the current turn to finish.",
      );
    }
    const item = this.buildQueueItem(existing.content, {
      author: existing.author,
      channel: existing.channel,
      replyTarget: existing.replyTarget,
      model: existing.model,
      role: existing.role,
      metadata: { ...(existing.metadata ?? {}), promotedFromItemId: existing.id },
    });
    const { item: admitted, supersededItemIds } = await store.admitSubmission(
      this.session.id,
      this.id,
      item,
      { steer: true, promoteFromItemId: existing.id },
    );
    if (supersededItemIds.length > 0) {
      await this.handleSteerSupersession(supersededItemIds);
    }
    await this.emitQueueState();
    void this.kick();
    return {
      sessionId: this.session.id,
      threadId: this.id,
      queueItemId: admitted.id,
      status: receiptStatus(admitted.status),
    };
  }

  /**
   * Steer supersession (Task 4, design decision 3): the durable supersession
   * stamp already landed atomically inside `admitSubmission({ steer: true })`
   * before this runs — so a gate-resolution race against a superseded item is
   * always a no-op by the time it could matter. Here we (1) withdraw any
   * pending gate owned by this thread (only the running turn can have one),
   * (2) settle every superseded item that never had a live attempt via
   * `settleUnclaimed` (a no-op / false for the currently-running item, which
   * settles through its own attempt's interrupted-handler / decideTurnOutcome
   * precedence instead), then (3) if the running item was superseded, abort
   * the live agent run so its turn unblocks and settles. The claim loop
   * (`kickLoop`'s `while (true)`) picks up the new head — the steer item —
   * once the running turn's settlement completes; no separate claim step is
   * needed here.
   */
  private async handleSteerSupersession(supersededItemIds: string[]): Promise<void> {
    const store = this.session.providers.store;
    const runningId = this.runningItem?.id;
    const runningSuperseded = runningId !== undefined && supersededItemIds.includes(runningId);
    // Abort synchronously, before any awaited I/O below, so a tool blocked on
    // a decision gate sees the signal already set once its withdrawal
    // propagates — otherwise the awaits in the settleUnclaimed loop give the
    // agent loop's tool-error follow-up call a chance to race ahead.
    // `Agent.abort()`/`waitForIdle()` are safe no-ops when nothing is running.
    if (runningSuperseded) {
      this.agent.abort();
    }
    for (const g of this.pendingDecisionGates()) {
      this.withdrawDecision(g.id, "steer");
    }
    for (const id of supersededItemIds) {
      await store.settleUnclaimed(this.session.id, this.id, id, { outcome: "superseded" });
      await this.emitSettled(id, { outcome: "superseded" });
    }
    if (runningSuperseded) {
      await this.agent.waitForIdle();
    }
  }

  /**
   * Collect-mode admission (Task 4): admits with status "collecting" and a
   * durable `metadata.collectDeadline`. dispatchId dedup applies at admission
   * via the same `admitSubmission` idempotency the other modes use. Arms an
   * in-process flush timer for the window; `Session.sweepOnce` additionally
   * flushes any window whose deadline has already passed (covers a deadline
   * elapsing while the process was down between the timer arming and firing).
   */
  private async submitCollect(content: PromptContent, opts: PromptOptions): Promise<PromptReceipt> {
    const store = this.session.providers.store;
    const windowMs = this.session.options.collectWindowMs ?? 5000;
    const base = this.buildQueueItem(content, {
      dispatchId: opts.dispatchId,
      author: opts.author,
      channel: opts.channel,
      replyTarget: opts.replyTarget,
      model: opts.model,
      role: opts.role,
      metadata: opts.metadata,
    });
    const deadline = base.createdAt + windowMs;
    const item: QueueItem = {
      ...base,
      status: "collecting",
      metadata: { ...(base.metadata ?? {}), collectDeadline: deadline },
    };
    const { item: admittedItem, admitted: wasAdmitted } = await store.admitSubmission(
      this.session.id,
      this.id,
      item,
    );
    await this.emitQueueState();
    if (wasAdmitted) {
      this.armCollectTimer(
        typeof admittedItem.metadata?.collectDeadline === "number"
          ? admittedItem.metadata.collectDeadline
          : deadline,
      );
    }
    return {
      sessionId: this.session.id,
      threadId: this.id,
      queueItemId: admittedItem.id,
      status: receiptStatus(admittedItem.status),
    };
  }

  private armCollectTimer(deadline: number): void {
    if (this.collectTimer) return; // window already open; flush reads all live constituents when it fires
    const delay = Math.max(0, deadline - Date.now());
    const timer = setTimeout(() => {
      this.collectTimer = null;
      void this.flushCollectWindow();
    }, delay);
    timer.unref?.();
    this.collectTimer = timer;
  }

  /**
   * Session-sweep hook (Task 4 design point 2): flush a collect window whose
   * deadline has already passed even if no in-process timer is live for it
   * (e.g. the timer never got armed this process, or restart — reconciliation
   * proper is Task 5, this is just the safety net the sweep owns).
   */
  async checkCollectDeadline(): Promise<void> {
    const store = this.session.providers.store;
    const items = await store.listUnsettledSubmissions(this.session.id);
    const collecting = items.filter((i) => i.threadId === this.id && i.status === "collecting");
    if (collecting.length === 0) return;
    const now = Date.now();
    const earliestDeadline = Math.min(
      ...collecting.map((i) =>
        typeof i.metadata?.collectDeadline === "number" ? i.metadata.collectDeadline : now,
      ),
    );
    if (earliestDeadline <= now) {
      await this.flushCollectWindow();
    }
  }

  /**
   * Flush the collect window: merge every currently-collecting item of this
   * thread (oldest-first, numbered-concatenation content — the same merge
   * shape the legacy in-memory `flushCollectBuffer` used) into one durable
   * item, settle each constituent `merged` pointing at it, then kick. Guarded
   * against the in-process timer and the session sweep both firing for the
   * same window (only the synchronous prefix before the first await runs
   * unconditionally, so the flag correctly serializes the two triggers).
   */
  private async flushCollectWindow(): Promise<void> {
    if (this.flushingCollect) return;
    this.flushingCollect = true;
    try {
      if (this.collectTimer) {
        clearTimeout(this.collectTimer);
        this.collectTimer = null;
      }
      const store = this.session.providers.store;
      const items = await store.listUnsettledSubmissions(this.session.id);
      const collecting = items
        .filter((i) => i.threadId === this.id && i.status === "collecting")
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (collecting.length === 0) return;

      const mergedContent = collecting
        .map((it, i) => `[${i + 1}] ${promptText(it.content)}`)
        .join("\n\n");
      const merged = this.buildQueueItem(mergedContent, {
        // Collect mode has no v2 producer today (REST rejects it; no
        // session sets it). If one lands, a multi-author window needs
        // per-constituent authors — this first-item stamp would credit
        // every constituent's text to one sender in the transcript and UI.
        author: collecting[0].author,
        channel: collecting[0].channel,
        replyTarget: collecting[0].replyTarget,
        model: collecting[0].model,
        metadata: { collect: { constituentIds: collecting.map((i) => i.id) } },
      });
      const { item: admittedMerged } = await store.admitSubmission(this.session.id, this.id, merged);
      for (const constituent of collecting) {
        await store.settleUnclaimed(
          this.session.id,
          this.id,
          constituent.id,
          { outcome: "merged" },
          { mergedIntoItemId: admittedMerged.id },
        );
        await this.emitSettled(constituent.id, { outcome: "merged" });
      }
      await this.emitQueueState();
      void this.kick();
    } finally {
      this.flushingCollect = false;
    }
  }

  /**
   * Validates + stamps a signal admission (plan decision 2/4). Non-signal
   * content passes through untouched. For signal content: defaults/validates
   * `tagName`, and — when `opts.internalSender` is set — enforces the hop
   * budget, requires `dispatchId`, namespaces it by the sender session id,
   * and stashes the stamped identity in `metadata.signalStamp` so `runItem`
   * can carry it onto the persisted `MessageEntry.signal` (QueueItem has no
   * dedicated field for it; `metadata` already flows through to the entry).
   * Throws `ValidationError` on any admission-time violation.
   */
  private prepareSubmissionContent(
    content: PromptContent,
    opts: PromptOptions,
  ): { content: PromptContent; dispatchId?: string; metadata?: Record<string, unknown> } {
    if (!isSignalContent(content)) {
      if (opts.internalSender) {
        throw new ValidationError("internalSender is only valid for signal content");
      }
      return { content, dispatchId: opts.dispatchId, metadata: opts.metadata };
    }

    const tagName = content.tagName ?? "signal";
    validateSignalTagName(tagName);
    validateSignalAttributeKeys(content.attributes);
    const normalized: SignalContent = { ...content, tagName };

    if (!opts.internalSender) {
      return { content: normalized, dispatchId: opts.dispatchId, metadata: opts.metadata };
    }

    if (!opts.dispatchId) {
      throw new ValidationError("internal signal admission requires opts.dispatchId");
    }
    const budget = this.session.options.signalHopBudget ?? SIGNAL_HOP_BUDGET;
    const hopCount = (opts.internalSender.hopCount ?? 0) + 1;
    if (hopCount > budget) {
      throw new ValidationError(
        `signal hop budget exceeded: hopCount ${hopCount} > budget ${budget}`,
      );
    }
    const stamp: SignalStamp = {
      senderSessionId: opts.internalSender.sessionId,
      senderOwner: opts.internalSender.owner,
      hopCount,
    };
    return {
      content: normalized,
      dispatchId: namespaceInternalDispatchId(opts.internalSender.sessionId, opts.dispatchId),
      metadata: { ...(opts.metadata ?? {}), signalStamp: stamp },
    };
  }

  private buildQueueItem(
    content: PromptContent,
    fields: {
      dispatchId?: string;
      author?: PromptAuthor;
      channel?: QueueItem["channel"];
      replyTarget?: QueueItem["replyTarget"];
      model?: string;
      role?: string;
      metadata?: Record<string, unknown>;
    },
  ): QueueItem {
    const now = Date.now();
    // Distributed tracing: stamp the admitting request's traceparent so the
    // eventual `submission.run` span can LINK back to it (the admission span
    // ends long before the turn runs, so a link — not a parent — is correct).
    const traceparent = activeTraceparent();
    const metadata = traceparent
      ? { ...(fields.metadata ?? {}), [TRACEPARENT_METADATA_KEY]: traceparent }
      : fields.metadata;
    return {
      id: uid("q"),
      threadId: this.id,
      dispatchId: fields.dispatchId,
      content,
      author: fields.author,
      channel: fields.channel,
      replyTarget: fields.replyTarget,
      model: fields.model,
      role: fields.role,
      metadata,
      status: "queued",
      attemptCount: 0,
      maxAttempts: 10,
      timeoutAt: now + 3_600_000,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Invoke a registered skill. Looks up the skill by name in
   * session.skills, validates args against the skill's argsSchema (if
   * present) via TypeBox's runtime checker, renders the skill content
   * with `{{var}}` interpolation, and submits the result as a normal
   * prompt with optional model/role/resultSchema overrides forwarded.
   */
  async skill(name: string, opts: SkillInvokeOptions = {}): Promise<PromptReceipt> {
    const skill = this.session.skills.get(name);
    if (!skill) {
      throw new Error(
        `skill "${name}" not registered on this session. Known: ${[...this.session.skills.keys()].join(", ") || "(none)"}`,
      );
    }
    const args = opts.args ?? {};
    if (skill.argsSchema) {
      const validator = Compile(skill.argsSchema as TSchema);
      if (!validator.Check(args)) {
        const errors = [...validator.Errors(args)]
          .map((e) => `  - ${e.instancePath || "(root)"}: ${e.message}`)
          .join("\n");
        throw new Error(`skill "${name}" args failed validation:\n${errors}`);
      }
    }
    const rendered = renderTemplate(skill.content, args);
    return this.submitPrompt(rendered, {
      author: opts.author,
      channel: opts.channel,
      model: opts.model,
      role: undefined, // role not currently part of SkillInvokeOptions; see types.ts
      resultSchema: opts.resultSchema,
      metadata: { skill: name, syntheticFrom: "skill" },
    });
  }

  async abort(): Promise<void> {
    this.aborted = true;
    if (this.collectTimer) {
      clearTimeout(this.collectTimer);
      this.collectTimer = null;
    }
    const store = this.session.providers.store;
    // Durable intent first: stamps abortRequestedAt on unsettled items so the
    // in-flight turn's settlement records `aborted`, and so a crash mid-abort
    // still reconciles to aborted.
    await store.requestAbort(this.session.id, this.id);
    // Withdraw any pending gates owned by this thread.
    for (const g of this.pendingDecisionGates()) {
      this.withdrawDecision(g.id, "abort");
    }
    // Interrupt the in-flight turn (if any) and let the claim loop drain — its
    // settlement path records the running item `aborted`.
    if (this.agent.state.isStreaming) {
      this.agent.abort();
      await this.agent.waitForIdle();
    }
    await this.kickTail;
    // Settle any never-claimed (queued/collecting) items `aborted`.
    const unsettled = await store.listUnsettledSubmissions(this.session.id);
    for (const it of unsettled) {
      if (it.threadId !== this.id) continue;
      if (it.status === "queued" || it.status === "collecting") {
        await store.settleUnclaimed(this.session.id, this.id, it.id, { outcome: "aborted" });
        await this.emitSettled(it.id, { outcome: "aborted" });
      }
    }
    await this.emitQueueState();
  }

  async pause(): Promise<void> {
    this.paused = true;
    await this.session.providers.store.saveThread(this.session.id, this.toThreadData());
    await this.emitQueueState();
  }

  async resume(): Promise<void> {
    if (!this.paused) return;
    this.paused = false;
    await this.session.providers.store.saveThread(this.session.id, this.toThreadData());
    await this.emitQueueState();
    void this.kick();
  }

  /**
   * Used by Engine.restoreSession to seed replay state before re-running a
   * blocked tool. When the tool calls requestDecision with a matching
   * resumeKey, the engine returns the stored resolution immediately.
   */
  setReplayContext(
    ctx: { gateId: string; ordinal: number; resolution?: DecisionResolution } | undefined,
  ): void {
    this.suspendedDecisionForReplay = ctx;
  }

  /**
   * Re-run a suspended tool with seeded suspendedDecision, push its result onto
   * the agent transcript, continue the agent loop, then settle the resumed turn.
   * Driven by `reconcileGate` (directly for a resolved gate, or via
   * `armPendingGateForRestart` once a re-armed pending gate resolves). Runs
   * under the fresh fenced attempt `reconcileGate` installed.
   */
  async replayBlocked(args: {
    suspended: SuspendedTurnState;
    resolution: DecisionResolution;
  }): Promise<void> {
    const { suspended, resolution } = args;
    const tools = this.buildTools();
    const tool = tools.find((t) => t.name === suspended.toolName);
    if (!tool) {
      this.emitError(
        "replay_tool_missing",
        `cannot replay: tool ${suspended.toolName} not registered`,
      );
      return;
    }
    this.setReplayContext({ gateId: suspended.gateId, ordinal: suspended.ordinal, resolution });
    // The deterministic gate ID is derived from
    // (sessionId, threadId, queueItemId, resumeKey, ordinal). During replay,
    // the tool's requestDecision call recomputes this from the active queue
    // item — so we must mirror the original queueItemId here, otherwise
    // the short-circuit won't match and the tool will try to open a
    // brand-new gate.
    const priorActive = this.runningItem;
    this.runningItem = {
      id: suspended.queueItemId,
      threadId: this.id,
      content: "",
      status: "running",
      attemptCount: 0,
      maxAttempts: 10,
      timeoutAt: suspended.createdAt + 3_600_000,
      createdAt: suspended.createdAt,
      updatedAt: Date.now(),
    };
    const fakeAbort = new AbortController();
    let toolResult;
    try {
      toolResult = await tool.execute(
        suspended.toolCallId,
        suspended.toolArgs,
        fakeAbort.signal,
      );
    } catch (err) {
      this.runningItem = priorActive;
      this.emitError(
        "replay_tool_failed",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    this.runningItem = priorActive;
    this.agent.state.messages = [
      ...this.agent.state.messages,
      {
        role: "toolResult",
        toolCallId: suspended.toolCallId,
        toolName: suspended.toolName,
        content: toolResult.content,
        details: toolResult.details,
        isError: false,
        timestamp: Date.now(),
      },
    ];
    // Persist the replayed tool_call part as completed so terminalization's
    // rest-state repair doesn't later rewrite it to an interrupted-error: the
    // tool DID run to completion on replay (its result was pushed above), it
    // just didn't flow through the agent loop's tool_execution_end.
    await this.persistReplayedToolResult(suspended.toolCallId, toolResult);
    await this.session.providers.store.clearSuspendedTurn(this.session.id, this.id, this.fence);
    this.blockedGateId = undefined;
    // Drive the continuation, recording any failure for settlement — a
    // keyless resume (applyResolvedKeyForResume rethrows NoCredentialsError
    // rather than continuing on pi-ai's ambient env fallback) and a
    // continuation stream failure both settle the turn `failed` instead of
    // wedging or mislabeling it.
    let continueError: unknown;
    try {
      // Host resolver (if any) delivers this resumed turn's per-turn key
      // before the continuation LLM call; no-op when absent.
      await this.applyResolvedKeyForResume();
      await this.agent.continue();
      await this.agent.waitForIdle();
    } catch (err) {
      continueError = err;
      this.emitError(
        "replay_continue_failed",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this.turnApiKey = undefined;
    }
    // Settle the resumed turn (reconciliation owns a fresh fenced attempt via
    // reconcileGate). Flip the durable block back to running first so
    // settleTurn's terminal transition is legal, then settle normally.
    if (this.fence && this.runningItem) {
      const store = this.session.providers.store;
      const fence = this.fence;
      const settleItem = this.runningItem;
      const current = await store.getQueueItem(this.session.id, settleItem.id);
      if (current?.status === "blocked_on_decision_gate") {
        await this.fencedWrite(() =>
          store.setSubmissionBlocked(this.session.id, this.id, settleItem.id, false, fence),
        );
      }
      try {
        await this.settleTurn(
          settleItem,
          continueError !== undefined ? { error: continueError } : undefined,
        );
      } catch (err) {
        this.emitError("settlement_failed", err instanceof Error ? err.message : String(err));
      }
      this.runningItem = null;
      this.fence = undefined;
      void this.kick();
    }
    await this.emitQueueState();
  }

  /**
   * Mark the persisted assistant tool_call part matching `toolCallId` as
   * completed with the replayed result — a fenced in-place update mirroring the
   * live tool_execution_end path.
   */
  private async persistReplayedToolResult(
    toolCallId: string,
    result: { content?: unknown; details?: unknown },
  ): Promise<void> {
    const store = this.session.providers.store;
    const entries = await store.getEntries(this.session.id, this.id);
    for (const e of entries) {
      if (e.type !== "message" || e.role !== "assistant" || !e.parts) continue;
      const part = e.parts.find(
        (p) => p.type === "tool_call" && p.callId === toolCallId,
      );
      if (part && part.type === "tool_call") {
        part.status = "completed";
        const structured =
          result && typeof result === "object" ? (result as Record<string, unknown>) : {};
        part.result = { ...structured, text: renderToolResult(result) };
        await this.fencedWrite(() =>
          store.updateEntry(this.session.id, this.id, e, this.fence),
        );
        return;
      }
    }
  }

  /**
   * Re-arm the GateManager for a still-pending gate after restart, so a
   * future resolveDecision triggers replay.
   */
  armPendingGateForRestart(gate: DecisionGate, suspended: SuspendedTurnState): void {
    this.blockedGateId = gate.id;
    this.gates
      .register(gate, () => {
        // Terminalization is driven off the promise rejection below (which the
        // GateManager fires alongside this callback), so this stays a no-op.
      })
      .then((resolution) => {
        void this.replayBlocked({ suspended, resolution });
      })
      .catch((err) => {
        // Expiry / withdrawal of a re-armed gate must reach the SAME terminal
        // state as the live path: persist the gate's terminal status, flip the
        // durable block back to running, clear the suspended checkpoint, and
        // drive the turn to settlement. Otherwise the item stays
        // blocked_on_decision_gate forever (the heartbeat renews its lease so
        // the sweep never reclaims it and maybeEmitStuck excludes it), wedging
        // the whole thread on every restart.
        if (isDecisionGateExpired(err) || isDecisionGateWithdrawn(err)) {
          this.terminalizeReconciledGate(gate, err).catch((e) =>
            this.emitError(
              "terminalize_reconciled_gate_failed",
              e instanceof Error ? e.message : String(e),
            ),
          );
          return;
        }
        this.emitError(
          "replay_after_pending_gate_failed",
          err instanceof Error ? err.message : String(err),
        );
      });
  }

  /**
   * Durable expiry backstop (Task 4). For each pending gate whose deadline has
   * lapsed: if it is armed in this process's GateManager, fire the live expiry
   * path (`expire` rejects the waiter → the requestDecision / re-arm handler
   * persists the terminal status and drives settlement). If it is NOT armed
   * (a lost in-process timer — e.g. a re-armed row whose waiter never attached),
   * re-arm through `reconcileGate`: the fresh fenced attempt registers the
   * already-past gate, which self-expires immediately and terminalizes.
   * Complements the low-latency in-memory `setTimeout` in `GateManager.register`.
   */
  async sweepExpiredGates(): Promise<void> {
    const store = this.session.providers.store;
    const now = Date.now();
    const gates = await store.listDecisionGates(this.session.id, this.id);
    // Lazily fetched once per sweep pass, shared by every lapsed gate.
    let suspended: SuspendedTurnState | null | undefined;
    for (const gate of gates) {
      if (gate.status !== "pending") continue;
      if (gate.expiresAt === undefined || gate.expiresAt > now) continue;
      if (this.gates.isPending(gate.id)) {
        this.gates.expire(gate.id);
        continue;
      }
      // Command gates live on this thread's rows but their waiter is armed
      // in the SESSION-level manager (awaitCommandGate) — a live one is
      // owned, not orphaned. Its own timer terminalizes it.
      if (this.session.isCommandGatePending(gate.id)) continue;
      // One read serves every gate this tick — the checkpoint cannot change
      // under the sweep (reconcileGate re-validates before acting).
      if (suspended === undefined) {
        suspended = await store.getSuspendedTurn(this.session.id, this.id);
      }
      if (!suspended || suspended.gateId !== gate.id) {
        // No armed waiter and no checkpoint reference this row: it is a
        // superseded pending gate (its turn moved on to a later gate, or a
        // pre-stickiness build left it behind). No turn state to repair —
        // expire the row in place so it stops rendering as an actionable
        // approval, and skip a row whose queue item is the live turn (that
        // turn's own gate cycle owns it).
        if (gate.queueItemId !== this.runningItem?.id) {
          await this.expireUnownedGateRow(gate);
        }
        continue;
      }
      // Checkpointed but not armed: a live turn (if any) owns the thread —
      // leave it be.
      if (this.runningItem) continue;
      const item = await store.getQueueItem(this.session.id, suspended.queueItemId);
      if (!item) continue;
      await this.reconcileGate(item, suspended, "rearm");
    }
  }

  /**
   * Expire a lapsed pending gate row that no waiter or checkpoint owns.
   * Row + DAG entry flip to `expired` and the expiry event reaches live
   * clients, so the approval card clears everywhere. Deliberately does NOT
   * touch queue items or the transcript — there is no suspended turn to
   * resume for these rows.
   *
   * Visibility (alert, don't auto-repair): every hit records the
   * `valet.gates.unowned_expired` counter and logs the gate id, so a
   * violation of the checkpoint-first open ordering shows up as a signal
   * distinct from ordinary expiry instead of being silently reaped. A
   * steady rate after the pre-stickiness backlog drains is a bug upstream.
   */
  private async expireUnownedGateRow(gate: DecisionGate): Promise<void> {
    try {
      await persistTerminalGate(this.session.providers.store, this.session.id, this.id, gate, {
        status: "expired",
      });
      recordGateUnownedExpired(gate.type);
      console.warn(
        `[engine] expired unowned pending gate ${gate.id} (session=${this.session.id} ` +
          `thread=${this.id} type=${gate.type}): no waiter or checkpoint owned it`,
      );
      await this.session.emit(
        { type: "decision_gate_expired", threadId: this.id, gateId: gate.id },
        { eventKey: `gate:${gate.id}:expired` },
      );
    } catch (err) {
      this.emitError(
        "expire_unowned_gate_failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Terminalize a re-armed gate that expired or was withdrawn after restart,
   * then drive its suspended turn to settlement. Mirrors the live
   * `requestDecision` expiry/withdrawal path (persist terminal gate status +
   * DAG entry, emit `decision_gate_expired` for expiry) but, because there is
   * no in-flight `runAgent` to rethrow into, uses `driveResumeToCompletion` to
   * repair the dangling gate tool_call, flip the block, continue, and settle —
   * matching what the live path's rethrow ultimately achieves.
   */
  private async terminalizeReconciledGate(gate: DecisionGate, err: unknown): Promise<void> {
    const store = this.session.providers.store;
    const reason = isDecisionGateWithdrawn(err) ? err.reason : undefined;
    await persistTerminalGate(
      store,
      this.session.id,
      this.id,
      gate,
      reason ? { status: "withdrawn", reason } : { status: "expired" },
    );
    if (!reason) {
      await this.session.emit(
        {
          type: "decision_gate_expired",
          threadId: this.id,
          gateId: gate.id,
        },
        { eventKey: `gate:${gate.id}:expired` },
      );
    }
    this.blockedGateId = undefined;

    if (this.runningItem && this.fence) {
      const message = reason
        ? `decision gate withdrawn (${reason}) before resolution`
        : "decision gate expired before resolution";
      await this.driveResumeToCompletion(this.runningItem, message);
    }
  }

  /**
   * One full gate cycle: persist the gate, checkpoint the suspended turn,
   * flip the durable block, await the human decision, then unwind. The
   * caller MUST hold this thread's gate-cycle slot (`gateCycleTail`) — the
   * strict running↔blocked_on_decision_gate toggle and the single
   * suspended-turn checkpoint slot both assume one cycle at a time.
   */
  private async runGateCycle(args: {
    req: DecisionGateRequest;
    gateCtx: GateContext;
    signal: AbortSignal;
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
  }): Promise<DecisionResolution> {
    const { req, gateCtx, signal, toolCallId, toolName, toolArgs } = args;
    const session = this.session;
    // Ordinal resolution: reuse a still-pending gate for this
    // (queueItemId, resumeKey) — JOIN it rather than open a duplicate — or,
    // once the latest is terminal, mint a fresh gate at ordinal+1 (a retried
    // action after a human decision gets a fresh decision). Null → ordinal 0.
    // One bounded read serves the ordinal resolution AND the sticky scan
    // below — both scope to this queue item's gates.
    const queueGates = await session.providers.store.listDecisionGatesForQueueItem(
      session.id,
      this.id,
      gateCtx.queueItemId,
    );
    const latestGate = latestGateForResume(queueGates, gateCtx.queueItemId, gateCtx.resumeKey);
    const joiningPending = latestGate?.status === "pending";
    const ordinal = latestGate
      ? joiningPending
        ? latestGate.ordinal
        : latestGate.ordinal + 1
      : 0;
    // Fence captured for the whole suspend/resume cycle of this claimed
    // turn. Undefined only on the replay path, which short-circuits above.
    const fence = this.fence;
    const runningItemId = this.runningItem?.id;
    // Fenced writes in the gate path route through fencedWrite (design
    // point 3): a stale fence aborts the turn, marks it for skipped
    // settlement, and unwinds the tool. The agent is already aborted at
    // that point, so the unwind never reaches the model as a tool error.
    // Non-stale errors (e.g. ConflictError from a wrong-direction blocked
    // toggle) still propagate — they are deliberate contract violations.
    const fencedGateWrite = async (fn: () => Promise<void>): Promise<void> => {
      await this.fencedWrite(fn);
      if (this.staleFenceDetected) {
        throw new Error(`turn superseded: stale write fence for item ${runningItemId}`);
      }
    };
    // When joining a still-pending gate the durable row + DAG entry already
    // exist, so reuse them; only re-arm the wait and re-checkpoint below.
    const gate = joiningPending && latestGate ? latestGate : fromRequest(req, { ...gateCtx, ordinal });
    // The turn unwound while this call waited for the gate-cycle slot:
    // Thread.abort sets `aborted`; steer supersession aborts the agent's
    // run signal without setting it. Either way, do not persist a gate
    // that no waiter will ever own. This check runs BEFORE the sticky
    // scan: an unwinding turn must get the withdrawal, not a stored
    // resolution that would let it run onResolution side effects and emit
    // audit records on behalf of a discarded attempt.
    if (this.aborted || signal.aborted) {
      throw new DecisionGateWithdrawnError(gate.id, this.aborted ? "abort" : "steer");
    }
    // Sticky terminal outcomes: within this queue item, a human denial or an
    // unanswered expiry in the request's dedupe scope is final. Return the
    // stored denial (or re-throw expiry) instead of opening a fresh gate —
    // otherwise an agent that retries after deny/expiry mints new gates
    // forever (tweaked args hash to a new resumeKey; a lapsed 72h gate
    // resurrects itself every 72h). A still-pending gate for this exact
    // resumeKey takes precedence: join it below and let the human answer.
    // A same-args retry returns the ORIGINAL ordinal on purpose — the policy
    // audit sink dedupes on (queueItemId, resumeKey, gateOrdinal), so model
    // retries of one denied call collapse onto the one human decision record.
    if (!joiningPending) {
      const sticky = findStickyTerminalGate(queueGates, {
        queueItemId: gateCtx.queueItemId,
        resumeKey: gateCtx.resumeKey,
        dedupeKey: req.dedupeKey,
      });
      if (sticky?.kind === "denied") {
        return { ...sticky.resolution, gateOrdinal: sticky.gate.ordinal };
      }
      if (sticky?.kind === "expired") {
        throw new DecisionGateExpiredError(sticky.gate.id, sticky.gate.ordinal);
      }
    }
    try {
      // Checkpoint FIRST — the suspended-turn row is the ownership anchor
      // for `terminalizeOrphanedGate`'s guard: once it references this gate,
      // a resolve/withdraw that lands before the waiter arms is left alone
      // (retryable) instead of consumed by the store-side orphan repair. A
      // crash in this window leaves a checkpoint without a row (inert; the
      // next cycle overwrites it) rather than a row without a checkpoint
      // (an orphan card). Use real toolName + toolArgs so restoreSession
      // can replay this exact tool call.
      await fencedGateWrite(() =>
        session.providers.store.saveSuspendedTurn(
          session.id,
          this.id,
          {
            sessionId: session.id,
            threadId: this.id,
            queueItemId: runningItemId ?? "",
            gateId: gate.id,
            model: session.options.modelSpec ?? session.options.model.id,
            toolCallId,
            toolName,
            toolArgs,
            resumeKey: gateCtx.resumeKey,
            ordinal: gate.ordinal,
            attempt: 1,
            createdAt: Date.now(),
          },
          fence,
        ),
      );

      if (!joiningPending) {
        await session.providers.store.saveDecisionGate(session.id, this.id, gate);
        const gateEntry: SessionEntry = {
          id: uid("e"),
          sessionId: session.id,
          threadId: this.id,
          parentId: null,
          type: "decision_gate",
          gate,
          queueItemId: runningItemId,
          createdAt: Date.now(),
        };
        await fencedGateWrite(() =>
          session.providers.store.appendEntries(session.id, this.id, [gateEntry], fence),
        );
      }

      // Durable block flag under the fence (running → blocked). Gate-blocked
      // turns retain their claim and do not settle until the gate resolves.
      this.blockedGateId = gate.id;
      if (fence && runningItemId) {
        await fencedGateWrite(() =>
          session.providers.store.setSubmissionBlocked(
            session.id,
            this.id,
            runningItemId,
            true,
            fence,
          ),
        );
      }
      this.lastEmittedStatus = "blocked_on_decision_gate";
      await this.fencedEmit(
        {
          type: "status",
          threadId: this.id,
          status: "blocked_on_decision_gate",
        },
        { queueItemId: runningItemId },
      );
      await session.emit(
        { type: "decision_gate", threadId: this.id, gate },
        { eventKey: `gate:${gate.id}:pending`, queueItemId: runningItemId },
      );
    } catch (err) {
      // A partially-opened gate must not survive as a pending row with no
      // registered waiter — that renders as an approval card that neither
      // resolve nor refresh can clear (TKAI-238).
      await this.cleanupFailedGateOpen(gate, fence, runningItemId);
      throw err;
    }

    try {
      const rawResolution = await this.gates.register(gate, async (gateId) => {
        await session.providers.store.updateDecisionGateEntry(
          session.id,
          this.id,
          gateId,
          { resolvedAt: new Date().toISOString(), gate: { ...gate, status: "expired" } },
        );
        await session.emit(
          { type: "decision_gate_expired", threadId: this.id, gateId },
          { eventKey: `gate:${gateId}:expired`, queueItemId: runningItemId },
        );
      });
      // Stamp the gate's ordinal onto the resolution before it is
      // persisted or handed back to the calling tool — the caller (e.g.
      // call_tool's policy audit) needs this to distinguish a
      // restart-replay double-fire (same ordinal) from a fresh
      // legitimate repeat (new ordinal) for the same resumeKey.
      const resolution: DecisionResolution = { ...rawResolution, gateOrdinal: gate.ordinal };
      // Mark gate resolved in store and update DAG entry
      await persistTerminalGate(session.providers.store, session.id, this.id, gate, {
        status: "resolved",
        resolution,
      });
      this.blockedGateId = undefined;
      if (fence && runningItemId) {
        await fencedGateWrite(() =>
          session.providers.store.setSubmissionBlocked(
            session.id,
            this.id,
            runningItemId,
            false,
            fence,
          ),
        );
      }
      await fencedGateWrite(() =>
        session.providers.store.clearSuspendedTurn(session.id, this.id, fence),
      );
      return resolution;
    } catch (err) {
      // Withdrawn or expired: persist the terminal status, then propagate.
      const reason = isDecisionGateWithdrawn(err) ? err.reason : undefined;
      await persistTerminalGate(
        session.providers.store,
        session.id,
        this.id,
        gate,
        reason ? { status: "withdrawn", reason } : { status: "expired" },
      );
      this.blockedGateId = undefined;
      // Flip the durable block back to running so the turn can end and
      // settle normally (the model sees the gate's terminal state).
      if (fence && runningItemId) {
        await fencedGateWrite(() =>
          session.providers.store.setSubmissionBlocked(
            session.id,
            this.id,
            runningItemId,
            false,
            fence,
          ),
        );
      }
      await fencedGateWrite(() =>
        session.providers.store.clearSuspendedTurn(session.id, this.id, fence),
      );
      throw err;
    }
  }

  /**
   * Best-effort unwind after a gate open failed partway. The original open
   * error propagates from the caller regardless of what this method cleans.
   *
   * Stale fence: a successor incarnation owns the turn's durable state.
   * Touch nothing — the row (if one persisted) stays pending so the
   * successor's re-run can adopt it through the join path, and the fenced
   * checkpoint/blocked cleanup below would fail stale anyway. An unfenced
   * withdraw here would yank a gate the successor may have re-armed.
   *
   * Live fence: the turn continues and no waiter will ever own this gate —
   * terminalize the row (created or joined) so it cannot render as an
   * unresolvable approval card, then release the checkpoint and the blocked
   * toggle. Cleanup failures are emitted, not swallowed: a blocked toggle
   * that stays flipped wedges the whole thread (alert, don't auto-repair).
   */
  private async cleanupFailedGateOpen(
    gate: DecisionGate,
    fence: WriteFence | undefined,
    runningItemId: string | undefined,
  ): Promise<void> {
    if (this.blockedGateId === gate.id) this.blockedGateId = undefined;
    if (this.staleFenceDetected) return;
    const store = this.session.providers.store;
    try {
      await persistTerminalGate(store, this.session.id, this.id, gate, {
        status: "withdrawn",
        reason: "abort",
      });
      await this.session.emit(
        { type: "decision_gate_withdrawn", threadId: this.id, gateId: gate.id, reason: "abort" },
        { eventKey: `gate:${gate.id}:withdrawn` },
      );
    } catch (e) {
      this.emitError(
        "gate_open_cleanup_failed",
        e instanceof Error ? e.message : String(e),
      );
    }
    try {
      const suspended = await store.getSuspendedTurn(this.session.id, this.id);
      if (suspended?.gateId === gate.id) {
        await store.clearSuspendedTurn(this.session.id, this.id, fence);
      }
      if (fence && runningItemId) {
        const item = await store.getQueueItem(this.session.id, runningItemId);
        if (item?.status === "blocked_on_decision_gate") {
          await store.setSubmissionBlocked(this.session.id, this.id, runningItemId, false, fence);
        }
      }
    } catch (e) {
      this.emitError(
        "gate_open_cleanup_failed",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  /**
   * Reconstruct the agent transcript from persisted DAG entries.
   *
   * Critical: assistant entries that issued tool calls have those calls in
   * `entry.parts` as `tool_call` parts. We MUST rebuild the AssistantMessage's
   * content[] with both text and ToolCall blocks, otherwise pushing a
   * subsequent toolResult (during replay) produces a malformed
   * [user, assistant(text-only), toolResult] sequence that LLM providers
   * reject. tool/system roles are dropped here — `replayBlocked` re-derives
   * the toolResult message before continuing.
   */
  rehydrateTranscript(entries: SessionEntry[]): void {
    this.agent.state.messages = entriesToAgentMessages(entries, this.session.options.model, {
      attributeAuthors: this.attributeAuthors,
    });
  }

  /**
   * Whether user messages carry a `[from: …]` sender line in the LLM
   * transcript. On when the session is shared (team/org-owned) — several
   * people prompt the same thread there, and the model cannot differentiate
   * them from the text alone. Personal sessions have one author; the line
   * would be noise.
   */
  private get attributeAuthors(): boolean {
    return this.session.owner.type !== "user";
  }

  setMode(mode: QueueMode): void {
    this.mode = mode;
  }

  toThreadData(): ThreadData {
    return {
      id: this.id,
      sessionId: this.session.id,
      key: this.key,
      status: this.paused ? "paused" : "active",
      activeLeafEntryId: undefined,
      queueMode: this.mode,
      paused: this.paused,
      model: this.modelOverride,
      summary: undefined,
      createdAt: this.threadCreatedAt,
      updatedAt: Date.now(),
    };
  }

  /**
   * Set or clear this thread's model override. New value takes effect on
   * the *next* LLM call (in-flight turns finish on their existing model).
   * Pass `null` to clear and fall back to the session default.
   *
   * Persists via `store.saveThread` and emits a `model_switched` engine
   * event so the wire / UI can react.
   */
  async setModel(
    modelId: string | null,
    reason: string = "set_via_api",
  ): Promise<{ fromModel: string; toModel: string }> {
    const sessionDefault = this.session.options.modelSpec ?? this.session.options.model.id;
    const before = this.modelOverride ?? sessionDefault;
    if (modelId === null) {
      this.modelOverride = undefined;
    } else {
      // Resolve before assigning so an unknown id is rejected and the
      // thread keeps its previous setting. With a host resolver present,
      // validate through it (null → same throw as the internal resolver's
      // undefined); absent → today's internal `resolveModelId` path.
      // NoCredentialsError means the spec IS valid (the model resolved) but
      // no key exists yet — accept it: a user must be able to select a model
      // before configuring its key.
      const resolver = this.session.options.resolveModel;
      let resolved: ResolvedModel | PiModel | null | undefined;
      try {
        resolved = resolver ? await resolver(modelId) : resolveModelId(modelId);
      } catch (err) {
        if (!(err instanceof NoCredentialsError)) throw err;
        resolved = { model: err.model };
      }
      if (!resolved) {
        throw new Error(`unknown model id: ${modelId}`);
      }
      this.modelOverride = modelId;
    }
    await this.session.providers.store.saveThread(this.session.id, this.toThreadData());
    const after = this.modelOverride ?? sessionDefault;
    if (before !== after) {
      await this.session.emit({
        type: "model_switched",
        threadId: this.id,
        fromModel: before,
        toModel: after,
        reason,
      });
    }
    return { fromModel: before, toModel: after };
  }

  /** Layered resolution: thread override → session default. Returns the
   *  live pi-ai Model to use for the next LLM call. */
  resolveTurnModel(): PiModel {
    if (this.modelOverride) {
      const m = resolveModelId(this.modelOverride);
      if (m) return m;
      // Stored override no longer resolvable; fall back to session default.
    }
    return this.session.options.model;
  }

  /** Effective model spec string for this turn: thread override → session
   *  default spec (`modelSpec` — the canonical form; `model.id` is the wire
   *  id and only coincides for bare/internal resolution). */
  private turnModelSpec(): string {
    return this.modelOverride ?? this.session.options.modelSpec ?? this.session.options.model.id;
  }

  /**
   * Resolve this turn's model, and — with a host `resolveModel` seam present —
   * stamp its per-turn API key onto `this.turnApiKey`. Absent resolver: the
   * existing synchronous `resolveTurnModel()` path, no key touched
   * (byte-identical). Present resolver: resolve the effective spec through it
   * and hold `{ model, apiKey }` for this turn only. If the resolver can't
   * resolve the (setModel-validated) spec at turn time, fall back to internal
   * resolution + env-key path, mirroring `resolveTurnModel`'s stale-override
   * fallback.
   */
  private async resolveTurnModelForTurn(): Promise<PiModel> {
    const resolver = this.session.options.resolveModel;
    if (!resolver) return this.resolveTurnModel();
    const spec = this.turnModelSpec();
    return withSpan("model.resolve", { "valet.model.spec": spec }, async (span) => {
      const resolved = await resolver(spec);
      if (resolved) {
        span.setAttributes({
          "valet.model.wire_id": resolved.model.id,
          "valet.model.provider": resolved.model.provider,
          // Key PRESENCE only — an undefined key means "env fallback", which
          // is exactly the thing to check when a turn 401s.
          "valet.model.key_source": resolved.apiKey !== undefined ? "resolver" : "env",
        });
        this.turnApiKey = resolved.apiKey;
        return resolved.model;
      }
      span.setAttribute("valet.model.key_source", "internal_fallback");
      return this.resolveTurnModel();
    });
  }

  /**
   * Resume/replay key delivery: with a host resolver present, re-resolve this
   * turn's effective spec and stamp the per-turn key + agent model before the
   * agent continues an interrupted or gate-resolved turn. No-op when the
   * resolver is absent (byte-identical to the pre-seam resume paths).
   *
   * THROWS `NoCredentialsError` straight through — symmetric with the
   * pre-run detection in runItem — and throws `unknown model id` when the
   * resolver returns null (spec no longer resolvable). Swallowing either and
   * continuing with a stale/unset key would silently activate pi-ai's
   * AMBIENT env fallback: a revoked org key could resume on a dev-shell/pod
   * env key the org never authorized. Callers treat the throw as a normal
   * turn failure (the continuation settles `failed`; claim cleaned, no
   * wedge).
   */
  private async applyResolvedKeyForResume(): Promise<void> {
    const resolver = this.session.options.resolveModel;
    if (!resolver) return;
    const spec = this.turnModelSpec();
    const resolved = await resolver(spec);
    if (resolved === null) {
      // Unknown spec — e.g. an admin deleted the custom provider row while
      // the session sat suspended at a gate. Silently proceeding would keep
      // the stale turnApiKey/model and continue on ambient env creds — the
      // exact failure mode the loud-fail contract exists to prevent. Same
      // surface as setModel's unknown-spec rejection; the caller settles the
      // resume `failed`.
      throw new Error(`unknown model id: ${spec}`);
    }
    this.turnApiKey = resolved.apiKey;
    this.agent.state.model = resolved.model;
  }

  async readEntries(opts?: MessageQuery): Promise<SessionEntry[]> {
    return this.session.providers.store.getEntries(this.session.id, this.id, opts);
  }

  // ── internals ───────────────────────────────────────────────────

  /** Current running submission id (for the session heartbeat's lease renewal). */
  runningItemId(): string | undefined {
    return this.runningItem?.id;
  }

  /**
   * Read-only snapshot of this thread's derived queue state from durable
   * rows. Same derivation as the `queue_state` event, without emitting.
   * Used by the `/status` and `/clear` built-ins.
   */
  async currentQueueState(): Promise<QueueState> {
    const items = await this.session.providers.store.listUnsettledSubmissions(this.session.id);
    return deriveQueueState(this.id, items, this.mode, this.paused, this.blockedGateId);
  }

  /** True when this thread is mid-turn (a submission is claimed and running). */
  get hasActiveRun(): boolean {
    return this.runningItem != null;
  }

  /**
   * Best current reading of this thread's agent status, for a subscriber that
   * connects mid-turn (the WS handshake seeds a `status` frame from it).
   * Derived from live in-memory state, so it self-corrects where
   * `lastEmittedStatus` alone would mislead: a resolved gate un-blocks back
   * to `tool_calling` (the gate was raised inside a tool call that is still
   * running), and a claimed-but-not-yet-streaming turn reads `thinking`.
   */
  get currentAgentStatus(): EngineEventStatus {
    if (this.blockedGateId) return "blocked_on_decision_gate";
    if (!this.runningItem) return "idle";
    if (this.lastEmittedStatus === "blocked_on_decision_gate") return "tool_calling";
    if (this.lastEmittedStatus === "idle") return "thinking";
    return this.lastEmittedStatus;
  }

  /**
   * The claim loop. Drives the thread's durable queue: repeatedly claim the
   * thread's runnable head from the store, run the turn under a write fence,
   * settle two-phase, and loop until nothing is claimable. Serialized — a
   * second call while one is in flight joins the same tail (the store's
   * head-blocking makes a redundant claim a harmless null).
   */
  async kick(): Promise<void> {
    if (this.kicking) return this.kickTail;
    this.kicking = true;
    this.kickTail = this.kickLoop()
      .catch((err) => {
        // The loop handles expected failures itself; anything escaping here
        // must not become an unhandled rejection through `void this.kick()`.
        this.emitError("kick_failed", err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        this.kicking = false;
      });
    return this.kickTail;
  }

  private async kickLoop(): Promise<void> {
    const store = this.session.providers.store;
    while (true) {
      if (this.paused) return;
      if (this.runningItem) return;
      const head = await this.unsettledHead();
      if (!head) return;

      // A previous settlement durably recorded its outcome (reserve) but the
      // finalize half failed transiently: retry it under the item's stored
      // current attemptId. The terminalizing head blocks claims until it lands.
      if (head.status === "terminalizing") {
        if (!(await this.retryFinalize(head))) return; // still failing; next sweep retries
        continue;
      }
      // running / blocked head: owned by a live attempt — nothing to claim
      // until it settles (expired-lease reclaim is Task 5 reconciliation).
      if (head.status !== "queued") return;

      // An abort was requested while this item was still queued: settle it
      // `aborted` without ever running it, rather than claiming it.
      if (head.abortRequestedAt !== undefined) {
        await store.settleUnclaimed(this.session.id, this.id, head.id, { outcome: "aborted" });
        await this.emitSettled(head.id, { outcome: "aborted" });
        await this.emitQueueState();
        continue;
      }

      const attemptId = uid("att");
      const claimed = await store.claimSubmission({
        sessionId: this.session.id,
        threadId: this.id,
        itemId: head.id,
        attemptId,
        ownerId: this.session.ownerId,
      });
      if (!claimed) return; // lost the race or head is not actually claimable

      await store.insertAttemptMarker(claimed.id, attemptId);
      this.runningItem = claimed;
      this.turnStartedAt = Date.now();
      const admissionLink = linkFromTraceparent(claimed.metadata?.[TRACEPARENT_METADATA_KEY]);
      this.submissionSpan = engineTracer().startSpan("submission.run", {
        attributes: {
          "valet.session.id": this.session.id,
          "valet.thread.id": this.id,
          "valet.queue_item.id": claimed.id,
          "valet.submission.attempt": claimed.attemptCount,
          // Queue wait — the time between admission and this claim — is a
          // first-order bottleneck signal, invisible inside any child span.
          "valet.submission.queue_wait_ms": Date.now() - claimed.createdAt,
          // Size, not content: enough to correlate "huge prompt" with a slow
          // turn without putting user text on a span.
          "valet.submission.content_chars": JSON.stringify(claimed.content).length,
          ...(claimed.channel ? { "valet.submission.channel": claimed.channel.channelType } : {}),
          ...(claimed.dispatchId ? { "valet.submission.dispatch_id": claimed.dispatchId } : {}),
          ...(claimed.author ? { "valet.submission.author": claimed.author.id } : {}),
        },
        links: admissionLink ? [admissionLink] : undefined,
      });
      this.fence = { itemId: claimed.id, attemptId };
      this.staleFenceDetected = false;
      this.session.ensureTimers();
      await this.emitQueueState();

      // Run-start reconcile window (sandbox reconcile spec, decision 4): the only
      // place convergence may act. Idle = no other thread mid-run and no pending
      // exec jobs. Errors degrade to running stale — never fail the turn.
      if (!this.session.hasOtherActiveRuns(this.id) && this.session.pendingJobCount() === 0) {
        try { await this.session.attachment.reconcile(); } catch (err) { console.error("[thread] reconcile failed, continuing:", err); }
      }

      // First load of repo AGENTS.md instructions (agents-md spec, decision 1):
      // the ready transition's host-hook refresh is async and unawaited, so
      // without this the first turn would race it and run without the
      // fragment. No-op unless a provider exists, the attachment is ready,
      // and no refresh has completed yet. Errors degrade to running without
      // instructions — never fail the turn.
      try {
        await this.session.ensureRepoInstructions();
      } catch (err) {
        console.error("[thread] repo-instructions load failed, continuing:", err);
      }

      let turnFailed = false;
      let turnError: unknown;
      try {
        await this.runItem(claimed);
      } catch (err) {
        turnFailed = true;
        turnError = err;
        this.emitError("run_failed", err instanceof Error ? err.message : String(err));
      }
      // A pre-first-token stream failure may leave NO assistant message for
      // this turn, so settlement can't rely on the transcript to detect it
      // (decideTurnOutcome deliberately ignores stale trailing messages) —
      // runItem records the agent throw independently and it becomes a
      // normal turn failure here.
      if (!turnFailed && this.turnAgentError !== undefined) {
        turnFailed = true;
        turnError = this.turnAgentError;
      }

      // The turn couldn't run because the host resolver threw
      // NoCredentialsError at turn start (`credentialError` is set ONLY by
      // that throw). For the first few attempts, release the claim back to
      // `queued` (fenced) instead of settling `failed`, so the submission
      // stays abortable and re-runs once credentials appear — a racing abort
      // settles it `aborted` via the queued settle-unclaimed path. Past the
      // cap, settle `failed` with the host's own credentials error so a
      // genuinely key-less session gets one bounded, surfaced failure
      // instead of a silent forever-spin.
      // From here to the end of the iteration the claim is installed: every
      // exit — release-success return, ownership-loss abandon, cap
      // fall-through, settleTurn success or throw, and any transient store
      // throw inside the credential-release helper — must clear
      // runningItem/fence exactly once, via the single finally below. A
      // store throw escaping with the claim still set would wedge the thread
      // (heartbeat renews the lease forever, nothing ever settles the item).
      const credentialError = this.credentialError;
      this.credentialError = undefined;
      const releaseFence = this.fence;
      try {
        // Invariant: credentialError and turnFailed are mutually exclusive —
        // runItem catches NoCredentialsError internally and returns normally
        // (it never propagates to the catch that sets turnFailed). The
        // `!turnFailed` guard is therefore provably redundant today, but
        // load-bearing if that invariant ever breaks: a turn that BOTH
        // errored and lacked credentials must settle failed, never enter the
        // release cycle. Keep the guard.
        if (credentialError !== undefined && !turnFailed && releaseFence) {
          const verdict = await this.attemptCredentialRelease(claimed, releaseFence);
          if (verdict === "released") {
            // Emit untagged (queueItemId: null): the item just went back to
            // `queued`, so the envelope must not carry it as a live claim.
            // runningItem/fence themselves clear only in the finally —
            // clearing them early opens an idle window in which a concurrent
            // reconcile pass could install a fresh claim that the pending
            // finally would then strip.
            await this.emitQueueState({ queueItemId: null });
            // Deliberately NO re-kick here: the session's 5s sweep interval
            // is the retry backoff. With pre-run credential detection an
            // immediate re-kick would burn all attempts in milliseconds and
            // defeat the "wait for a key to appear" grace window.
            return;
          }
          if (verdict === "abandon") {
            // A successor attempt owns the item (or it settled): nothing of
            // ours left to settle — but OUR attempt's marker is now stale and
            // no other path cleans it (the successor only deletes its own on
            // settle; the refused release CAS is contract-bound to touch no
            // markers). Delete it here or one row leaks per ownership-loss
            // cycle for the session's lifetime. Best-effort: a transient
            // store blip must not escape to the settlement_failed catch and
            // abort the iteration over pure cleanup — on failure the marker
            // simply leaks this one row.
            try {
              await store.deleteAttemptMarker(claimed.id, releaseFence.attemptId);
            } catch (err) {
              this.emitError(
                "stale_marker_cleanup_failed",
                err instanceof Error ? err.message : String(err),
              );
            }
            return;
          }
          if (verdict === "settle-cap") {
            // Cap reached — settle `failed` with the HOST's message.
            // decideTurnOutcome still yields to a racing abort/supersession
            // first. Append the user entry NOW (every credential attempt
            // returned pre-append, so this cannot double-append): the
            // transcript must record what the user asked when the failure
            // surfaces.
            await this.appendUserEntry(claimed);
            turnFailed = true;
            turnError = credentialError;
          }
          // "settle-owned": a supersession or abort stamp owns the outcome —
          // fall through with turnFailed still false so decideTurnOutcome
          // settles it `superseded`/`aborted` (do NOT release — a re-queued
          // superseded item is an orphan skipped by both unsettledHead and
          // the store's claim head; a re-queued aborted item is a
          // running→queued→aborted flicker on the queue-state stream).
        }

        await this.settleTurn(claimed, turnFailed ? { error: turnError } : undefined);
      } catch (err) {
        // Transient (non-stale) settlement failure: keep the attempt marker so
        // the sweep / reconciliation can finish the job. Do not wedge the
        // thread and do not leak the rejection to void callers.
        this.emitError(
          "settlement_failed",
          err instanceof Error ? err.message : String(err),
        );
        return;
      } finally {
        this.submissionSpan?.end();
        this.submissionSpan = undefined;
        this.runningItem = null;
        this.fence = undefined;
      }
    }
  }

  /**
   * One credential-release cycle for a claimed turn whose host resolver
   * threw `NoCredentialsError` before the turn could run. Consults and
   * updates the DURABLE budget on the queue item (`credentialAttempts` /
   * `lastCredentialReleaseAt` — written atomically inside the release CAS,
   * surviving restarts so a crash-looping keyless session still fails
   * boundedly). Backoff-aware: a release within
   * `credentialReleaseBackoffMs` of the last COUNTED cycle coalesces into it
   * (external kicks fire on every submit/resume/abort; a burst must not burn
   * the budget in milliseconds).
   *
   * Verdicts for the claim loop:
   *  - "released": claim released back to `queued` (budget persisted).
   *  - "settle-cap": budget exhausted — settle `failed` with the host error.
   *  - "settle-owned": a durable stamp (supersession OR abort) landed on the
   *    item, possibly mid-window — the outcome belongs to that stamp: settle
   *    under our attempt with no failure so decideTurnOutcome yields
   *    `superseded`/`aborted` accordingly (never re-queue: a superseded
   *    re-queue is an orphan; an aborted one is a queue-state flicker).
   *  - "abandon": a successor attempt owns the item (or it settled) —
   *    nothing of ours left to settle.
   */
  private async attemptCredentialRelease(
    claimed: QueueItem,
    releaseFence: WriteFence,
  ): Promise<"released" | "settle-cap" | "settle-owned" | "abandon"> {
    const store = this.session.providers.store;
    // Mirror settleTurn's guards: a successor attempt may own the item now.
    if (this.staleFenceDetected) return "abandon";
    const current = await store.getQueueItem(this.session.id, claimed.id);
    if (!current || current.status !== "running") return "abandon";
    if (current.supersededByItemId || current.abortRequestedAt !== undefined) {
      return "settle-owned";
    }

    const now = Date.now();
    const backoffMs =
      this.session.options.credentialReleaseBackoffMs ?? CREDENTIAL_RELEASE_BACKOFF_MS;
    const prevCount = current.credentialAttempts ?? 0;
    const lastAt = current.lastCredentialReleaseAt;
    const withinBackoff = lastAt !== undefined && now - lastAt < backoffMs;
    const count = withinBackoff ? prevCount : prevCount + 1;
    // NB: the durable counter records COMPLETED release cycles, not the
    // terminal attempt — on settle-cap the row keeps credential_attempts at
    // MAX-1 (or lower under burst coalescing) because the cap returns before
    // any CAS and settlement deliberately writes no counter. Any future
    // feature that re-runs a settled row must reset or re-derive the budget
    // rather than trusting this value.
    if (!withinBackoff && count >= MAX_CREDENTIAL_ATTEMPTS) return "settle-cap";

    // The release CAS is the atomic authority, not the `current` snapshot
    // above: it refuses when a supersession or abort stamp landed between
    // the snapshot read and this commit (TOCTOU window). The budget counters
    // ride the same CAS — persisted iff the release lands.
    const released = await store.releaseSubmission(
      this.session.id,
      this.id,
      claimed.id,
      releaseFence,
      { attempts: count, lastReleaseAt: withinBackoff && lastAt !== undefined ? lastAt : now },
    );
    if (released) return "released";
    // CAS refused. Re-read to decide who owns the item now: still running
    // under OUR attempt means a supersession/abort stamped after the
    // snapshot — we must settle it ourselves (a bare CAS-fail must never
    // strand the item running+stamped). Anything else: a successor owns it.
    const after = await store.getQueueItem(this.session.id, claimed.id);
    if (!after || after.status !== "running" || after.attemptId !== releaseFence.attemptId) {
      return "abandon";
    }
    return "settle-owned";
  }

  /**
   * The thread's oldest unsettled, non-superseded, non-collecting submission —
   * mirrors the store's claim-head rule. A running/blocked/terminalizing head
   * blocks every later item from being claimed.
   */
  private async unsettledHead(): Promise<QueueItem | undefined> {
    const all = await this.session.providers.store.listUnsettledSubmissions(this.session.id);
    return all
      .filter((i) => i.threadId === this.id && i.status !== "collecting" && !i.supersededByItemId)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  }

  /**
   * Retry the finalize half of an interrupted settlement. The outcome is
   * already durably recorded on the item; finalize re-runs the fence against
   * the item's stored CURRENT attemptId (never cleared on terminal
   * transitions), so this is safe even after the in-memory fence is gone.
   */
  async retryFinalize(item: QueueItem): Promise<boolean> {
    const store = this.session.providers.store;
    const attemptId = item.attemptId;
    if (!attemptId) return false; // defensive: terminalizing items always carry one
    const fence: WriteFence = { itemId: item.id, attemptId };
    try {
      await store.finalizeSettlement(this.session.id, this.id, item.id, fence);
    } catch (err) {
      if (err instanceof StaleAttemptError) return false; // successor owns it now
      this.emitError(
        "settlement_failed",
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
    await store.deleteAttemptMarker(item.id, attemptId);
    await this.emitSettled(item.id, item.outcome ?? { outcome: "completed" });
    await this.emitQueueState();
    return true;
  }

  /**
   * Two-phase settlement for a claimed turn. Skipped when the turn is still
   * blocked on a decision gate (the claim is retained), or when a stale fence
   * signalled that a successor already owns the item.
   */
  private async settleTurn(item: QueueItem, turnFailure?: { error: unknown }): Promise<void> {
    return this.inSubmissionContext(() =>
      withSpan(
        "submission.settle",
        {
          "valet.session.id": this.session.id,
          "valet.thread.id": this.id,
          "valet.queue_item.id": item.id,
        },
        (span) => this.settleTurnInner(item, turnFailure, span),
      ),
    );
  }

  private async settleTurnInner(
    item: QueueItem,
    turnFailure: { error: unknown } | undefined,
    span: Span,
  ): Promise<void> {
    if (this.staleFenceDetected) {
      // A successor owns this item; do not settle. (Zombie self-fencing.)
      return;
    }
    const fence = this.fence;
    if (!fence) return;
    const store = this.session.providers.store;
    const current = await store.getQueueItem(this.session.id, item.id);
    if (!current) return;
    // Gate-blocked turns do not settle — the claim is retained until the gate
    // resolves and the turn actually ends.
    if (current.status === "blocked_on_decision_gate") return;
    if (current.status === "settled" || current.status === "terminalizing") return;

    const outcome = this.decideTurnOutcome(current, turnFailure);
    span.setAttribute("valet.submission.outcome", outcome.outcome);
    this.submissionSpan?.setAttribute("valet.submission.outcome", outcome.outcome);
    recordSettlement(
      outcome.outcome,
      this.turnStartedAt !== undefined ? Math.max(0, this.turnStartedAt - item.createdAt) : undefined,
    );
    if (outcome.outcome === "failed") {
      markSpanError(span, outcome.error ?? "submission failed");
      if (this.submissionSpan) markSpanError(this.submissionSpan, outcome.error ?? "submission failed");
    }
    let patchRef: SettlePatchRef;
    try {
      await store.reserveSettlement(this.session.id, this.id, item.id, outcome, fence);
      await this.repairRestState(item, fence);
      // Best-effort workspace patch (engine traces spec, change 3) — runs
      // between reserve and finalize so the record lands in finalize's own
      // transaction, but its own I/O never throws and never weakens the CAS.
      patchRef = await this.captureSettlePatch(item);
      await store.finalizeSettlement(this.session.id, this.id, item.id, fence, patchRef);
    } catch (err) {
      if (err instanceof StaleAttemptError) {
        this.staleFenceDetected = true;
        return;
      }
      throw err;
    }
    await store.deleteAttemptMarker(item.id, fence.attemptId);
    await this.emitSettled(item.id, outcome, patchRef);
    await this.emitQueueState();
  }

  /**
   * Best-effort settle-time patch capture (engine traces spec, change 3).
   * Never throws; a sandbox that isn't currently `ready` is skipped rather
   * than re-provisioned (a hibernated sandbox must not be woken to diff it).
   */
  private async captureSettlePatch(item: QueueItem): Promise<SettlePatchRef> {
    return withSpan(
      "patch.capture",
      { "valet.session.id": this.session.id, "valet.queue_item.id": item.id },
      async (span) => {
        const ref = await capturePatch({
          sessionId: this.session.id,
          queueItemId: item.id,
          blobs: this.session.providers.blobs,
          startRef: this.session.options.startRef,
          sandbox: this.session.attachment.current(),
          attachmentState: this.session.attachment.state,
        });
        span.setAttribute("valet.patch.status", ref.status);
        if (ref.reason !== undefined) span.setAttribute("valet.patch.reason", ref.reason);
        if (ref.bytes !== undefined) span.setAttribute("valet.patch.bytes", ref.bytes);
        if (ref.status === "failed") markSpanError(span, ref.reason ?? "patch capture failed");
        return ref;
      },
    );
  }

  /** Map the turn's terminal state to a SubmissionOutcome. */
  private decideTurnOutcome(
    current: QueueItem,
    turnFailure?: { error: unknown },
  ): SubmissionOutcome {
    // Agent messages carry no queueItemId, so scope the transcript read with
    // the in-memory turn marker instead: `currentAssistantMessageId` is
    // cleared at turn start (runItem) and set on the turn's own
    // `message_start`, so an undefined value means the trailing assistant
    // message predates this item (e.g. the credential-cap path appends
    // nothing) — its stopReason must not decide this item's outcome. A real
    // abort OF THIS ITEM still wins via the durable `abortRequestedAt` stamp
    // checked below, which `Thread.abort` writes before interrupting the
    // stream.
    const last = this.agent.state.messages[this.agent.state.messages.length - 1];
    const stop =
      this.currentAssistantMessageId !== undefined && last && last.role === "assistant"
        ? last.stopReason
        : undefined;
    if (current.supersededByItemId) return { outcome: "superseded" };
    if (current.abortRequestedAt !== undefined || stop === "aborted") return { outcome: "aborted" };
    // A throw outside the agent stream (tool building, store I/O, model
    // resolution) must settle `failed` — the last agent message may be a stale
    // prior turn's clean stop and would otherwise decide `completed`.
    if (turnFailure) {
      const e = turnFailure.error;
      return { outcome: "failed", error: e instanceof Error ? e.message : String(e) };
    }
    if (stop === "error") {
      const errText = last && last.role === "assistant" ? last.errorMessage : undefined;
      return { outcome: "failed", error: errText ?? "turn ended with an error" };
    }
    // "stop" and "length" both settle completed — a length-terminated turn
    // still ended with usable output (revisit if we want to distinguish).
    return { outcome: "completed" };
  }

  /**
   * Rest-state repair (spec, Terminalization): any trailing assistant tool_call
   * part still marked `running` when the turn ends (interrupted mid-tool) is
   * rewritten to an error part — never re-executed. Fenced.
   */
  private async repairRestState(
    item: QueueItem,
    fence: WriteFence | undefined,
    errorText: string = "interrupted",
  ): Promise<void> {
    const store = this.session.providers.store;
    const entries = await store.getEntries(this.session.id, this.id);
    for (const e of entries) {
      if (e.type !== "message" || e.role !== "assistant") continue;
      if (e.queueItemId !== item.id) continue;
      const parts = e.parts;
      if (!parts) continue;
      let mutated = false;
      for (const p of parts) {
        if (p.type === "tool_call" && p.status === "running") {
          p.status = "error";
          p.error = errorText;
          mutated = true;
        }
      }
      if (mutated) {
        await store.updateEntry(this.session.id, this.id, e, fence);
      }
    }
  }

  private async emitSettled(
    itemId: string,
    outcome: SubmissionOutcome,
    patch?: SettlePatchRef,
  ): Promise<void> {
    // Deterministic eventKey `settled:{itemId}`: every settlement path (fenced
    // two-phase, retryFinalize, reconciliation, and the fenceless
    // settleUnclaimed sites) routes through here, so a double-emission across
    // restart/reconcile paths dedupes to exactly one durable row per item.
    await this.session.emit(
      {
        type: "submission_settled",
        sessionId: this.session.id,
        threadId: this.id,
        queueItemId: itemId,
        outcome,
        ...(patch ? { patch } : {}),
      },
      { eventKey: `settled:${itemId}`, queueItemId: itemId },
    );
  }

  /**
   * Reconciliation executor — settle branch (steps 1,2,3,5,6). Never-claimed
   * items (still queued/collecting) settle via the fenceless `settleUnclaimed`
   * CAS; claimed items (running/blocked) settle under a freshly-owned attempt so
   * the two-phase reserve/finalize is fenced. Superseded items additionally
   * withdraw their still-pending gate (carry-forward: steer-crash cleanup).
   */
  async settleReconciled(
    item: QueueItem,
    outcome: SubmissionOutcome,
    suspended: SuspendedTurnState | null,
  ): Promise<void> {
    const store = this.session.providers.store;

    if (item.status === "queued" || item.status === "collecting") {
      const ok = await store.settleUnclaimed(this.session.id, this.id, item.id, outcome);
      if (ok) {
        await this.emitSettled(item.id, outcome);
        await this.emitQueueState();
      }
      return;
    }

    // Claimed (running / blocked): own a fresh attempt so the settle is fenced.
    const attemptId = uid("att");
    const expectedAttemptId = item.attemptId;
    if (!expectedAttemptId) return; // defensive: claimed items always carry one
    const replaced = await store.replaceSubmissionAttempt(
      this.session.id,
      this.id,
      item.id,
      {
        sessionId: this.session.id,
        threadId: this.id,
        itemId: item.id,
        attemptId,
        ownerId: this.session.ownerId,
      },
      { expectedAttemptId },
    );
    if (!replaced) return; // lost the CAS — a successor owns it now
    const fence: WriteFence = { itemId: item.id, attemptId };

    // Carry-forward: a crash between the steer supersession stamp and the gate
    // withdrawal leaves a pending gate on the superseded item. Clean it up
    // durably (reason 'steer') as part of settling it superseded.
    if (outcome.outcome === "superseded" && suspended) {
      const gate = await store.getDecisionGate(this.session.id, suspended.gateId);
      if (gate && gate.status === "pending") {
        await persistTerminalGate(store, this.session.id, this.id, gate, {
          status: "withdrawn",
          reason: "steer",
        });
        await this.session.emit(
          {
            type: "decision_gate_withdrawn",
            threadId: this.id,
            gateId: gate.id,
            reason: "steer",
          },
          { eventKey: `gate:${gate.id}:withdrawn` },
        );
      }
    }

    let patchRef: SettlePatchRef;
    try {
      await store.reserveSettlement(this.session.id, this.id, item.id, outcome, fence);
      await this.repairRestState(item, fence);
      if (suspended) await store.clearSuspendedTurn(this.session.id, this.id, fence);
      // A claimed-then-reconciled item may have run tools before the crash or
      // supersession — capture whatever landed on disk, same best-effort
      // contract as the normal settle path.
      patchRef = await this.captureSettlePatch(item);
      await store.finalizeSettlement(this.session.id, this.id, item.id, fence, patchRef);
    } catch (err) {
      if (err instanceof StaleAttemptError) return; // successor owns it now
      throw err;
    }
    await store.deleteAttemptMarker(item.id, attemptId);
    await this.emitSettled(item.id, outcome, patchRef);
    await this.emitQueueState();
  }

  /**
   * Reconciliation executor — gate branch (step 4). Takes over the blocked
   * turn's attempt (fresh attemptId, this instance's ownerId) so the retained
   * claim's lease renews under our heartbeat and the eventual replay's writes
   * are fenced, then either re-arms the pending gate or replays the resolved
   * one. Mirrors the pre-Task-5 `resumeBlockedThreadIfReady`, now attempt-owned.
   */
  async reconcileGate(
    item: QueueItem,
    suspended: SuspendedTurnState,
    mode: "rearm" | "replay",
  ): Promise<void> {
    const store = this.session.providers.store;
    const attemptId = uid("att");
    const expectedAttemptId = item.attemptId;
    if (!expectedAttemptId) return;
    const replaced = await store.replaceSubmissionAttempt(
      this.session.id,
      this.id,
      item.id,
      {
        sessionId: this.session.id,
        threadId: this.id,
        itemId: item.id,
        attemptId,
        ownerId: this.session.ownerId,
      },
      { expectedAttemptId },
    );
    if (!replaced) return; // lost the CAS
    await store.insertAttemptMarker(item.id, attemptId);
    this.runningItem = replaced;
    this.turnStartedAt = Date.now();
    this.fence = { itemId: item.id, attemptId };
    this.staleFenceDetected = false;
    this.session.ensureTimers();

    const gate = await store.getDecisionGate(this.session.id, suspended.gateId);
    if (!gate) {
      // Gate vanished between the decision and here — nothing to re-arm.
      this.runningItem = null;
      this.fence = undefined;
      return;
    }

    if (mode === "rearm") {
      this.armPendingGateForRestart(gate, suspended);
    } else {
      const entries = await store.getEntries(this.session.id, this.id);
      const entry = entries.find(
        (e) => e.type === "decision_gate" && e.gate.id === gate.id,
      );
      const resolution = entry && entry.type === "decision_gate" ? entry.resolution : undefined;
      if (!resolution) {
        this.emitError("replay_missing_resolution", `gate ${gate.id} resolved but no resolution stored`);
        this.runningItem = null;
        this.fence = undefined;
        return;
      }
      void this.replayBlocked({ suspended, resolution });
    }
    await this.emitQueueState();
  }

  /**
   * Reconciliation executor — resume branch (step 7). Own a fresh attempt (CAS
   * on the dead one), record the marker, repair the transcript rest-state
   * FIRST (dangling tool_call parts → error, never re-executed — per the
   * continuation contract, an honest error is the only safe injection), rehydrate
   * the agent transcript, append synthetic toolResults for the interrupted
   * calls so the trailing message is toolResult-convertible, then continue the
   * turn and settle it normally.
   */
  async resumeInterrupted(item: QueueItem): Promise<void> {
    const store = this.session.providers.store;
    const attemptId = uid("att");
    const expectedAttemptId = item.attemptId;
    if (!expectedAttemptId) return;
    const replaced = await store.replaceSubmissionAttempt(
      this.session.id,
      this.id,
      item.id,
      {
        sessionId: this.session.id,
        threadId: this.id,
        itemId: item.id,
        attemptId,
        ownerId: this.session.ownerId,
      },
      { expectedAttemptId },
    );
    if (!replaced) return; // lost the CAS
    await store.insertAttemptMarker(item.id, attemptId);
    this.runningItem = replaced;
    this.turnStartedAt = Date.now();
    this.fence = { itemId: item.id, attemptId };
    this.staleFenceDetected = false;
    this.session.ensureTimers();
    await this.emitQueueState();

    await this.driveResumeToCompletion(replaced, "interrupted — result lost in restart");
  }

  /**
   * Drive an interrupted turn we already own (`runningItem` + `fence` installed
   * by the caller) to completion and settle it. Repairs the dangling tool_call
   * to an error carrying `repairMessage`, clears any stale suspended-gate
   * checkpoint, flips the durable block back to running, rehydrates the
   * transcript, continues the agent so the model sees the repaired state, then
   * settles normally. Shared by `resumeInterrupted` (step-7 resume) and the
   * re-armed-gate expiry/withdrawal terminalization (`terminalizeReconciledGate`).
   */
  private async driveResumeToCompletion(item: QueueItem, repairMessage: string): Promise<void> {
    return withSpan(
      "agent.turn",
      {
        "valet.session.id": this.session.id,
        "valet.thread.id": this.id,
        "valet.queue_item.id": item.id,
        "valet.turn.resumed": true,
      },
      async (span) => {
        this.turnSpan = span;
        this.turnToolCallCount = 0;
        this.llmRoundStartedAt = Date.now();
        try {
          await this.driveResumeToCompletionInner(item, repairMessage);
        } finally {
          this.turnSpan = undefined;
          this.llmSpan?.end();
          this.llmSpan = undefined;
        }
      },
    );
  }

  private async driveResumeToCompletionInner(item: QueueItem, repairMessage: string): Promise<void> {
    const store = this.session.providers.store;
    const fence = this.fence;
    if (!fence) return;

    let turnFailed = false;
    let turnError: unknown;
    try {
      // Rest-state repair FIRST — before appending any recovery output.
      await this.repairRestState(item, fence, repairMessage);

      // A resume reached from the blocked fall-through (gate expired/withdrawn/
      // missing while the engine was down) still has the suspended-turn
      // checkpoint on disk; clear it so a later restart doesn't try to replay a
      // dead gate.
      const staleSuspended = await store.getSuspendedTurn(this.session.id, this.id);
      if (staleSuspended && staleSuspended.queueItemId === item.id) {
        await store.clearSuspendedTurn(this.session.id, this.id, fence);
      }
      // Same fall-through: flip the durable block back to running (strict
      // blocked→running toggle, done once) so the resumed turn can settle —
      // settleTurn refuses to settle a blocked item.
      if (item.status === "blocked_on_decision_gate") {
        await store.setSubmissionBlocked(this.session.id, this.id, item.id, false, fence);
      }

      // Rehydrate from the repaired entries. entriesToAgentMessages answers
      // every resolved (completed/error) tool call — including the crash point
      // just repaired to an interrupted error — so the trailing message is
      // toolResult-convertible, satisfying the continuation contract. No
      // separate synthetic append: entriesToAgentMessages is the single owner
      // of toolResult emission (no callId is ever answered twice).
      const entries = await store.getEntries(this.session.id, this.id);
      this.agent.state.messages = entriesToAgentMessages(
        entries,
        {
          api: this.session.options.model.api,
          provider: this.session.options.model.provider,
          id: this.session.options.model.id,
        },
        { attributeAuthors: this.attributeAuthors },
      );
      this.agent.state.tools = this.buildTools();

      // Host resolver (if any) delivers this resumed turn's per-turn key before
      // the continuation LLM call; no-op when absent.
      await this.applyResolvedKeyForResume();
      await this.agent.continue();
      await this.agent.waitForIdle();
    } catch (err) {
      turnFailed = true;
      turnError = err;
      this.emitError("resume_failed", err instanceof Error ? err.message : String(err));
    } finally {
      this.turnApiKey = undefined;
    }

    try {
      await this.settleTurn(item, turnFailed ? { error: turnError } : undefined);
    } catch (err) {
      this.emitError("settlement_failed", err instanceof Error ? err.message : String(err));
      this.runningItem = null;
      this.fence = undefined;
      return;
    }
    this.runningItem = null;
    this.fence = undefined;
    void this.kick();
  }

  /**
   * Emit the derived `queue_state` event for this thread from durable rows.
   * The emit envelope's retention-linkage `queueItemId` defaults to the
   * running item; pass `{ queueItemId: null }` to emit untagged (used by the
   * credential-release path, where the item has just gone back to `queued`
   * but the in-memory claim must stay installed until the loop's finally —
   * clearing it early opens a window for a concurrent reconcile to install a
   * fresh claim that the pending finally would strip).
   */
  private async emitQueueState(opts?: { queueItemId?: string | null }): Promise<void> {
    const items = await this.session.providers.store.listUnsettledSubmissions(this.session.id);
    const state = deriveQueueState(this.id, items, this.mode, this.paused, this.blockedGateId);
    const tag = opts?.queueItemId === undefined ? this.runningItem?.id : opts.queueItemId;
    await this.session.emit(
      { type: "queue_state", threadId: this.id, state },
      { queueItemId: tag ?? undefined },
    );
  }

  /**
   * Build and persist the turn's user MessageEntry (signal envelope handling
   * included) under the current fence, and return the text the model actually
   * sees this turn. Called by `runItem` on the normal path and by the claim
   * loop's credential-cap branch — a capped keyless submission must still
   * leave a transcript record of what the user asked (every pre-cap
   * credential attempt returns BEFORE appending, so the cap append is the
   * item's first and only one).
   */
  private async appendUserEntry(
    item: QueueItem,
  ): Promise<{ text: string; attachments: MessageEntry["attachments"] }> {
    // Signal content persists as its raw body + `signal` metadata; the text
    // the model actually sees this turn is the same rendered XML envelope
    // `entriesToAgentMessages` would reconstruct on reload (single render
    // function, two call sites).
    let signalMeta: MessageEntry["signal"];
    let text: string;
    let entryContent: string;
    if (isSignalContent(item.content)) {
      signalMeta = buildSignalMeta(item.content, item.metadata);
      text = renderSignalEnvelope(signalMeta, item.content.body);
      entryContent = item.content.body;
    } else {
      text = promptText(item.content);
      entryContent = text;
    }

    // Extract attachments if the prompt content has them.
    let attachments: MessageEntry["attachments"];
    if (
      !isSignalContent(item.content) &&
      typeof item.content === "object" &&
      item.content !== null &&
      "attachments" in item.content &&
      Array.isArray(item.content.attachments)
    ) {
      // Runtime validation of each attachment element to guard against malformed wire data
      const validated: MessageEntry["attachments"] = [];
      for (const att of item.content.attachments) {
        if (typeof att !== "object" || att === null) continue;
        if (att.type === "file") {
          // Sandbox file (upload subsystem): persist path/size/hash so the
          // REST projection and the transcript note survive reload. A
          // malformed file attachment is DROPPED with a warning — it must
          // never fall through to the image branch, where it would persist
          // as a phantom image with no url/data and silently vanish from
          // the projection and the transcript note on reload.
          if (
            typeof att.path === "string" &&
            typeof att.bytes === "number" &&
            typeof att.sha256 === "string" &&
            typeof att.name === "string"
          ) {
            validated.push({
              type: "file" as const,
              path: att.path,
              bytes: att.bytes,
              sha256: att.sha256,
              mimeType: att.mimeType,
              markdownPath: att.markdownPath,
              extractedTo: att.extractedTo,
              extractedFiles: att.extractedFiles,
              name: att.name,
            });
          } else {
            console.warn(
              `thread ${this.id}: dropping malformed file attachment (name=${String(att.name)})`,
            );
          }
        } else if (typeof att.mimeType === "string") {
          // Data/url-carrying media (images; channel audio/file bytes keep
          // their long-standing image-shaped persistence).
          validated.push({
            type: "image" as const,
            url: att.url,
            data: att.data,
            mimeType: att.mimeType,
            name: att.name,
          });
        }
        // Skip malformed elements silently; real issues will surface in model calls
      }
      attachments = validated.length > 0 ? validated : undefined;
    }

    // IDEMPOTENT: skip when this submission's user entry already exists — a
    // transient settle throw after the credential-cap append leaves a
    // `running` item WITH its user entry; the retried attempt (fresh re-run
    // or a second cap pass) must not duplicate it. Return the persisted
    // entry's attachments (the authoritative on-disk shape) so a retried
    // attempt still feeds the model the same image blocks.
    const existing = await this.session.providers.store.getEntries(this.session.id, this.id);
    const existingUserEntry = existing.find(
      (e): e is MessageEntry =>
        e.type === "message" && e.role === "user" && e.queueItemId === item.id,
    );
    if (existingUserEntry) {
      return { text, attachments: existingUserEntry.attachments };
    }
    // QueueItem.metadata flows through onto the entry so synthetic flags like
    // compaction_continue survive into the DAG for client UIs and for later
    // restoration.

    const userEntry: MessageEntry = {
      id: uid("e"),
      sessionId: this.session.id,
      threadId: this.id,
      parentId: null,
      type: "message",
      role: "user",
      content: entryContent,
      signal: signalMeta,
      author: item.author,
      channel: item.channel,
      attachments,
      // signalStamp (when present) has already been lifted into `signal`
      // above; stripping it here avoids duplicating the sender stamp into
      // the persisted entry's metadata (and onto the wire) a second time.
      // Built as a fresh object so the queue item's own stored metadata is
      // never mutated.
      metadata: stripSignalStamp(item.metadata),
      queueItemId: item.id,
      createdAt: Date.now(),
    };
    await this.fencedWrite(() =>
      this.session.providers.store.appendEntries(this.session.id, this.id, [userEntry], this.fence),
    );
    return { text, attachments };
  }

  /**
   * Run the claimed turn inside an `agent.turn` span, itself parented under
   * the live `submission.run` span. The span's usage/cost/model attributes
   * are stamped by the `turn_end` handler via `this.turnSpan`; children
   * (model resolution, tool executions, sandbox execs, credential reads)
   * nest automatically through the host's context manager.
   */
  private async runItem(item: QueueItem): Promise<void> {
    return this.inSubmissionContext(() =>
      withSpan(
        "agent.turn",
        {
          "valet.session.id": this.session.id,
          "valet.thread.id": this.id,
          "valet.queue_item.id": item.id,
          // Context size going INTO the turn — the first thing to look at
          // when a turn is slow (big context → slow rounds, compaction risk).
          "valet.turn.context_messages": this.agent.state.messages.length,
          ...(item.role !== undefined ? { "valet.turn.role": item.role } : {}),
          ...(item.model !== undefined ? { "valet.turn.model_override": item.model } : {}),
        },
        async (span) => {
          this.turnSpan = span;
          this.turnToolCallCount = 0;
          this.llmRoundStartedAt = Date.now();
          try {
            await this.runItemInner(item);
          } finally {
            this.turnSpan = undefined;
            this.llmSpan?.end();
            this.llmSpan = undefined;
          }
        },
      ),
    );
  }

  /** Run `fn` with the live `submission.run` span as the active parent. */
  private inSubmissionContext<T>(fn: () => Promise<T>): Promise<T> {
    const span = this.submissionSpan;
    if (!span) return fn();
    return otelContext.with(otelTrace.setSpan(otelContext.active(), span), fn);
  }

  private async runItemInner(item: QueueItem): Promise<void> {
    this.aborted = false;
    this.credentialError = undefined;
    this.turnAgentError = undefined;
    this.currentAssistantMessageId = undefined;
    this.currentAssistantParts = [];
    this.currentToolCalls.clear();

    // Warm-on-claim (spec decision 5): kick sandbox provisioning at the
    // start of the claimed turn, in parallel with the LLM call — never at
    // session-create time. Hoisted ABOVE model resolution so provisioning is
    // amortized over credential-release cycles too (a keyless turn still
    // warms; the sandbox is ready by the time a key appears). Fire-and-forget;
    // tool ops that touch the sandbox await readiness themselves via
    // PolicySandbox. Sessions opted out via `warmSandboxOnClaim: false`
    // (e.g. orchestrators) stay sandbox-less until a turn's tool actually
    // touches the filesystem — the lazy PolicySandbox attachment provisions
    // on that first touch.
    if (this.session.options.warmSandboxOnClaim !== false) {
      this.session.attachment.warm();
    }

    // Layered model resolution (thread override → session default), BEFORE
    // the user-entry append and buildTools. A host resolver that throws
    // NoCredentialsError means the turn cannot reach the model at all: flag
    // it for the claim loop's release path and return with NO user entry
    // appended, NO agent run, and NO assistant error entry — so bounded
    // credential retries never duplicate entries. Any OTHER resolver throw
    // (disabled provider, model not active, unknown provider) settles the
    // turn `failed`: append the user entry FIRST so the prompt is still in
    // the transcript when the failure surfaces, then rethrow with an
    // identical failure surface.
    let turnModel: PiModel;
    try {
      turnModel = await this.resolveTurnModelForTurn();
    } catch (err) {
      if (err instanceof NoCredentialsError) {
        this.credentialError = err;
        return;
      }
      await this.appendUserEntry(item);
      throw err;
    }

    // Persist the user message entry (shared helper — the claim loop's
    // credential-cap branch appends the same entry shape). Threading
    // `attachments` through to `runAgent` is what keeps a turn-1 image in
    // `agent.state.messages` across subsequent turns: the LLM sees the image
    // on every downstream call, not just the turn it was uploaded on.
    const { text, attachments } = await this.appendUserEntry(item);

    // Build the AgentTool list with closures over this turn's ToolContext.
    this.agent.state.tools = this.buildTools();

    // Apply the turn model (resolved above) BEFORE the role overlay so a
    // role's model frontmatter still wins for that one turn. The baseline is
    // captured here so we restore the right thing, not whatever the role
    // overlaid.
    const baselineModel = this.agent.state.model;
    if (turnModel !== baselineModel) {
      this.agent.state.model = turnModel;
    }

    // Repo AGENTS.md instructions overlay (agents-md spec, decision 4):
    // applied FIRST so the composition is base → systemContext → repo
    // instructions → role → cold hint, and restored LAST so the existing
    // overlays nest unchanged inside it.
    const repoInstructionsPrompt = this.applyRepoInstructionsForTurn();
    // Apply role overlay (system-prompt overlay + optional model override) for
    // this one turn. Restored unconditionally in finally.
    const roleOverlay = this.applyRoleForTurn(item);
    // Cold-attachment hint (spec decision 7), applied AFTER the role overlay
    // so the two compose (role text, then hint). Restored unconditionally in
    // finally, before the role restore, so both idioms nest correctly
    // whether or not a role was applied this turn.
    const coldHintPrompt = this.applyColdHintForTurn();
    // The sender line must match what entriesToAgentMessages renders for
    // this entry on reload — same gate (shared owner, non-signal), same
    // render function — or the hot and cold transcripts diverge.
    const sender =
      this.attributeAuthors && !isSignalContent(item.content) ? item.author : undefined;
    try {
      try {
        await this.runAgent(text, attachments, sender);
      } catch (err) {
        // Record the throw for settlement: a stream failing before its first
        // message_start leaves no assistant message this turn, and
        // decideTurnOutcome ignores stale trailing messages — without this
        // the turn would settle `completed`. The claim loop folds it into
        // turnFailed; abort/supersession still take precedence there.
        this.turnAgentError = err;
        this.emitError("agent_failed", err instanceof Error ? err.message : String(err));
      }

      // Proactive compaction: if this turn pushed us past usable, run a
      // compaction pass before yielding back to the queue. Reactive
      // compaction (overflow retry) is handled inline in runAgent.
      if (this.shouldCompactProactive()) {
        try {
          await this.compactThread({ mode: "proactive" });
        } catch (err) {
          this.emitError(
            "compaction_failed",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    } finally {
      this.restoreColdHintAfterTurn(coldHintPrompt);
      this.restoreRoleAfterTurn(roleOverlay);
      this.restoreRepoInstructionsAfterTurn(repoInstructionsPrompt);
      // Restore the agent's baseline model so the next turn picks up any
      // mutation we made via setModel. We compute the override fresh on
      // each turn anyway, but keeping state tidy avoids surprises.
      this.agent.state.model = baselineModel;
      // Per-turn key is turn-scoped only — clear it so the next turn re-resolves
      // (rotation applies next turn; a resolver-less session never set it).
      this.turnApiKey = undefined;
    }
  }

  /**
   * Cold-attachment model hint (spec decision 7): when the sandbox
   * attachment isn't ready at turn start, appends a hint to the
   * (role-overlaid) system prompt telling the model filesystem/shell tools
   * will wait. Returns the pre-hint prompt so the caller can restore it
   * unconditionally in the turn's finally, regardless of whether a role was
   * also applied this turn.
   *
   * For `warmSandboxOnClaim: false` sessions the hint applies only while
   * the attachment is actually `provisioning` — a lazy session's earlier
   * turn may have kicked a provision that is still booting when this turn
   * claims. In the `detached` state nothing is provisioning (no warm()
   * kick happened), so a "provisioning" hint would be false and the lazy
   * first-touch contract covers it silently instead.
   */
  private applyColdHintForTurn(): string {
    const preHintPrompt = this.agent.state.systemPrompt;
    if (this.session.attachment.state === "ready") return preHintPrompt;
    if (this.session.options.warmSandboxOnClaim === false && this.session.attachment.state !== "provisioning") {
      return preHintPrompt;
    }
    const estimateMs = this.session.attachment.coldStartEstimateMs ?? 10_000;
    const hint = `\n\n[workspace status] The workspace sandbox is provisioning (~${Math.ceil(estimateMs / 1000)}s). Filesystem and shell tools will wait for it; sequence non-filesystem work first.`;
    this.agent.state.systemPrompt = preHintPrompt + hint;
    return preHintPrompt;
  }

  private restoreColdHintAfterTurn(preHintPrompt: string): void {
    this.agent.state.systemPrompt = preHintPrompt;
  }

  /**
   * Repo AGENTS.md instructions overlay (agents-md spec, decision 4).
   * Snapshots `session.repoInstructions()` exactly ONCE, here at turn start,
   * and appends a turn-local fragment — a `refreshRepoInstructions()` that
   * lands mid-turn replaces the session's reference but cannot change the
   * prompt this turn already carries; the new value takes effect on the next
   * turn's overlay. Returns the pre-overlay prompt for the unconditional
   * restore in the turn's finally.
   */
  private applyRepoInstructionsForTurn(): string {
    const preOverlayPrompt = this.agent.state.systemPrompt;
    const instructions = this.session.repoInstructions();
    if (!instructions) return preOverlayPrompt;
    const fragment = buildRepoInstructionsFragment(instructions);
    if (!fragment) return preOverlayPrompt;
    this.agent.state.systemPrompt = preOverlayPrompt
      ? `${preOverlayPrompt}\n\n${fragment}`
      : fragment;
    return preOverlayPrompt;
  }

  private restoreRepoInstructionsAfterTurn(preOverlayPrompt: string): void {
    this.agent.state.systemPrompt = preOverlayPrompt;
  }

  private applyRoleForTurn(item: QueueItem): RoleOverlay {
    const roleName = item.role;
    if (!roleName) return { restore: false };
    const role = this.session.roles.get(roleName);
    if (!role) {
      // Spec: prompt-level role resolution errors fail the prompt before
      // model invocation. We surface as an emitted error and skip overlay
      // — the run still proceeds with the base configuration so the
      // failure is visible to the LLM and the user, not silent.
      this.emitError("role_not_found", `role "${roleName}" not registered on this session`);
      return { restore: false };
    }
    const baseSystemPrompt = this.agent.state.systemPrompt;
    const overlaid = baseSystemPrompt
      ? `${baseSystemPrompt}\n\n${role.content}`
      : role.content;
    this.agent.state.systemPrompt = overlaid;

    let priorModel: PiModel | undefined;
    if (role.model) {
      // Resolve the role's model id against pi-ai's registry (provider/model)
      // or the session's pre-registered model. The simplest reuse: if the
      // role.model matches a known anthropic model, look it up; otherwise
      // skip the override and emit a warning.
      try {
        const next = resolveRoleModel(role.model);
        if (next) {
          priorModel = this.agent.state.model;
          this.agent.state.model = next;
        }
      } catch (err) {
        this.emitError(
          "role_model_lookup_failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return {
      restore: true,
      systemPrompt: baseSystemPrompt,
      model: priorModel,
    };
  }

  private restoreRoleAfterTurn(overlay: RoleOverlay): void {
    if (!overlay.restore) return;
    if (overlay.systemPrompt !== undefined) {
      this.agent.state.systemPrompt = overlay.systemPrompt;
    }
    if (overlay.model !== undefined) {
      this.agent.state.model = overlay.model;
    }
  }

  /**
   * Run one prompt cycle. On context-overflow error, compact and retry once.
   *
   * `attachments` MUST be included on the pushed user message so the current
   * turn's image content blocks land in `agent.state.messages` — otherwise
   * they exist only in persisted `MessageEntry.attachments`, which is
   * consulted (via `entriesToAgentMessages`) only on cold rehydrate, resume,
   * and compaction. A session that stays hot across turns would otherwise
   * send `[{type:"text", text}]` on turn 1 (image invisible) and on every
   * later turn (turn-1 image still invisible) — the "attachments lost after
   * turn 1" symptom.
   */
  private async runAgent(
    text: string,
    attachments?: MessageEntry["attachments"],
    sender?: PromptAuthor,
  ): Promise<void> {
    const content = userContentBlocks(text, attachments, sender);
    await this.agent.prompt({
      role: "user",
      content,
      timestamp: Date.now(),
    });
    await this.agent.waitForIdle();

    const last = this.agent.state.messages[this.agent.state.messages.length - 1];
    if (
      !this.overflowRetryInProgress &&
      last &&
      last.role === "assistant" &&
      last.stopReason === "error" &&
      isContextOverflow(last, this.session.options.model.contextWindow)
    ) {
      this.overflowRetryInProgress = true;
      try {
        await this.compactThread({ mode: "reactive" });
        // Drop the failed assistant message from the agent transcript and retry.
        this.agent.state.messages = this.agent.state.messages.slice(0, -1);
        await this.agent.prompt({
          role: "user",
          content,
          timestamp: Date.now(),
        });
        await this.agent.waitForIdle();
      } finally {
        this.overflowRetryInProgress = false;
      }
    }
  }

  private shouldCompactProactive(): boolean {
    if (this.skipNextProactiveCheck) {
      this.skipNextProactiveCheck = false;
      return false;
    }
    const cfg = this.session.options.compaction;
    if (cfg?.enabled === false) return false;
    const usage = this.lastAssistantUsage;
    if (!usage) return false;
    const usable = usableTokens(this.session.options.model, cfg);
    if (usable === 0) return false;
    return usage.total >= usable;
  }

  /**
   * Run a compaction pass: prune cheap stale tool outputs, then if the
   * result still doesn't fit, summarize older messages into a
   * CompactionEntry. Persist DAG updates and rewrite agent.state.messages
   * so the next turn sees a smaller context.
   */
  async compactThread(opts: { mode: "proactive" | "reactive" | "manual" }): Promise<void> {
    const cfg = this.session.options.compaction;
    if (cfg?.enabled === false) return;
    return withSpan(
      "compaction",
      {
        "valet.session.id": this.session.id,
        "valet.thread.id": this.id,
        "valet.compaction.mode": opts.mode,
      },
      (span) => this.compactThreadInner(opts, span),
    );
  }

  private async compactThreadInner(
    opts: { mode: "proactive" | "reactive" | "manual" },
    span?: Span,
  ): Promise<void> {
    const cfg = this.session.options.compaction;
    const session = this.session;
    const store = session.providers.store;
    const model = cfg?.summarizerModel ?? session.options.model;

    // Load full DAG for the thread.
    const entries = await store.getEntries(session.id, this.id);

    // Step 1: pruning pass (cheap, no LLM).
    const protectedTools = new Set<string>();
    for (const t of [...session.builtinTools, ...(session.options.tools ?? [])]) {
      if (t.protectedFromPruning) protectedTools.add(t.name);
    }
    const prunePlan = planPrune({ entries, cfg, protectedTools });
    if (prunePlan.willCommit) {
      const mutable = entries.map((e) => structuredClone(e)) as SessionEntry[];
      applyPrune(mutable, prunePlan);
      // Persist each elided entry back to the store via updateEntry. Compaction
      // only runs inside a claimed turn (from runItem after runAgent, or the
      // reactive-overflow path in runAgent), so `this.fence` names the current
      // attempt — thread it through so a superseding successor's fence still
      // wins over these writes.
      for (const entry of mutable) {
        if (!prunePlan.toElide.has(entry.id)) continue;
        await store.updateEntry(session.id, this.id, entry, this.fence);
      }
      // Apply to the live agent transcript:
      this.applyElisionsToAgentMessages(prunePlan);
    }

    // Step 2: cut-point selection.
    const cut = selectCutPoint({ entries, model: session.options.model, cfg });
    if (cut.cutIndex === 0 || cut.cutIndex === entries.length) {
      // Nothing to compact: either the tail already fits everything, or
      // there's no tail to preserve. The pruning pass above may have been
      // sufficient on its own.
      return;
    }

    const head = entries.slice(0, cut.cutIndex);
    if (head.length === 0) return;

    // Step 3: summarize.
    await session.emit(
      { type: "compaction_start", threadId: this.id },
      { queueItemId: this.runningItem?.id },
    );
    let summaryResult: SummarizeResult;
    try {
      const previousSummary = findMostRecentCompaction(entries)?.summary;
      summaryResult = await summarize({
        headEntries: head,
        model,
        toolOutputMaxChars: cfg?.toolOutputMaxChars,
        attributeAuthors: this.attributeAuthors,
        previousSummary,
        // Reactive compaction fires WITHIN a claimed turn (and proactive
        // just after runAgent, still before the turn's finally clears it),
        // so `turnApiKey` is live here. Without this, a BYO-key session
        // whose only key comes from the host `resolveModel` seam would fail
        // the summarizer completion on first context overflow. Undefined
        // when no resolver is wired (env-fallback path) — behavior unchanged.
        apiKey: this.turnApiKey,
      });
    } catch (err) {
      await session.emit(
        { type: "compaction_end", threadId: this.id },
        { queueItemId: this.runningItem?.id },
      );
      throw err;
    }

    // Step 4: persist CompactionEntry.
    const compactionEntry: CompactionEntry = {
      id: uid("c"),
      sessionId: session.id,
      threadId: this.id,
      parentId: head[head.length - 1].id,
      type: "compaction",
      summary: summaryResult.summary,
      coveredEntryIds: head.map((e) => e.id),
      tokenCountBefore: estimateTotalTokens(head),
      tokenCountAfter: estimateTokens(summaryResult.summary),
      fileContext: extractFileContext(head),
      createdAt: Date.now(),
    };
    span?.setAttributes({
      "valet.compaction.tokens_before": compactionEntry.tokenCountBefore,
      "valet.compaction.tokens_after": compactionEntry.tokenCountAfter,
      "valet.compaction.entries_covered": compactionEntry.coveredEntryIds.length,
    });
    // Fenced under the current turn's attempt (compaction is always in-turn).
    await store.appendEntries(session.id, this.id, [compactionEntry], this.fence);

    // Step 5: rewrite agent.state.messages. The simplest and most
    // correct path is to rebuild from the now-augmented DAG.
    const updatedEntries = await store.getEntries(session.id, this.id);
    this.agent.state.messages = entriesToAgentMessages(
      updatedEntries,
      {
        api: session.options.model.api,
        provider: session.options.model.provider,
        id: session.options.model.id,
      },
      { attributeAuthors: this.attributeAuthors },
    );

    await session.emit(
      { type: "compaction_end", threadId: this.id },
      { queueItemId: this.runningItem?.id },
    );

    // Step 5.5: compaction hooks (Phase 4 decision 9). Run in order, each
    // individually try/caught — a throwing hook is logged via emitError and
    // never blocks a later hook or the rest of compaction (auto-continue
    // below still runs even if every hook throws).
    for (const hook of session.options.compactionHooks ?? []) {
      try {
        await hook({
          sessionId: session.id,
          threadId: this.id,
          mode: opts.mode,
          summary: summaryResult.summary,
        });
      } catch (err) {
        this.emitError(
          "compaction_hook_failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Step 6: auto-continue (proactive only). Inject a synthetic user
    // message tagged with metadata.compaction_continue so client UIs can
    // hide it. Admitted as a durable submission so the claim loop picks it up
    // after the current turn settles.
    if (opts.mode === "proactive" && cfg?.autoContinue !== false) {
      // Durable admission: the claim loop picks this up after the current turn
      // settles. metadata flags let client UIs hide the synthetic continuation.
      const followUp = this.buildQueueItem(AUTO_CONTINUE_PROMPT, {
        metadata: { compaction_continue: true, synthetic: true },
      });
      await store.admitSubmission(session.id, this.id, followUp);
      await this.emitQueueState();
    }

    // Cool-down: skip the next proactive check so the auto-continue turn
    // doesn't immediately re-trigger compaction on a small-context model.
    this.skipNextProactiveCheck = true;
  }

  private applyElisionsToAgentMessages(plan: PruneResult): void {
    if (!plan.willCommit) return;
    // Walk agent.state.messages and replace tool-call result references.
    // pi-agent-core stores tool calls inside assistant messages and tool
    // results as separate toolResult messages. We replace toolResult content
    // for any callId in the plan.
    const elidedCallIds = new Set<string>();
    for (const ids of plan.toElide.values()) {
      for (const id of ids) elidedCallIds.add(id);
    }
    for (const m of this.agent.state.messages) {
      if (m.role !== "toolResult") continue;
      if (!elidedCallIds.has(m.toolCallId)) continue;
      m.content = [{ type: "text", text: "[output elided to save context]" }];
    }
  }

  private buildAgent(): Agent {
    // Only wire `getApiKey` when a host resolver is present. Absent → the Agent
    // is constructed with the exact same options as before the seam existed, so
    // pi-ai's env-var fallback stamps StreamOptions.apiKey (byte-identical pin).
    const hasResolver = this.session.options.resolveModel !== undefined;
    const agent = new Agent({
      initialState: {
        model: this.session.options.model,
        systemPrompt: this.buildBaseSystemPrompt(),
      },
      streamFn: streamSimple,
      // Filter out custom AgentMessage types (decision_gate, compaction, etc.)
      // before the LLM sees them. They live in the engine DAG, not in LLM context.
      convertToLlm: (messages: AgentMessage[]): Message[] => {
        return messages.filter(
          (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
        ) as Message[];
      },
      // Per-turn key delivery: pi-agent-core calls this with the turn's provider
      // and stamps the result onto StreamOptions.apiKey (undefined → env fallback).
      ...(hasResolver ? { getApiKey: (_provider: string) => this.turnApiKey } : {}),
    });
    agent.subscribe((event, _signal) => this.handleAgentEvent(event));
    return agent;
  }

  /**
   * Base system prompt = `options.systemPrompt` + ordered `systemContext`
   * fragments, sorted by `(order ?? 100, name)` (Phase 4 decision 6). Baked
   * in once at agent construction so it sits BEFORE the per-turn role
   * overlay (`applyRoleForTurn`) and cold-sandbox hint
   * (`applyColdHintForTurn`), both of which append to
   * `agent.state.systemPrompt` on top of whatever this returns. Final
   * composition: base → systemContext → role overlay → cold hint — a
   * deliberate deviation from the portable-runtime spec's "after role
   * overlays" ordering; do not "fix" it.
   */
  private buildBaseSystemPrompt(): string {
    const base = this.session.options.systemPrompt ?? "";
    const fragments = this.session.options.systemContext ?? [];
    if (fragments.length === 0) return base;
    const sorted = [...fragments].sort((a, b) => {
      const orderA = a.order ?? 100;
      const orderB = b.order ?? 100;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name);
    });
    const fragmentText = sorted.map((f) => f.content).join("\n\n");
    return base ? `${base}\n\n${fragmentText}` : fragmentText;
  }

  private buildTools(): AgentTool[] {
    const all: ToolDef[] = [...this.session.builtinTools, ...(this.session.options.tools ?? [])];
    return all.map((def) =>
      toAgentTool(def, ({ signal, toolCallId, toolName, toolArgs }) =>
        this.buildToolContext({ signal, toolCallId, toolName, toolArgs }),
      ),
    );
  }

  private buildToolContext(args: {
    signal: AbortSignal;
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
  }): ToolContext {
    const { signal, toolCallId, toolName, toolArgs } = args;
    const session = this.session;
    return {
      userId: session.options.userId,
      orgId: session.options.orgId,
      sessionId: session.id,
      threadId: this.id,
      sessionPurpose: session.options.purpose,
      cwd: session.options.workspace,
      credentials: session.credentialProvider(),
      sandbox: session.sandbox,
      config: session.options.toolConfig,
      owner: session.owner,
      policyResolver: session.options.policyResolver,
      pluginStoreFactory: session.options.pluginStoreFactory,
      queueItemId: this.runningItem?.id,
      signal,
      decisionGateId: this.toolCtxOverlay.gateId,
      suspendedDecision: this.suspendedDecisionForReplay,
      requestDecision: async (req: DecisionGateRequest): Promise<DecisionResolution> => {
        if (!req.resumeKey) {
          throw new Error(
            "DecisionGateRequest.resumeKey is required for restart-safe gates.",
          );
        }
        const gateCtx = {
          sessionId: session.id,
          threadId: this.id,
          queueItemId: this.runningItem?.id ?? "",
          resumeKey: req.resumeKey,
        };
        // Restart-safe replay: if running with a suspendedDecision and the
        // gate ID matches, return the stored resolution without re-persisting.
        const sc = shouldShortCircuit({
          ctx: gateCtx,
          suspendedDecision: this.suspendedDecisionForReplay,
        });
        if (sc.match) {
          const replayOrdinal = this.suspendedDecisionForReplay?.ordinal;
          this.suspendedDecisionForReplay = undefined; // one-shot
          // The persisted resolution already carries gateOrdinal from the
          // original (non-replay) requestDecision call below, but stamp it
          // defensively so a replay is self-describing even if the stored
          // record predates this field.
          return { ...sc.resolution, gateOrdinal: sc.resolution.gateOrdinal ?? replayOrdinal };
        }
        // One gate cycle at a time per thread (see gateCycleTail): the next
        // open waits until the previous gate resolves and releases the
        // durable blocked toggle (TKAI-238).
        const prevCycle = this.gateCycleTail;
        let releaseCycle!: () => void;
        this.gateCycleTail = new Promise<void>((r) => {
          releaseCycle = r;
        });
        await prevCycle;
        try {
          return await this.runGateCycle({ req, gateCtx, signal, toolCallId, toolName, toolArgs });
        } finally {
          releaseCycle();
        }
      },
      threadRead: async (key, opts) => {
        const sibling = await this.session.threadByKey(key);
        if (!sibling) return [];
        return sibling.readEntries(opts);
      },
      listThreads: async () => {
        // Pull from the store so paused/archived threads not currently
        // hydrated in memory still surface.
        const datas = await session.providers.store.listThreads(session.id);
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
      setModel: async ({ model }) => {
        // Intentionally thread-scoped only — see ToolContext.setModel docs.
        // The session default is a user-facing setting; agents shouldn't
        // change it unilaterally.
        return this.setModel(model, `tool:${toolName}`);
      },
    };
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "agent_start":
        await this.session.emit(
          { type: "thread_start", threadId: this.id },
          { queueItemId: this.runningItem?.id },
        );
        this.lastEmittedStatus = "thinking";
        await this.fencedEmit(
          { type: "status", threadId: this.id, status: "thinking" },
          { queueItemId: this.runningItem?.id },
        );
        break;
      case "message_start": {
        if (event.message.role === "assistant") {
          this.currentAssistantMessageId = uid("e");
          this.currentAssistantParts = [];
          this.currentToolCalls.clear();
          this.currentAssistantEntry = undefined;
          // One llm.generate span per assistant round, parented under the
          // turn. Start time is the SYNTHESIZED round start — the model was
          // "thinking" from the moment the prior round's work finished, and
          // message_start only fires once streaming begins.
          if (this.turnSpan) {
            this.llmSpan?.end(); // defensive: never leak a dangling round
            this.llmSpan = engineTracer().startSpan(
              "llm.generate",
              {
                startTime: this.llmRoundStartedAt ?? Date.now(),
                attributes: {
                  "valet.session.id": this.session.id,
                  "valet.thread.id": this.id,
                },
              },
              otelTrace.setSpan(otelContext.active(), this.turnSpan),
            );
          }
          await this.fencedEmit(
            {
              type: "message_start",
              threadId: this.id,
              messageId: this.currentAssistantMessageId,
              role: "assistant",
            },
            { queueItemId: this.runningItem?.id },
          );
        }
        break;
      }
      case "message_update": {
        // A superseded (zombie) attempt can keep receiving buffered stream
        // events after its fence died. Fenced durable emits already throw
        // StaleAttemptError; ephemeral emits (text_delta, tool_call_update)
        // bypass the fence, so gate them on the detected-stale flag to stop
        // painting a dead attempt's output into live clients.
        if (this.staleFenceDetected) break;
        const ev = event.assistantMessageEvent;
        if (ev.type === "text_delta") {
          await this.session.emit({
            type: "text_delta",
            threadId: this.id,
            text: ev.delta,
          });
        } else if (ev.type === "toolcall_start" || ev.type === "toolcall_delta") {
          // Live-only args streaming: forward the raw JSON chunk keyed by
          // callId so clients can render the tool call before it executes.
          const block = ev.partial.content[ev.contentIndex];
          if (block?.type === "toolCall") {
            await this.session.emit({
              type: "tool_call_update",
              threadId: this.id,
              callId: block.id,
              toolName: block.name,
              argsDelta: ev.type === "toolcall_delta" ? ev.delta : "",
            });
          }
        } else if (ev.type === "toolcall_end") {
          const part: MessagePart = {
            type: "tool_call",
            callId: ev.toolCall.id,
            toolName: ev.toolCall.name,
            status: "running",
            args: ev.toolCall.arguments,
          };
          this.currentToolCalls.set(ev.toolCall.id, part);
          this.currentAssistantParts.push(part);
        }
        break;
      }
      case "message_end": {
        if (event.message.role === "assistant" && this.currentAssistantMessageId) {
          // Close this round's llm.generate span with per-round attributes.
          // The NEXT round (if any) effectively starts now — tools run in
          // between and tool_execution_end re-stamps the round start.
          if (this.llmSpan) {
            const u = event.message.usage;
            this.llmSpan.setAttributes({
              "gen_ai.request.model": event.message.model,
              "gen_ai.usage.input_tokens": u.input,
              "gen_ai.usage.output_tokens": u.output,
              "valet.llm.stop_reason": event.message.stopReason,
              "valet.llm.tool_calls": this.currentToolCalls.size,
            });
            if (event.message.stopReason === "error") {
              markSpanError(this.llmSpan, event.message.errorMessage ?? "stream error");
            }
            this.llmSpan.end();
            this.llmSpan = undefined;
          }
          this.llmRoundStartedAt = Date.now();
          const text = textOf(event.message);
          // Compose parts: leading text + tool calls (already tracked)
          const parts: MessagePart[] = [];
          if (text) parts.push({ type: "text", text });
          for (const p of this.currentAssistantParts) parts.push(p);

          // "length" maps to end_turn: a length-terminated turn still ended
          // with usable output (Task 6 resolves result text from the last
          // assistant entry with stopReason end_turn).
          const stopReason: MessageEntry["stopReason"] | undefined =
            event.message.stopReason === "aborted"
              ? "abort"
              : event.message.stopReason === "error"
              ? "error"
              : event.message.stopReason === "stop" || event.message.stopReason === "length"
              ? "end_turn"
              : undefined; // toolUse (mid-turn) carries no stopReason
          const entry: MessageEntry = {
            id: this.currentAssistantMessageId,
            sessionId: this.session.id,
            threadId: this.id,
            parentId: null,
            type: "message",
            role: "assistant",
            content: text,
            parts,
            model: event.message.model,
            queueItemId: this.runningItem?.id,
            stopReason,
            createdAt: Date.now(),
          };
          await this.fencedWrite(() =>
            this.session.providers.store.appendEntries(this.session.id, this.id, [entry], this.fence),
          );
          // Hold a reference so tool_execution_end can re-persist as each
          // tool completes (`parts` is shared by reference; mutating a
          // tool_call's status flows through to this entry's parts array).
          this.currentAssistantEntry = entry;
          await this.fencedEmit(
            {
              type: "message_end",
              threadId: this.id,
              messageId: entry.id,
              reason:
                event.message.stopReason === "aborted"
                  ? "abort"
                  : event.message.stopReason === "error"
                  ? "error"
                  : "end_turn",
            },
            { queueItemId: this.runningItem?.id },
          );
        }
        break;
      }
      case "tool_execution_start":
        this.turnToolCallCount++;
        this.toolCtxOverlay.gateId = undefined;
        await this.fencedEmit(
          {
            type: "tool_start",
            threadId: this.id,
            tool: event.toolName,
            callId: event.toolCallId,
            args: event.args ?? {},
          },
          { queueItemId: this.runningItem?.id },
        );
        this.lastEmittedStatus = "tool_calling";
        await this.fencedEmit(
          { type: "status", threadId: this.id, status: "tool_calling" },
          { queueItemId: this.runningItem?.id },
        );
        break;
      case "tool_execution_end": {
        const part = this.currentToolCalls.get(event.toolCallId);
        const resultText = renderToolResult(event.result);
        if (part && part.type === "tool_call") {
          part.status = event.isError ? "error" : "completed";
          // Persist the *flattened* text alongside the raw structured
          // result. pi-agent-core emits AgentToolResult-shaped objects
          // (`{ content: [{ type: "text", text }] }`) and consumers that
          // try to read a tool result later (UI renderers, thread_read
          // formatting, exports) shouldn't need to know about that shape.
          // Storing both means any reader can pull `result.text` and Just
          // Get something readable; clients that want the raw blocks can
          // still inspect `result.content`.
          const structured =
            event.result && typeof event.result === "object"
              ? (event.result as Record<string, unknown>)
              : {};
          part.result = { ...structured, text: resultText };
        }
        // The next LLM round begins once tool results are in — re-stamp the
        // synthesized round start so llm.generate covers its full wait.
        this.llmRoundStartedAt = Date.now();
        // Re-persist the entry now that this tool's status/result has been
        // mutated. Without this, sqlite still has status="running" + no
        // result; on reload the chat shows tool cards stuck mid-execution.
        if (this.currentAssistantEntry) {
          const entry = this.currentAssistantEntry;
          await this.fencedWrite(() =>
            this.session.providers.store.updateEntry(this.session.id, this.id, entry, this.fence),
          );
        }
        await this.fencedEmit(
          {
            type: "tool_end",
            threadId: this.id,
            tool: event.toolName,
            callId: event.toolCallId,
            result: resultText,
            isError: event.isError,
          },
          { queueItemId: this.runningItem?.id },
        );
        break;
      }
      case "turn_end": {
        const stopReason =
          event.message.role === "assistant" ? event.message.stopReason : undefined;
        const errorMessage =
          event.message.role === "assistant" ? event.message.errorMessage : undefined;
        // Usage/cost trace (engine traces spec, change 1): one snapshot feeds
        // BOTH the entry update and the enriched turn_end event below, so the
        // two surfaces can never disagree.
        let turnUsage: MessageUsage | undefined;
        let turnCost: MessageCost | undefined;
        let turnModel: string | undefined;
        if (event.message.role === "assistant") {
          const u = event.message.usage;
          this.lastAssistantUsage = {
            input: u.input,
            output: u.output,
            cacheRead: u.cacheRead,
            cacheWrite: u.cacheWrite,
            total: u.totalTokens || u.input + u.output + u.cacheRead + u.cacheWrite,
          };
          // All-zero usage (dev fakes, providers that don't report) is
          // "no usage reported" — omit, mirroring the cost-is-null rule.
          if (this.lastAssistantUsage.total > 0) turnUsage = { ...this.lastAssistantUsage };
          turnModel = event.message.model;
          // Cost is null, not zero: unpriced models (custom providers, dev
          // fakes) omit the field entirely — a missing value reads
          // "unpriced", never "$0".
          const c = u.cost;
          if (c && c.total > 0) {
            turnCost = {
              input: c.input,
              output: c.output,
              cacheRead: c.cacheRead,
              cacheWrite: c.cacheWrite,
              total: c.total,
            };
          }
          if (this.currentAssistantEntry && turnUsage) {
            const entry = this.currentAssistantEntry;
            entry.usage = turnUsage;
            if (turnCost) entry.cost = turnCost;
            await this.fencedWrite(() =>
              this.session.providers.store.updateEntry(this.session.id, this.id, entry, this.fence),
            );
          }
          // Metrics: same snapshot the entry/span get (no-op without a
          // registered MeterProvider).
          recordTurn({
            model: turnModel,
            reason: stopReason === "aborted" ? "abort" : stopReason === "error" ? "error" : "end_turn",
            durationMs: this.turnStartedAt !== undefined ? Date.now() - this.turnStartedAt : undefined,
            usage: turnUsage,
            costUsd: turnCost?.total,
          });
          // A round that errored/aborted before message_end leaves a
          // dangling llm.generate span — close it with the turn's fate.
          if (this.llmSpan) {
            if (errorMessage) markSpanError(this.llmSpan, errorMessage);
            this.llmSpan.end();
            this.llmSpan = undefined;
          }
          // Same snapshot onto the live agent.turn span (distributed tracing).
          if (this.turnSpan) {
            this.turnSpan.setAttributes({
              "valet.turn.stop_reason": stopReason ?? "end_turn",
              "valet.turn.tool_calls": this.turnToolCallCount,
            });
            if (errorMessage) {
              this.turnSpan.setAttribute("valet.turn.error", attrTruncate(errorMessage, 300));
            }
            if (turnModel !== undefined) this.turnSpan.setAttribute("gen_ai.request.model", turnModel);
            if (turnUsage) {
              this.turnSpan.setAttributes({
                "gen_ai.usage.input_tokens": turnUsage.input,
                "gen_ai.usage.output_tokens": turnUsage.output,
                "valet.usage.cache_read_tokens": turnUsage.cacheRead,
                "valet.usage.cache_write_tokens": turnUsage.cacheWrite,
                "valet.usage.total_tokens": turnUsage.total,
              });
            }
            if (turnCost) this.turnSpan.setAttribute("valet.cost.total_usd", turnCost.total);
            if (stopReason === "error") {
              markSpanError(this.turnSpan, errorMessage ?? "turn ended with an error");
            }
          }
        }
        if (errorMessage) {
          // Same stdout mirror as `emitError`: the event is best-effort (a
          // dead WS drops it), and this is the path provider failures take
          // (bad key, exhausted credits, 4xx/5xx) — without a log line the
          // host process is silent about a turn that returned nothing.
          console.error(
            `[engine] agent error session=${this.session.id} thread=${this.id} ${stopReason ?? "agent_error"}: ${errorMessage}`,
          );
          await this.fencedEmit(
            {
              type: "error",
              threadId: this.id,
              code: stopReason ?? "agent_error",
              error: errorMessage,
              recoverable: stopReason !== "error",
            },
            { queueItemId: this.runningItem?.id },
          );
        }
        const reason: "end_turn" | "error" | "abort" =
          stopReason === "aborted"
            ? "abort"
            : stopReason === "error"
            ? "error"
            : "end_turn";
        await this.fencedEmit(
          {
            type: "turn_end",
            threadId: this.id,
            reason,
            ...(turnModel !== undefined ? { model: turnModel } : {}),
            ...(turnUsage !== undefined ? { usage: turnUsage } : {}),
            ...(turnCost !== undefined ? { cost: turnCost } : {}),
            ...(turnUsage !== undefined && this.turnStartedAt !== undefined
              ? { turnDurationMs: Date.now() - this.turnStartedAt }
              : {}),
          },
          { queueItemId: this.runningItem?.id },
        );
        this.lastEmittedStatus = "idle";
        await this.fencedEmit(
          { type: "status", threadId: this.id, status: "idle" },
          { queueItemId: this.runningItem?.id },
        );
        break;
      }
      default:
        break;
    }
  }

  /**
   * Run a fenced store write. A StaleAttemptError means a successor now owns
   * the item: mark the turn stale (so settlement is skipped), abort the agent,
   * and swallow — never rethrow to the user (zombie self-fencing signal).
   */
  private async fencedWrite(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof StaleAttemptError) {
        this.staleFenceDetected = true;
        this.emitError("stale_fence", `turn superseded for item ${err.itemId}`);
        if (this.agent.state.isStreaming) this.agent.abort();
        return;
      }
      throw err;
    }
  }

  /**
   * Emit a live-execution event under the turn's write fence (decision 12).
   * `Session.emit` rethrows `StaleAttemptError` for a fenced append — this
   * wrapper is the site that actually absorbs it, mirroring `fencedWrite`:
   * mark the turn stale, abort the agent if still streaming, and swallow.
   * A rethrow here would otherwise escape as an unhandled rejection since
   * `handleAgentEvent` runs from a fire-and-forget `agent.subscribe`
   * callback with no caller to catch it.
   */
  private async fencedEmit(event: EngineEvent, opts: Omit<EmitOptions, "fence"> = {}): Promise<void> {
    try {
      await this.session.emit(event, { ...opts, fence: this.fence });
    } catch (err) {
      if (err instanceof StaleAttemptError) {
        this.staleFenceDetected = true;
        this.emitError("stale_fence", `turn superseded for item ${err.itemId}`);
        if (this.agent.state.isStreaming) this.agent.abort();
        return;
      }
      throw err;
    }
  }

  private emitError(code: string, message: string): void {
    // Event delivery is best-effort (a dead WS drops it silently), so also
    // log to stderr — otherwise a failing turn (bad key, exhausted credits,
    // provider outage) leaves zero trace in the host process output.
    console.error(`[engine] thread error session=${this.session.id} thread=${this.id} ${code}: ${message}`);
    void this.session.emit({
      type: "error",
      threadId: this.id,
      code,
      error: message,
      recoverable: true,
    });
  }

  /**
   * Durable, resumable result observation (spec ~404, plan Task 6). Derives
   * the result from durable state — never from the `submission_settled`
   * event alone, since that emit is best-effort and can be lost. A settled
   * submission returns immediately from the store; an unsettled one
   * subscribes to the event as a wakeup and re-derives from the store once
   * woken (or once more, defensively, on timeout/abort).
   *
   * `outcome: "merged"` delegates: recurses on `mergedIntoItemId`, bounded to
   * `MAX_MERGE_DELEGATION_DEPTH` hops so a corrupt/cyclic linkage can never
   * spin forever.
   */
  async awaitResult(queueItemId: string, opts: AwaitResultOptions = {}): Promise<SubmissionResult> {
    return this.resolveResult(queueItemId, opts, 0);
  }

  private async resolveResult(
    itemId: string,
    opts: AwaitResultOptions,
    depth: number,
  ): Promise<SubmissionResult> {
    if (depth > MAX_MERGE_DELEGATION_DEPTH) {
      return {
        queueItemId: itemId,
        outcome: "failed",
        error: `merge delegation depth exceeded ${MAX_MERGE_DELEGATION_DEPTH} hops`,
      };
    }
    const store = this.session.providers.store;
    let item = await store.getQueueItem(this.session.id, itemId);
    if (!item) throw new NotFoundError("queue item", itemId);
    if (item.status !== "settled") {
      await this.waitForSettlement(itemId, opts);
      item = await store.getQueueItem(this.session.id, itemId);
      if (!item || item.status !== "settled") {
        throw new Error(`queue item ${itemId} did not settle after wait`);
      }
    }
    return this.buildResult(item, opts, depth);
  }

  private async buildResult(
    item: QueueItem,
    opts: AwaitResultOptions,
    depth: number,
  ): Promise<SubmissionResult> {
    const outcome = item.outcome ?? { outcome: "failed", error: "settled without a recorded outcome" };
    if (outcome.outcome === "merged") {
      if (!item.mergedIntoItemId) {
        return {
          queueItemId: item.id,
          outcome: "failed",
          error: "merged submission is missing mergedIntoItemId",
        };
      }
      return this.resolveResult(item.mergedIntoItemId, opts, depth + 1);
    }
    const entries = await this.session.providers.store.getEntries(this.session.id, item.threadId);
    const text =
      outcome.outcome === "superseded"
        ? resolvePartialSubmissionText(entries, item.id)
        : resolveSubmissionText(entries, item.id);
    const result: SubmissionResult = { queueItemId: item.id, outcome: outcome.outcome, text };
    if (outcome.error !== undefined) result.error = outcome.error;
    if (opts.resultSchema && outcome.outcome === "completed") {
      const extracted = extractStructuredOutput(text ?? "", opts.resultSchema);
      if (extracted.output !== undefined) result.output = extracted.output;
      if (extracted.error !== undefined) result.error = extracted.error;
    }
    return result;
  }

  /**
   * Resolves once `itemId` settles, rejects on timeout/abort. Never mutates
   * the submission — a timed-out or aborted wait leaves it running.
   *
   * The `submission_settled` event is a wakeup hint, not the source of
   * truth: some settlement paths (e.g. a collect-window constituent settled
   * via `settleUnclaimed` in `flushCollectWindow`) never publish it, and the
   * event emit itself is best-effort. A low-frequency durable poll is the
   * actual correctness mechanism; the event and the immediate post-subscribe
   * re-check just make the common case resolve promptly instead of waiting
   * out a poll tick.
   */
  private async waitForSettlement(itemId: string, opts: AwaitResultOptions): Promise<void> {
    const store = this.session.providers.store;
    await new Promise<void>((resolve, reject) => {
      let done = false;
      let unsubscribe: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let poll: ReturnType<typeof setInterval> | undefined;
      let onAbort: (() => void) | undefined;

      const cleanup = () => {
        unsubscribe?.();
        if (timer !== undefined) clearTimeout(timer);
        if (poll !== undefined) clearInterval(poll);
        if (onAbort && opts.signal) opts.signal.removeEventListener("abort", onAbort);
      };
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        cleanup();
        if (err) reject(err);
        else resolve();
      };
      const checkStore = () => {
        void store.getQueueItem(this.session.id, itemId).then((current) => {
          if (current?.status === "settled") finish();
        });
      };

      unsubscribe = this.session.providers.stream.subscribe(
        { sessionId: this.session.id, eventTypes: ["submission_settled"] },
        (busEvent) => {
          const event = busEvent.event;
          if (event.type === "submission_settled" && event.queueItemId === itemId) checkStore();
        },
      );

      // Race guard: the submission may have settled between the caller's
      // last read and this subscribe call.
      checkStore();

      // Durable fallback: not every settlement path emits the event (e.g.
      // collect-window constituents settle via settleUnclaimed with no
      // event), so a poll is the only way to guarantee this promise
      // eventually resolves against store truth.
      poll = setInterval(checkStore, 50);
      poll.unref?.();

      const timeoutMs = opts.timeoutMs;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => finish(new TimeoutError(itemId, timeoutMs)), timeoutMs);
        timer.unref?.();
      }

      if (opts.signal) {
        if (opts.signal.aborted) {
          finish(new Error(`awaitResult aborted waiting for submission ${itemId}`));
          return;
        }
        onAbort = () => finish(new Error(`awaitResult aborted waiting for submission ${itemId}`));
        opts.signal.addEventListener("abort", onAbort);
      }
    });
  }
}

function promptText(content: PromptContent): string {
  if (typeof content === "string") return content;
  if (isSignalContent(content)) return content.body;
  return content.text ?? "";
}

function isSignalContent(content: PromptContent): content is SignalContent {
  return typeof content === "object" && content !== null && "kind" in content && content.kind === "signal";
}

/** Stamped internal-sender identity carried through `QueueItem.metadata.signalStamp` (no dedicated QueueItem field). */
interface SignalStamp {
  senderSessionId: string;
  senderOwner: Principal;
  hopCount: number;
}

function isPrincipalLike(value: unknown): value is Principal {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    (rec.type === "user" || rec.type === "team" || rec.type === "org") && typeof rec.id === "string"
  );
}

function readSignalStamp(metadata: Record<string, unknown> | undefined): SignalStamp | undefined {
  const raw = metadata?.signalStamp;
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.senderSessionId !== "string") return undefined;
  if (typeof rec.hopCount !== "number") return undefined;
  if (!isPrincipalLike(rec.senderOwner)) return undefined;
  return { senderSessionId: rec.senderSessionId, hopCount: rec.hopCount, senderOwner: rec.senderOwner };
}

/**
 * Returns `metadata` with the `signalStamp` key removed, without mutating
 * the input. Used when persisting the user `MessageEntry`: the stamp has
 * already been lifted into `entry.signal` by `buildSignalMeta`, so leaving
 * it in `entry.metadata` too would duplicate the sender stamp into the
 * persisted entry (and onto the wire).
 */
function stripSignalStamp(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata || !("signalStamp" in metadata)) return metadata;
  const { signalStamp: _signalStamp, ...rest } = metadata;
  return rest;
}

/** Builds the `MessageEntry.signal` snapshot for a signal `QueueItem` at persistence time (runItem). */
function buildSignalMeta(
  content: SignalContent,
  metadata: Record<string, unknown> | undefined,
): NonNullable<MessageEntry["signal"]> {
  const stamp = readSignalStamp(metadata);
  return {
    signalType: content.signalType,
    attributes: content.attributes,
    tagName: content.tagName ?? "signal",
    senderSessionId: stamp?.senderSessionId,
    senderOwner: stamp?.senderOwner,
    hopCount: stamp?.hopCount,
    origin: content.origin,
  };
}

/** Map a submission's live status onto the narrower PromptReceipt status. */
function receiptStatus(status: QueueItem["status"]): PromptReceipt["status"] {
  if (status === "running") return "running";
  if (status === "blocked_on_decision_gate") return "blocked_on_decision_gate";
  return "queued";
}

function textOf(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  const parts = (message.content ?? []).filter((b) => b.type === "text") as Array<{
    type: "text";
    text: string;
  }>;
  return parts.map((p) => p.text).join("");
}

function renderToolResult(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const r = result as { content?: Array<{ type: string; text?: string }> };
  if (!r.content) return JSON.stringify(result);
  return r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

interface RoleOverlay {
  restore: boolean;
  systemPrompt?: string;
  model?: PiModel;
}

/**
 * Resolve a model id (or `provider/model`) to a pi-ai Model instance.
 *
 * - `provider/model` form (e.g. "anthropic/claude-haiku-4-5") — used as-is.
 * - Bare ids — tried under a small set of common providers (anthropic
 *   first since the engine is anthropic-default).
 *
 * Returns undefined when nothing matches. Callers that need to fail hard
 * (e.g. user-driven setModel) should throw on undefined.
 */
export function resolveModelId(spec: string): PiModel | undefined {
  const slash = spec.indexOf("/");
  if (slash > 0) {
    const provider = spec.slice(0, slash);
    const modelId = spec.slice(slash + 1);
    return getModel(provider as never, modelId as never);
  }
  const tryProviders = ["anthropic", "openai", "google"] as const;
  for (const p of tryProviders) {
    const m = getModel(p, spec as never);
    if (m) return m;
  }
  return undefined;
}

// Back-compat alias used by applyRoleForTurn in this file.
const resolveRoleModel = resolveModelId;

/** Extract readable text from a persisted tool_call `result` (any shape). */
function toolResultText(result: unknown): string {
  if (result && typeof result === "object") {
    const r = result as { text?: unknown; content?: Array<{ type: string; text?: string }> };
    if (typeof r.text === "string") return r.text;
    if (Array.isArray(r.content)) {
      return r.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
    }
    return JSON.stringify(result);
  }
  return String(result ?? "");
}

function findMostRecentCompaction(
  entries: readonly SessionEntry[],
): CompactionEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "compaction") return e;
  }
  return undefined;
}

/**
 * Convert persisted user-message attachments into the pi-ai `ImageContent`
 * blocks the model consumes. Single source of truth for base64 / data-URL
 * decoding; used by BOTH `entriesToAgentMessages` (historical entries on
 * rehydrate / resume / compaction) AND `Thread.runAgent` (the CURRENT turn's
 * user message, so its image lands in `agent.state.messages` alongside the
 * text and survives into every subsequent turn's LLM call).
 *
 * Attachments without usable `data` or `url` are skipped silently; a URL
 * that is not a base64 `data:` URL is dropped with a warning (the model
 * cannot fetch remote URLs from here).
 */
/**
 * Build the content blocks for a user message from its text and persisted
 * attachments. Single source of truth for BOTH `entriesToAgentMessages`
 * (historical entries on rehydrate / resume / compaction) AND
 * `Thread.runAgent` (the current turn), so hot and cold transcripts agree.
 *
 * File attachments (sandbox uploads) render as a system-authored note
 * prepended to the text — the model reads paths, not bytes. Image
 * attachments render as image content blocks.
 *
 * `sender` (when set) renders as a `[from: …]` line above the text so the
 * model can tell which person sent the message. Callers pass it only on
 * shared (team/org-owned) sessions — on a personal session every prompt has
 * the same author and the line would be noise.
 */
export function userContentBlocks(
  text: string,
  attachments: MessageEntry["attachments"] | undefined,
  sender?: PromptAuthor,
): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  const files = (attachments ?? []).filter(
    (a): a is Extract<NonNullable<MessageEntry["attachments"]>[number], { type: "file" }> =>
      a.type === "file",
  );
  const note = formatFileAttachmentsNote(files);
  const senderLine = formatSenderLine(sender);
  const prefixed = [senderLine, note, text].filter((s) => s !== undefined && s !== "").join("\n\n");
  return [
    { type: "text" as const, text: prefixed },
    ...attachmentsToImageBlocks(attachments),
  ];
}


export function attachmentsToImageBlocks(
  attachments: MessageEntry["attachments"] | undefined,
): Array<{ type: "image"; data: string; mimeType: string }> {
  if (!attachments || attachments.length === 0) return [];
  const blocks: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const att of attachments) {
    if (att.type !== "image") continue;
    let imageData: string;
    // att.data is set when a tool returns binary attachment data (e.g. screenshot utilities)
    if (att.data instanceof Uint8Array) {
      imageData = Buffer.from(att.data).toString("base64");
    } else if (att.url) {
      // Extract base64 payload from data: URL
      const match = att.url.match(/^data:([^;]+);base64,([A-Za-z0-9+/]+=*)$/);
      if (!match) {
        // Invalid data: URL format — skip this attachment and log a warning
        console.warn(`[engine] skipping attachment with invalid data: URL format: ${att.url}`);
        continue;
      }
      imageData = match[2];
    } else {
      // Skip attachments without data
      continue;
    }
    blocks.push({ type: "image", data: imageData, mimeType: att.mimeType });
  }
  return blocks;
}

export function entriesToAgentMessages(
  entries: readonly SessionEntry[],
  modelHint: { api: string; provider: string; id: string },
  opts?: {
    /**
     * Render each user entry's `author` as a `[from: …]` line (shared
     * team/org sessions, where prompts come from different people). Signal
     * entries are exempt — their envelope already names the sender.
     */
    attributeAuthors?: boolean;
  },
): AgentMessage[] {
  // 1. Find the most recent CompactionEntry. Everything in its coveredEntryIds is dropped.
  let activeCompaction: { summary: string; covered: Set<string> } | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "compaction") {
      activeCompaction = { summary: e.summary, covered: new Set(e.coveredEntryIds) };
      break;
    }
  }

  const out: AgentMessage[] = [];
  if (activeCompaction) {
    out.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `<previous-context>\n${activeCompaction.summary}\n</previous-context>`,
        },
      ],
      timestamp: 0,
    });
  }

  for (const e of entries) {
    if (e.type !== "message") continue;
    if (activeCompaction?.covered.has(e.id)) continue;

    if (e.role === "user") {
      const text = e.signal ? renderSignalEnvelope(e.signal, e.content) : e.content;
      const sender = opts?.attributeAuthors && !e.signal ? e.author : undefined;
      const contentBlocks = userContentBlocks(text, e.attachments, sender);
      out.push({
        role: "user",
        content: contentBlocks,
        timestamp: e.createdAt,
      });
      continue;
    }
    if (e.role === "assistant") {
      const blocks: Array<TextContent | ThinkingContent | ToolCall> = [];
      const parts = e.parts ?? [];
      const hadStructuredParts = parts.length > 0;
      for (const p of parts) {
        if (p.type === "text") blocks.push({ type: "text", text: p.text });
        else if (p.type === "thinking") blocks.push({ type: "thinking", thinking: p.text });
        else if (p.type === "tool_call") {
          blocks.push({
            type: "toolCall",
            id: p.callId,
            name: p.toolName,
            arguments: (p.args as Record<string, unknown>) ?? {},
          });
        }
      }
      if (!hadStructuredParts && e.content) {
        blocks.push({ type: "text", text: e.content });
      }
      out.push({
        role: "assistant",
        content: blocks,
        api: modelHint.api,
        provider: modelHint.provider,
        model: e.model ?? modelHint.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: e.createdAt,
      });
      // Answer every resolved tool call from persisted history — providers
      // reject a context whose toolCall lacks a matching toolResult, and a
      // multi-round turn has tool calls in EARLIER assistant messages too.
      // This function is the single owner of toolResult emission: the resume
      // path repairs dangling parts to `error` BEFORE rehydrating, so the
      // crash point is answered here with its honest interrupted error (never
      // a fabricated success, never re-executed). Parts still `running` (a
      // suspended gate's tool) stay unanswered — `replayBlocked` pushes their
      // result after re-running the tool, so no callId is answered twice.
      for (const p of parts) {
        if (p.type !== "tool_call") continue;
        if (p.status !== "completed" && p.status !== "error") continue;
        const isError = p.status === "error";
        out.push({
          role: "toolResult",
          toolCallId: p.callId,
          toolName: p.toolName,
          content: [
            { type: "text", text: isError ? p.error ?? "tool call failed" : toolResultText(p.result) },
          ],
          isError,
          timestamp: e.createdAt,
        });
      }
    }
  }
  return out;
}
