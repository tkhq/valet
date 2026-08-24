import type { TSchema, Static } from "typebox";
import type { Model } from "@mariozechner/pi-ai";
// Type-only import — erased at runtime, so the plugin-catalog ↔ types cycle
// exists only for the type checker (both directions are `import type`).
import type { ApprovalMode } from "./plugin-catalog.js";

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

/**
 * What code the session's sandbox workspace actually booted with (engine
 * traces spec, change 2). Captured by the HOST — the engine never derives it
 * by sniffing the sandbox — and persisted verbatim on the session row.
 * Sessions without one (pre-migration, or non-git workspaces) are not
 * eval-replayable; absent means absent.
 */
export interface SessionStartRef {
  /** Canonical clone URL, without secrets (e.g. `https://github.com/tkhq/valet.git`). */
  repoUrl: string;
  /** Branch as fetched (e.g. `dev-v2`), or `undefined` for detached-HEAD boots. */
  branch?: string;
  /** Full 40-char SHA. Never a short hash — replay must be unambiguous. */
  commitSha: string;
  /** Best-effort capture wall clock. Convenience only; the row's `created_at` is the source of truth. */
  capturedAt: number;
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
   * Start-ref for the sandbox workspace, captured after the specProvider's
   * prep steps complete. Absent for sessions that predate this field or ran
   * without a git-backed workspace.
   */
  startRef?: SessionStartRef;
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

/**
 * Settle-time patch capture record (engine traces spec, change 3). Written
 * to the queue item by `finalizeSettlement` and mirrored on the
 * `submission_settled` event; both point at the same BlobStore key
 * (`patches/{sessionId}/{queueItemId}.diff`). Best-effort — capture failure
 * never fails the settle.
 */
export interface SettlePatchRef {
  status: "captured" | "skipped" | "failed";
  /** Human-readable, only when status != 'captured'. */
  reason?: string;
  /** `patches/{sessionId}/{queueItemId}.diff` when captured. */
  blobKey?: string;
  /** Stored bytes (post-truncation if truncated). */
  bytes?: number;
  truncated?: boolean;
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
  /**
   * DURABLE credential-release budget: counted keyless release cycles
   * (bounded by the engine's MAX_CREDENTIAL_ATTEMPTS). Written by
   * `releaseSubmission` when the caller passes counters; survives restart so
   * a keyless session in a crash-loop still fails boundedly instead of
   * cycling queued→running→queued forever. Absent ≡ 0.
   */
  credentialAttempts?: number;
  /**
   * Time (ms) of the last COUNTED credential-release cycle — releases within
   * the backoff window of it coalesce into the same cycle (no increment).
   */
  lastCredentialReleaseAt?: number;
  timeoutAt: number; // default createdAt + 3_600_000
  abortRequestedAt?: number;
  ownerId?: string;
  leaseExpiresAt?: number;
  /** Settle-time patch capture record; written at settlement. Absent on
   * unsettled items and on items settled before patch capture shipped. */
  settlePatch?: SettlePatchRef;
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
  /**
   * Target thread id. When set, the prompt (or command result) goes to this
   * thread instead of the session default. Throws if no thread has this id.
   */
  threadId?: string;
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
  /** Set when the submission was handled as a command and no prompt was queued. */
  command?: { name: string; source: import("./commands/types.js").CommandSource };
  /** Set when an unknown /word passed through as prompt text; closest registered name. */
  nearMiss?: string;
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

/** Per-turn token usage (engine traces spec, change 1). Shape mirrors the
 * pi-ai `Usage` counters; `total` falls back to the four-way sum when the
 * provider's `totalTokens` is 0/absent. */
export interface MessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** Per-turn USD cost from pi-ai's pricing registry. Present only when the
 * model is priced — never zero-filled: a missing field reads "unpriced",
 * never "$0". */
export interface MessageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

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
  /** Present only on the turn's final assistant entry when the model reported usage. */
  usage?: MessageUsage;
  /** Present only when the model is in pi-ai's pricing registry; unpriced turns omit. */
  cost?: MessageCost;
  /**
   * Image attachments on a user message. Only present on user entries with
   * attached images; never on assistant, tool, or system entries.
   */
  attachments?: Array<{ type: "image"; url?: string; data?: Uint8Array; mimeType: string; name?: string }>;
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

export interface CommandResultEntry extends BaseEntry {
  type: "command_result";
  command: string; // as typed, with leading slash
  source: import("./commands/types.js").CommandSource;
  ok: boolean;
  output: string; // markdown
}

export type SessionEntry =
  | MessageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | DecisionGateEntry
  | CommandResultEntry;

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
  /**
   * Optional host policy resolver consulted by `call_tool` before invoking a
   * plugin action. Absent === the engine's built-in riskLevel→approvalMode
   * fallback (`approvalModeFor`), byte-identical to pre-policy behavior.
   * Threaded from `CreateSessionOptions.policyResolver` via `buildToolContext`.
   */
  policyResolver?: PolicyResolver;
  /**
   * The queue item (turn) this tool call runs under. On a restart replay the
   * engine reconstructs the running item with the ORIGINAL queueItemId (see
   * `SuspendedTurnState.queueItemId`), so the value is stable across replay.
   * Consumed by `call_tool`'s policy audit (`PolicyInvocationRecord.queueItemId`).
   */
  queueItemId?: string;
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
  /**
   * The resolved gate's ordinal (see `DecisionGate.ordinal`), stamped on by
   * `Thread.requestDecision` — both on the live-registration path (from the
   * gate it just opened/joined) and the restart-replay short-circuit path
   * (from the persisted gate entry) — before the resolution is handed back
   * to the calling tool. Callers (e.g. `call_tool`'s policy audit) use this
   * to distinguish a replayed resolution from a fresh one for the same
   * resumeKey: a true restart replay carries the SAME ordinal as the
   * original decision, while a new legitimate call for identical args mints
   * a new (incremented) ordinal. Absent only for resolutions constructed
   * outside the engine's gate machinery (e.g. hand-built in tests).
   */
  gateOrdinal?: number;
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

// ── Policy resolution (org policy engine seam) ─────────────────────

/**
 * Input handed to a host `PolicyResolver` when `call_tool` is about to
 * invoke a plugin action. `appliesIn` is `"session"` from the interactive
 * `call_tool` path; a future workflow-mode invoker (T3) passes `"workflow"`.
 */
export interface PolicyResolveInput {
  service: string;
  actionId: string;
  riskLevel: RiskLevel;
  params: Record<string, unknown> | undefined;
  userId?: string;
  orgId?: string;
  sessionId: string;
  threadId: string;
  appliesIn: "session" | "workflow";
}

/**
 * Which precedence rung produced a `PolicyDecision`. Tightened from a bare
 * `string` to this literal union (action-policies plan, T3 review carry-
 * forward) so the host resolver + audit sink share one closed vocabulary:
 * `resolver_error` is the synthetic fail-closed source the engine stamps when
 * a host `resolve()` throws (see `call_tool`); every other member is produced
 * by the host's pure precedence core (`policies/resolution.ts`). This is a
 * type-narrowing only — the runtime string values are unchanged.
 */
export type PolicyProvenanceSource =
  | "org_policy"
  | "runtime_grant"
  | "override"
  | "plugin_default"
  | "risk_default"
  | "resolver_error";

/**
 * The host's decision for one action invocation. `mode` drives `call_tool`:
 * `allow` → straight through; `require_approval` → open an approval gate;
 * `deny` → refuse. `provenance` is opaque to the engine and rides into the
 * gate `context` and every audit record so the host can explain the call.
 */
export interface PolicyDecision {
  mode: ApprovalMode;
  provenance: {
    baseMode: ApprovalMode;
    matchedPolicyId?: string;
    matchedGrantId?: string;
    matchedOverrideId?: string;
    source: PolicyProvenanceSource;
  };
  /**
   * Extra gate actions the host wants offered on a require_approval gate.
   * Actions flagged `approves: true` are treated as approval by `call_tool`
   * AFTER `onResolution` runs. The engine strips the `approves` flag to plain
   * `DecisionAction`s before opening the gate.
   */
  extraGateActions?: (DecisionAction & { approves: boolean })[];
}

/**
 * Audit record emitted (fire-and-forget) by `call_tool` for every
 * plugin-action invocation attempt made through a host `PolicyResolver`.
 * `status` is the terminal disposition of the attempt:
 *  - `denied`    — resolver returned `deny`; the action never ran.
 *  - `rejected`  — a require_approval gate was not approved (human deny or an
 *                  `onResolution` throw); the action never ran.
 *  - `completed` — `action.execute` returned (success or handled failure).
 *  - `error`     — `action.execute` threw, or validated params were rejected.
 * `allowed` / `approved` are reserved for non-executing callers (workflow
 * mode / T3); `call_tool` collapses those into `completed`/`error` and relies
 * on `resolvedMode` + `provenance` to show whether the call was allowed
 * outright or approved through a gate. `durationMs` is set for executed paths.
 */
export interface PolicyInvocationRecord {
  service: string;
  actionId: string;
  toolId: string;
  riskLevel: RiskLevel;
  sessionId: string;
  threadId: string;
  userId?: string;
  orgId?: string;
  appliesIn: "session" | "workflow";
  summary?: string;
  status: "pending" | "allowed" | "denied" | "approved" | "rejected" | "error" | "completed";
  resolvedMode: ApprovalMode;
  provenance: PolicyDecision["provenance"];
  durationMs?: number;
  error?: string;
  /**
   * The deterministic resumeKey `call_tool` derives for this invocation
   * (`${tool_id}:${stableJson(params)}`) — same value passed as
   * `DecisionGateRequest.resumeKey` when a gate opens. Always present, even
   * for `allow`/`deny` dispositions that never open a gate, so an audit sink
   * can correlate every record for a given (tool, args) pair.
   */
  resumeKey: string;
  /**
   * The resolved decision gate's ordinal (`DecisionResolution.gateOrdinal`),
   * present only when a gate was actually opened for this invocation
   * (`require_approval`, both `rejected` and post-approval outcomes). A host
   * audit sink can use (resumeKey, gateOrdinal) as the true dedup key: a
   * restart-replay double-fire reuses the SAME gateOrdinal as the original
   * record, while a second legitimate identical call mints a new one.
   */
  gateOrdinal?: number;
  /**
   * The queue item (turn) this invocation ran under. `gateOrdinal` is scoped
   * to `(queueItemId, resumeKey)` and resets per turn, so an audit sink MUST
   * include `queueItemId` in any dedup key built from `(resumeKey,
   * gateOrdinal)` — without it, two different turns gating on the identical
   * (tool, args) pair collide. A restart replay reuses the ORIGINAL turn's
   * queueItemId (the suspended-turn state mirrors it), so replay dedup still
   * holds. Absent only when a host builds a ToolContext outside the engine's
   * thread machinery (e.g. hand-assembled in tests).
   */
  queueItemId?: string;
  /**
   * The invocation's params and the executed action's result, verbatim.
   * Populated so an audit sink can persist them (size-capping is the sink's
   * job — the engine does not truncate). `result` is present only for
   * `completed` dispositions.
   */
  params?: Record<string, unknown>;
  result?: unknown;
}

/**
 * Optional host-provided policy port. Absent === the engine's built-in
 * riskLevel→approvalMode fallback (`approvalModeFor`), byte-identical to
 * pre-policy behavior. Present === `call_tool` consults it per invocation.
 */
export interface PolicyResolver {
  resolve(input: PolicyResolveInput): Promise<PolicyDecision>;
  /**
   * Host side effects on gate resolution (grant/policy writes). Awaited by
   * `call_tool` BEFORE it interprets the resolution; a throw fails the
   * approval closed (the resolution is treated as not-approved). Best-effort
   * otherwise.
   */
  onResolution?(
    input: PolicyResolveInput,
    decision: PolicyDecision,
    resolution: DecisionResolution,
  ): Promise<void>;
  /**
   * Audit sink for every invocation attempt. Fire-and-forget — `call_tool`
   * never awaits it and swallows rejections, so it must never be relied on to
   * gate execution.
   */
  onInvocation?(record: PolicyInvocationRecord): Promise<void>;
}

// ── Sandbox ────────────────────────────────────────────────────────

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  stdin?: string;
  maxOutputBytes?: number;
  /**
   * Run this exec with the sandbox's full (root) privileges. Default false:
   * in a docker-enabled sandbox (SandboxCreateOpts.docker) providers run
   * non-privileged execs as the dedicated workload user (`dockerd`) so
   * files the workload creates are mapped inside the rootless docker
   * daemon's user namespace. In sandboxes without docker, this flag has no
   * effect — every exec keeps the container's default user.
   */
  privileged?: boolean;
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
  /** True when the job's capped output buffer (maxOutputBytes) dropped
   * bytes. Optional: a provider that cannot detect the drop omits it. */
  truncated?: boolean;
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
  /**
   * The owning session's id. `Engine.materializeSandbox` stamps this on
   * every attachment-built sandbox, and its stamp always wins — a value a
   * host sets here is overwritten, so an opts object cloned from another
   * session can never mis-attribute ownership. Providers that implement
   * `list()` record it on the backing resource (sandbox-kubernetes: a CR
   * annotation) so a reconcile sweep can map a listed sandbox back to its
   * session.
   */
  sessionId?: string;
  /** Interactive-service profile. Default "headless" (agent-only). "full"
   * additionally runs ttyd + code-server + the auth gateway. */
  profile?: "headless" | "full";
  /**
   * Credential files to mount at /etc/valet/creds/ inside the sandbox.
   * Keys are file names. Values are file contents (plain strings — tokens,
   * keys, etc.). The provider writes the data into a Kubernetes Secret and
   * mounts it as a whole-directory volume. Updates propagate into running
   * sandboxes without restart or replacement — the kubelet refreshes the
   * mount automatically (see SandboxProvider.updateCreds).
   *
   * Absent: no creds volume is mounted.
   */
  credsFiles?: Record<string, string>;
  /**
   * Request a rootless docker daemon inside the sandbox. Providers that
   * support it (capabilities().dockerSupport) grant: seccomp/AppArmor/system
   * paths unconfined, CAP_SYS_ADMIN + CAP_NET_ADMIN, /dev/fuse + /dev/net/tun,
   * and VALET_SANDBOX_DOCKER=1 so the image start scripts launch
   * dockerd-rootless. Never privileged. See spec decision 2 in
   * docs/specs/2026-08-15-sandbox-docker-design.md. Providers without support
   * ignore the flag.
   */
  docker?: boolean;
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
   * Whether the sandbox's filesystem and global state are isolated from the
   * host process (container/VM backends: docker, kubernetes). When false or
   * absent (local/virtual and test fakes), `exec` reaches the HOST — prep
   * steps that mutate global state (`git config --global`, installing into
   * `/usr/local/bin`) must be skipped for sessions that don't strictly need
   * them. Optional so existing capability literals stay valid; absent means
   * NOT isolated.
   */
  isolated?: boolean;
  /**
   * Whether the backend honors SandboxCreateOpts.docker (rootless
   * docker-in-sandbox). Absent means not supported; the flag is ignored.
   */
  dockerSupport?: boolean;
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
  /**
   * Whether the provider supports live-mount credential files via
   * SandboxCreateOpts.credsFiles and SandboxProvider.updateCreds. When
   * true, the provider mounts /etc/valet/creds/ from a Kubernetes Secret
   * and updates propagate into running sandboxes without restart. When
   * false or absent, credsFiles is ignored.
   */
  credsMount?: boolean;
}

export interface SandboxStatus {
  id: string;
  /**
   * `released` is load-bearing for lifecycle sweeps: it means "the
   * backing resource does not exist" — the workflow reclaimer permanently
   * skips its destroy on it, and the stranded-idle sweep stamps rows
   * hibernated without a suspend. Providers MUST throw on transient
   * backend errors rather than report `released` (kubernetes does).
   * Caveat: sandbox-docker reports `released` for any id its in-process
   * map has forgotten (every sandbox after an api restart, even with the
   * container still running) — today only capability gates
   * (`deriveId`/`hibernation`, both absent on docker) keep the sweeps off
   * that path; fix the map-miss conflation before pointing a
   * released-trusting consumer at docker.
   */
  state: "provisioning" | "ready" | "idle" | "snapshotting" | "released" | "error";
  startedAt?: number;
  error?: string;
}

/** One provider-side sandbox, as reported by `SandboxProvider.list` — the
 * reconcile sweep's raw material. */
export interface SandboxListing {
  id: string;
  /** The owning session recorded at create time (`SandboxCreateOpts.sessionId`).
   * Null for sandboxes created before session stamping existed. */
  sessionId: string | null;
  /** Backend creation time (ms since epoch); null when the backend does not
   * report one. The reconcile sweep's over-age report skips sandboxes
   * without it. */
  createdAtMs: number | null;
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
   * Optional deterministic-id seam. Providers whose sandbox ids are a pure
   * function of the session key (sandbox-kubernetes: `sandboxCrName`)
   * implement this so reapers can recompute a destroy handle that was never
   * recorded. Providers with backend-assigned ids (modal/docker) must NOT
   * implement this.
   */
  deriveId?(sessionKey: string): string;
  /**
   * Optional enumeration seam for reconcile sweeps: every sandbox this
   * provider currently backs, with the owning session recorded at create
   * time. Providers whose sandboxes durably outlive the api process
   * (sandbox-kubernetes: the CR is the record) implement this so an
   * orphan/TTL sweep can find leaked sandboxes no DB row points at.
   * Providers whose handles are process-local (docker/local) omit it — a
   * sweep treats an absent `list` as "nothing to reconcile".
   */
  list?(): Promise<SandboxListing[]>;
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
  /**
   * Push updated credential files into a running sandbox. The provider
   * writes the new data to the backing store (e.g. a Kubernetes Secret)
   * and the sandbox's /etc/valet/creds/ mount reflects the change without
   * restart. Call order matters: call create() first, then updateCreds().
   * Absent on providers that do not support live credential mounts
   * (SandboxCapabilities.credsMount is false or absent).
   */
  updateCreds?(id: string, files: Record<string, string>): Promise<void>;
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
      /**
       * Live-only tool-call argument streaming (same ephemeral plane as
       * text_delta — never durable, never persisted). Emitted once when the
       * model opens a tool call (empty argsDelta) and once per raw args JSON
       * chunk. Consumers concatenate argsDelta per callId and parse the
       * accumulated string leniently; `tool_start` later carries the
       * complete args and self-heals any dropped delta.
       */
      type: "tool_call_update";
      threadId: string;
      callId: string;
      toolName: string;
      argsDelta: string;
    }
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
  | { type: "tool_start"; threadId: string; tool: string; callId?: string; args: Record<string, unknown> }
  | { type: "tool_end"; threadId: string; tool: string; callId?: string; result: string; isError: boolean }
  | {
      type: "turn_end";
      threadId: string;
      reason: "end_turn" | "error" | "abort";
      /**
       * Usage/cost enrichment (engine traces spec, change 1): written from the
       * SAME `lastAssistantUsage` snapshot as the entry's `usage`/`cost` so
       * event-bus consumers (telemetry projections) never need to read
       * `engine_entries`. Absent on non-assistant turn ends (aborted with no
       * assistant activity).
       */
      model?: string;
      usage?: MessageUsage;
      cost?: MessageCost;
      turnDurationMs?: number;
    }
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
      /**
       * A slash command ran and produced a transcript record (slash-commands
       * design). Session-scoped when the command is thread-agnostic; carries
       * the executing thread id otherwise. Emitted after the
       * `command_result` entry is persisted.
       */
      type: "command_result";
      threadId?: string;
      entry: CommandResultEntry;
    }
  | {
      type: "submission_settled";
      sessionId: string;
      threadId: string;
      queueItemId: string;
      outcome: SubmissionOutcome;
      /** Patch-capture linkage (engine traces spec, change 3): same record the
       * settle wrote to the queue item, so live consumers need no store read. */
      patch?: SettlePatchRef;
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
    }
  | {
      /**
       * Host extension event. The ENGINE NEVER emits this — it exists so a
       * host can push app-level, session-scoped events through the same
       * durable EventStream its WebSocket layer already subscribes to
       * (first consumer: Valet Design's `design.artifact.updated`). `name`
       * is namespaced by the host; `payload` is host-opaque JSON. The
       * engine treats the variant as pass-through data, same contract as
       * `toolConfig`.
       */
      type: "host_event";
      name: string;
      payload?: Record<string, unknown>;
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
  /**
   * terminalizing→settled. Idempotent (re-running after settled is a no-op).
   * Fenced. `patchRef`, when present, is written to the item's settle-patch
   * columns in the same transactional finalize (engine traces spec, change 3);
   * callers that pass nothing observe the prior behavior and leave any
   * existing record untouched.
   */
  finalizeSettlement(
    sessionId: string,
    threadId: string,
    itemId: string,
    fence: WriteFence,
    patchRef?: SettlePatchRef,
  ): Promise<void>;
  /**
   * CAS settle for never-claimed items (decision 2): succeeds only when
   * status is 'collecting' or 'queued'. Used for superseded/merged/
   * aborted-while-queued outcomes. mergedIntoItemId is stamped when
   * outcome is 'merged'. A matched CAS also stamps the settle-patch record
   * `skipped:no_work` (engine traces spec, change 3): a never-claimed item
   * definitionally ran no tools, so there is no diff to capture.
   */
  settleUnclaimed(
    sessionId: string,
    threadId: string,
    itemId: string,
    outcome: SubmissionOutcome,
    opts?: { mergedIntoItemId?: string },
  ): Promise<boolean>;
  /**
   * Fenced release of a claimed turn back to `queued` (attempt cleared, lease
   * dropped) without settling it — for a turn that could not run at all (e.g.
   * the host resolver yielded no usable model credentials). The submission stays
   * claimable and abortable. CAS-guarded on `status = 'running'` + the caller's
   * attempt id + `supersededByItemId` unset + `abortRequestedAt` unset: a
   * superseding attempt's later release is a no-op; a superseded item is
   * REFUSED (releasing it to `queued` would orphan it — superseded items are
   * skipped by the claim head and by unsettledHead, so nothing would ever
   * settle it); an abort-stamped item is REFUSED (it must settle `aborted`
   * under the current attempt, never flicker running→queued→aborted).
   * Returns whether the CAS matched (true = released + marker deleted;
   * false = full no-op, no state change, no markers touched).
   *
   * A matched CREDENTIAL release (payload present) DECREMENTS `attemptCount`
   * (floor 0) in the same atomic write: a keyless release cycle never
   * consumed run budget, so it can neither trip the stuck-head signal nor
   * exhaust the generic retry budget (`maxAttempts`) — those cycles are
   * separately bounded by the durable credential budget. A PLAIN release
   * (no payload — reconciliation's fresh re-run of a crashed pre-stream
   * attempt) keeps the claim's increment, so a deterministically
   * crash-looping item still exhausts `maxAttempts` instead of oscillating
   * net-zero forever. `replaceSubmissionAttempt` increments are unaffected.
   *
   * `credential`, when present, atomically persists the durable
   * credential-release budget (`credentialAttempts` +
   * `lastCredentialReleaseAt`) in the same CAS transaction — the engine
   * computes the counters and the store writes them only when the CAS
   * matches. Omitted (e.g. a reconciliation re-queue that is not a
   * credential cycle) the columns are left untouched.
   */
  releaseSubmission(
    sessionId: string,
    threadId: string,
    itemId: string,
    fence: WriteFence,
    credential?: { attempts: number; lastReleaseAt: number },
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

// ── Sandbox spec / prep steps ─────────────────────────────────────

/**
 * One idempotent workspace-preparation step. `id` names the step; `hash`
 * is a content fingerprint used by the diff/apply machinery in later tasks.
 * `critical` marks steps whose failure must fail the provision.
 *
 * `apply` receives the live {@link Sandbox} handle and runs the step.
 * Throwing rejects the provision with {@link SandboxPreparationError}.
 */
export interface PrepStep {
  id: string;
  hash: string;
  critical: boolean;
  apply(sandbox: Sandbox): Promise<void>;
}

/**
 * The full desired state for a session's sandbox: an optional OCI image ref
 * (wired in Task 5; ignored by the Task 3 attachment) and an ordered list of
 * {@link PrepStep}s to apply after provisioning.
 */
export interface DesiredSandboxSpec {
  /** Target OCI image ref. Ignored by the Task 3 attachment — Task 5 wires it. */
  image?: string;
  /** Stable content hash across all steps; used by the diff engine in Task 4+. */
  specHash: string;
  steps: PrepStep[];
}

/**
 * Host-provided factory that returns the desired sandbox spec for a session.
 * Called once per (sandbox, epoch) after a freshly-created sandbox reports
 * ready, before any {@link SandboxAttachment} waiter resolves.
 */
export type SpecProvider = () => Promise<DesiredSandboxSpec>;

// ── Engine API ─────────────────────────────────────────────────────

/**
 * Repository agent instructions read from the workspace — the AGENTS.md
 * format (https://agents.md/). Produced by a host
 * `repoInstructionsProvider`; injected into the system prompt as a per-turn
 * overlay. See docs/specs/2026-08-15-agents-md-instructions-design.md.
 */
export interface RepoInstructions {
  /**
   * Root AGENTS.md (or CLAUDE.md fallback) content of the primary repo
   * binding, already size-capped by the host. Empty string === no root file;
   * the fragment then carries only the nested-file list.
   */
  content: string;
  /**
   * Absolute in-sandbox paths of other AGENTS.md files (nested files and
   * secondary bindings' roots). Listed — not inlined — with the format's
   * closest-file-wins precedence instruction.
   */
  nestedPaths: string[];
}

export interface RoleSpec {
  name: string;
  description?: string;
  model?: string;
  content: string;
  source?: "session" | "thread" | "prompt" | "plugin" | "sandbox";
}

/**
 * One skill, in the Agent Skills format
 * (https://agentskills.io/specification). `name`, `description`, and the
 * markdown body come from a `SKILL.md`; `license`, `compatibility`,
 * `metadata`, and `allowedTools` are the spec's optional fields.
 *
 * `argsSchema` and the `{{placeholder}}` rendering it validates are a
 * Valet extension, NOT part of the spec. An imported skill will not use
 * them. See `docs/specs/2026-08-05-agent-skills-design.md`.
 */
export interface SkillSource {
  name: string;
  description?: string;
  content: string;
  argsSchema?: TSchema;
  source?: "plugin" | "sandbox" | "repo" | "user";
  /** Spec field. License name, or the name of a bundled license file. */
  license?: string;
  /** Spec field. Environment requirements, at most 500 characters. */
  compatibility?: string;
  /** Spec field. A map of text keys to text values, for properties the
   * spec itself does not define. */
  metadata?: Record<string, string>;
  /** Spec field `allowed-tools`, in camelCase: a space-separated list of
   * pre-approved tools. Experimental in the spec, and Valet does not act
   * on it yet. */
  allowedTools?: string;
  /** How a slash invocation expands. "context" (default): wrap in <skill>
   * tags, append args. "prompt": substitute $1/$@ into the body, send bare.
   * Prompt skills are never surfaced as capability documentation. */
  invocation?: "context" | "prompt";
  /** Autocomplete hint for the first argument, e.g. "<topic> [audience]". */
  argHint?: string;
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
 *
 * `model.id` is the provider-WIRE id — pi-ai sends it verbatim as the request
 * `model` parameter, so it must be exactly what the provider's API accepts
 * (e.g. `gpt-4.1`, `deepseek/deepseek-v4-pro`), never a Valet-namespaced
 * spec. `canonicalId` is the namespaced spec the engine persists and feeds
 * BACK to the resolver on later turns (`openai/gpt-4.1`,
 * `openrouter/deepseek/deepseek-v4-pro`); it defaults to `model.id` when
 * absent (bare Anthropic back-compat, where wire id and spec coincide).
 */
export interface ResolvedModel {
  model: Model<any>;
  apiKey?: string;
  canonicalId?: string;
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
  /**
   * The session default model's canonical (namespaced) spec — what
   * `SessionData.model` persists and what `resolveModel` re-receives on
   * later turns. Absent → `model.id` is used (correct whenever wire id and
   * spec coincide, i.e. bare Anthropic ids / internal resolution). Hosts
   * with a `resolveModel` seam SHOULD set this whenever the resolved
   * model's wire id differs from the spec (`openai/…`, `openrouter/…`,
   * custom `{rowId}/…`).
   */
  modelSpec?: string;
  /**
   * Start-ref for this session's workspace (engine traces spec, change 2).
   * Set by the host once the workspace state is known — either resolved
   * before `createSession` (out-of-band clone) or via `Session.setStartRef`
   * after the specProvider's steps complete (in-sandbox clone). Persisted verbatim
   * on the session row; treated as opaque by the engine. Absent === no
   * start-ref recorded (this session is not eval-replayable).
   */
  startRef?: SessionStartRef;
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
   *
   * Credential contract: the resolver throws `NoCredentialsError` when the
   * spec resolves to a REAL model but no API key is available anywhere (org
   * key absent AND env fallback absent). The engine detects this at turn
   * start, before any side-effecting work, and releases the claim back to
   * `queued` for a bounded number of attempts. `{ model, apiKey: undefined }`
   * remains legal and means "engine/pi-ai env fallback will work" — the
   * engine infers nothing from an undefined key.
   */
  resolveModel?: (spec: string) => Promise<ResolvedModel | null>;
  /**
   * Optional host-provided spec factory. Absent === no prep — existing paths
   * unchanged. When present, it is called once per (sandbox, epoch) after a
   * freshly cold-booted sandbox reports ready and BEFORE any `ensureReady`
   * waiter resolves. The engine calls `specProvider()`, then applies each
   * {@link PrepStep} in order. A step rejection is terminal for that provision
   * — waiters reject with `sandbox preparation failed: {message}`, the
   * attachment lands in `error`, and the next `ensureReady` re-provisions and
   * re-runs all steps. Only the cold `doProvision` path runs steps; a
   * hibernation wake (`doResume`, same epoch) does not.
   */
  specProvider?: SpecProvider;
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
  /**
   * Optional host-provided org-policy resolver. Absent === the engine's
   * built-in fallback: `call_tool` derives approval from each action's
   * riskLevel (`approvalModeFor`) exactly as before — no resolver machinery
   * runs, gate default actions are unchanged, and no audit records are
   * emitted. When present, `call_tool` consults it per invocation:
   *  - `resolve()` returns a `PolicyDecision` (`allow` → straight through,
   *    `require_approval` → open a gate, `deny` → refuse);
   *  - `onResolution?` runs on gate resolution before the outcome is
   *    interpreted (a throw fails the approval closed);
   *  - `onInvocation?` receives a fire-and-forget audit record per attempt.
   * A throwing `resolve()` fails closed to `require_approval` with provenance
   * source `resolver_error` (keeps a human in the loop rather than bricking on
   * a transient store error). Threaded onto `ToolContext.policyResolver`.
   */
  policyResolver?: PolicyResolver;
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
   * Minimum spacing (ms) between COUNTED credential-release cycles for a
   * keyless submission: releases landing inside the window still release but
   * do not advance the bounded credential-attempt budget (external kicks fire
   * on every submit/resume/abort; a burst must not burn the budget in
   * milliseconds). Default CREDENTIAL_RELEASE_BACKOFF_MS (4000, just under
   * the 5s sweep). Tests pass 0 to make every release cycle count.
   */
  credentialReleaseBackoffMs?: number;
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
  /**
   * Host capabilities for slash commands the engine cannot answer alone
   * (`/model`, `/sessions`). Absent === those built-ins return `ok: false`
   * with an explicit "not exposed" message, and the engine stays runnable in
   * bare tests.
   */
  commandContext?: import("./commands/types.js").CommandContext;
  /**
   * Host-injected workspace-skill source for slash commands. Absent === no
   * workspace skills. Read lazily and cached; the host calls
   * `Session.refreshCommandRegistry()` after workspace prep and on any event
   * that also refreshes skills.
   */
  workspaceSkillsProvider?: () => Promise<SkillSource[]>;
  /**
   * Host-injected re-reader for the session's skill set (plugin skills plus
   * the stored skills the owner can reach, merged by the host's shadow rule).
   * `Session.refreshCommandRegistry()` invokes it and replaces the session's
   * skill map with the result, so managed skills created or edited after the
   * session was built reach the slash-command registry and `skill`-tool
   * lookups of a long-lived (cached) session. Absent === the skill set stays
   * the construction-time `options.skills`, exactly as before.
   */
  skillsProvider?: () => Promise<SkillSource[]>;
  /**
   * Host-injected reader for the workspace's AGENTS.md instructions
   * (docs/specs/2026-08-15-agents-md-instructions-design.md). Absent === no
   * repo instructions — every existing path is unchanged. When present, the
   * engine loads it lazily at run start once the attachment is `ready`
   * (`Session.ensureRepoInstructions`) and the host re-invokes
   * `Session.refreshRepoInstructions()` on each `ready` transition. A `null`
   * return means the workspace carries no instructions.
   */
  repoInstructionsProvider?: () => Promise<RepoInstructions | null>;
  /**
   * When true, a skill named `review` also registers a bare `/review` command
   * in addition to the always-present `/skill:review`. Default false.
   */
  bareSkillNames?: boolean;
  /**
   * Action-backed plugin commands, registered under `${pluginName}:${def.name}`.
   * The host derives these from every loaded `ValetPlugin.commands`. Absent ===
   * no plugin commands. Paired with `pluginCatalog`: the registry entry resolves
   * the command, and `pluginCatalog` invokes its backing action.
   */
  pluginCommands?: Array<{
    pluginName: string;
    def: import("./commands/types.js").CommandDef;
  }>;
  /**
   * Plugin action catalog for the slash-command path — built by the host with
   * `buildPluginCatalog(actionPlugins)` from the SAME plugins that back the
   * LLM `call_tool` tool. A plugin command's `def.action` is invoked against
   * this catalog through the shared `invokeAction` core, so approval policy and
   * arg validation stay identical to the tool path. Absent === plugin commands
   * report that no catalog is available.
   */
  pluginCatalog?: import("./plugin-catalog.js").PluginCatalog;
  /**
   * Host approval hook for the slash-command path only. A plugin command whose
   * action needs approval (`require_approval`) calls this instead of the
   * turn-scoped decision gate — a command is not a claimed turn, so it cannot
   * suspend one. Return a resolution with `actionId: "approve"` to proceed,
   * `"pending"` when the decision is deferred, anything else to deny. Absent ===
   * approval-requiring plugin commands are denied.
   */
  commandRequestDecision?: (
    req: DecisionGateRequest,
  ) => Promise<DecisionResolution>;
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
  /** Interactive-service profile for the child's sandbox (default "headless"). */
  profile?: "headless" | "full";
  /** Request a rootless docker daemon inside the child's sandbox
   * (docker-in-sandbox, `SandboxCreateOpts.docker`). */
  docker?: boolean;
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
 * Reads the messages of a child session on behalf of its parent.
 *
 * A `child.settled` signal carries a bounded copy of the child's result, so
 * a parent that needs the whole thing has to come back for it. This is the
 * only way it can: `thread_read` reaches threads inside one session, and a
 * child is a separate session.
 *
 * Returns `null` when `childSessionId` is not a child of `parentSessionId`.
 * A caller cannot tell "not yours" from "does not exist", which keeps the
 * ids of other people's sessions unguessable.
 */
export type ChildReader = (
  req: { childSessionId: string; limit?: number },
  ctx: { parentSessionId: string },
) => Promise<SessionEntry[] | null>;

/**
 * Reports a child session's liveness on behalf of its parent — the
 * observability leg of the child toolset (`task` spawns, `child_read`
 * reads, `child_send` steers, `child_status` checks). `settled` mirrors
 * the host's watch row; `lastActivityAt` is the child's queue activity
 * clock (`SessionStore.latestActivityAt`), null when the child has no
 * queue items yet. A status read never wakes the child.
 *
 * Returns `null` when `childSessionId` is not a child of
 * `parentSessionId`, with the same "not yours" / "does not exist"
 * ambiguity as `ChildReader`.
 */
export type ChildStatusReader = (
  req: { childSessionId: string },
  ctx: { parentSessionId: string },
) => Promise<{ settled: boolean; lastActivityAt: number | null } | null>;

/**
 * Sends a message into a child session on behalf of its parent — the
 * steering half of the child toolset (`task` spawns, `child_read` reads,
 * `child_send` redirects). `interrupt: true` supersedes the child's
 * in-flight work (queue-mode steer); the default queues behind it.
 *
 * The host re-points its settlement watch at the new submission, so the
 * parent's next `child.settled` signal reports the steered work, not the
 * superseded original. The signal lands on the thread that spawned the
 * child (the durable edge), not necessarily the thread the send came from.
 * A send that re-opens a settled child pays the host's active-children
 * limits and may reject.
 *
 * Returns `null` when `childSessionId` is not a child of `parentSessionId`,
 * with the same "not yours" / "does not exist" ambiguity as `ChildReader`.
 */
export type ChildSender = (
  req: { childSessionId: string; message: string; interrupt?: boolean },
  ctx: { parentSessionId: string; parentThreadId: string; actorUserId: string },
) => Promise<{ queueItemId: string } | null>;

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
