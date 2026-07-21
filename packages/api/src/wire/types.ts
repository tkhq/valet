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
  /** ID for client-side optimistic placeholder; the actual user-message row created server-side. */
  messageId: string;
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
}

export interface CreateWorkflowRequest {
  name: string;
  definition: unknown;
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
}

export interface ResolveWorkflowApprovalResponse {
  ok: true;
}

export interface CancelWorkflowRunResponse {
  ok: true;
}

export interface GetMemoryTreeResponse {
  entries: MemoryTreeEntry[];
}

// ── REST: plugins + credentials (plugin-system-v2 plan Task 15) ───────────

export type CredentialKind = "oauth2" | "api_key" | "bot_token" | "service_account";

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

export type LlmProviderKindWire = "anthropic" | "openai" | "google" | "openai_compatible";

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
}

/** GitHub's app-manifest schema (https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) — only the fields this flow sets. */
export interface GithubAppManifestWire {
  name: string;
  url: string;
  redirect_url: string;
  hook_attributes: { url: string; active?: boolean };
  public: boolean;
  default_events: string[];
  permissions: Record<string, string>;
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
// git credential helper / `valet-gh` wrapper POST `{host, owner, repo}`; the
// route resolves the session's bound repo to a usable git credential.

export interface PostSandboxGitCredentialRequest {
  /** Git host from the credential request (e.g. `github.com`). Informational
   * — the resolvable host is derived from the matched binding's clone URL. */
  host: string;
  /** Repository owner (org/user login) the credential is wanted for. Must be
   * one of the session's bound owners (case-insensitive) or the request 403s. */
  owner: string;
  /** Repository name (no `owner/` prefix, `.git` stripped). Optional — when
   * present it disambiguates two same-owner bindings that carry different
   * `auth`; when absent or unmatched the route falls back to the first owner
   * match. */
  repo?: string;
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

// ── REST: sandbox image prebuilds (sandbox images v2 plan, Task 6) ───────
//
// `/api/org/image-catalog` + `/api/org/prebuilds/*` — org-admin CRUD, see
// `routes/image-catalog.ts` / `routes/prebuilds.ts`. Row shapes are
// returned verbatim (no secret material lives on either table) so these
// wire types mirror the Drizzle row types 1:1. `/api/prebuilds/for-repo` is
// the one member-accessible (non-admin-gated) read in this group — its
// response is deliberately narrow (see `GetPrebuildForRepoResponse`).

export interface ImageCatalogEntryWire {
  id: string;
  orgId: string;
  name: string;
  ref: string;
  pullSecretName: string | null;
  kind: "base";
  createdAt: number;
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

export interface PrebuildConfigWire {
  id: string;
  orgId: string;
  repoHost: string;
  repoFullName: string;
  cloneUrl: string;
  baseImageId: string | null;
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
  baseImageId?: string | null;
  schedule?: PrebuildScheduleWire;
  enabled?: boolean;
}

export interface CreatePrebuildConfigResponse {
  config: PrebuildConfigWire;
}

export interface PatchPrebuildConfigRequest {
  cloneUrl?: string;
  baseImageId?: string | null;
  schedule?: PrebuildScheduleWire;
  enabled?: boolean;
}

export interface PatchPrebuildConfigResponse {
  config: PrebuildConfigWire;
}

export type PrebuildStatusWire = "queued" | "building" | "pushed" | "failed";

export interface PrebuildWire {
  id: string;
  configId: string;
  commitSha: string;
  imageRef: string;
  status: PrebuildStatusWire;
  builderBackend: string;
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

export type EventSubscriptionTargetWire =
  | { kind: "workflow"; workflowId: string }
  | { kind: "orchestrator"; orchestrator?: "user" | "org" }
  | { kind: "signal" };

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
