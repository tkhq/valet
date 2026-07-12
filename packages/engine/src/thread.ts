import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { getModel, isContextOverflow } from "@mariozechner/pi-ai";
import type { Api, Message, Model, TextContent, ThinkingContent, ToolCall } from "@mariozechner/pi-ai";

type PiModel = Model<Api>;
import type { Session } from "./session.js";
import { toAgentTool } from "./tool-bridge.js";
import {
  fromRequest,
  GateManager,
  isDecisionGateExpired,
  isDecisionGateWithdrawn,
  shouldShortCircuit,
} from "./decision-gate.js";
import { renderTemplate } from "./roles-skills/index.js";
import { deriveQueueState, resolvePartialSubmissionText, resolveSubmissionText } from "./submission.js";
import { NotFoundError, StaleAttemptError, TimeoutError } from "./errors.js";
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
  MessagePart,
  MessageEntry,
  MessageQuery,
  PromptAuthor,
  PromptContent,
  PromptOptions,
  PromptReceipt,
  QueueItem,
  QueueMode,
  SessionEntry,
  SkillInvokeOptions,
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
  private mode: QueueMode;
  private aborted = false;
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
    | { gateId: string; resolution?: DecisionResolution }
    | undefined;
  /** Token usage from the most recent assistant message, captured at turn_end. */
  private lastAssistantUsage:
    | { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
    | undefined;
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
      void this.session.emit({
        type: "decision_gate_resolved",
        threadId: this.id,
        gateId,
        resolution,
      });
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
    const resolved: DecisionGate = {
      ...existing,
      status: "resolved",
      updatedAt: Date.now(),
    };
    await store.saveDecisionGate(this.session.id, this.id, resolved);
    await store.updateDecisionGateEntry(this.session.id, this.id, gateId, {
      gate: resolved,
      resolution,
      resolvedAt: new Date(resolution.resolvedAt).toISOString(),
    });
  }

  withdrawDecision(gateId: string, reason: DecisionWithdrawReason): boolean {
    const ok = this.gates.withdraw(gateId, reason);
    if (ok) {
      void this.session.emit({
        type: "decision_gate_withdrawn",
        threadId: this.id,
        gateId,
        reason,
      });
    }
    return ok;
  }

  async submitPrompt(content: PromptContent, opts: PromptOptions): Promise<PromptReceipt> {
    const effectiveMode: QueueMode = opts.queueMode ?? this.mode;

    if (effectiveMode === "collect") {
      return this.submitCollect(content, opts);
    }

    const item = this.buildQueueItem(content, {
      dispatchId: opts.dispatchId,
      author: opts.author,
      channel: opts.channel,
      replyTarget: opts.replyTarget,
      model: opts.model,
      role: opts.role,
      metadata: opts.metadata,
    });

    const store = this.session.providers.store;
    const { item: admitted, supersededItemIds } = await store.admitSubmission(
      this.session.id,
      this.id,
      item,
      effectiveMode === "steer" ? { steer: true } : undefined,
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
      }
      await this.emitQueueState();
      void this.kick();
    } finally {
      this.flushingCollect = false;
    }
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
      metadata: fields.metadata,
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
    ctx: { gateId: string; resolution?: DecisionResolution } | undefined,
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
    this.setReplayContext({ gateId: suspended.gateId, resolution });
    // The deterministic gate ID is derived from
    // (sessionId, threadId, queueItemId, resumeKey). During replay, the
    // tool's requestDecision call recomputes this from the active queue
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
    try {
      await this.agent.continue();
      await this.agent.waitForIdle();
    } catch (err) {
      this.emitError(
        "replay_continue_failed",
        err instanceof Error ? err.message : String(err),
      );
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
        await this.settleTurn(settleItem);
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
          void this.terminalizeReconciledGate(gate, err);
          return;
        }
        this.emitError(
          "replay_after_pending_gate_failed",
          err instanceof Error ? err.message : String(err),
        );
      });
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
    const status: DecisionGate["status"] = reason ? "withdrawn" : "expired";
    const terminal: DecisionGate = { ...gate, status, updatedAt: Date.now() };
    await store.saveDecisionGate(this.session.id, this.id, terminal);
    await store.updateDecisionGateEntry(this.session.id, this.id, gate.id, {
      gate: terminal,
      ...(reason
        ? { withdrawnReason: reason }
        : { resolvedAt: new Date().toISOString() }),
    });
    if (!reason) {
      await this.session.emit({
        type: "decision_gate_expired",
        threadId: this.id,
        gateId: gate.id,
      });
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
    this.agent.state.messages = entriesToAgentMessages(entries, this.session.options.model);
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
    const sessionDefault = this.session.options.model.id;
    const before = this.modelOverride ?? sessionDefault;
    if (modelId === null) {
      this.modelOverride = undefined;
    } else {
      // Resolve before assigning so an unknown id is rejected and the
      // thread keeps its previous setting.
      const resolved = resolveModelId(modelId);
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

  async readEntries(opts?: MessageQuery): Promise<SessionEntry[]> {
    return this.session.providers.store.getEntries(this.session.id, this.id, opts);
  }

  // ── internals ───────────────────────────────────────────────────

  /** Current running submission id (for the session heartbeat's lease renewal). */
  runningItemId(): string | undefined {
    return this.runningItem?.id;
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
      this.fence = { itemId: claimed.id, attemptId };
      this.staleFenceDetected = false;
      this.session.ensureTimers();
      await this.emitQueueState();

      let turnFailed = false;
      let turnError: unknown;
      try {
        await this.runItem(claimed);
      } catch (err) {
        turnFailed = true;
        turnError = err;
        this.emitError("run_failed", err instanceof Error ? err.message : String(err));
      }
      try {
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
        this.runningItem = null;
        this.fence = undefined;
      }
    }
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
    await this.session.emit({
      type: "submission_settled",
      sessionId: this.session.id,
      threadId: this.id,
      queueItemId: item.id,
      outcome: item.outcome ?? { outcome: "completed" },
    });
    await this.emitQueueState();
    return true;
  }

  /**
   * Two-phase settlement for a claimed turn. Skipped when the turn is still
   * blocked on a decision gate (the claim is retained), or when a stale fence
   * signalled that a successor already owns the item.
   */
  private async settleTurn(item: QueueItem, turnFailure?: { error: unknown }): Promise<void> {
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
    try {
      await store.reserveSettlement(this.session.id, this.id, item.id, outcome, fence);
      await this.repairRestState(item, fence);
      await store.finalizeSettlement(this.session.id, this.id, item.id, fence);
    } catch (err) {
      if (err instanceof StaleAttemptError) {
        this.staleFenceDetected = true;
        return;
      }
      throw err;
    }
    await store.deleteAttemptMarker(item.id, fence.attemptId);
    await this.session.emit({
      type: "submission_settled",
      sessionId: this.session.id,
      threadId: this.id,
      queueItemId: item.id,
      outcome,
    });
    await this.emitQueueState();
  }

  /** Map the turn's terminal state to a SubmissionOutcome. */
  private decideTurnOutcome(
    current: QueueItem,
    turnFailure?: { error: unknown },
  ): SubmissionOutcome {
    const last = this.agent.state.messages[this.agent.state.messages.length - 1];
    const stop = last && last.role === "assistant" ? last.stopReason : undefined;
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

  private async emitSettled(itemId: string, outcome: SubmissionOutcome): Promise<void> {
    await this.session.emit({
      type: "submission_settled",
      sessionId: this.session.id,
      threadId: this.id,
      queueItemId: itemId,
      outcome,
    });
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
        const withdrawn: DecisionGate = { ...gate, status: "withdrawn", updatedAt: Date.now() };
        await store.saveDecisionGate(this.session.id, this.id, withdrawn);
        await store.updateDecisionGateEntry(this.session.id, this.id, gate.id, {
          gate: withdrawn,
          withdrawnReason: "steer",
        });
        await this.session.emit({
          type: "decision_gate_withdrawn",
          threadId: this.id,
          gateId: gate.id,
          reason: "steer",
        });
      }
    }

    try {
      await store.reserveSettlement(this.session.id, this.id, item.id, outcome, fence);
      await this.repairRestState(item, fence);
      if (suspended) await store.clearSuspendedTurn(this.session.id, this.id, fence);
      await store.finalizeSettlement(this.session.id, this.id, item.id, fence);
    } catch (err) {
      if (err instanceof StaleAttemptError) return; // successor owns it now
      throw err;
    }
    await store.deleteAttemptMarker(item.id, attemptId);
    await this.emitSettled(item.id, outcome);
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
      this.agent.state.messages = entriesToAgentMessages(entries, {
        api: this.session.options.model.api,
        provider: this.session.options.model.provider,
        id: this.session.options.model.id,
      });
      this.agent.state.tools = this.buildTools();

      await this.agent.continue();
      await this.agent.waitForIdle();
    } catch (err) {
      turnFailed = true;
      turnError = err;
      this.emitError("resume_failed", err instanceof Error ? err.message : String(err));
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

  /** Emit the derived `queue_state` event for this thread from durable rows. */
  private async emitQueueState(): Promise<void> {
    const items = await this.session.providers.store.listUnsettledSubmissions(this.session.id);
    const state = deriveQueueState(this.id, items, this.mode, this.paused, this.blockedGateId);
    await this.session.emit({ type: "queue_state", threadId: this.id, state });
  }

  private async runItem(item: QueueItem): Promise<void> {
    const text = promptText(item.content);
    this.aborted = false;
    this.currentAssistantMessageId = undefined;
    this.currentAssistantParts = [];
    this.currentToolCalls.clear();

    // Persist user message entry. QueueItem.metadata flows through onto the
    // entry so synthetic flags like compaction_continue survive into the DAG
    // for client UIs and for later restoration.
    const userEntry: MessageEntry = {
      id: uid("e"),
      sessionId: this.session.id,
      threadId: this.id,
      parentId: null,
      type: "message",
      role: "user",
      content: text,
      author: item.author,
      channel: item.channel,
      metadata: item.metadata,
      queueItemId: item.id,
      createdAt: Date.now(),
    };
    await this.fencedWrite(() =>
      this.session.providers.store.appendEntries(this.session.id, this.id, [userEntry], this.fence),
    );

    // Build the AgentTool list with closures over this turn's ToolContext.
    this.agent.state.tools = this.buildTools();

    // Layered model resolution: thread override → session default.
    // applied BEFORE role overlay so a role's model frontmatter still wins
    // for that one turn. Captured here so we restore the right baseline,
    // not whatever the role overlaid.
    const baselineModel = this.agent.state.model;
    const turnModel = this.resolveTurnModel();
    if (turnModel !== baselineModel) {
      this.agent.state.model = turnModel;
    }

    // Apply role overlay (system-prompt overlay + optional model override) for
    // this one turn. Restored unconditionally in finally.
    const roleOverlay = this.applyRoleForTurn(item);
    try {
      try {
        await this.runAgent(text);
      } catch (err) {
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
      this.restoreRoleAfterTurn(roleOverlay);
      // Restore the agent's baseline model so the next turn picks up any
      // mutation we made via setModel. We compute the override fresh on
      // each turn anyway, but keeping state tidy avoids surprises.
      this.agent.state.model = baselineModel;
    }
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

  /** Run one prompt cycle. On context-overflow error, compact and retry once. */
  private async runAgent(text: string): Promise<void> {
    await this.agent.prompt({
      role: "user",
      content: [{ type: "text", text }],
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
          content: [{ type: "text", text }],
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
  async compactThread(opts: { mode: "proactive" | "reactive" }): Promise<void> {
    const cfg = this.session.options.compaction;
    if (cfg?.enabled === false) return;
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
    await session.emit({ type: "compaction_start", threadId: this.id });
    let summaryResult: SummarizeResult;
    try {
      const previousSummary = findMostRecentCompaction(entries)?.summary;
      summaryResult = await summarize({
        headEntries: head,
        model,
        toolOutputMaxChars: cfg?.toolOutputMaxChars,
        previousSummary,
      });
    } catch (err) {
      await session.emit({ type: "compaction_end", threadId: this.id });
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
    // Fenced under the current turn's attempt (compaction is always in-turn).
    await store.appendEntries(session.id, this.id, [compactionEntry], this.fence);

    // Step 5: rewrite agent.state.messages. The simplest and most
    // correct path is to rebuild from the now-augmented DAG.
    const updatedEntries = await store.getEntries(session.id, this.id);
    this.agent.state.messages = entriesToAgentMessages(updatedEntries, {
      api: session.options.model.api,
      provider: session.options.model.provider,
      id: session.options.model.id,
    });

    await session.emit({ type: "compaction_end", threadId: this.id });

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
    const agent = new Agent({
      initialState: {
        model: this.session.options.model,
        systemPrompt: this.session.options.systemPrompt ?? "",
      },
      // Filter out custom AgentMessage types (decision_gate, compaction, etc.)
      // before the LLM sees them. They live in the engine DAG, not in LLM context.
      convertToLlm: (messages: AgentMessage[]): Message[] => {
        return messages.filter(
          (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
        ) as Message[];
      },
    });
    agent.subscribe((event, _signal) => this.handleAgentEvent(event));
    return agent;
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
          this.suspendedDecisionForReplay = undefined; // one-shot
          return sc.resolution;
        }
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
        const gate = fromRequest(req, gateCtx);
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

        // checkpoint the suspended turn — use real toolName + toolArgs so
        // restoreSession can replay this exact tool call.
        await fencedGateWrite(() =>
          session.providers.store.saveSuspendedTurn(
            session.id,
            this.id,
            {
              sessionId: session.id,
              threadId: this.id,
              queueItemId: runningItemId ?? "",
              gateId: gate.id,
              model: session.options.model.id,
              toolCallId,
              toolName,
              toolArgs,
              resumeKey: req.resumeKey ?? gate.id,
              attempt: 1,
              createdAt: Date.now(),
            },
            fence,
          ),
        );

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
        await session.emit({
          type: "status",
          threadId: this.id,
          status: "blocked_on_decision_gate",
        });
        await session.emit({ type: "decision_gate", threadId: this.id, gate });

        try {
          const resolution = await this.gates.register(gate, async (gateId) => {
            await session.providers.store.updateDecisionGateEntry(
              session.id,
              this.id,
              gateId,
              { resolvedAt: new Date().toISOString(), gate: { ...gate, status: "expired" } },
            );
            await session.emit({ type: "decision_gate_expired", threadId: this.id, gateId });
          });
          // Mark gate resolved in store and update DAG entry
          const resolved: DecisionGate = { ...gate, status: "resolved", updatedAt: Date.now() };
          await session.providers.store.saveDecisionGate(session.id, this.id, resolved);
          await session.providers.store.updateDecisionGateEntry(session.id, this.id, gate.id, {
            gate: resolved,
            resolution,
            resolvedAt: new Date(resolution.resolvedAt).toISOString(),
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
          const reason =
            err instanceof Error && err.name === "DecisionGateWithdrawnError"
              ? (err as { reason?: DecisionWithdrawReason }).reason ?? "cancel"
              : undefined;
          const status = reason ? "withdrawn" : "expired";
          const terminal: DecisionGate = { ...gate, status, updatedAt: Date.now() };
          await session.providers.store.saveDecisionGate(session.id, this.id, terminal);
          await session.providers.store.updateDecisionGateEntry(session.id, this.id, gate.id, {
            gate: terminal,
            withdrawnReason: reason,
          });
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
        await this.session.emit({ type: "thread_start", threadId: this.id });
        await this.session.emit({ type: "status", threadId: this.id, status: "thinking" });
        break;
      case "message_start": {
        if (event.message.role === "assistant") {
          this.currentAssistantMessageId = uid("e");
          this.currentAssistantParts = [];
          this.currentToolCalls.clear();
          this.currentAssistantEntry = undefined;
          await this.session.emit({
            type: "message_start",
            threadId: this.id,
            messageId: this.currentAssistantMessageId,
            role: "assistant",
          });
        }
        break;
      }
      case "message_update": {
        const ev = event.assistantMessageEvent;
        if (ev.type === "text_delta") {
          await this.session.emit({
            type: "text_delta",
            threadId: this.id,
            text: ev.delta,
          });
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
          await this.session.emit({
            type: "message_end",
            threadId: this.id,
            messageId: entry.id,
            reason:
              event.message.stopReason === "aborted"
                ? "abort"
                : event.message.stopReason === "error"
                ? "error"
                : "end_turn",
          });
        }
        break;
      }
      case "tool_execution_start":
        this.toolCtxOverlay.gateId = undefined;
        await this.session.emit({
          type: "tool_start",
          threadId: this.id,
          tool: event.toolName,
          args: event.args ?? {},
        });
        await this.session.emit({ type: "status", threadId: this.id, status: "tool_calling" });
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
        // Re-persist the entry now that this tool's status/result has been
        // mutated. Without this, sqlite still has status="running" + no
        // result; on reload the chat shows tool cards stuck mid-execution.
        if (this.currentAssistantEntry) {
          const entry = this.currentAssistantEntry;
          await this.fencedWrite(() =>
            this.session.providers.store.updateEntry(this.session.id, this.id, entry, this.fence),
          );
        }
        await this.session.emit({
          type: "tool_end",
          threadId: this.id,
          tool: event.toolName,
          result: resultText,
          isError: event.isError,
        });
        break;
      }
      case "turn_end": {
        const stopReason =
          event.message.role === "assistant" ? event.message.stopReason : undefined;
        const errorMessage =
          event.message.role === "assistant" ? event.message.errorMessage : undefined;
        if (event.message.role === "assistant") {
          const u = event.message.usage;
          this.lastAssistantUsage = {
            input: u.input,
            output: u.output,
            cacheRead: u.cacheRead,
            cacheWrite: u.cacheWrite,
            total: u.totalTokens || u.input + u.output + u.cacheRead + u.cacheWrite,
          };
        }
        if (errorMessage) {
          await this.session.emit({
            type: "error",
            threadId: this.id,
            code: stopReason ?? "agent_error",
            error: errorMessage,
            recoverable: stopReason !== "error",
          });
        }
        const reason: "end_turn" | "error" | "abort" =
          stopReason === "aborted"
            ? "abort"
            : stopReason === "error"
            ? "error"
            : "end_turn";
        await this.session.emit({ type: "turn_end", threadId: this.id, reason });
        await this.session.emit({ type: "status", threadId: this.id, status: "idle" });
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

  private emitError(code: string, message: string): void {
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
    if (opts.resultSchema) throw new Error("resultSchema lands in Phase 5");
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

      unsubscribe = this.session.providers.bus.subscribe(
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
  return content.text ?? "";
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
 * Convert engine DAG entries to pi-agent-core AgentMessages, honoring the
 * most recent CompactionEntry (drop covered entries, inject summary as a
 * `<previous-context>` user message) and elided tool results (replace with
 * a placeholder text block on the assistant side).
 *
 * Pure function — kept here rather than inside Thread so it's
 * testable and reusable from places like Engine.restoreSession.
 */
export function entriesToAgentMessages(
  entries: readonly SessionEntry[],
  modelHint: { api: string; provider: string; id: string },
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
      out.push({
        role: "user",
        content: [{ type: "text", text: e.content }],
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
