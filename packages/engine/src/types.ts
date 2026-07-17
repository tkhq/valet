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
  /** Typed result validated against `AwaitResultOptions.resultSchema`; set only when `outcome` is 'completed' and extraction/validation succeeded. */
  output?: unknown;
  error?: string;
}

export interface AwaitResultOptions {
  timeoutMs?: number;
  /** When set and the submission's outcome is 'completed', extracts and validates JSON from the final assistant text into `SubmissionResult.output`. */
  resultSchema?: TSchema;
  signal?: AbortSignal;
}

// ── Prompts ────────────────────────────────────────────────────────

/**
 * A signal is an event the agent observes rather than a direct user→assistant
 * message: a Slack thread reply, a GitHub issue comment, a webhook, a timer,
 * or another session's settlement. External conversations are multi-party —
 * the agent participates as one member — so sender identity and event
 * metadata travel as flat string attributes, not as the message author.
 */
export interface SignalContent {
  kind: "signal";
  /** Namespaced event type, e.g. 'slack.message', 'github.issue_comment', 'child.settled'. */
  signalType: string;
  /** The event's text payload. Always a plain string; JSON-stringify structured payloads. */
  body: string;
  /** Flat, string-valued metadata: sender, external ids, timestamps, permalinks. */
  attributes?: Record<string, string>;
  /** XML envelope tag for model rendering. Must match /^[A-Za-z_][A-Za-z0-9_.-]*$/; defaults to 'signal'. */
  tagName?: string;
}

export type PromptContent =
  | string
  | {
      text?: string;
      attachments?: PromptAttachment[];
    }
  | SignalContent;

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
  /**
   * Set only by trusted host code (never by route handlers relaying raw
   * client input) when admitting a signal on behalf of another session —
   * child settlement, cross-orchestrator messaging, workflow dispatch. The
   * engine stamps the envelope with this identity, increments/enforces the
   * hop budget, and namespaces `dispatchId` by `sessionId` so senders can't
   * collide with or replay one another's ids. Only meaningful when `content`
   * is a `SignalContent`; `dispatchId` is required in that case.
   */
  internalSender?: { sessionId: string; owner: Principal; hopCount?: number };
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
  /**
   * Present when this user entry originated from a `SignalContent` prompt.
   * `content` holds the raw (unescaped) body; rendering into LLM context
   * wraps it in the XML envelope described here (see `renderSignalEnvelope`
   * in submission.ts). `senderSessionId`/`senderOwner`/`hopCount` are set
   * only for internally-stamped admissions (`PromptOptions.internalSender`).
   */
  signal?: {
    signalType: string;
    attributes?: Record<string, string>;
    tagName: string;
    senderSessionId?: string;
    senderOwner?: Principal;
    hopCount?: number;
  };
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
  /** Verbatim passthrough of `CreateSessionOptions.toolConfig` (Phase 4 decision 7). */
  config?: Record<string, unknown>;
  /**
   * Ownership principal of the session this tool call is running in
   * (`Session.owner`). Not part of the original ToolContext surface; added
   * for the `task` built-in (Phase 4 decision 10) so a `ChildSpawner` can be
   * called with the correct owner without threading it through toolConfig.
   */
  owner?: Principal;
  requestDecision: (gate: DecisionGateRequest) => Promise<DecisionResolution>;
  emitArtifact?: (artifact: ToolArtifact) => Promise<void>;
  suspendedDecision?: { gateId: string; ordinal: number; resolution?: DecisionResolution };
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

/**
 * Result of a job-mode exec kickoff (decision 9). `execId` identifies the
 * job for subsequent pollJob/cancelJob calls.
 */
export interface ExecJobHandle {
  execId: string;
}

/**
 * Incremental poll result for a job-mode exec (decision 9). `output` is the
 * slice of combined stdout+stderr since `offset` — callers accumulate by
 * re-polling with `nextOffset`. `status: "failed"` means job infrastructure
 * failure (e.g. lost the process); a non-zero exit code is a normal `"done"`.
 */
export interface JobPoll {
  status: "running" | "done" | "failed";
  exitCode?: number;
  output: string;
  nextOffset: number;
}

export interface GatewayEndpoint {
  host: string;
  port: number;
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
  /** Job-mode exec (decision 9). Optional — providers that support long-running,
   * detached commands implement all three of execJob/pollJob/cancelJob. */
  execJob?(command: string, opts?: ExecOpts): Promise<ExecJobHandle>;
  pollJob?(execId: string, offset: number): Promise<JobPoll>;
  cancelJob?(execId: string): Promise<void>;
  /**
   * The in-sandbox auth gateway's reachable endpoint, or null when this
   * sandbox has no gateway (headless profile / providers without interactive
   * services). Absent method === always null — existing paths unchanged.
   */
  gatewayEndpoint?(): Promise<GatewayEndpoint | null>;
}

export interface SandboxCreateOpts {
  image?: string;
  workspace?: string;
  env?: Record<string, string>;
  timeout?: number;
  resources?: { cpu?: number; memory?: string };
  metadata?: Record<string, unknown>;
  /** Interactive-service profile. Default "headless" (agent-only). "full"
   * additionally runs ttyd + code-server + the auth gateway. */
  profile?: "headless" | "full";
}

/**
 * Static description of what a sandbox backend can do (decision 1). Used by
 * the attachment/policy layer to decide on cold-start hints, snapshot
 * strategy, etc. — not a runtime probe, a fixed per-backend constant.
 */
export interface SandboxCapabilities {
  snapshot: "memory" | "filesystem" | "none";
  persistentWorkspace: boolean;
  tunnels: boolean;
  warmPool: boolean;
  /**
   * Whether the backend can scale an idle sandbox to zero and later wake it
   * with its workspace intact (hibernation). When true, the provider MUST
   * implement `suspend`/`resume` and the attachment layer's `suspended` state
   * becomes reachable. When false (docker/local/virtual today), `suspend`/
   * `resume` are absent and `SandboxAttachment.suspend()` is a refused no-op.
   */
  hibernation: boolean;
  /**
   * Whether the backend can boot a sandbox from an arbitrary, caller-supplied
   * OCI image ref (`SandboxCreateOpts.image`). True for docker/kubernetes,
   * where `image` selects the container image; false for local/virtual, which
   * run against the host process/an in-memory fake and ignore `image`
   * entirely. The prebuild-resolution layer consults this before pointing a
   * session at a prebuilt image: a `customImage: false` provider always boots
   * the stock runtime regardless of any matching prebuild.
   */
  customImage: boolean;
  coldStartEstimateMs?: number;
}

export interface SandboxStatus {
  id: string;
  state: "provisioning" | "ready" | "idle" | "snapshotting" | "released" | "error";
  startedAt?: number;
  error?: string;
}

export interface SandboxProvider {
  readonly backend: string;
  capabilities(): SandboxCapabilities;
  create(opts: SandboxCreateOpts): Promise<Sandbox>;
  restore(id: string): Promise<Sandbox>;
  destroy(id: string): Promise<void>;
  status(id: string): Promise<SandboxStatus>;
  /**
   * Optional non-terminal teardown seam for `SandboxAttachment.reportFailure`'s
   * degradation/re-provision path (spec `docs/specs/2026-07-15-kubernetes-deployment-design.md`
   * decision 5). When implemented, `reportFailure` prefers `release` over
   * `destroy` for the old sandbox before re-`create`ing — for providers whose
   * `destroy` cascades to persistent storage (e.g. sandbox-kubernetes's CR
   * deletion, which cascade-deletes the workspace PVC), `release` can leave
   * the backing resource standing so the subsequent `create` (upsert-shaped)
   * re-adopts it and the workspace survives. Providers that don't implement
   * it (docker/local/virtual) keep their exact current behavior — `reportFailure`
   * falls back to `destroy`.
   */
  release?(id: string): Promise<void>;
  /**
   * Optional hibernation seam (paired with `SandboxCapabilities.hibernation`).
   * `suspend` scales the sandbox to zero while retaining its workspace; `resume`
   * wakes it under the same id. When both are implemented (and capability true),
   * `SandboxAttachment.suspend()` drives them and the `suspended` attachment
   * state becomes reachable. Absent === capability off — existing paths
   * unchanged, and `SandboxAttachment.suspend()` refuses with an explicit error.
   */
  suspend?(id: string): Promise<void>;
  resume?(id: string): Promise<void>;
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
    }
  | {
      /**
       * Sandbox attachment lifecycle signal (spec §Sandbox Attachment,
       * decision 8). Session-scoped, no threadId. Emitted on provisioning,
       * ready, error, and released transitions with a deterministic
       * `sandbox:{epoch}:{state}` eventKey — idempotent under re-provision
       * loops.
       */
      type: "sandbox_status";
      sandboxId?: string;
      state: "provisioning" | "ready" | "idle" | "snapshotting" | "suspended" | "released" | "error";
      epoch: number;
      estimateMs?: number;
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
   *
   * CHANGED (decision 12): optional `fence`. When provided, the
   * implementation MUST verify `fence.attemptId` is the queue item's current
   * attempt and reject with `StaleAttemptError` otherwise — closing the
   * zombie double-emit gap for live-execution events from a superseded
   * attempt. Fence-less appends (the default) are unaffected and always
   * accepted by fence logic (implementations that haven't wired a fence
   * check MUST also accept fenced appends — validation requires wiring).
   */
  append(event: BusEvent, eventKey: string, fence?: WriteFence): Promise<{ offset: string }>;
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
   *
   * opts.maxPending, when set, enforces the per-thread pending cap INSIDE
   * this call's own transaction: the store counts the thread's unsettled,
   * non-superseded items (idempotent replays excluded — they're resolved
   * before the count) and throws PendingCapError when that count is already
   * >= maxPending. Doing the check and the insert in one transaction is what
   * closes the TOCTOU window a separate pre-check would leave open under
   * concurrent admissions.
   */
  admitSubmission(
    sessionId: string,
    threadId: string,
    item: QueueItem,
    opts?: { steer?: boolean; maxPending?: number },
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
  /** Session ids that currently have at least one non-settled queue item. Used by eager boot restore. */
  listSessionIdsWithUnsettledSubmissions(): Promise<string[]>;
  /** Settled queue items whose updatedAt is strictly before `cutoff`. Used by the event-retention prune. */
  listSettledSubmissionsBefore(sessionId: string, cutoff: number): Promise<QueueItem[]>;
  getQueueItem(sessionId: string, itemId: string): Promise<QueueItem | null>;
  /**
   * Max last-touched timestamp across the session's queue items, or null when
   * the session has no items. Reads the `updatedAt` column: it is stamped on
   * every queue-item mutation (admission, claim, lease renewal, settlement), so
   * it is the honest "when did anything last happen in this session" signal.
   * `createdAt` would only reflect admission, and there is no dedicated
   * settled-at column, so `updatedAt` is the correct choice. Used by the
   * hibernation idle-sweep to decide when a session's sandbox may be suspended.
   */
  latestActivityAt(sessionId: string): Promise<number | null>;
  /**
   * All unsettled submissions across sessions (operator surface). Unlike
   * `QueueItem` elsewhere (always accessed via an already-known sessionId),
   * these carry `sessionId` explicitly since callers have no other way to
   * tell which session each cross-session result belongs to.
   */
  listAllUnsettledSubmissions(): Promise<(QueueItem & { sessionId: string })[]>;
  /**
   * Operator escape hatch: CAS any non-settled status → settled with the given
   * outcome; deletes attempt markers. Throws ConflictError if already settled,
   * NotFoundError if the item doesn't exist.
   */
  forceSettle(
    sessionId: string,
    itemId: string,
    outcome: "failed" | "aborted",
    error?: string,
  ): Promise<QueueItem>;
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

/**
 * A model spec resolved by a host `resolveModel` seam: the live pi-ai model to
 * run the turn on, plus an optional per-turn API key. `apiKey` undefined means
 * "no host key — use pi-ai's env-var fallback". Produced by the host, consumed
 * by the engine at turn start and by `Session.setModel`/`Thread.setModel`.
 */
export interface ResolvedModel {
  model: Model<any>;
  apiKey?: string;
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
  /**
   * Optional host-provided model resolver. Absent === the engine's current
   * internal resolution (`resolveModelId`): every existing path is unchanged
   * and the pi-agent-core Agent is constructed WITHOUT `getApiKey`, so pi-ai's
   * env-var fallback stamps `StreamOptions.apiKey`. When present:
   *  - `Session.setModel` / `Thread.setModel` validate ids through it (a `null`
   *    return throws the same "unknown model id" surface as today);
   *  - at each turn start the effective model spec (thread override → session
   *    default) is resolved through it and the returned `{ model, apiKey }` is
   *    held for that turn only — never cached across turns, so a rotated key
   *    takes effect on the next turn;
   *  - the Agent's `getApiKey` returns that per-turn key so pi-agent-core
   *    stamps `StreamOptions.apiKey` (an `undefined` key preserves env fallback).
   */
  resolveModel?: (spec: string) => Promise<ResolvedModel | null>;
  /**
   * Optional host-provided post-provision prep hook. Absent === no prep —
   * existing paths unchanged (the provision path executes exactly today's
   * statements). When present, it runs once per (sandbox, epoch) after a
   * freshly cold-booted sandbox reports ready and BEFORE any `ensureReady`
   * waiter is resolved: the host receives the live `Sandbox` handle plus the
   * attachment epoch and may do first-boot setup (e.g. clone a repo into the
   * workspace). No waiter ever observes an unprepped sandbox. A rejection is
   * terminal for that provision — waiters reject with
   * `sandbox preparation failed: {message}`, the attachment lands in `error`,
   * and the next `ensureReady` re-provisions and re-runs prep. Only the cold
   * `doProvision` path runs prep; a hibernation wake (`doResume`, same epoch)
   * does not.
   */
  prepareSandbox?: (sandbox: Sandbox, epoch: number) => Promise<void>;
  /**
   * Optional host-provided credential resolver. Absent === raw store read —
   * existing paths unchanged (the session-scoped `CredentialProvider`
   * `Session.credentialProvider()` returns reads `providers.credentials`
   * directly, byte-identical to before). When present it REPLACES that read:
   * `Session.credentialProvider()` calls it with `(owner, service)` and uses
   * its return value directly — a `null` return yields `null` with NO store
   * fallback. The host implementation is the single decision point (e.g. the
   * api resolves `github` through the token service and delegates every other
   * service to the raw store itself), so the engine never re-reads the store
   * behind a resolver it was given.
   */
  credentialResolver?: (owner: CredentialOwner, service: string) => Promise<StoredCredential | null>;
  queueMode?: QueueMode;
  /** Collect-mode buffering window in ms (default 5000). */
  collectWindowMs?: number;
  systemPrompt?: string;
  /** Compaction tuning. See CompactionConfig defaults. */
  compaction?: CompactionConfig;
  /**
   * Max time (ms) a tool op will wait for the sandbox attachment to become
   * ready before failing with WorkspaceProvisioningError. Default: 60_000
   * (SANDBOX_READY_TIMEOUT_MS, defined in sandbox/policy.ts).
   */
  sandboxReadyTimeoutMs?: number;
  metadata?: Record<string, unknown>;
  /** Max stamped hopCount an internally-admitted signal may carry. Default SIGNAL_HOP_BUDGET (3). */
  signalHopBudget?: number;
  /** Max unsettled, non-superseded submissions a single thread may hold. Default MAX_PENDING_PER_THREAD (20). */
  maxPendingPerThread?: number;
  /**
   * Ordered fragments assembled into the agent's system prompt once at
   * construction (Phase 4 decision 6): `base systemPrompt + "\n\n" +
   * fragments sorted by (order ?? 100, name)`. Landed BEFORE per-turn role
   * overlays and the cold-sandbox hint — final composition is
   * base → systemContext → role overlay → cold hint. This is a deliberate
   * deviation from the portable-runtime spec's "after role overlays"
   * ordering; do not "fix" it back.
   */
  systemContext?: Array<{ name: string; content: string; order?: number }>;
  /**
   * Host-supplied, session-scoped config surfaced verbatim as
   * `ToolContext.config` inside every tool execution (Phase 4 decision 7).
   * Opaque to the engine — e.g. an internal API base URL / token for
   * app-level tools like `mem_*`.
   */
  toolConfig?: Record<string, unknown>;
  /**
   * Who this session belongs to. Defaults to `{ type: 'user', id: userId }`
   * (today's behavior) when omitted (Phase 4 decision 8). Persisted via
   * `Session.toData().owner`; a restored session preserves its persisted
   * owner even if the host's restore-time options omit it.
   */
  owner?: Principal;
  /**
   * Hooks run in order after a successful compaction (summary entry
   * persisted), each individually try/caught — a throwing hook is logged
   * and never blocks compaction or later hooks (Phase 4 decision 9).
   */
  compactionHooks?: CompactionHook[];
  /**
   * Whether `Thread.runTurn` fire-and-forgets `session.attachment.warm()` at
   * the start of every claimed turn (spec decision 5's default warm-on-claim
   * behavior). Default: true. Set to false for sessions that must stay
   * sandbox-less until a turn actually touches the filesystem/shell — e.g.
   * API-shaped orchestrator sessions (see docs/specs/2026-07-11-orchestrator-engine-design.md,
   * "Sandbox-less by default"). The lazy `PolicySandbox` attachment still
   * provisions on first sandbox-touching tool op regardless of this flag;
   * this only controls the proactive warm kick and its cold-start system
   * prompt hint.
   */
  warmSandboxOnClaim?: boolean;
}

/**
 * Fires after `Thread.compactThread` persists a compaction summary.
 * `mode` mirrors the modes `compactThread` itself accepts: the engine's
 * two automatic triggers (`proactive`, `reactive`) plus `manual`, for a
 * host- or tool-initiated compaction pass outside the normal turn loop.
 */
export type CompactionHook = (args: {
  sessionId: string;
  threadId: string;
  mode: "proactive" | "reactive" | "manual";
  summary: string;
}) => Promise<void>;

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

// ── Child spawning (`task` built-in, Phase 4 decision 10) ──────────

/** Request payload for the `task` built-in tool. `repo` interpretation is host policy. */
export interface SpawnChildRequest {
  prompt: string;
  title?: string;
  repo?: string;
  branch?: string;
  model?: string;
}

export interface SpawnChildResult {
  childSessionId: string;
  queueItemId: string;
}

/**
 * Host-injected child-session factory, surfaced to the `task` tool via
 * `toolConfig.childSpawner`. Its absence is the engine's depth limit: child
 * sessions get no spawner in their own toolConfig, so `task` calls inside a
 * child session fall through to `[task_unavailable]`.
 */
export type ChildSpawner = (
  req: SpawnChildRequest,
  ctx: { parentSessionId: string; parentThreadId: string; actorUserId: string; owner: Principal },
) => Promise<SpawnChildResult>;

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
