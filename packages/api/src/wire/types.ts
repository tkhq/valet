/**
 * Wire protocol — REST + WebSocket shapes shared between server and web.
 *
 * Single source of truth: the web package imports these types via the
 * `@valet/api/wire` subpath export. No build step — Vite resolves source TS.
 *
 * Stability rules:
 *   - REST request/response shapes are versioned implicitly by the route path.
 *   - WS frames have a discriminated `type`. Add new types; don't repurpose.
 *   - WS frames carry a monotonically-increasing `seq` (per socket) for
 *     client-side ordering. Durable frames also carry a persistent `offset`;
 *     clients resume after a gap by reconnecting with `?fromOffset=<offset>`.
 */
import type { RepoListItem } from "@valet/sdk/repos";
import type { CommandInfo, RegistryDiagnostic } from "@valet/engine";
export type { CommandInfo, RegistryDiagnostic };

// ── Common ────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  name?: string;
}

export interface ApiError {
  error: string;
  code?: string;
}

// ── REST: auth ────────────────────────────────────────────────────────────

/**
 * `GET /api/auth-config` — unauthenticated. Drives `/login`/`/signup`
 * control rendering (auth-v2 design). `stub: true` means no `AuthConfig`
 * resolved (`BETTER_AUTH_SECRET` unset) — real auth endpoints aren't
 * mounted and the app runs the `VALET_LOCAL_AUTH` dev stub.
 */
export interface AuthConfigResponse {
  stub: boolean;
  social: ("google" | "github")[];
  sso: { name: string } | null;
}

// ── REST: sessions ────────────────────────────────────────────────────────

export type SessionStatus = "active" | "hibernated" | "archived" | "deleted";

/** Interactive-service profile (sandbox auth gateway plan, Task 5).
 * "headless" (default) is agent-only; "full" additionally runs ttyd +
 * code-server + the auth gateway inside the sandbox. Only web-created
 * interactive sessions may request "full". */
export type SandboxProfile = "headless" | "full";

export interface SessionSummary {
  id: string;
  workspace: string;
  status: SessionStatus;
  title?: string;
  createdAt: number;
  updatedAt: number;
}

/** A single repo bound to a session (GitHub/repo integration plan, Task 2).
 * `host` defaults to "github" server-side when omitted. `auth` selects how
 * the sandbox authenticates the clone: "auto" (server picks), "app" (GitHub
 * App installation token), or "user" (the session owner's linked OAuth
 * token) — defaults to "auto". */
export interface RepoBinding {
  host?: string;
  fullName: string;
  cloneUrl: string;
  ref?: string;
  auth?: "auto" | "app" | "user";
}

export interface SessionDetail extends SessionSummary {
  messageCount: number;
  /** Session-default model id. Threads inherit when they have no override. */
  model?: string;
  profile: SandboxProfile;
  /** Repos bound to this session, in position order. Omitted when unbound. */
  repos?: RepoBinding[];
}

export interface CreateSessionRequest {
  workspace: string;
  title?: string;
  /** Optional first user prompt; if set, server enqueues immediately after creation. */
  initialPrompt?: string;
  /** Defaults to "headless" server-side when omitted. */
  profile?: SandboxProfile;
  /** Multiple repo bindings. Mutually exclusive with `repo` (400 if both set). */
  repos?: RepoBinding[];
  /** Sugar for a single repo binding — equivalent to `repos: [repo]`. */
  repo?: RepoBinding;
}

export interface ListSessionsResponse {
  sessions: SessionSummary[];
}

export type CreateSessionResponse = SessionDetail;
export type GetSessionResponse = SessionDetail;

/** POST /api/sessions/:id/sandbox-jwt — mints a short-lived service JWT the
 * session's sandbox uses to call back into the API (auth-v2 design). */
export interface SandboxJwtResponse {
  token: string;
  expiresAt: number;
}

/** POST /api/sessions/:id/pause — manual hibernation (sandbox hibernation
 * plan, Task 4). Suspends the session's sandbox and marks the row
 * `"hibernated"`; the next touch (submission, gateway-touch, or a future
 * wake) resumes it and clears the status back to `"active"`. */
export interface PauseSessionResponse {
  status: "hibernated";
}

// ── REST: orchestrator ────────────────────────────────────────────────────

/** POST /api/orchestrator — ensures the caller's orchestrator session exists. */
export interface EnsureOrchestratorResponse {
  sessionId: string;
}

/** GET /api/orchestrator — probes without creating. */
export interface GetOrchestratorResponse {
  sessionId: string;
  exists: boolean;
}

export type OrchestratorPresence = "idle" | "thinking" | "working";

/** GET /api/orchestrator/info — assistant identity + presence (assistant-
 * centered web UI decision 4). Never creates the engine session. */
export interface GetOrchestratorInfoResponse {
  sessionId: string;
  name: string | null;
  personality: string | null;
  presence: OrchestratorPresence;
  activeChildren: number;
}

/** PATCH /api/orchestrator/info — `name` upserts `orchestrator_identities.handle`;
 * `personality` writes the `assistant/personality.md` memory file (decision 5). */
export interface PatchOrchestratorInfoRequest {
  name?: string;
  personality?: string;
}

export interface PatchOrchestratorInfoResponse {
  ok: true;
}

export interface OrchestratorChildSummary {
  sessionId: string;
  title: string;
  parentThreadId: string;
  status: "running" | "settled";
  outcome?: string;
  createdAt: number;
}

/** GET /api/orchestrator/children — child_watches ⋈ agent_sessions for the
 * caller's orchestrator (decision 6). */
export interface GetOrchestratorChildrenResponse {
  children: OrchestratorChildSummary[];
}

// ── REST: threads ─────────────────────────────────────────────────────────

export interface ThreadSummary {
  id: string;
  sessionId: string;
  title?: string;
  createdAt: number;
  /** Thread-level model override. Falls back to the session default when undefined. */
  model?: string;
  /**
   * The engine thread key — encodes the thread's ORIGIN by convention:
   * `web:{nonce}` (created from the UI), `events` (event-subscription
   * deliveries), `signal:workflow:{runId}` (workflow orchestrator/llm
   * nodes), `signal:{senderId}` (cross-orchestrator), channel-owned keys
   * like `telegram:dm:{chatId}`, or `default`. The web sidebar buckets
   * threads by this (see packages/web `thread-origin.ts`).
   */
  key?: string;
}

export interface ListThreadsResponse {
  threads: ThreadSummary[];
}

export interface CreateThreadRequest {
  /** Optional title — not currently persisted by the engine; reserved. */
  title?: string;
}

export type CreateThreadResponse = ThreadSummary;

/**
 * Patch a thread's settings. Currently only `model` is mutable; pass
 * `null` to clear the override and fall back to the session default.
 */
export interface PatchThreadRequest {
  model?: string | null;
}

export type PatchThreadResponse = ThreadSummary;

/**
 * Patch a session's settings. Currently only `model` is mutable; this is
 * the session default that threads inherit when they have no override.
 */
export interface PatchSessionRequest {
  model?: string;
}

export type PatchSessionResponse = SessionDetail;

// ── REST: messages ────────────────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "tool" | "system";

/**
 * Discriminated union for message parts. Mirrors the engine's MessagePart
 * one-to-one for `text` and `tool_call` so the bridge is mechanical.
 * `thinking` and `attachment` parts from the engine are dropped on the wire
 * (the UI doesn't render them in the agent loop).
 */
export type MessagePart =
  | { kind: "text"; text: string }
  | {
      kind: "tool_call";
      callId: string;
      toolName: string;
      status: "running" | "completed" | "error";
      args?: unknown;
      result?: unknown;
      error?: string;
    };

/**
 * Trimmed projection of engine `MessageEntry.signal` (plan decision 2).
 * `tagName`/`hopCount`/`senderOwner` are engine-internal and not shipped —
 * the UI only needs enough to render a signal card and link to the sender.
 */
export interface MessageSignal {
  signalType: string;
  attributes?: Record<string, string>;
  senderSessionId?: string;
}

/**
 * Slash-command metadata on a `command_result` entry. Present only when
 * `role === "system"` and the entry originated from a slash command.
 * `name` is the command name without the leading slash.
 */
export interface MessageCommand {
  name: string;
  source: string;
  ok: boolean;
}

export interface Message {
  id: string;
  sessionId: string;
  threadId: string | null;
  role: MessageRole;
  content: string;
  parts: MessagePart[];
  createdAt: number;
  /**
   * The submission (engine queue item) that produced this entry —
   * transcript↔submission linkage. Populated from the engine's
   * `BaseEntry.queueItemId` for REST-fetched rows; the web client also
   * stamps this on optimistic user messages once `POST /messages` returns
   * (its `messageId` is the queue item id). Drives exact matching of
   * `submission.settled` events to the originating user message.
   */
  queueItemId?: string;
  /**
   * Present when this entry originated from a `SignalContent` prompt (e.g.
   * a `child.settled` notification). A wire message with `signal` renders
   * as a card, never a user bubble (plan decision 3).
   */
  signal?: MessageSignal;
  /**
   * Present when this message is a `command_result` entry (slash-commands
   * plan, Task 11). `name` is the command name without the leading slash.
   * The renderer uses `ok` to show success/failure styling.
   */
  command?: MessageCommand;
  /**
   * Model that produced this entry (assistant messages). Gives the reply
   * visible attribution so a model switch is verifiable in the transcript,
   * not only in the header picker.
   */
  model?: string;
}

export interface ListMessagesResponse {
  messages: Message[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface SendPromptRequest {
  text: string;
  /** Target thread id. If omitted, server uses the session's default thread. */
  threadId?: string;
}

export interface SendPromptResponse {
  /**
   * Queue item id for client-side optimistic linkage. `null` when the text
   * executed as a slash command — commands never take a queue item.
   */
  messageId: string | null;
  threadId: string;
}

// ── REST: decision gates ──────────────────────────────────────────────────

export type DecisionGateType = "approval" | "question" | "credential_request";
export type DecisionGateStatus = "pending" | "resolved" | "expired" | "withdrawn";
export type DecisionWithdrawReason = "steer" | "abort" | "cancel";

export interface DecisionAction {
  id: string;
  label: string;
  style?: "primary" | "danger";
}

/**
 * Why a policy-driven approval gate opened — the typed subset of the engine
 * gate's `context.provenance` (the raw `context` stays engine-only). Same
 * vocabulary as `ActionLogEntryWire`; `source` names the winning precedence
 * rung — the engine's `PolicyProvenanceSource` values: `org_policy` /
 * `runtime_grant` / `override` / `plugin_default` / `risk_default` /
 * `resolver_error`. Absent for gates that did not come from the policy
 * resolver.
 */
export interface DecisionGateProvenance {
  baseMode: ApprovalModeWire;
  source: string;
  matchedPolicyId?: string;
  matchedGrantId?: string;
  matchedOverrideId?: string;
}

export interface DecisionGate {
  id: string;
  sessionId: string;
  threadId: string;
  type: DecisionGateType;
  title: string;
  body?: string;
  actions: DecisionAction[];
  expiresAt?: number;
  status: DecisionGateStatus;
  createdAt: number;
  updatedAt: number;
  provenance?: DecisionGateProvenance;
}

export interface DecisionResolution {
  actionId?: string;
  value?: string;
  resolvedBy: string;
  resolvedAt: number;
}

export interface ListDecisionsResponse {
  gates: DecisionGate[];
}

/**
 * Resolve a pending gate. For `approval` and `credential_request` gates the
 * client sends `actionId` matching one of `gate.actions`. For `question`
 * gates the client sends `value` (free-form text).
 */
export interface ResolveDecisionRequest {
  actionId?: string;
  value?: string;
}

export interface WithdrawDecisionRequest {
  /** Why the gate is being cancelled. The agent's withdraw paths (`steer` /
   *  `abort`) live in the engine; user-initiated cancellation always sends
   *  `cancel`. */
  reason?: DecisionWithdrawReason;
}

// ── WebSocket events ──────────────────────────────────────────────────────

/**
 * `WireEvent` is the discriminated union the client receives on the WS.
 * Shape designed for the agent loop only: deltas + tool lifecycle + status.
 *
 * Engine emits richer events (compaction, decision gates, model switches)
 * — those that the loop UI needs to render are surfaced here; the rest are
 * dropped by the bridge.
 */
export type WireEvent =
  // `init` carries only session metadata. The client fetches messages via
  // GET /messages?threadId=… (REST is the authoritative source for thread
  // history). Earlier versions sent the default thread's messages here, but
  // that wiped non-default-thread state on every WS reconnect.
  | { seq: number; ts: number; offset?: string; type: "init"; session: SessionDetail }
  | { seq: number; ts: number; offset?: string; type: "message_start"; threadId: string; messageId: string; role: MessageRole }
  | { seq: number; ts: number; offset?: string; type: "text_delta"; threadId: string; messageId: string; delta: string }
  | {
      seq: number;
      ts: number; offset?: string;
      type: "message_update";
      threadId: string;
      messageId: string;
      parts: MessagePart[];
      content?: string;
    }
  | {
      seq: number;
      ts: number; offset?: string;
      type: "message_end";
      threadId: string;
      messageId: string;
      reason: "end_turn" | "error" | "abort";
    }
  | {
      seq: number;
      ts: number; offset?: string;
      type: "tool_start";
      threadId: string;
      toolName: string;
      callId?: string;
      args?: Record<string, unknown>;
    }
  | {
      seq: number;
      ts: number; offset?: string;
      type: "tool_end";
      threadId: string;
      toolName: string;
      callId?: string;
      result: string;
      isError: boolean;
    }
  | {
      seq: number;
      ts: number; offset?: string;
      type: "status";
      threadId: string;
      status: "idle" | "queued" | "thinking" | "tool_calling" | "streaming" | "blocked_on_decision_gate" | "error";
    }
  | {
      seq: number;
      ts: number; offset?: string;
      type: "turn_end";
      threadId: string;
      reason: "end_turn" | "error" | "abort";
    }
  | {
      seq: number;
      ts: number; offset?: string;
      type: "error";
      threadId?: string;
      code: string;
      message: string;
      recoverable: boolean;
    }
  | {
      seq: number;
      ts: number; offset?: string;
      type: "model_switched";
      /** Present when scope === thread; absent for session-level switches. */
      threadId?: string;
      fromModel: string;
      toModel: string;
      reason: string;
    }
  | { seq: number; ts: number; offset?: string; type: "decision_gate"; threadId: string; gate: DecisionGate }
  | {
      seq: number;
      ts: number; offset?: string;
      type: "decision_gate_resolved";
      threadId: string;
      gateId: string;
      resolution: DecisionResolution;
    }
  | { seq: number; ts: number; offset?: string; type: "decision_gate_expired"; threadId: string; gateId: string }
  | {
      seq: number;
      ts: number; offset?: string;
      type: "decision_gate_withdrawn";
      threadId: string;
      gateId: string;
      reason: DecisionWithdrawReason;
    }
  | {
      seq: number;
      ts: number;
      offset?: string;
      type: "queue.state";
      sessionId: string;
      threadId: string;
      state: WireQueueState;
    }
  | {
      seq: number;
      ts: number;
      offset?: string;
      type: "submission.settled";
      sessionId: string;
      threadId: string;
      queueItemId: string;
      outcome: "completed" | "failed" | "aborted" | "superseded" | "merged";
      error?: string;
    }
  | {
      seq: number;
      ts: number;
      offset?: string;
      type: "sandbox.status";
      state: string;
      epoch: number;
      estimateMs?: number;
    }
  | {
      seq: number;
      ts: number;
      offset?: string;
      type: "command_result";
      /** Target thread id, if the command ran in a thread context. */
      threadId?: string;
      /** The completed command as a wire `Message` (role "system", content = output). */
      message: Message;
    }
  | { seq: number; ts: number; offset?: string; type: "ping" };

export type WireEventType = WireEvent["type"];

/**
 * Thin projection of the engine's `QueueState` for the wire. The full items
 * live behind the admin REST surface; the live socket ships only id lists so
 * the client can reconcile ordering without carrying prompt payloads.
 */
export interface WireQueueState {
  mode: "followup" | "steer" | "collect";
  status: "idle" | "queued" | "running" | "blocked_on_decision_gate" | "paused";
  activeItemId?: string;
  pendingIds: string[];
  collectingIds: string[];
  blockedGateId?: string;
}

// ── WebSocket: client → server frames ────────────────────────────────────

export interface ClientHello {
  type: "subscribe";
}

export interface ClientPong {
  type: "pong";
}

export type ClientFrame = ClientHello | ClientPong;

// ── REST: admin ──────────────────────────────────────────────────────────
//
// Operator surface for inspecting/repairing submission lifecycle state
// across sessions. Admin-only (role === "admin"). Lifecycle-only — no
// `content` field, since prompt bodies may hold user data.

export type AdminSubmissionStatus =
  | "collecting"
  | "queued"
  | "running"
  | "blocked_on_decision_gate"
  | "terminalizing"
  | "settled";

export interface AdminSubmission {
  id: string;
  sessionId: string;
  threadId: string;
  status: AdminSubmissionStatus;
  outcome?: "completed" | "failed" | "aborted" | "superseded" | "merged";
  error?: string;
  attemptId?: string;
  attemptCount: number;
  maxAttempts: number;
  ownerId?: string;
  leaseExpiresAt?: number;
  /** `leaseExpiresAt != null && leaseExpiresAt < now`, computed server-side. */
  leaseExpired: boolean;
  timeoutAt: number;
  abortRequestedAt?: number;
  supersededByItemId?: string;
  mergedIntoItemId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ListAdminSubmissionsResponse {
  submissions: AdminSubmission[];
}

export interface ForceSettleRequest {
  outcome: "failed" | "aborted";
  error?: string;
}

export interface ForceSettleResponse {
  submission: AdminSubmission;
}

// ── REST: teams ──────────────────────────────────────────────────────────
//
// Org's membership structure (orchestrator spec, "Identity"). Every route is
// org-membership-gated — no cross-org access. No teams UI this phase; these
// shapes exist for the service/route layer and future web work.

export type TeamRole = "admin" | "member";

export interface TeamSummary {
  id: string;
  orgId: string;
  name: string;
  createdAt: number;
  memberCount: number;
}

export interface TeamMemberSummary {
  userId: string;
  role: TeamRole;
}

export interface ListTeamsResponse {
  teams: TeamSummary[];
}

export interface ListTeamMembersResponse {
  members: TeamMemberSummary[];
}

export interface CreateTeamRequest {
  name: string;
}

export interface CreateTeamResponse {
  team: TeamSummary;
}

export interface AddTeamMemberRequest {
  userId: string;
  role: TeamRole;
}

export interface SetTeamMemberRoleRequest {
  role: TeamRole;
}

// ── REST: notifications ──────────────────────────────────────────────────
//
// Web delivery for the attention router (Phase 4 decision 19). Own-rows-only
// — every route derives `userId` from the caller's session, never a path
// param. 30s polling from the web client; no WS plumbing this phase.

export type NotificationKind = "notification" | "question" | "escalation" | "approval";
export type NotificationUrgency = "low" | "normal" | "high";

export interface NotificationSummary {
  id: string;
  kind: NotificationKind;
  urgency: NotificationUrgency;
  title: string;
  body?: string;
  href?: string;
  sessionId?: string;
  createdAt: number;
  readAt?: number;
}

export interface ListNotificationsResponse {
  notifications: NotificationSummary[];
}

export interface NotificationPreferenceSummary {
  kind: NotificationKind;
  web: boolean;
}

export interface ListNotificationPreferencesResponse {
  preferences: NotificationPreferenceSummary[];
}

export interface SetNotificationPreferenceRequest {
  kind: NotificationKind;
  web: boolean;
}

// ── REST: memory tree ────────────────────────────────────────────────────
//
// GET /api/memory/tree — flat file listing for the web explorer (assistant-
// centered web UI decision 7). No directory rows; the client derives the
// tree from paths. `dir` is always `false` today (every row is a file) —
// carried for API-table fidelity / future directory rows.

export interface MemoryTreeEntry {
  path: string;
  title: string;
  type: string;
  pinned: boolean;
  updatedAt: number;
  dir: boolean;
  /** Stored content length in UTF-16 code units — display-grade size, not
   * exact UTF-8 bytes. */
  sizeBytes: number;
}

// ── REST: workflows (engine v2 Phase 5) ──────────────────────────────────
//
// Own-rows-only, same owner-scoping convention as sessions (decision 18).

export interface WorkflowDefinitionSummary {
  id: string;
  name: string;
  definition: unknown;
  createdAt: number;
  updatedAt: number;
  ownerType: "user" | "team";
  ownerId: string;
}

export interface CreateWorkflowRequest {
  name: string;
  definition: unknown;
  /** Create as a team-owned workflow instead of personal. Caller must be a
   * current member of the team; a non-member or unknown id 404s, same as
   * any other cross-owner access (decision 18's own-rows convention). */
  teamId?: string;
}

export interface ValidationErrorResponse {
  error: string;
  errors: string[];
}

export type CreateWorkflowResponse = WorkflowDefinitionSummary;
export type GetWorkflowResponse = WorkflowDefinitionSummary;
export type UpdateWorkflowResponse = WorkflowDefinitionSummary;

export interface UpdateWorkflowRequest {
  name?: string;
  definition?: unknown;
}

export interface ListWorkflowsResponse {
  workflows: WorkflowDefinitionSummary[];
}

export interface StartWorkflowRunRequest {
  input?: Record<string, unknown>;
}

export interface StartWorkflowRunResponse {
  runId: string;
}

export type WorkflowRunStatus = "pending" | "running" | "parked" | "terminalizing" | "settled";
export type WorkflowRunOutcome = "completed" | "failed" | "cancelled";

export interface WorkflowRunSummary {
  runId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  outcome?: WorkflowRunOutcome;
  createdAt: number;
  updatedAt: number;
}

export interface ListWorkflowRunsResponse {
  runs: WorkflowRunSummary[];
}

// Version history: one immutable snapshot per definition-changing save
// (v1 = create). Detail includes the stored definition for read-only
// display and restore.
export interface WorkflowVersionSummary {
  version: number;
  name: string;
  createdAt: number;
}

export interface ListWorkflowVersionsResponse {
  versions: WorkflowVersionSummary[];
}

export interface GetWorkflowVersionResponse extends WorkflowVersionSummary {
  definition: unknown;
}

export interface WorkflowRunCheckpoint {
  nodeId: string;
  iteration: number;
  status: "intent" | "completed" | "failed" | "skipped";
  result?: unknown;
  error?: string;
  createdAt: number;
}

export interface WorkflowRunSignal {
  signalId: string;
  signalType: string;
  payload?: unknown;
  createdAt: number;
}

export interface WorkflowRunDetail {
  run: WorkflowRunSummary & {
    waitingOn: unknown[];
    definition: unknown;
    params: unknown;
  };
  checkpoints: WorkflowRunCheckpoint[];
  signals: WorkflowRunSignal[];
}

export type GetWorkflowRunResponse = WorkflowRunDetail;

export interface ResolveWorkflowApprovalRequest {
  approved: boolean;
  note?: string;
  /** "Grant the rest of this run" (action-policies plan, Task 3/6): exact
   *  `(service, actionId)` pairs to authorize for the remainder of the run
   *  via an exec-scoped runtime grant. Only consulted by the approval node
   *  executor when `approved` is `true`; ignored on a denial. */
  grantActions?: Array<{ service: string; actionId: string }>;
}

export interface ResolveWorkflowApprovalResponse {
  ok: true;
}

export interface CancelWorkflowRunResponse {
  ok: true;
}

// Arbitrary-URL webhook triggers (overhaul design decision 5). `hookId` is
// the bearer secret in `POST /api/hooks/workflows/:workflowId/:hookId` —
// minting/rotating returns it once; `GetWorkflowWebhookResponse` also
// returns it since the management surface is owner-scoped and re-showing
// the URL (not just "a hook exists") is the point of a status check.
export interface WorkflowWebhookResponse {
  workflowId: string;
  hookId: string;
  createdAt: number;
  updatedAt: number;
}

export interface DeleteWorkflowWebhookResponse {
  deleted: boolean;
}

export interface GetMemoryTreeResponse {
  entries: MemoryTreeEntry[];
}

// ── REST: plugins + credentials (plugin-system-v2 plan Task 15) ───────────

export type CredentialKind = "oauth2" | "api_key" | "bot_token" | "service_account";

/** One statically-declared action, for the org-policy admin UI's target
 *  picker (action-policies plan, Task 4) — `id` is the fully-qualified
 *  action id (`"github.create_issue"`), matching what `action_policies.
 *  action_id` / `action_policy_overrides.action_id` store. */
export interface PluginActionSummary {
  id: string;
  name: string;
  riskLevel: RiskLevelWire;
}

export interface PluginServiceSummary {
  /** Credential store key — defaults to the plugin name when the
   * declaration omits its own `service` (see `CredentialDeclaration`). */
  service: string;
  type: CredentialKind;
  scopes?: string[];
  connectLabel?: string;
  configKeys: string[];
  connected: boolean;
  /** Set (to `true`) only when an `ActionPlugin` for this service declares
   * `resolveActions` — the plugin's action list isn't fully known statically. */
  dynamic?: true;
  /** For CONNECTED dynamic services only: the tool count resolved live from
   * the service (TTL-cached server-side). Absent while disconnected, and on
   * resolution timeout/failure — the UI falls back to its static copy. */
  toolCount?: number;
  /** How the connect UI obtains this credential: "oauth" renders a Connect
   * redirect button; "manual" renders token entry. authorization_code-mode
   * declarations report "manual" when their client env vars are unset so
   * the UI never renders a Connect button that would 503. */
  connect: "oauth" | "manual";
  /** Statically-declared actions for this service (empty when the plugin
   * only declares `resolveActions` dynamic discovery, or none at all). */
  actions: PluginActionSummary[];
}

export interface PluginSummary {
  name: string;
  version: string;
  description?: string;
  /** Count of statically-declared actions only (plugins with `resolveActions`
   * may expose more at runtime — see `PluginServiceSummary.dynamic`). */
  actionCount: number;
  /**
   * Set (to `true`) when ANY of the plugin's ActionPlugins declares
   * `resolveActions`. Needed at the plugin level because a dynamic plugin
   * with no credential declaration (e.g. deepwiki) has `services: []`, and
   * the UI would otherwise read it as content-only.
   */
  dynamic?: true;
  /** Empty when the plugin declares no `credentials` (nothing to connect). */
  services: PluginServiceSummary[];
}

export interface ListPluginsResponse {
  plugins: PluginSummary[];
}

// ── REST: skills ─────────────────────────────────────────────────────────

/**
 * A skill — a markdown playbook the agent can pull into a turn through the
 * `skill` tool. Skills come from two places, and `origin` says which:
 *
 *   - `plugin` — shipped inside a plugin package. Everyone sees the same set.
 *   - `local`  — written in the product, stored in the `skills` table.
 *   - `repo`   — synced from a repository into the same table.
 *
 * The two stored origins carry a row id and owner; a plugin skill carries
 * its plugin's name. Narrow on `origin` to read either group.
 */
interface SkillSummaryBase {
  /** The identifier the agent passes to the `skill` tool. */
  name: string;
  description?: string;
  /** True when the skill declares an `argsSchema`, so the caller must supply
   * values for the `{{placeholder}}` names in its body. Plugin skills only —
   * a stored skill takes no arguments. */
  takesArgs: boolean;
}

export interface PluginSkillSummary extends SkillSummaryBase {
  origin: "plugin";
  /** Name of the plugin that ships this skill. */
  plugin: string;
}

export interface StoredSkillSummary extends SkillSummaryBase {
  origin: "local" | "repo";
  /** Row id. The `/api/skills/stored/:id` routes take this. */
  id: string;
  ownerType: "user" | "team" | "org";
  ownerId: string;
  /**
   * True when another skill already holds this name, so this one never
   * reaches a session. A plugin skill always wins, and between two stored
   * skills the personal one wins over the team one. Rename this skill to
   * make it reachable.
   */
  shadowed: boolean;
  updatedAt: number;
  /**
   * How the engine expands this skill as a slash command.
   * `"context"` (default) wraps the body in `<skill>` tags;
   * `"prompt"` substitutes args and sends the body bare.
   * Absent when the skill uses the `"context"` default.
   */
  invocation?: "context" | "prompt";
  /**
   * Hint shown in the command palette for the first argument.
   * Present only on prompt-invocation skills that declare one.
   */
  argHint?: string;
}

export type SkillSummary = PluginSkillSummary | StoredSkillSummary;

export interface ListSkillsResponse {
  skills: SkillSummary[];
}

/** A skill plus its markdown body, with the frontmatter already removed.
 * Placeholders stay unfilled — this route reads the skill, it does not
 * invoke it. */
export type GetSkillResponse = SkillSummary & { content: string };

/** One stored skill, body included — what the create/read/update routes
 * return.
 *
 * `editable` says whether THIS caller may write the row. A user or team row
 * follows the caller's ownership; an org-library row is editable only for an
 * org admin. A member reads an org row but gets `editable: false`, so the
 * detail page shows the body read-only. */
export type SkillResponse = StoredSkillSummary & { content: string; editable: boolean };

export interface CreateSkillRequest {
  name: string;
  description: string;
  /** The markdown body. Write it without frontmatter: `name` and
   * `description` above are the frontmatter. */
  content: string;
  /** Create the skill for a team the caller belongs to instead of for the
   * caller. A non-member or unknown id 404s, same as any other cross-owner
   * access. */
  teamId?: string;
  /** Create the skill for the org instead of for the caller.
   * Requires the caller to be an org admin; a non-admin gets 403. */
  ownerType?: "user" | "team" | "org";
  /**
   * How the engine expands this skill as a slash command.
   * `"context"` (default) wraps the body in `<skill>` tags;
   * `"prompt"` substitutes args and sends the body bare.
   * Must be `"context"` or `"prompt"` when present.
   */
  invocation?: "context" | "prompt";
  /**
   * Hint shown in the command palette for the first argument.
   * Meaningful only for `invocation: "prompt"` skills.
   */
  argHint?: string;
}

/** Every field is optional; an absent field keeps its stored value. */
export interface UpdateSkillRequest {
  name?: string;
  description?: string;
  content?: string;
  /**
   * How the engine expands this skill as a slash command.
   * `"context"` (default) wraps the body in `<skill>` tags;
   * `"prompt"` substitutes args and sends the body bare.
   * Must be `"context"` or `"prompt"` when present.
   */
  invocation?: "context" | "prompt";
  /**
   * Hint shown in the command palette for the first argument.
   * Meaningful only for `invocation: "prompt"` skills.
   */
  argHint?: string;
}

export interface DeleteSkillResponse {
  ok: true;
}

// ── REST: skill sources ──────────────────────────────────────────────────

/**
 * A tracked skill repository. Valet mirrors its `SKILL.md` files into the
 * skill catalog as `repo`-origin skills, and keeps mirroring as the
 * repository moves.
 *
 * Public repositories only. Nothing here carries a GitHub credential.
 */
export interface SkillSourceSummary {
  id: string;
  /** `owner/repo`. */
  repo: string;
  /** Branch, tag, or commit. Empty means the default branch. */
  ref: string;
  /** Directory that holds the skill directories. Empty means the root. */
  subpath: string;
  ownerType: "user" | "team" | "org";
  ownerId: string;
  enabled: boolean;
  /** `pending` — never synced. `ok` — synced. `warning` — synced, but at
   * least one skill was skipped. `error` — the last sync failed. */
  status: "pending" | "ok" | "warning" | "error";
  /** Skills this source currently mirrors. */
  skillCount: number;
  lastSyncedAt: number | null;
  /** Commit the last sync read. */
  lastSha: string | null;
  /** What the last sync has to report: the failure for `error`, the skills
   * it skipped for `warning`, null otherwise. */
  lastMessage: string | null;
}

export interface ListSkillSourcesResponse {
  sources: SkillSourceSummary[];
}

export interface CreateSkillSourceRequest {
  /** `owner/repo`, or a GitHub URL. A `/tree/` URL also sets `ref` and
   * `subpath`, unless the fields below give them explicitly. */
  repo: string;
  ref?: string;
  subpath?: string;
  /** Track the repository for a team the caller belongs to instead of for
   * the caller. A non-member or unknown id 404s. Mutually exclusive with
   * `ownerType: "org"`. */
  teamId?: string;
  /** Track the repository for the org instead of for the caller.
   * Requires the caller to be an org admin; a non-admin gets 403. */
  ownerType?: "user" | "team" | "org";
}

/** What a sync did. Returned by the create route too, because adding a
 * source imports it right away. */
export interface SkillSourceSyncResponse {
  source: SkillSourceSummary;
  imported: number;
  updated: number;
  deleted: number;
  /** One line per skill the sync skipped, each naming the fix. */
  warnings: string[];
}

export interface DeleteSkillSourceResponse {
  ok: true;
}

export interface CredentialSummary {
  service: string;
  type: CredentialKind;
  scopes?: string[];
  connectedAt: string;
  /** Epoch ms — present only for a credential with a known expiry
   * (`StoredCredential.expiresAt`). Health-relevant, not secret. */
  expiresAt?: number;
  /** `metadata.login`, when the stored credential carries one (GitHub App
   * OAuth / PAT credentials). Never secret material. */
  login?: string;
  /** `metadata.identityOnly === true` — a social-login credential with
   * sign-in-only scopes, not repo-capable (see `services/github-tokens.ts`'s
   * "healthy" definition). */
  identityOnly?: boolean;
  /** `metadata.refreshFailedAt`, when a previous token-refresh attempt
   * failed and left the credential needing a reconnect. Epoch ms. */
  refreshFailedAt?: number;
}

export interface ListCredentialsResponse {
  credentials: CredentialSummary[];
}

export interface PutCredentialRequest {
  type: CredentialKind;
  accessToken?: string;
  apiKey?: string;
  /** Only meaningful (and only accepted) alongside `type: "oauth2"`. */
  refreshToken?: string;
  metadata?: Record<string, unknown>;
  /** Owner scope for the saved credential. `"org"` requires the caller to be
   * an org admin. Defaults to `"user"`. */
  scope?: "user" | "org";
}

export interface PutCredentialResponse {
  ok: true;
}

export interface DeleteCredentialResponse {
  ok: true;
}

// ── REST: me + models (split-settings design) ─────────────────────────────
//
// `/api/me` is the settings-shell's per-user profile surface — distinct
// from better-auth's own session-probe endpoints under `/api/auth/*`.
// `orgRole` comes from `org_members.role` (falls back to `"member"` if the
// caller has no org-membership row); `defaultModel` feeds `EngineHost`'s
// model override seam and is validated against `/api/models`'s id set on
// PATCH.

export interface MeResponse {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: "admin" | "member";
  orgId: string;
  orgRole: "admin" | "member";
  defaultModel: string | null;
}

/** Whitelisted fields only — unknown keys 400. `defaultModel: null` clears the override. */
export interface PatchMeRequest {
  name?: string;
  avatarUrl?: string;
  defaultModel?: string | null;
}

export type PatchMeResponse = MeResponse;

/** Org-level settings response for `PATCH /api/org/settings`. */
export interface OrgSettingsResponse {
  bareSkillCommands: boolean;
}

/** Org-level settings request for `PATCH /api/org/settings`. */
export interface PatchOrgSettingsRequest {
  bareSkillCommands?: boolean;
}

/** Namespaced `id` (`{providerKindOrRowId}/{modelId}`, bare = Anthropic
 * back-compat) — see `services/model-catalog.ts`. `active: false` marks a
 * configured-but-currently-unusable model (disabled provider, or no
 * resolvable key); such entries are excluded from `ListModelsResponse`. */
export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  reasoning?: boolean;
  providerId: string;
  providerKind: LlmProviderKindWire;
  providerName: string;
  active: boolean;
  pricing?: { input: number; output: number };
}

export interface ListModelsResponse {
  models: ModelInfo[];
}

// ── REST: usage (`/api/usage/summary`) ─────────────────────────────────

export interface UsageWindow {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Every token the window billed: input + output + cache read + cache
   * write. On a cache-heavy model, input + output is a small part of this. */
  totalTokens: number;
  /** Estimated USD, summed over PRICED turns only. Turns on an unpriced
   * model (custom/OpenRouter providers, dev fakes) contribute nothing — read
   * `unpricedTurns` before you present this as the full spend. */
  costUsd: number;
  /** Assistant turns that reported usage in the window. */
  turns: number;
  /** Turns of `turns` whose model reported no price. `costUsd` excludes
   * them; it is a floor, not a total, whenever this is above 0. */
  unpricedTurns: number;
}

export interface UsageMemberSummary extends UsageWindow {
  userId: string;
  name: string;
}

export interface UsageSummaryResponse {
  me: { day: UsageWindow; week: UsageWindow; month: UsageWindow };
  /** Present only when the org's `features.organizations` flag is on —
   * single-user mode never sees comparative usage. */
  org?: { windowDays: number; members: UsageMemberSummary[] };
}

// ── REST: org (split-settings design) ──────────────────────────────────
//
// Singular `/api/org` shape — single-org is deliberate (spec decision 7);
// `orgId` always resolves from the caller's own membership. `GET` is
// member-readable; `PATCH` (incl. the `features.organizations` gate toggle
// itself) is org-admin only. The members routes additionally require the
// gate to be on — off => 404 `{error:"organizations not enabled"}`.

export interface OrgFeaturesWire {
  organizations: boolean;
}

export interface OrgResponse {
  id: string;
  name: string;
  createdAt: number;
  features: OrgFeaturesWire;
  callerRole: "admin" | "member";
}

/** Whitelisted fields only — unknown top-level keys 400. */
export interface PatchOrgRequest {
  name?: string;
  features?: Partial<OrgFeaturesWire>;
}

export type PatchOrgResponse = OrgResponse;

export interface OrgMemberWire {
  userId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: "admin" | "member";
  joinedAt: number;
}

export interface OrgMembersResponse {
  members: OrgMemberWire[];
}

export interface PatchOrgMemberRequest {
  role: "admin" | "member";
}

export interface PatchOrgMemberResponse {
  ok: true;
}

// ── REST: org invites (org-admin only) ───────────────────────────────────
//
// `POST` mints a code and returns it exactly once — no other response ever
// includes it (only `invites.code_hash` is persisted).

export interface CreateInviteRequest {
  email?: string;
  role: "admin" | "member";
}

export interface CreateInviteResponse {
  id: string;
  code: string;
  email: string | null;
  role: "admin" | "member";
  expiresAt: number;
}

export interface InviteWire {
  id: string;
  email: string | null;
  role: "admin" | "member";
  createdBy: string;
  createdAt: number;
  expiresAt: number;
}

export interface ListInvitesResponse {
  invites: InviteWire[];
}

export interface RevokeInviteResponse {
  ok: true;
}

// ── REST: identity links (channel-link Phase 7) ───────────────────────────
//
// `/api/me/identity-links` — per-user Telegram (etc.) account linking.
// Just `telegram` this pass (see `packages/api/src/routes/identity-links.ts`).

export interface IdentityLinkStatus {
  provider: string;
  linked: boolean;
  externalId?: string;
  notifyAttention?: boolean;
  createdAt?: number;
  /** Transport availability — false when no bot token is configured. */
  channelReady: boolean;
}

export interface ListIdentityLinksResponse {
  links: IdentityLinkStatus[];
}

export interface StartIdentityLinkResponse {
  deepLink: string;
  expiresInSeconds: number;
}

export interface PatchIdentityLinkRequest {
  notifyAttention: boolean;
}

export interface PatchIdentityLinkResponse {
  ok: true;
}

// ── REST: org LLM providers (split-settings design, llm-providers spec) ──
//
// `/api/org/llm-providers` — admin-gated provider CRUD + encrypted key
// management. `LlmProviderSummary` never carries key material — only
// `hasKey`/`keyLast4`. Model ids elsewhere in the wire protocol are
// namespaced `{providerKindOrRowId}/{modelId}` (see the design doc); this
// file's `preferences` endpoints move that ordered list.

export type LlmProviderKindWire = "anthropic" | "openai" | "google" | "openrouter" | "openai_compatible";

export interface LlmProviderModelWire {
  id: string;
  name: string;
  contextWindow?: number;
  pricing?: { input: number; output: number };
}

export interface LlmProviderSummary {
  id: string;
  kind: LlmProviderKindWire;
  name: string;
  baseUrl?: string;
  enabled: boolean;
  models: LlmProviderModelWire[];
  hasKey: boolean;
  keyLast4?: string;
  envFallback: boolean;
  createdAt: number;
}

export interface ListLlmProvidersResponse {
  providers: LlmProviderSummary[];
}

export interface CreateLlmProviderRequest {
  kind: LlmProviderKindWire;
  name: string;
  baseUrl?: string;
  models?: LlmProviderModelWire[];
}

export type CreateLlmProviderResponse = LlmProviderSummary;

/** Whitelisted fields only — `kind` is immutable after creation. */
export interface PatchLlmProviderRequest {
  name?: string;
  baseUrl?: string;
  enabled?: boolean;
  models?: LlmProviderModelWire[];
}

export type PatchLlmProviderResponse = LlmProviderSummary;

export interface PutLlmProviderKeyRequest {
  apiKey: string;
}

/** Never echoes the submitted key — only its last 4 characters. */
export interface PutLlmProviderKeyResponse {
  hasKey: true;
  keyLast4: string;
}

// `DELETE .../key` and `DELETE /:id` return 204 No Content — no response body.

export interface GetLlmProviderPreferencesResponse {
  preferences: string[];
}

export interface PutLlmProviderPreferencesRequest {
  preferences: string[];
}

export type PutLlmProviderPreferencesResponse = GetLlmProviderPreferencesResponse;

// `GET /openrouter/models` — OpenRouter's LIVE catalog merged with the
// built-in pi-ai registry (live wins on collisions), sorted by id. Powers
// the settings picker that edits an openrouter row's curated `models`
// selection; the live fetch is what makes brand-new models pickable before
// any registry bump. `live: false` = the upstream fetch failed and the
// response is registry-only (stale but usable).
export interface OpenrouterRegistryResponse {
  models: LlmProviderModelWire[];
  live: boolean;
}

// `POST .../probe` — custom-provider discovery: GETs `{baseUrl}/models`
// upstream and echoes back the ids. 502 `{ error }` carries the verbatim
// upstream status + body text on failure (admin tool; raw errors are
// correct per the design doc's failure-semantics section).
export interface ProbeLlmProviderResponse {
  models: { id: string }[];
}

// `POST .../test` — 1-token completion round-trip through the resolution
// bridge. Always 200: `ok: true` on success, `ok: false` with a message on
// failure (a result to display, not a transport error).
export interface TestLlmProviderRequest {
  modelId: string;
}

export type TestLlmProviderResponse = { ok: true; latencyMs: number } | { ok: false; error: string };

export interface DeleteIdentityLinkResponse {
  ok: true;
}

// ── REST: GitHub App setup (GitHub/repo integration plan, Task 5) ────────
//
// `/api/org/github-app` — admin-gated App-manifest setup flow, installation
// listing, and config removal. `GetGithubAppResponse`/`GithubAppInfo` never
// carry secret material (private key / OAuth client secret / webhook
// secret) — only the plain fields `github-app.ts`'s `GithubAppConfig`
// exposes alongside them. The public webhook (`/webhooks/github-app`) has
// no wire response type of its own; it always answers `204`/`403`/`404`.

export interface GithubAppInstallationSummary {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string | null;
  suspended: boolean;
  linkedUserId: string | null;
}

export interface GithubAppInfo {
  appId: string;
  appSlug: string;
  htmlUrl: string;
  installUrl: string;
}

export interface GetGithubAppResponse {
  configured: boolean;
  app?: GithubAppInfo;
  installations: GithubAppInstallationSummary[];
  webhook: { mode: "public" | "manual" };
}

export interface PostGithubAppManifestRequest {
  /** `"org:{login}"` to create the app under a GitHub organization, or
   * `"personal"`/omitted for the caller's personal GitHub account. */
  target?: string;
  /** Deliver webhook events. Only honored when the server has a public
   * URL — without one the manifest omits the webhook entirely (GitHub
   * rejects unreachable hook URLs even when marked inactive). */
  webhook?: boolean;
  /** Full permission map (`{contents: "write", ...}`) — replaces the
   * server defaults when present, so deselecting a permission sticks. */
  permissions?: Record<string, string>;
  /** Webhook event names — replaces the plugin-derived defaults when
   * present. Only delivered in public-webhook mode. */
  events?: string[];
}

/** GitHub's app-manifest schema (https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) — only the fields this flow sets. */
export interface GithubAppManifestWire {
  name: string;
  url: string;
  redirect_url: string;
  /** Omitted entirely when webhooks are off/impossible — GitHub validates
   * hook_attributes.url reachability even with active: false, so a
   * localhost placeholder gets the whole manifest rejected. */
  hook_attributes?: { url: string; active?: boolean };
  /** OAuth callback URLs for USER authorization (`/api/me/github/callback`)
   * — distinct from `redirect_url`, which only serves the manifest flow.
   * Without this the created App has no callback registered and user
   * connects fail at GitHub's authorize step. */
  callback_urls: string[];
  public: boolean;
  default_events: string[];
  /** GitHub's manifest schema names this `default_permissions` — a bare
   * `permissions` key is REJECTED by the app-creation form. */
  default_permissions: Record<string, string>;
}

export interface PostGithubAppManifestResponse {
  /** Where the browser should POST the manifest (GitHub's app-creation form). */
  url: string;
  manifest: GithubAppManifestWire;
  /** HMAC-signed `{orgId, nonce, exp}` — echoed back by GitHub as the
   * `state` query param on the `redirect_url` callback. */
  state: string;
}

// ── REST: user GitHub connect (App-OAuth, GitHub/repo integration plan
// Task 6) ────────────────────────────────────────────────────────────────
// `/api/me/github` — a signed-in user's own App-OAuth connection, distinct
// from the org-level App setup above. `GET /callback` has no wire response
// type of its own (always a 302 redirect, or a 400/409/502 error body).

export interface PostGithubConnectResponse {
  /** `{github}/login/oauth/authorize?...` — where the browser should
   * navigate to start the App-OAuth authorize flow. */
  url: string;
}

// ── REST: repo listing (GitHub/repo integration plan, Task 7)
// ────────────────────────────────────────────────────────────────────────
// `GET /api/repos` — union of every `RepoHost` the caller has access to;
// only `github` exists today (`repos/host.ts`'s `repoHostForUrl`).

export interface GetReposResponse {
  /** `RepoListItem` (from `@valet/sdk/repos`) plus the host-specific
   * `installed` flag — set when the repo was found via a GitHub App
   * installation (as opposed to only the personal/org-PAT listing tier). */
  repos: (RepoListItem & { installed?: boolean })[];
  /** The signed-in user has a usable personal GitHub credential (healthy
   * `resolveUserApiToken`) — distinct from `installed` below. */
  connected: boolean;
  /** The org has at least one non-suspended GitHub App installation. */
  installed: boolean;
}

// ── REST: in-sandbox git credential surface (GitHub/repo integration plan,
// Task 8) ────────────────────────────────────────────────────────────────
// `POST /api/sandbox/git-credential` — sandbox-token authed. The in-sandbox
// git credential helper / `gh` shim POST `{host, owner?, repo?, purpose?}`;
// the route resolves the session's bound repo — or, for an unbound owner,
// org-level `auto` resolution — to a usable git credential.

export interface PostSandboxGitCredentialRequest {
  /** Git host from the credential request (e.g. `github.com`). For a bound
   * owner the resolvable host is derived from the binding's clone URL; for
   * the org-level fallback it selects the `RepoHost` directly. */
  host: string;
  /** Repository owner (org/user login) the credential is wanted for. A
   * session-bound owner (case-insensitive) resolves with its binding's auth
   * mode; an unbound or absent owner falls back to org-level `auto`
   * resolution (github.com only). The `gh` shim omits it when run outside
   * a repo. */
  owner?: string;
  /** Repository name (no `owner/` prefix, `.git` stripped). Optional — when
   * present it disambiguates two same-owner bindings that carry different
   * `auth`; when absent or unmatched the route falls back to the first owner
   * match. */
  repo?: string;
  /** Resolution ladder: `"git"` (default; installation-first) for clone and
   * push, `"api"` (user-first, sole-installation fallback) for the `gh`
   * shim's REST/GraphQL calls. Anything else is treated as `"git"`. */
  purpose?: "git" | "api";
}

/** A usable git credential — `password` is the token, `username` its paired
 * Basic-Auth username (`x-access-token` for GitHub). Emitted only over the
 * response body, never logged. */
export interface SandboxGitCredential {
  username: string;
  password: string;
}

/** No credential applies but the request is valid — the helper proceeds
 * tokenless (a public clone works; a private one surfaces the host's own
 * auth error downstream). */
export interface SandboxGitAnonymous {
  anonymous: true;
}

export type PostSandboxGitCredentialResponse = SandboxGitCredential | SandboxGitAnonymous;

// ── REST: sandbox image sources + bakes (sandbox-reconciliation plan, Task 17) ──
//
// `/api/org/sources` — org-admin CRUD for all image source kinds
// (external/base/repo) and their bake history. Replaces the split
// `/api/org/image-catalog` + `/api/org/prebuilds/*` surfaces.
// `/api/sources/for-repo` is the one member-accessible (non-admin-gated)
// read — deliberately narrow (see `GetPrebuildForRepoResponse`).
//
// SourceSummary mirrors the `image_sources` row; BakeSummary mirrors `bakes`.
// The legacy types below (ImageCatalogEntryWire, PrebuildConfigWire, etc.)
// are kept while web components migrate in Task 18.

// ── New unified types (/api/org/sources) ────────────────────────────────────

/** Mirrors the `image_sources` row for all kinds (external/base/repo). */
export interface SourceSummary {
  id: string;
  orgId: string;
  kind: "external" | "base" | "repo";
  parentId: string | null;
  name: string;
  externalRef: string | null;
  pullSecretName: string | null;
  setupCommands: string[] | null;
  repoHost: string | null;
  repoFullName: string | null;
  cloneUrl: string | null;
  schedule: "nightly" | "off";
  enabled: boolean;
  lastBoundAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Mirrors the `bakes` row. */
export interface BakeSummary {
  id: string;
  sourceId: string;
  identityHash: string;
  commitSha: string | null;
  imageRef: string;
  status: "queued" | "building" | "pushed" | "failed";
  builderBackend: string | null;
  error: string | null;
  logTail: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
}

export interface ListSourcesResponse {
  sources: SourceSummary[];
  builderAvailable: boolean;
}

export interface CreateSourceResponse {
  source: SourceSummary;
}

export interface PatchSourceResponse {
  source: SourceSummary;
}

export interface ListBakesResponse {
  bakes: BakeSummary[];
}

export interface TriggerBakeResponse {
  bake: BakeSummary;
}

// ── Legacy types kept for web-component backward compatibility (Task 18 migrates) ──

// `image_sources` row (kind='external') — replaces the old image_catalog
// entry. `externalRef` is the image URI that was previously `ref`.
export interface ImageCatalogEntryWire {
  id: string;
  orgId: string;
  kind: "external";
  name: string;
  externalRef: string | null;
  pullSecretName: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ListImageCatalogResponse {
  images: ImageCatalogEntryWire[];
}

export interface CreateImageCatalogRequest {
  name: string;
  ref: string;
  pullSecretName?: string;
}

export interface CreateImageCatalogResponse {
  image: ImageCatalogEntryWire;
}

export type PrebuildScheduleWire = "nightly" | "off";

// `image_sources` row (kind='repo') — replaces the old prebuild_configs entry.
// `parentId` is the linked base/external source id (previously `baseImageId`).
export interface PrebuildConfigWire {
  id: string;
  orgId: string;
  kind: "repo";
  parentId: string | null;
  name: string;
  repoHost: string | null;
  repoFullName: string | null;
  cloneUrl: string | null;
  schedule: PrebuildScheduleWire;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ListPrebuildConfigsResponse {
  configs: PrebuildConfigWire[];
}

export interface CreatePrebuildConfigRequest {
  repoFullName: string;
  cloneUrl: string;
  repoHost?: string;
  /** Linked base/external source id. Previously `baseImageId`. */
  baseImageId?: string | null;
  schedule?: PrebuildScheduleWire;
  enabled?: boolean;
}

export interface CreatePrebuildConfigResponse {
  config: PrebuildConfigWire;
}

export interface PatchPrebuildConfigRequest {
  cloneUrl?: string;
  /** Linked base/external source id. Previously `baseImageId`. */
  baseImageId?: string | null;
  schedule?: PrebuildScheduleWire;
  enabled?: boolean;
}

export interface PatchPrebuildConfigResponse {
  config: PrebuildConfigWire;
}

export type PrebuildStatusWire = "queued" | "building" | "pushed" | "failed";

// `bakes` row — replaces the old prebuilds entry.
// `sourceId` is the linked image_sources id (previously `configId`).
export interface PrebuildWire {
  id: string;
  sourceId: string;
  identityHash: string;
  commitSha: string | null;
  imageRef: string;
  status: PrebuildStatusWire;
  builderBackend: string | null;
  error: string | null;
  logTail: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
}

export interface RebuildPrebuildResponse {
  prebuild: PrebuildWire;
}

export interface ListPrebuildBuildsResponse {
  builds: PrebuildWire[];
}

export interface GetPrebuildsMetaResponse {
  /** `null` when no `ImageBuilder` is wired for this deployment — the
   * settings page shows the "unavailable on this deployment" banner but
   * keeps the image catalog usable regardless. */
  builder: string | null;
}

/** `GET /api/prebuilds/for-repo?fullName=owner/repo` — any authed org
 * member. The newest `pushed` build for the caller's org + repo, or
 * `null`. Deliberately narrow (no `imageRef`/`error`/`logTail`) — this is
 * the one prebuild read a non-admin member can hit. */
export interface GetPrebuildForRepoResponse {
  prebuild: { commitSha: string; finishedAt: number } | null;
}

// ── REST: events + subscriptions (event-system plan, Task 7) ─────────────
//
// `/api/events*` (catalog + org-scoped feed) and `/api/event-subscriptions`
// (CRUD) — see `routes/events.ts`. Subscription bodies are validated against
// the merged plugin catalog before any row is written.

/** Mirrors the engine's `EventCatalogEntry` for the catalog endpoint. */
export interface EventCatalogEntryWire {
  key: string;
  description: string;
  filters: { field: string; path: string; description: string }[];
}

export interface GetEventCatalogResponse {
  services: { service: string; entries: EventCatalogEntryWire[] }[];
}

/** Mirrors `events/match.ts`'s `SubscriptionFilter`. */
export interface EventSubscriptionFilterWire {
  field: string;
  op: "eq" | "in" | "prefix" | "contains";
  value: string | string[];
}

// `{ kind: "signal" }` (wake parked workflow runs) is intentionally absent:
// no workflow node parks on the event-signal shape yet, so the CRUD
// validator rejects it — see routes/events.ts TARGET_KINDS.
export type EventSubscriptionTargetWire =
  | { kind: "workflow"; workflowId: string }
  | { kind: "orchestrator"; orchestrator?: "user" | "org" };

export interface EventSubscriptionWire {
  id: string;
  name: string;
  ownerType: "user" | "org";
  ownerId: string;
  eventKeys: string[];
  filters: EventSubscriptionFilterWire[];
  target: EventSubscriptionTargetWire;
  enabled: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

// ─── Action policies (action-policies plan, Task 4) ─────────────────────────
//
// `/api/org/policies` (admin CRUD + action log), `/api/me/policy-overrides`,
// `/api/me/grants`. See `packages/api/src/policies/resolution.ts` for the
// precedence semantics these rows feed and `packages/api/src/policies/
// admin.ts` for the CRUD/pagination service layer backing these routes.

export type RiskLevelWire = "low" | "medium" | "high" | "critical";
export type ApprovalModeWire = "allow" | "require_approval" | "deny";
export type PolicyAppliesInWire = "any" | "workflow" | "session";

export interface ParamMatcherWire {
  path: string;
  op: "eq" | "neq" | "regex" | "in" | "not_in" | "gt" | "gte" | "lt" | "lte" | "exists" | "not_exists";
  value?: unknown;
}

export interface ActionPolicyWire {
  id: string;
  service: string | null;
  actionId: string | null;
  riskLevel: RiskLevelWire | null;
  mode: ApprovalModeWire;
  paramMatchers: ParamMatcherWire[];
  appliesIn: PolicyAppliesInWire;
  origin: "settings" | "approval_prompt" | "workflow_editor" | "admin";
  managedBy: string | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateEventSubscriptionRequest {
  name: string;
  eventKeys: string[];
  filters?: EventSubscriptionFilterWire[];
  target: EventSubscriptionTargetWire;
  enabled?: boolean;
}

export type CreateEventSubscriptionResponse = EventSubscriptionWire;

export interface ListEventSubscriptionsResponse {
  subscriptions: EventSubscriptionWire[];
}

export interface PatchEventSubscriptionRequest {
  name?: string;
  eventKeys?: string[];
  filters?: EventSubscriptionFilterWire[];
  enabled?: boolean;
}

export type PatchEventSubscriptionResponse = EventSubscriptionWire;

/** Feed item — payload deliberately excluded (fetch `/api/events/:id`). */
export interface EventSummaryWire {
  id: string;
  service: string;
  eventKey: string;
  summary: string;
  refs: Record<string, string>;
  actor: { externalId: string; login?: string } | null;
  occurredAt: number;
  receivedAt: number;
}

export interface ListEventsResponse {
  events: EventSummaryWire[];
}

export interface EventDeliveryWire {
  id: string;
  subscriptionId: string;
  status: "pending" | "delivered" | "failed" | "dead";
  attempts: number;
  lastError: string | null;
  deliveredAt: number | null;
}

export interface GetEventResponse {
  event: EventSummaryWire & { payload: unknown };
  deliveries: EventDeliveryWire[];
}

// ── REST: health (single-binary CLI, portable-runtime plan) ──────────────
//
// `GET /api/health` — public, unauthenticated. The API currently answers
// `{ ok, service, ts }`; `version` is optional here so a future build that
// stamps the running binary version (single-binary plan Task 6) is a
// non-breaking addition. Append-only: existing consumers ignore it.

export interface HealthResponse {
  ok: boolean;
  service: string;
  ts: number;
  version?: string;
  /** Resolved sandbox backend (`docker` | `local` | `kubernetes`) the server
   * is running. Append-only; existing consumers ignore it. */
  sandboxBackend?: string;
}

// ── REST: slash commands (slash-commands plan, Task 10) ──────────────────
//
// `GET /api/sessions/:id/commands` — the merged command registry for a
// session: built-ins, skills, user + repo templates, and plugin commands, plus
// any registry diagnostics (name collisions, shadowed entries). `CommandInfo`
// and `RegistryDiagnostic` are the engine's own registry shapes, forwarded
// as-is.

/** One enumerable completion for a command's first argument. */
export interface CommandArgOption {
  /** The literal text to insert (e.g. a model id). */
  value: string;
  /** Human-readable label shown beside the value (e.g. a model's display name). */
  label?: string;
}

/**
 * Engine `CommandInfo` plus wire-only argument completions. The registry
 * itself is sync and cannot enumerate async sources (model ids need a DB +
 * credential read), so the route attaches `argOptions` for the commands it
 * knows how to enumerate.
 */
export type WireCommandInfo = CommandInfo & { argOptions?: CommandArgOption[] };

export interface ListCommandsResponse {
  commands: WireCommandInfo[];
  diagnostics: RegistryDiagnostic[];
}

export interface ListOrgPoliciesResponse {
  policies: ActionPolicyWire[];
}

/** Exactly one of `service`/`actionId`/`riskLevel` — matches the DB CHECK
 *  constraint; the route 400s otherwise. */
export interface CreateOrgPolicyRequest {
  service?: string;
  actionId?: string;
  riskLevel?: RiskLevelWire;
  mode: ApprovalModeWire;
  paramMatchers?: ParamMatcherWire[];
  appliesIn?: PolicyAppliesInWire;
  expiresAt?: number | null;
}

export type CreateOrgPolicyResponse = ActionPolicyWire;

/** Rule fields only — `service`/`actionId`/`riskLevel` (the row's target
 *  identity) are immutable after creation; re-target by deleting and
 *  recreating. */
export interface PatchOrgPolicyRequest {
  mode?: ApprovalModeWire;
  paramMatchers?: ParamMatcherWire[];
  appliesIn?: PolicyAppliesInWire;
  expiresAt?: number | null;
}

export type PatchOrgPolicyResponse = ActionPolicyWire;

/** DELETE soft-revokes (stamps `revokedAt`) rather than row-deleting; the
 *  response echoes the now-revoked row. */
export type DeleteOrgPolicyResponse = ActionPolicyWire;

/** POST /api/org/policies/preview — dry-run the resolver against a
 *  synthetic invocation, without writing anything. Admin-only, same gate as
 *  the rest of `/api/org/policies`. */
export interface PreviewOrgPolicyRequest {
  service: string;
  actionId: string;
  riskLevel: RiskLevelWire;
  params?: Record<string, unknown>;
  appliesIn: "session" | "workflow";
  sessionId?: string;
  workflowExecutionId?: string;
  /** Whose per-user overrides to fold into the preview. An admin may preview
   *  another member's effective resolution by passing that member's id here;
   *  the `orgId` is ALWAYS forced to the calling admin's own org (never taken
   *  from the request), so this can only ever reveal resolution within the
   *  caller's org, never cross-org. Omit to preview with no override layer. */
  userId?: string;
}

export interface PreviewOrgPolicyResponse {
  mode: ApprovalModeWire;
  provenance: {
    baseMode: ApprovalModeWire;
    matchedPolicyId?: string;
    matchedGrantId?: string;
    matchedOverrideId?: string;
    source: string;
  };
}

export type ActionInvocationStatusWire = "allowed" | "denied" | "approved" | "rejected" | "error" | "completed";

export interface ActionLogEntryWire {
  invocationId: string;
  createdAt: number;
  service: string | null;
  actionId: string | null;
  riskLevel: RiskLevelWire | null;
  /** The policy DECISION for this invocation — key audit/action-log
   *  consumers on this, not `status` (execution outcome). */
  resolvedMode: ApprovalModeWire | null;
  baseMode: ApprovalModeWire | null;
  matchedPolicyId: string | null;
  matchedGrantId: string | null;
  matchedOverrideId: string | null;
  status: ActionInvocationStatusWire | null;
  sessionId: string | null;
  workflowExecutionId: string | null;
  userId: string | null;
  params: unknown;
  paramsTruncated: boolean | null;
  result: unknown;
  resultTruncated: boolean | null;
  error: string | null;
  durationMs: number | null;
  startedAt: number | null;
}

/** Keyset-paginated — `cursor` is opaque (base64url of `{s, id}`, see
 *  `policies/admin.ts`'s `ActionLogCursor`). `nextCursor` is `null` at the
 *  end of the result set. */
export interface ListActionLogResponse {
  entries: ActionLogEntryWire[];
  nextCursor: string | null;
}

export interface ActionPolicyOverrideWire {
  id: string;
  service: string | null;
  actionId: string | null;
  riskLevel: RiskLevelWire | null;
  mode: ApprovalModeWire;
  paramMatchers: ParamMatcherWire[];
  createdAt: number;
  updatedAt: number;
}

export interface ListPolicyOverridesResponse {
  overrides: ActionPolicyOverrideWire[];
}

/** PUT /api/me/policy-overrides — upsert-BY-TARGET, not by row id: the
 *  caller has at most one override per (service|actionId|riskLevel) target,
 *  so the target triple IS the addressing key. A second PUT for the same
 *  target updates the existing row in place. A `mode: "allow"` write is
 *  bounds-checked against org policy (`validateOverrideBounds`,
 *  `policies/admin.ts`) before it's accepted — an `actionId` not found in
 *  the plugin catalog fails CLOSED (400), which also covers an action only
 *  reachable via a plugin's dynamic `resolveActions` seam (intentional, safe
 *  direction — not a gap). */
export interface PutPolicyOverrideRequest {
  service?: string;
  actionId?: string;
  riskLevel?: RiskLevelWire;
  mode: ApprovalModeWire;
  paramMatchers?: ParamMatcherWire[];
}

export type PutPolicyOverrideResponse = ActionPolicyOverrideWire;

/** DELETE /api/me/policy-overrides — same target-addressing as PUT; the
 *  target triple goes in the request body (DELETE-with-body, since there's
 *  no per-row id in the URL to delete by). */
export interface DeletePolicyOverrideRequest {
  service?: string;
  actionId?: string;
  riskLevel?: RiskLevelWire;
}

export interface DeletePolicyOverrideResponse {
  ok: true;
}

export interface RuntimeGrantWire {
  id: string;
  sessionId: string | null;
  workflowExecutionId: string | null;
  policyKey: string;
  grantedBy: string;
  createdAt: number;
}

export interface ListGrantsResponse {
  grants: RuntimeGrantWire[];
}

/** DELETE /api/me/grants — revokes (stamps `revokedAt`, never row-deletes)
 *  the caller's own live grant matching this exact scope + policy key. */
export interface DeleteGrantRequest {
  sessionId?: string;
  workflowExecutionId?: string;
  service: string;
  actionId: string;
}

export interface DeleteGrantResponse {
  ok: true;
}
