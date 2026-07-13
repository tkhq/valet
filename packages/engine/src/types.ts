import type { TSchema, Static } from "typebox";
import type { Model } from "@mariozechner/pi-ai";

// ── Identity / authoring ──────────────────────────────────────────

export interface PromptAuthor {
  id: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  externalId?: string;
}

export interface ChannelTarget {
  channelType: string;
  channelId: string;
  threadId?: string;
}

// ── Sessions / threads / queue ────────────────────────────────────

export type SessionPurpose = "interactive" | "orchestrator" | "workflow" | "child";
export type SessionStatus =
  | "initializing"
  | "running"
  | "paused"
  | "hibernated"
  | "terminated"
  | "error";

/** Ownership principal, shared with the application layer. Serialized `${type}:${id}`. */
export interface Principal {
  type: "user" | "team" | "org";
  id: string;
}

export interface SessionData {
  id: string;
  /** Who the session belongs to; access to team/org-owned sessions follows membership. */
  owner: Principal;
  userId: string;
  orgId: string;
  workspace: string;
  purpose: SessionPurpose;
  status: SessionStatus;
  sandboxId?: string;
  snapshotId?: string;
  parentSessionId?: string;
  parentThreadId?: string;
  /**
   * Persisted session-default model id (e.g. "claude-haiku-4-5" or
   * "anthropic/claude-opus-4-7"). Layered resolution at turn time:
   * `thread.model ?? session.model ?? hostDefault`. Mutated by
   * `Session.setModel`; resolved to a live `Model<any>` on each turn.
   */
  model?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export type QueueMode = "followup" | "steer" | "collect";
export type ThreadStatus = "active" | "paused" | "archived";
export type QueueStatus = "idle" | "queued" | "running" | "blocked_on_decision_gate" | "paused";

export interface ThreadData {
  id: string;
  sessionId: string;
  key: string;
  status: ThreadStatus;
  activeLeafEntryId?: string;
  queueMode: QueueMode;
  /** Persisted pause flag — the only stored piece of queue state; everything else in QueueState derives from durable queue items. */
  paused?: boolean;
  model?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface QueueState {
  threadId: string;
  mode: QueueMode;
  status: QueueStatus;
  activeItemId?: string;
  pending: QueueItem[];
  collectBuffer?: QueueItem[];
  blockedGateId?: string;
}

export interface WriteFence {
  itemId: string;
  attemptId: string;
}

export interface SubmissionClaim {
  sessionId: string;
  threadId: string;
  itemId: string;
  attemptId: string;
  ownerId: string;
  leaseDurationMs?: number; // default 30_000
}

export interface SubmissionOutcome {
  outcome: "completed" | "failed" | "aborted" | "superseded" | "merged";
  error?: string;
}

export type SubmissionStatus =
  | "collecting"
  | "queued"
  | "running"
  | "blocked_on_decision_gate"
  | "terminalizing"
  | "settled";

export interface QueueItem {
  id: string;
  threadId: string;
  /** Idempotent admission key. Unique per session when present. */
  dispatchId?: string;
  content: PromptContent;
  author?: PromptAuthor;
  channel?: ChannelTarget;
  replyTarget?: ChannelTarget;
  model?: string;
  /** Role name to apply for this one prompt (system-prompt overlay + optional model override). */
  role?: string;
  metadata?: Record<string, unknown>;
  // Durable execution lifecycle
  status: SubmissionStatus;
  outcome?: SubmissionOutcome;
  supersededByItemId?: string;
  mergedIntoItemId?: string;
  attemptId?: string;
  attemptCount: number; // starts 0; claim/replace set+increment
  maxAttempts: number; // default 10
  timeoutAt: number; // default createdAt + 3_600_000
  abortRequestedAt?: number;
  ownerId?: string;
  leaseExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SubmissionResult {
  queueItemId: string;
  outcome: SubmissionOutcome["outcome"];
  /** Content of the last persisted assistant entry carrying this queueItemId with stopReason 'end_turn'. */
  text?: string;
  output?: unknown; // Phase 5 (resultSchema) — always undefined in Phase 1
  error?: string;
}

export interface AwaitResultOptions {
  timeoutMs?: number;
  resultSchema?: TSchema; // typed now, rejected until Phase 5
  signal?: AbortSignal;
}

// ── Prompts ────────────────────────────────────────────────────────

export type PromptContent =
  | string
  | {
      text?: string;
      attachments?: PromptAttachment[];
    };

export type PromptAttachment =
  | { type: "image"; url?: string; data?: Uint8Array; mimeType: string; name?: string }
  | { type: "file"; url?: string; data?: Uint8Array; mimeType: string; name: string }
  | { type: "audio"; url?: string; data?: Uint8Array; mimeType: string; name?: string };

export interface PromptOptions {
  author?: PromptAuthor;
  channel?: ChannelTarget;
  replyTarget?: ChannelTarget;
  queueMode?: QueueMode;
  model?: string;
  role?: string;
  resultSchema?: TSchema;
  metadata?: Record<string, unknown>;
  /** Idempotent admission key. Re-submitting the same dispatchId returns the existing submission. */
  dispatchId?: string;
}

export interface PromptReceipt {
  sessionId: string;
  threadId: string;
  queueItemId: string;
  status: "queued" | "running" | "blocked_on_decision_gate";
}

// ── Messages and DAG entries ──────────────────────────────────────

export interface BaseEntry {
  id: string;
  sessionId: string;
  threadId: string;
  parentId: string | null;
  createdAt: number;
  metadata?: Record<string, unknown>;
  /** The submission that produced this entry — the transcript↔submission linkage. */
  queueItemId?: string;
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool_call";
      callId: string;
      toolName: string;
      status: "running" | "completed" | "error";
      args?: unknown;
      result?: unknown;
      error?: string;
      /** Set by the pruner. When true, `result` has been replaced with a placeholder; the original output is no longer available. */
      elided?: boolean;
    }
  | { type: "attachment"; attachment: ToolAttachment }
  | { type: "error"; message: string; code?: string };

export interface MessageEntry extends BaseEntry {
  type: "message";
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  parts?: MessagePart[];
  author?: PromptAuthor;
  channel?: ChannelTarget;
  model?: string;
  /** Persisted on the turn's final assistant entry. */
  stopReason?: "end_turn" | "error" | "abort";
}

export interface CompactionEntry extends BaseEntry {
  type: "compaction";
  summary: string;
  coveredEntryIds: string[];
  tokenCountBefore: number;
  tokenCountAfter: number;
  fileContext?: { read: string[]; modified: string[] };
}

export interface BranchSummaryEntry extends BaseEntry {
  type: "branch_summary";
  branchRootId: string;
  branchLeafId: string;
  summary: string;
}

export interface DecisionGateEntry extends BaseEntry {
  type: "decision_gate";
  gate: DecisionGate;
  resolvedAt?: string;
  resolution?: DecisionResolution;
  withdrawnReason?: DecisionWithdrawReason;
}

export type SessionEntry = MessageEntry | CompactionEntry | BranchSummaryEntry | DecisionGateEntry;

export interface MessageQuery {
  limit?: number;
  cursor?: string;
  afterEntryId?: string;
  beforeEntryId?: string;
  includeCompacted?: boolean;
  includeSystemEntries?: boolean;
}

// ── Tools ──────────────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ToolDef<TParams extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParams;
  riskLevel?: RiskLevel;
  requiresApproval?: boolean | ((args: Static<TParams>, ctx: ToolContext) => Promise<boolean> | boolean);
  /** When true, this tool's outputs are exempt from pruning during compaction. */
  protectedFromPruning?: boolean;
  execute: (args: Static<TParams>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolResult {
  text: string;
  attachments?: ToolAttachment[];
}

export type ToolAttachment =
  | { type: "image"; data: Uint8Array; mimeType: string; name?: string }
  | { type: "file"; data: Uint8Array; mimeType: string; name: string }
  | { type: "text"; content: string; name?: string; language?: string };

export type ToolArtifact =
  | { type: "file"; path?: string; blobKey?: string; title?: string }
  | { type: "link"; url: string; title: string }
  | { type: "diff"; path?: string; content: string };

export interface ToolContext {
  userId: string;
  orgId: string;
  sessionId: string;
  threadId: string;
  sessionPurpose?: SessionPurpose;
  actor?: { id: string; name?: string; email?: string };
  channelType?: string;
  channelId?: string;
  decisionGateId?: string;
  replyChannelType?: string;
  replyChannelId?: string;
  cwd?: string;
  repo?: { url?: string; branch?: string; ref?: string; provider?: string };
  credentials: CredentialProvider;
  sandbox: Sandbox;
  requestDecision: (gate: DecisionGateRequest) => Promise<DecisionResolution>;
  emitArtifact?: (artifact: ToolArtifact) => Promise<void>;
  suspendedDecision?: { gateId: string; resolution?: DecisionResolution };
  signal: AbortSignal;
  threadRead: (key: string, opts?: MessageQuery) => Promise<SessionEntry[]>;
  /**
   * List all sibling threads in this session (including the caller's own
   * thread). Useful for orchestrator-style agents that want to discover
   * which keys exist before calling `threadRead`.
   */
  listThreads: () => Promise<
    Array<{
      id: string;
      key: string;
      status: ThreadStatus;
      model?: string;
      summary?: string;
      createdAt: number;
      updatedAt: number;
    }>
  >;
  /**
   * Switch the active model for *this thread*. Resolves the id, persists,
   * emits `model_switched`. Takes effect on the next turn — the in-flight
   * tool call finishes against the old model. Throws on unresolvable ids.
   *
   * Intentionally thread-scoped only. Changing the session default is a
   * user-facing setting (it affects every future thread the user opens),
   * not something an agent should reach for unilaterally; that path lives
   * on the API server (`PATCH /api/sessions/:id`) and is reachable only
   * from the UI.
   */
  setModel: (args: { model: string }) => Promise<{
    fromModel: string;
    toModel: string;
  }>;
}

// ── Credentials ────────────────────────────────────────────────────

export interface Credential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

export interface CredentialProvider {
  /**
   * Fetch a stored credential. The `service` arg is optional so plugin
   * actions can call `.get()` to use their own default scope (set up by
   * the plugin catalog when it builds PluginActionContext); first-class
   * tools should always pass it explicitly.
   */
  get(service?: string): Promise<Credential | null>;
  request(service: string, reason: string): Promise<Credential>;
}

export interface CredentialOwner {
  type: "user" | "org" | "session";
  id: string;
}

export interface StoredCredential {
  type: "oauth2" | "api_key" | "bot_token" | "service_account" | "app_install";
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  expiresAt?: number;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

export interface CredentialStore {
  get(owner: CredentialOwner, service: string): Promise<StoredCredential | null>;
  save(owner: CredentialOwner, service: string, credential: StoredCredential): Promise<void>;
  delete(owner: CredentialOwner, service: string): Promise<void>;
  list(owner: CredentialOwner): Promise<{ service: string; scopes?: string[]; connectedAt: string }[]>;
}

// ── Decision gates ─────────────────────────────────────────────────

export type DecisionGateType = "approval" | "question" | "credential_request";
export type DecisionGateStatus = "pending" | "resolved" | "expired" | "withdrawn";
export type DecisionWithdrawReason = "steer" | "abort" | "cancel";

export interface DecisionAction {
  id: string;
  label: string;
  style?: "primary" | "danger";
}

export interface DecisionGateRef {
  messageId: string;
  channelId: string;
  threadId?: string;
  [key: string]: unknown;
}

export interface DecisionGate {
  id: string;
  sessionId: string;
  threadId: string;
  /** The queue item whose turn opened this gate. Part of the ordinal identity. */
  queueItemId: string;
  /** Stable per-suspension-point key supplied by the tool. Part of the ordinal identity. */
  resumeKey: string;
  /**
   * Monotonic retry counter for a (queueItemId, resumeKey) pair. Replay reuses
   * the same ordinal (joins the same persisted gate); a retried action after a
   * terminal decision gets ordinal+1 (a fresh human decision).
   */
  ordinal: number;
  type: DecisionGateType;
  title: string;
  body?: string;
  actions: DecisionAction[];
  expiresAt?: number;
  status: DecisionGateStatus;
  context?: Record<string, unknown>;
  origin?: { channelType?: string; channelId?: string; messageId?: string };
  refs?: Array<{ channelType: string; ref: DecisionGateRef }>;
  createdAt: number;
  updatedAt: number;
}

// what tools pass to ctx.requestDecision — minimal shape; engine fills in identity fields
export interface DecisionGateRequest {
  type: DecisionGateType;
  title: string;
  body?: string;
  actions?: DecisionAction[];
  expiresAt?: number;
  context?: Record<string, unknown>;
  origin?: DecisionGate["origin"];
  // stable ID for re-entrancy: tools must supply the same id when re-run with suspendedDecision
  resumeKey?: string;
}

export interface DecisionResolution {
  actionId?: string;
  value?: string;
  resolvedBy: string;
  resolvedAt: number;
  source?: { channelType?: string; channelId?: string; messageId?: string };
}

export interface SuspendedTurnState {
  sessionId: string;
  threadId: string;
  queueItemId: string;
  gateId: string;
  model: string;
  leafMessageId?: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  resumeKey: string;
  /** The gate's ordinal at checkpoint time — replay reconstructs the gate id from (resumeKey, ordinal). */
  ordinal: number;
  attempt: number;
  createdAt: number;
}

// ── Sandbox ────────────────────────────────────────────────────────

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  stdin?: string;
  maxOutputBytes?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  truncated?: boolean;
}

export interface Sandbox {
  id: string;
  readFile(path: string): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }>;
  mkdir(path: string): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;
  exec(command: string, opts?: ExecOpts): Promise<ExecResult>;
  snapshot?(): Promise<string>;
  tunnels?(): Promise<Record<string, string>>;
  destroy?(): Promise<void>;
}

export interface SandboxCreateOpts {
  image?: string;
  workspace?: string;
  env?: Record<string, string>;
  timeout?: number;
  resources?: { cpu?: number; memory?: string };
  metadata?: Record<string, unknown>;
}

export interface SandboxStatus {
  id: string;
  state: "creating" | "running" | "stopped" | "error";
  startedAt?: number;
  error?: string;
}

export interface SandboxProvider {
  create(opts: SandboxCreateOpts): Promise<Sandbox>;
  restore(id: string): Promise<Sandbox>;
  destroy(id: string): Promise<void>;
  status(id: string): Promise<SandboxStatus>;
}

// ── Blob store ─────────────────────────────────────────────────────

export interface BlobStore {
  put(
    key: string,
    data: Uint8Array | ReadableStream,
    opts?: { contentType?: string },
  ): Promise<void>;
  get(key: string): Promise<{ data: ReadableStream; contentType?: string } | null>;
  delete(key: string): Promise<void>;
}

// ── Engine events ──────────────────────────────────────────────────

export type EngineEventStatus =
  | "idle"
  | "queued"
  | "thinking"
  | "tool_calling"
  | "streaming"
  | "blocked_on_decision_gate"
  | "error";

export type EngineEvent =
  | { type: "message_start"; threadId: string; messageId: string; role: "assistant" | "system" }
  | { type: "text_delta"; threadId: string; text: string }
  | {
      type: "message_update";
      threadId: string;
      messageId: string;
      parts: MessagePart[];
      content?: string;
    }
  | {
      type: "message_end";
      threadId: string;
      messageId: string;
      reason: "end_turn" | "error" | "abort";
    }
  | { type: "tool_start"; threadId: string; tool: string; args: Record<string, unknown> }
  | { type: "tool_end"; threadId: string; tool: string; result: string; isError: boolean }
  | { type: "turn_end"; threadId: string; reason: "end_turn" | "error" | "abort" }
  | { type: "thread_start"; threadId: string; parentThreadId?: string }
  | { type: "queue_state"; threadId: string; state: QueueState }
  | { type: "compaction_start" | "compaction_end"; threadId: string }
  | { type: "task_start" | "task_end"; childSessionId: string; threadId: string }
  | { type: "status"; threadId: string; status: EngineEventStatus }
  | { type: "error"; threadId?: string; code: string; error: string; recoverable: boolean }
  | { type: "decision_gate"; threadId: string; gate: DecisionGate }
  | { type: "decision_gate_resolved"; threadId: string; gateId: string; resolution: DecisionResolution }
  | { type: "decision_gate_expired"; threadId: string; gateId: string }
  | {
      type: "decision_gate_withdrawn";
      threadId: string;
      gateId: string;
      reason: DecisionWithdrawReason;
    }
  | { type: "model_switched"; threadId?: string; fromModel: string; toModel: string; reason: string }
  | {
      type: "submission_settled";
      sessionId: string;
      threadId: string;
      queueItemId: string;
      outcome: SubmissionOutcome;
    }
  | {
      /**
       * Stuck-head attention event (spec §Reconciliation, "Stuck-head alarm").
       * Emitted once per observation pass when an unsettled submission crosses
       * the retry threshold (attemptCount >= 3) or the wall-clock bound
       * (age > 15min), gate-blocked items excluded. The attention router lands
       * in Phase 4; Phase 1 just surfaces the signal.
       */
      type: "submission_stuck";
      sessionId: string;
      threadId: string;
      queueItemId: string;
      attemptCount: number;
      ageMs: number;
    };

export interface BusEvent {
  sessionId: string;
  threadId?: string;
  /** The submission whose turn produced this event. Drives retention/truncation. */
  queueItemId?: string;
  userId?: string;
  event: EngineEvent;
  timestamp: number;
}

/** Durable, offset-addressed event. Offset is 16-digit zero-padded decimal, monotonic per session. */
export interface StoredBusEvent extends BusEvent {
  offset: string;
}

/** What live subscribers receive: durable events carry offset, live-only deltas don't. */
export type DeliveredBusEvent = BusEvent & { offset?: string };

export type Unsubscribe = () => void;

export interface EventFilter {
  sessionId?: string;
  userId?: string;
  eventTypes?: string[];
}

export interface EventStream {
  /**
   * Durably append and fan out to live subscribers. `eventKey` is unique per
   * session: an append whose eventKey already exists is a no-op returning the
   * original offset (appendOnce).
   */
  append(event: BusEvent, eventKey: string): Promise<{ offset: string }>;
  /** Read durable events with offset > fromOffset (exclusive), in offset order. */
  read(
    sessionId: string,
    opts?: { fromOffset?: string; limit?: number },
  ): Promise<{ events: StoredBusEvent[]; nextOffset: string }>;
  /** Live fan-out. Durable events are delivered AFTER their append commits, in offset order per session. */
  subscribe(filter: EventFilter, callback: (event: DeliveredBusEvent) => void): Unsubscribe;
  /** Live-only fan-out for text_delta: no append, no offset. */
  publishEphemeral(event: BusEvent): void;
  /** Delete durable events whose queueItemId is in the list. Returns deleted count. */
  prune(sessionId: string, queueItemIds: string[]): Promise<number>;
  /** Drop the session's entire log (called from deleteSession paths / tests). */
  deleteSession(sessionId: string): Promise<void>;
}

// ── Session store ──────────────────────────────────────────────────

export interface ListOpts {
  limit?: number;
  cursor?: string;
  status?: string;
  createdAfter?: Date;
  createdBefore?: Date;
}

export interface SessionStore {
  saveSession(session: SessionData): Promise<void>;
  saveThread(sessionId: string, thread: ThreadData): Promise<void>;
  // CHANGED: optional fence; store MUST reject with StaleAttemptError when a
  // fence is provided and does not name the item's current attempt.
  appendEntries(
    sessionId: string,
    threadId: string,
    entries: SessionEntry[],
    fence?: WriteFence,
  ): Promise<void>;
  /**
   * Replace an existing entry in place. Required for pruning during
   * compaction to persist tool-result elision; also useful for any
   * other in-place mutation. Throws NotFoundError if no entry with the
   * given id exists in (sessionId, threadId).
   */
  updateEntry(
    sessionId: string,
    threadId: string,
    entry: SessionEntry,
    fence?: WriteFence,
  ): Promise<void>;
  saveDecisionGate(sessionId: string, threadId: string, gate: DecisionGate): Promise<void>;
  saveDecisionGateRef(
    sessionId: string,
    threadId: string,
    gateId: string,
    ref: { channelType: string; ref: DecisionGateRef },
  ): Promise<void>;
  updateDecisionGateEntry(
    sessionId: string,
    threadId: string,
    gateId: string,
    patch: Partial<DecisionGateEntry>,
  ): Promise<void>;
  saveSuspendedTurn(
    sessionId: string,
    threadId: string,
    suspended: SuspendedTurnState,
    fence?: WriteFence,
  ): Promise<void>;
  clearSuspendedTurn(sessionId: string, threadId: string, fence?: WriteFence): Promise<void>;
  updateSessionStatus(
    id: string,
    status: SessionStatus,
    metadata?: Partial<SessionData>,
  ): Promise<void>;
  flush?(): Promise<void>;

  // === Submission lifecycle (durable execution) ===
  /**
   * Idempotent admission. Same dispatchId + deep-equal content → returns the
   * existing item with admitted=false. Same dispatchId + different content →
   * throws ConflictError. steer:true additionally stamps supersededByItemId
   * on every unsettled item of the thread admitted before this one, in the
   * same atomic step, and returns their ids.
   */
  admitSubmission(
    sessionId: string,
    threadId: string,
    item: QueueItem,
    opts?: { steer?: boolean },
  ): Promise<{ item: QueueItem; admitted: boolean; supersededItemIds: string[] }>;
  /**
   * CAS queued→running. Succeeds only when itemId is the thread's runnable
   * head: the oldest item with status 'queued' and no supersededByItemId.
   * Records attemptId, ownerId, lease; increments attemptCount. Returns the
   * updated item, or null when not head / not queued / already claimed.
   */
  claimSubmission(claim: SubmissionClaim): Promise<QueueItem | null>;
  /** CAS: install a new attempt on a running/blocked item whose lease expired. Null when the CAS loses. */
  replaceSubmissionAttempt(
    sessionId: string,
    threadId: string,
    itemId: string,
    claim: SubmissionClaim,
    opts: { expectedAttemptId: string },
  ): Promise<QueueItem | null>;
  insertAttemptMarker(itemId: string, attemptId: string): Promise<void>;
  deleteAttemptMarker(itemId: string, attemptId: string): Promise<void>;
  /**
   * True when an attempt marker row exists for (itemId, attemptId). Durable
   * evidence that the attempt began executing; reconciliation uses it (with the
   * lease) to tell "may still be running" from "safe to reclaim".
   */
  hasAttemptMarker(itemId: string, attemptId: string): Promise<boolean>;
  /** Renew leases for items this owner still owns; silently skips items whose attempt was replaced. */
  renewLeases(ownerId: string, itemIds: string[]): Promise<void>;
  listExpiredSubmissions(now: number): Promise<QueueItem[]>;
  listUnsettledSubmissions(sessionId: string): Promise<QueueItem[]>;
  getQueueItem(sessionId: string, itemId: string): Promise<QueueItem | null>;
  /** Stamp abortRequestedAt on unsettled submissions in scope. First write wins; NOT terminal. */
  requestAbort(sessionId: string, threadId?: string): Promise<void>;
  /** Fenced two-phase settlement for claimed turns: running|blocked→terminalizing, recording the outcome. */
  reserveSettlement(
    sessionId: string,
    threadId: string,
    itemId: string,
    outcome: SubmissionOutcome,
    fence: WriteFence,
  ): Promise<void>;
  /** terminalizing→settled. Idempotent (re-running after settled is a no-op). Fenced. */
  finalizeSettlement(
    sessionId: string,
    threadId: string,
    itemId: string,
    fence: WriteFence,
  ): Promise<void>;
  /**
   * CAS settle for never-claimed items (decision 2): succeeds only when
   * status is 'collecting' or 'queued'. Used for superseded/merged/
   * aborted-while-queued outcomes. mergedIntoItemId is stamped when
   * outcome is 'merged'.
   */
  settleUnclaimed(
    sessionId: string,
    threadId: string,
    itemId: string,
    outcome: SubmissionOutcome,
    opts?: { mergedIntoItemId?: string },
  ): Promise<boolean>;
  /** Fenced: running↔blocked_on_decision_gate transitions for the claimed turn. */
  setSubmissionBlocked(
    sessionId: string,
    threadId: string,
    itemId: string,
    blocked: boolean,
    fence: WriteFence,
  ): Promise<void>;

  getSession(id: string): Promise<SessionData | null>;
  listSessions(userId: string, opts?: ListOpts): Promise<SessionData[]>;
  getThread(sessionId: string, threadId: string): Promise<ThreadData | null>;
  listThreads(sessionId: string): Promise<ThreadData[]>;
  getEntries(
    sessionId: string,
    threadId: string,
    opts?: MessageQuery,
  ): Promise<SessionEntry[]>;
  listDecisionGates(sessionId: string, threadId?: string): Promise<DecisionGate[]>;
  getDecisionGate(sessionId: string, gateId: string): Promise<DecisionGate | null>;
  /** Latest gate (any status) for a (queueItemId, resumeKey) pair, or null. */
  getLatestGateForResume(
    sessionId: string,
    threadId: string,
    queueItemId: string,
    resumeKey: string,
  ): Promise<DecisionGate | null>;
  getSuspendedTurn(sessionId: string, threadId: string): Promise<SuspendedTurnState | null>;
  deleteSession(id: string): Promise<void>;
}

// ── Engine API ─────────────────────────────────────────────────────

export interface RoleSpec {
  name: string;
  description?: string;
  model?: string;
  content: string;
  source?: "session" | "thread" | "prompt" | "plugin" | "sandbox";
}

export interface SkillSource {
  name: string;
  description?: string;
  content: string;
  argsSchema?: TSchema;
  source?: "plugin" | "sandbox" | "repo" | "user";
}

export interface SkillInvokeOptions {
  args?: Record<string, unknown>;
  model?: string;
  author?: PromptAuthor;
  channel?: ChannelTarget;
  resultSchema?: TSchema;
}

export interface CreateSessionOptions {
  id?: string;
  userId: string;
  orgId: string;
  workspace: string;
  purpose?: SessionPurpose;
  parentSessionId?: string;
  parentThreadId?: string;
  sandbox: Sandbox | SandboxCreateOpts;
  tools?: ToolDef[];
  roles?: RoleSpec[];
  skills?: SkillSource[];
  model: Model<any>;
  modelFailover?: Model<any>[];
  queueMode?: QueueMode;
  /** Collect-mode buffering window in ms (default 5000). */
  collectWindowMs?: number;
  systemPrompt?: string;
  /** Compaction tuning. See CompactionConfig defaults. */
  compaction?: CompactionConfig;
  metadata?: Record<string, unknown>;
}

export interface CompactionConfig {
  /** Master switch. Default: true. */
  enabled?: boolean;
  /** Subtract from contextWindow when computing usable space. Default: min(20_000, model.maxOutputTokens). */
  reserveTokens?: number;
  /** Last N turns are never compacted. Default: 2. */
  tailTurns?: number;
  /** Floor for tail token budget. Default: 2_000. */
  minPreserveRecentTokens?: number;
  /** Ceiling for tail token budget. Default: 8_000. */
  maxPreserveRecentTokens?: number;
  /** Recent tool-output bytes never pruned. Default: 40_000 (estimated tokens). */
  pruneProtectTokens?: number;
  /** Pruning only commits if it'd save at least this many tokens. Default: 20_000. */
  pruneMinimumTokens?: number;
  /** Tool outputs longer than this get truncated when fed to the summarizer. Default: 2_000 chars. */
  toolOutputMaxChars?: number;
  /** Optional separate model for the summarization call. Default: session model. */
  summarizerModel?: Model<any>;
  /** Tool names whose outputs are exempt from pruning. Merged with ToolDef.protectedFromPruning. Defaults: ['skill', 'thread_read']. */
  protectedTools?: string[];
  /**
   * After a proactive compaction, inject a synthetic user message
   * ("Continue if you have next steps...") so the agent resumes the task.
   * Tagged with metadata.compaction_continue so client UIs can hide it.
   * Default: true. Reactive (overflow) compactions never auto-continue —
   * they retry the original turn that triggered the overflow.
   */
  autoContinue?: boolean;
}

/**
 * Options accepted by Engine.restoreSession. The host re-supplies tools,
 * sandbox, model, etc. — the engine does not maintain a registry of session
 * creation options across restarts.
 */
export interface RestoreSessionOptions {
  sessionId: string;
  options: Omit<CreateSessionOptions, "id">;
}

export interface ProviderBundle {
  store: SessionStore;
  stream: EventStream;
  blobs?: BlobStore;
  credentials?: CredentialStore;
  sandboxProvider?: SandboxProvider;
}

export interface EngineOptions {
  providers: ProviderBundle;
  defaultUserId?: string;
  defaultOrgId?: string;
}
