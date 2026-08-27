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

/**
 * What a session is DOING right now. `SessionStatus` is the lifecycle of the
 * row; this is the run state the Sessions surface reads at a glance.
 *
 * Exactly one value applies. When several are true at once, the highest of
 * this order wins:
 *
 *   1. `needs_you` — a decision gate is pending. The session is blocked on a
 *      person and stays blocked until somebody answers.
 *   2. `working`   — a submission is in flight (queued, collecting, or running).
 *   3. `failed`    — the last turn settled with an error.
 *   4. `sleeping`  — the row status is `hibernated`.
 *   5. `idle`      — nothing is queued and nothing needs a person.
 *
 * See `sessions/run-state.ts` for the derivation and for which signals the
 * server can read without a per-session query.
 */
export type SessionRunState = "needs_you" | "working" | "failed" | "sleeping" | "idle";

export interface SessionSummary {
  id: string;
  workspace: string;
  status: SessionStatus;
  /** What the session is doing. See `SessionRunState` for the precedence. */
  runState: SessionRunState;
  title?: string;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms of the last event in this session: the later of the row's
   * `updatedAt` and the newest unsettled submission's `updatedAt`. Queue
   * work does not touch the session row, so `updatedAt` alone reads stale
   * during a long turn. */
  lastActivityAt: number;
  /** Who the session belongs to. Present so a list can be read per
   * workspace and a row can name its owner — without it the client cannot
   * tell a personal session from a team's, and every session looked
   * personal because that is all one could create. */
  owner: AssistantOwner;
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
  /** Request a rootless docker daemon inside this session's sandbox
   * (docker-in-sandbox). See docs/specs/2026-08-15-sandbox-docker-design.md. */
  docker: boolean;
  /** Repos bound to this session, in position order. Omitted when unbound. */
  repos?: RepoBinding[];
}

export interface CreateSessionRequest {
  workspace: string;
  title?: string;
  /** Create as a team-owned session instead of personal. Caller must be a
   * current member of the team; a non-member or unknown id 404s, same as
   * any other cross-owner access. Mirrors `CreateWorkflowRequest.teamId` —
   * one spelling for "make this the team's, not mine". */
  teamId?: string;
  /** Optional first user prompt; if set, server enqueues immediately after creation. */
  initialPrompt?: string;
  /** Defaults to "headless" server-side when omitted. */
  profile?: SandboxProfile;
  /** Request a rootless docker daemon inside this session's sandbox
   * (docker-in-sandbox). Defaults to false. */
  docker?: boolean;
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

/** GET /api/orchestrator — probes without creating. `sessionId` is null
 * while the caller has no default assistant: an assistant addresses its
 * session by its own id, so a caller that owns none has no id to report. */
export interface GetOrchestratorResponse {
  sessionId: string | null;
  exists: boolean;
}

export type OrchestratorPresence = "idle" | "thinking" | "working";

// ── REST: assistants ──────────────────────────────────────────────────────
//
// An assistant is a named agent a principal owns, with its own session. A
// principal — you, or a team — owns any number. See
// `docs/specs/2026-08-13-assistants-design.md`.

/** Who owns an assistant. The owner is its scope, not its identity: two
 * assistants owned by the same team are different assistants. */
export interface AssistantOwner {
  type: "user" | "team" | "org";
  id: string;
}

export interface AssistantSummary {
  id: string;
  owner: AssistantOwner;
  /** Absent until someone names it. The UI shows a placeholder rather than
   * inventing a name the user never chose. */
  name?: string;
  /** `assistant:{id}` — every assistant, default included. Carried here so
   * listing assistants is also how the client learns their session ids, and
   * opening one still creates nothing until the conversation starts. */
  sessionId: string;
  /** The one machine-driven paths use when nobody chose: workflow
   * orchestrator nodes, event subscriptions, channel bindings. Exactly one
   * per owner. */
  isDefault: boolean;
  createdAt: number;
}

export interface ListAssistantsResponse {
  assistants: AssistantSummary[];
}

/** `POST /api/assistants`. Omit `owner` for one of your own. Creating a
 * team's assistant follows the same rule as administering one. */
export interface CreateAssistantRequest {
  name?: string;
  owner?: AssistantOwner;
}

export type CreateAssistantResponse = AssistantSummary;

/** `PATCH /api/assistants/:id`. `isDefault: true` promotes this one and
 * demotes the previous default in the same write — a principal is never
 * left with none, which would strand every automation that targets it. */
export interface PatchAssistantRequest {
  name?: string;
  isDefault?: true;
}

export type PatchAssistantResponse = AssistantSummary;

/** `POST /api/assistants/:id/session` — get-or-create this assistant's
 * session. Creating an assistant writes no session, so the client calls this
 * before opening the conversation. Idempotent. */
export interface EnsureAssistantSessionResponse {
  sessionId: string;
}

/** GET /api/orchestrator/info — assistant identity + presence (assistant-
 * centered web UI decision 4). Never creates the engine session. */
export interface GetOrchestratorInfoResponse {
  sessionId: string;
  name: string | null;
  personality: string | null;
  presence: OrchestratorPresence;
  activeChildren: number;
}

/** PATCH /api/orchestrator/info — `name` sets `assistants.name` on the
 * caller's default assistant; `personality` writes the
 * `assistant/personality.md` memory file (decision 5). */
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
  /** Set when the thread is archived (display state; history is intact). */
  archivedAt?: number;
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
 * Patch a thread's settings. Pass `model: null` to clear the override and
 * fall back to the session default. `archived` toggles app-side display
 * state — an archived thread leaves the default GET /threads list.
 */
export interface PatchThreadRequest {
  model?: string | null;
  archived?: boolean;
}

export type PatchThreadResponse = ThreadSummary;

/**
 * Patch a session's settings. Send one field or both.
 *
 * `model` is the session default that threads inherit when they have no
 * override. `title` is the session name shown in the header and the lists;
 * a person sets it to correct what the auto-titler chose. A body with
 * neither field is rejected.
 */
export interface PatchSessionRequest {
  model?: string;
  /** New session name. Trimmed server-side. Must not be empty. */
  title?: string;
  /**
   * Move the session to a team (a team id) or to your own workspace
   * (`null`). Omitted means no change. The caller must administer the
   * session; a team move also requires current membership of the target
   * team — a non-member or unknown id 404s, the same existence-hiding
   * `CreateSessionRequest.teamId` applies. Refused while a turn is running:
   * the engine binds skills and credential context to the owner at build.
   */
  teamId?: string | null;
  /**
   * Raise the session to `"full"` to run the terminal and the VS Code
   * server in its sandbox, or drop it back to `"headless"`.
   *
   * The profile is baked into the sandbox at create time (the container
   * command and, on kubernetes, the Service), so a change recreates the
   * sandbox. The workspace survives; an open terminal does not. The request
   * is refused while a turn is unsettled.
   */
  profile?: SandboxProfile;
}

export type PatchSessionResponse = SessionDetail;

// ── REST: messages ────────────────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "tool" | "system";

/**
 * Discriminated union for message parts. Mirrors the engine's MessagePart
 * one-to-one for `text`, `tool_call`, and `thinking` so the bridge is
 * mechanical. `attachment` and `error` parts from the engine are still
 * dropped on the wire (the UI doesn't render them in the agent loop).
 */
export type MessagePart =
  | { kind: "text"; text: string }
  | {
      kind: "tool_call";
      callId: string;
      toolName: string;
      /**
       * `streaming` is a live-plane-only state: the client synthesizes it
       * from `tool_call_update` frames while args are still being generated.
       * The engine never persists it, so REST (`GET /messages`) and
       * `message_update` frames only ever carry the other three.
       */
      status: "streaming" | "running" | "completed" | "error";
      args?: unknown;
      result?: unknown;
      error?: string;
    }
  | { kind: "thinking"; text: string };

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
  /**
   * Image attachments on a user message. Populated for user entries with
   * attached images; never on assistant, tool, or system entries. The
   * engine's `MessageEntry.attachments` is the source of truth; this is
   * the wire projection.
   */
  attachments?: PromptImageAttachment[];
}

export interface ListMessagesResponse {
  messages: Message[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface PromptImageAttachment {
  kind: "image";
  /** `data:<mime>;base64,<payload>`. */
  url: string;
  mimeType: string;
  name: string;
}

export interface SendPromptRequest {
  text: string;
  /** Target thread id. If omitted, server uses the session's default thread. */
  threadId?: string;
  /** Image attachments for the message. */
  attachments?: PromptImageAttachment[];
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
      /**
       * Live-only tool-call argument streaming (ephemeral, no offset).
       * `argsDelta` is a raw chunk of the args JSON; concatenate per callId
       * and parse leniently. `tool_start` later carries the complete args
       * and self-heals any dropped delta.
       */
      seq: number;
      ts: number; offset?: string;
      type: "tool_call_update";
      threadId: string;
      callId: string;
      toolName: string;
      argsDelta: string;
    }
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

/**
 * Where a team came from. `local` teams are created in Valet and Valet owns
 * them. `idp` teams mirror an identity-provider group: the client shows them
 * as read-only, and the API refuses to mutate them.
 *
 * A `config` team is declared in `valet.yaml`. It sits between the two: the
 * file asserts its declared members at every boot but never removes anybody,
 * so the client keeps the member controls and warns that a boot puts the
 * declared members back. Delete is refused, because the next boot would
 * recreate the team empty.
 */
export type TeamOrigin = "local" | "config" | "idp";

export interface TeamSummary {
  id: string;
  orgId: string;
  name: string;
  origin: TeamOrigin;
  /**
   * The identity-provider group path this team mirrors, e.g. `/platform`.
   * Null for a `local` and for a `config` team. The client shows it, so a
   * reader knows which group to change.
   */
  externalId: string | null;
  createdAt: number;
  memberCount: number;
  /** The caller's role on this team; null when the caller is not a member
   * (org admins see every team in the org). The UI gates admin-only
   * controls on this plus the caller's org role. */
  callerRole: "admin" | "member" | null;
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
// Owner-scoped exactly like sessions (decision 18): the list returns the
// caller's own rows plus their teams', `?ownerType=&ownerId=` narrows it to
// one owner, and an owner the caller cannot reach 404s.

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

/**
 * `GET /api/workflows/import/repo-file` — one file out of a PUBLIC GitHub
 * repository, so the import dialog can read a definition that lives in
 * version control.
 *
 * The body is returned as text, not as a parsed definition, because the
 * import client already owns the parser it applies to a pasted file. One
 * parser reads both sources, so the two cannot accept different shapes.
 */
export interface GetWorkflowImportFileResponse {
  /** `owner/repo`, as resolved from what the caller typed. */
  repo: string;
  path: string;
  /** The ref that was read. Empty means the repository default branch. */
  ref: string;
  /** The file, decoded as UTF-8 text. */
  content: string;
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
  /** True when the run is parked waiting for at least one human approval. */
  needsApproval?: boolean;
  /**
   * Set only while the run is parked: what it is blocked on, so a run list
   * shows the gate (node + signal/timer) without a per-run detail fetch.
   * Same conditions `GetWorkflowRunResponse.run.waitingOn` carries.
   */
  waitingOn?: Array<{ kind: string; nodeId: string; signalType?: string; wakeAt?: number }>;
  // Set when a `workflow` node in another run started this one (batch
  // fan-out): the parent run, the node that called it, and which foreach
  // item it belongs to. Absent on a top-level run.
  parentRunId?: string;
  parentNodeId?: string;
  parentIteration?: number;
}

export interface ListWorkflowRunsResponse {
  runs: WorkflowRunSummary[];
  /** Pass back as `cursor` for the next page. Absent on the last page. */
  nextCursor?: string;
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
  /** The session a session/orchestrator node drove. Present on a failed
   * node too — that is where the failure is readable. */
  sessionId?: string;
  /** The run a `workflow` node started. */
  childRunId?: string;
  /**
   * The thread a `session` or `orchestrator` node submitted to. Present
   * only for those node kinds. `/chat` and `/sessions/:id` both take a
   * `thread` search param, so this is what makes a run link back to the
   * exact conversation it started rather than the newest one.
   */
  threadId?: string;
}

/** One pending approval gate on a parked workflow run. */
export interface WorkflowPendingGate {
  nodeId: string;
  kind: "approval" | "policy_gate";
  iteration?: number;
  /** Approval nodes: the human-readable prompt from the definition. */
  prompt?: string;
  /** Policy gates: the service that owns the action. */
  service?: string;
  /** Policy gates: the action identifier. */
  action?: string;
  riskLevel?: string;
  provenance?: string;
  gateParams?: unknown;
  gateParamsTruncated?: boolean;
  gateItem?: unknown;
  timeoutAt?: number;
  onDeny?: "fail" | "skip";
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
  pendingGates: WorkflowPendingGate[];
}

export type GetWorkflowRunResponse = WorkflowRunDetail;

export interface ResolveWorkflowApprovalRequest {
  approved: boolean;
  note?: string;
  /** Approve scope (policy gates): 'once' (default) authorizes only this
   * invocation; 'run' writes a run-scoped grant for the gated action;
   * 'always' (org admin only) writes a durable org allow policy. Ignored on
   * approval-node gates and on denials. */
  scope?: "once" | "run" | "always";
  /** Foreach-iteration disambiguation; omit or 0 for top-level nodes. */
  iteration?: number;
}

export interface ResolveWorkflowApprovalResponse {
  ok: true;
}

export interface CancelWorkflowRunResponse {
  ok: true;
}

export interface RetryWorkflowRunResponse {
  runId: string;
}

// ── Workflow permissions preview ──────────────────────────────────────────
//
// `GET /api/workflows/:id/permissions` predicts, per tool node in the STORED
// definition, how the policy ladder would resolve the node's action for the
// calling user if a run started now. The prediction runs the same
// `resolveActionPolicy` core as the run-time invoker, with `appliesIn:
// "workflow"` and no execution id (a run that has not started has no
// exec-scoped grants). It is advisory: org policies with param matchers
// evaluate against the node's static params, so a template value (`{{ ... }}`)
// can flip a matcher at run time.
//
// Approval nodes are deliberately absent — an author-placed approval node is
// an intended gate, not a permission requirement.

export interface WorkflowNodePermissionWire {
  nodeId: string;
  service: string;
  action: string;
  /** The fully-qualified policy actionId (`service.action`). Null when the
   * action is not in the static plugin catalog (for example a dynamic MCP
   * action), which also makes the prediction `unknown`. */
  actionId: string | null;
  riskLevel?: string;
  /** Predicted resolution for the calling user. `unknown` when the action
   * is not in the static catalog. */
  mode: "allow" | "require_approval" | "deny" | "unknown";
  /** `PolicyProvenanceSource` of the prediction (org_policy, override,
   * plugin_default, risk_default, ...). Absent when `mode` is `unknown`. */
  provenance?: string;
}

export interface GetWorkflowPermissionsResponse {
  nodes: WorkflowNodePermissionWire[];
}

export interface AllowWorkflowPermissionsRequest {
  /** Qualified actionIds to pre-approve. Each must be one of the workflow's
   * gating actions (mode `require_approval`). Omit to pre-approve all of
   * them. The server re-derives the gating set from the stored definition —
   * the client cannot mint an override for an unrelated action here. */
  actionIds?: string[];
}

export interface AllowWorkflowPermissionsResponse {
  /** Qualified actionIds now covered by a per-user allow override. The
   * override applies to every run and session of this user, not only this
   * workflow. */
  allowed: string[];
  /** Gating actions an override cannot cover: the write-time bounds check
   * rejects an allow override that would bypass an org `deny` or
   * `require_approval` policy. Each carries the corrective reason. */
  blocked: { actionId: string; reason: string }[];
}

// ── Node preview (dry run) ────────────────────────────────────────────────
//
// `POST /api/workflows/:id/preview` resolves every `{{ ... }}` path in a
// definition against real data and reports what each node would receive. A
// template path that does not resolve renders as an empty value and the run
// still reports success, so a preview that only showed outputs would hide
// the failure it exists to find. Two rules keep it honest:
//
//   1. A node is either EXECUTED or DESCRIBED, never faked. Only pure node
//      types run (`trigger`, `set`, `if`, `stop`). Everything with a side
//      effect — a model call, an action, a session, a child run — is
//      described from its declared shape and never invoked.
//   2. Every value says where it came from: a real run, this preview's own
//      pure execution, or the sample input the caller typed.

export interface PreviewWorkflowRequest {
  /**
   * Preview an unsaved definition. Omit to preview the stored one. The
   * editor sends the definition in hand, which is the whole point: the
   * paths a person is fixing are not saved yet.
   */
  definition?: unknown;
  /** Sample trigger fields. They override the sample run's `trigger.data`. */
  input?: Record<string, unknown>;
  /**
   * Where node results come from. `last_run` (the default) reads the
   * newest run of this workflow; `none` previews against the sample input
   * alone, which is what a workflow that has never run has.
   */
  sample?: "last_run" | "none";
  /** Preview one node. Omit for every node in the definition. */
  nodeId?: string;
}

/**
 * `executed` — the node really ran and `output` is its real output.
 * `described` — nothing ran; `outputShape` says what a real run produces.
 */
export type PreviewFidelity = "executed" | "described";

/** One templated field on a node, and what it resolves to. */
export interface PreviewField {
  /** Dotted field path inside the node, e.g. `prompt` or `params.title`. */
  field: string;
  /** The template exactly as written. */
  source: string;
  /** What the template renders to against the sample data. */
  resolved: unknown;
  /** Paths in this field that did not resolve. Empty is the normal case. */
  unresolvedPaths: string[];
}

/** One `{{ ... }}` path that resolved to nothing. */
export interface PreviewUnresolvedPath {
  /** The path exactly as written, e.g. `nodes.draft.result.response`. */
  path: string;
  /** The node field the path was written in. */
  field: string;
  /** The longest leading part of `path` that does hold a value. */
  resolvedPrefix: string;
  /** Keys present at `resolvedPrefix`. This is the list to pick from. */
  availableKeys: string[];
  /** The finding in one line, ready to show. */
  message: string;
}

/**
 * Where the shape came from. `observed` is read off a real result in the
 * sample run and is therefore exact. `declared` comes from the node's own
 * `outputSchema`. `known` is the node type's documented result. `unknown`
 * means only the caller of the action can say.
 */
export type PreviewShapeOrigin = "observed" | "declared" | "known" | "unknown";

export interface PreviewOutputShape {
  origin: PreviewShapeOrigin;
  /** An example value of this shape. Absent when nothing is known. */
  example?: unknown;
  /** Paths a downstream node can read, e.g. `nodes.draft.result.text`. */
  paths: string[];
  /** What the reader must know about this shape. */
  note?: string;
}

export interface PreviewNode {
  nodeId: string;
  /** The node's `type` field, verbatim. */
  type: string;
  fidelity: PreviewFidelity;
  /** Why the node was described instead of executed. Absent when executed. */
  describedReason?: string;
  fields: PreviewField[];
  unresolved: PreviewUnresolvedPath[];
  /** The node's real output. Present only when `fidelity` is `executed`. */
  output?: unknown;
  outputShape: PreviewOutputShape;
  /** Facts that change what this node does, e.g. a foreach truncation. */
  warnings: string[];
  /** Set when the node could not be previewed at all, e.g. a broken template. */
  error?: string;
}

export interface PreviewSample {
  /** `last_run` when run data was found; `sample_only` when there was none. */
  kind: "last_run" | "sample_only";
  runId?: string;
  runCreatedAt?: number;
  /** Node ids whose values came from that run. */
  fromRun: string[];
  /** Node ids whose values this preview computed by executing a pure node. */
  fromPreview: string[];
  /** Trigger input that does not satisfy the declared `dataSchema`. */
  inputErrors: Array<{ field: string; message: string }>;
}

export interface PreviewWorkflowResponse {
  sample: PreviewSample;
  nodes: PreviewNode[];
}

// Arbitrary-URL webhook triggers (overhaul design decision 5). `hookId` is
// the bearer secret in `POST /api/hooks/workflows/:workflowId/:hookId` —
// minting/rotating returns it once; `GetWorkflowWebhookResponse` also
// returns it since the management surface is owner-scoped and re-showing
// the URL (not just "a hook exists") is the point of a status check.
export interface WorkflowWebhookResponse {
  workflowId: string;
  hookId: string;
  /** The full trigger URL, built server-side (see `workflowWebhookUrl`) —
   * the client renders it verbatim rather than reconstructing it, since
   * the public origin can differ from the browser's own origin. */
  url: string;
  createdAt: number;
  updatedAt: number;
}

export interface DeleteWorkflowWebhookResponse {
  deleted: boolean;
}

// Workflow schedules (cron triggers), nested under one workflow at
// `/api/workflows/:id/schedules`. `schedule-service.ts` also supports
// orchestrator-prompt schedules; this surface manages only the
// workflow-scoped kind, so `workflowId` is always set. The flat trigger
// surface below manages both kinds and is what the UI calls.
export interface WorkflowScheduleWire {
  scheduleId: string;
  workflowId: string;
  name: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  lastFiredAt: number | null;
  nextFireAt: number;
}

export interface ListWorkflowSchedulesResponse {
  schedules: WorkflowScheduleWire[];
}

/**
 * Body of `POST /api/workflows/:id/schedules`. The target discriminator that
 * the flat `CreateWorkflowScheduleRequest` carries is implied by the path
 * here, so this body omits it — hence the separate name.
 */
export interface CreateScheduleOnWorkflowRequest {
  name: string;
  /** 5-field cron expression (minute hour day-of-month month day-of-week). */
  cron: string;
  /** IANA timezone name; defaults to UTC. */
  timezone?: string;
  /** Run input passed to the workflow's trigger node on each fire. */
  input?: Record<string, unknown>;
}

export type CreateWorkflowScheduleResponse = WorkflowScheduleWire;

export interface DeleteWorkflowScheduleResponse {
  deleted: boolean;
}

// ── REST: workflow templates ─────────────────────────────────────────────
//
// A template is a workflow definition a plugin ships, plus the copy the
// gallery needs to explain it BEFORE it is installed. Install publishes a
// normal workflow owned by the caller, through the same create path every
// other definition takes, so an installed template is editable, runnable,
// and deletable like any other workflow.
//
// The summary is deliberately presentation-shaped: `steps`, `schedule`, and
// `requires` answer the three questions a person asks of a card — what does
// it do, when does it run, and what must I connect first.

/**
 * A service the template's tool nodes call, with the caller's connection
 * state. `connected: false` blocks install: a workflow tool node reads the
 * credential of the run's owner, so the first run would fail on a missing
 * token. A template that fails on its first run is worse than one the
 * gallery refuses to install.
 */
export interface WorkflowTemplateRequirement {
  /** Credential service key, matching `PluginServiceSummary.service`. */
  service: string;
  connected: boolean;
  /**
   * Set when the plugin resolves its actions at run time (an MCP-backed
   * service). The action NAMES this template calls are then unverifiable
   * when the definition is saved, and can still fail on the first run.
   */
  dynamic?: true;
  /**
   * Set when this deployment or organization has not configured the service
   * — the same "unconfigured" state `PluginServiceSummary.connect` reports,
   * from the same resolver (integration-availability design).
   *
   * `connected` is false for such a service and stays false: the
   * integrations page hides an unconfigured service, so there is no page
   * that would let the reader connect it. Without this field the gallery
   * offered "Connect Slack" and sent the reader to a page with no Slack on
   * it. With it, the card names the setup an admin has to do instead.
   */
  unconfigured?: true;
}

/**
 * One field the installer fills in. Derived server-side from the template's
 * trigger `dataSchema`: `hidden` entries are dropped, and `label` falls back
 * to the field name, so the gallery never shows a raw field id.
 */
export interface WorkflowTemplateInput {
  name: string;
  type: "string" | "number" | "boolean";
  label: string;
  placeholder?: string;
  description?: string;
  required: boolean;
  default?: string | number | boolean;
}

/** The cron a template arms at install. Null when it only runs on demand. */
export interface WorkflowTemplateSchedule {
  /** 5-field cron expression, as `workflow_schedules.cron` stores it. */
  cron: string;
  /** IANA timezone name. */
  timezone: string;
}

export interface WorkflowTemplateSummary {
  id: string;
  name: string;
  /** One sentence, in the words of the person who wants the outcome. */
  description: string;
  /** What the workflow does, one plain-language line per step. */
  steps: string[];
  schedule: WorkflowTemplateSchedule | null;
  requires: WorkflowTemplateRequirement[];
  inputs: WorkflowTemplateInput[];
  /**
   * Limits the installer must know BEFORE installing — a step whose action
   * name resolves only at run time, an action an org policy can gate into a
   * parked run, a batch-size cap. Shown in the install dialog.
   */
  caveats: string[];
}

export interface ListWorkflowTemplatesResponse {
  templates: WorkflowTemplateSummary[];
}

export interface InstallWorkflowTemplateRequest {
  /**
   * Values for `WorkflowTemplateSummary.inputs`, written into the installed
   * definition. A scheduled run applies no `dataSchema` defaults, so a
   * parameter the schedule needs is baked in here rather than read from the
   * trigger at run time.
   */
  inputs?: Record<string, unknown>;
  /**
   * Install into a team workspace instead of the caller's own, exactly as
   * `CreateWorkflowRequest.teamId` does. The caller must be a current
   * member; a non-member or an unknown id is not found.
   *
   * A team install is refused for a SCHEDULED template that calls any tool
   * action: a scheduled run acts as the workflow's owner, and a team owner
   * has no connected account, so every such step would fail on every run.
   */
  teamId?: string;
}

export interface InstallWorkflowTemplateResponse {
  workflowId: string;
  /** The installed name. A repeat install of one template is numbered. */
  workflowName: string;
  /** Present when the template armed a cron schedule. */
  scheduleId?: string;
}

/** A run row read outside one workflow's page, where the reader has no
 * heading to tell them which workflow it belongs to. */
export interface GlobalWorkflowRunSummary extends WorkflowRunSummary {
  workflowName: string;
}

export interface ListAllWorkflowRunsResponse {
  runs: GlobalWorkflowRunSummary[];
  /** Absent on the last page, exactly as `ListWorkflowRunsResponse`. */
  nextCursor?: string;
}

// ── Workflow triggers (spec 2026-08-15) ──────────────────────────────────

export interface WorkflowScheduleTriggerDetail {
  cron: string;
  timezone: string;
  targetKind: "workflow" | "orchestrator";
  prompt?: string;
  input?: unknown;
  nextFireAt: number;
  lastFiredAt: number | null;
}

export interface WorkflowEventTriggerDetail {
  eventKeys: string[];
  filters: unknown[];
}

export type WorkflowTriggerItem =
  | {
      kind: "schedule";
      id: string;
      workflowId?: string;
      name: string;
      enabled: boolean;
      detail: WorkflowScheduleTriggerDetail;
    }
  | {
      kind: "event";
      id: string;
      workflowId: string;
      name: string;
      enabled: boolean;
      detail: WorkflowEventTriggerDetail;
    };

export interface ListWorkflowTriggersResponse {
  triggers: WorkflowTriggerItem[];
}

export type CreateWorkflowScheduleRequest = {
  name: string;
  cron: string;
  timezone?: string;
} & (
  | { target: { kind: "workflow"; workflowId: string; input?: unknown } }
  | { target: { kind: "orchestrator"; prompt: string } }
);

export interface UpdateWorkflowScheduleRequest {
  name?: string;
  cron?: string;
  timezone?: string;
  enabled?: boolean;
  prompt?: string;
  input?: unknown;
}

export interface WorkflowScheduleResponse {
  schedule: {
    scheduleId: string;
    targetKind: "workflow" | "orchestrator";
    workflowId?: string;
    prompt?: string;
    name: string;
    cron: string;
    timezone: string;
    enabled: boolean;
    input?: unknown;
    lastFiredAt: number | null;
    nextFireAt: number;
  };
}

export interface CreateWorkflowEventTriggerRequest {
  workflowId: string;
  name: string;
  eventKeys: string[];
  filters?: unknown[];
}

export interface UpdateWorkflowEventTriggerRequest {
  name?: string;
  eventKeys?: string[];
  filters?: unknown[];
  enabled?: boolean;
}

export interface WorkflowEventTriggerResponse {
  trigger: {
    triggerId: string;
    workflowId: string;
    name: string;
    eventKeys: string[];
    filters: unknown[];
    enabled: boolean;
  };
}

export interface WorkflowTriggerCatalogEntry {
  key: string;
  description: string;
  filters: { field: string; description: string }[];
}

export interface GetWorkflowTriggerCatalogResponse {
  catalog: { service: string; entries: WorkflowTriggerCatalogEntry[] }[];
}

export interface GetMemoryTreeResponse {
  entries: MemoryTreeEntry[];
}

// ── REST: plugins + credentials (plugin-system-v2 plan Task 15) ───────────

export type CredentialKind = "oauth2" | "api_key" | "bot_token" | "service_account";

/**
 * One statically-declared action, reduced to what two surfaces need: the
 * org-policy admin UI's target picker, and the connect UI's statement of
 * what a credential unlocks. Names, ids and risk only — parameter schemas
 * and descriptions stay server-side.
 */
export interface PluginActionSummary {
  /** The fully-qualified action id (`"github.create_issue"`), matching what
   * `action_policies.action_id` / `action_policy_overrides.action_id` store,
   * so a policy row created here matches at resolution time. */
  id: string;
  /** Human-readable label, the same string the approval gate shows. */
  name: string;
  riskLevel: RiskLevelWire;
  /**
   * True when the engine's approval gate stops this action and asks the user
   * before it runs. Resolved server-side through the engine's own
   * `approvalModeForAction`, never re-derived from `riskLevel` by a client:
   * a plugin may pin `defaultApprovalMode` and override risk entirely, and a
   * client that guessed would promise a gate that never fires.
   */
  requiresApproval: boolean;
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
   * redirect button; "manual" renders token entry; "org" means the org
   * credential (Settings → Organization) provides the service and there is
   * nothing for the user to connect — the tile states that and offers no
   * token entry; "unconfigured" means the deployment/org prerequisite is
   * missing (OAuth client env vars, or the org-scoped credential an admin
   * connects in Settings → Organization) — the UI offers no connect path,
   * and hides the tile unless a leftover credential still needs
   * disconnecting. See
   * docs/specs/2026-08-17-integration-availability-design.md. */
  connect: "oauth" | "manual" | "org" | "unconfigured";
  /**
   * Which prerequisite blocks the connection, for the note the tile shows.
   * Present only when `connect === "unconfigured"`.
   *
   * - `"deployment"` — the server has no OAuth client for this service. The
   *   fix is an environment variable and a server restart, so no page in
   *   the product can perform it.
   * - `"org"` — the org-scoped credential is missing. An admin connects it
   *   in Settings → Organization.
   *
   * EVERY caller reads this field. Each cause has a different corrective
   * action, and a member who sees the tile (a leftover credential keeps it
   * on screen) needs the note to name the right one. The field carries a
   * cause and nothing else: no variable name, no identifier, no value.
   */
  connectBlockedBy?: "deployment" | "org";
  /**
   * The deployment environment variables this service still needs, for a
   * caller who can set them. Present only when `connectBlockedBy ===
   * "deployment"` AND the caller is an org admin (`org_members.role`), so
   * its presence is the permission — a member's JSON simply lacks the key,
   * and the tile stays hidden for somebody who cannot act.
   *
   * `GET /api/credentials/:service/connect` holds the same gate on the
   * `missing` array in its 503 body, so the two surfaces that can name
   * these variables agree on who reads them.
   *
   * NAMES ONLY. The array is built by filtering the declaration's own
   * `clientIdEnv`/`clientSecretEnv` name fields, and the values behind those
   * names are read only as a presence test (`authCodeEnvReady`). A variable
   * name is not a secret; its value is, and no value can reach this array,
   * because `string[]` of manifest names is the only thing it can hold.
   */
  missingEnv?: string[];
  /** Stable slug the client maps to a brand mark, e.g. "github", "gmail".
   * Absent when the plugin declares none — the UI falls back to initials.
   * A slug, not an image: the mark ships with the client so a service icon
   * costs no request and cannot break when a vendor moves its asset. */
  iconSlug?: string;
  /**
   * Whether the stored credential still works, for the CONNECTED case.
   * `connected` alone is set membership in the credential store, so a
   * revoked or expired token reads as connected while the agent silently
   * drops the service from its tool list. These say otherwise.
   */
  health?: {
    /** Epoch ms the access token expires, when the grant reports one. */
    expiresAt?: number;
    /** The connected account, e.g. an email or login handle. Shown so a
     * user with two accounts knows which one is wired up. */
    login?: string;
    /** The last refresh attempt failed — the connection needs re-auth and
     * will not recover on its own. */
    refreshFailed?: boolean;
    /** The grant carries identity only, with none of the scopes the
     * service's actions need. */
    identityOnly?: boolean;
  };
  /**
   * The actions THIS credential unlocks, for the connect UI to state what a
   * user is about to hand over before they hand it over.
   *
   * Joined on the key the runtime actually reads — `credentialService ??
   * service` on each `ActionPlugin`, the same expression `invokeAction` uses
   * to scope a credential provider. The join is deliberate, not incidental:
   * it makes the list true by construction. When a plugin's credential
   * declaration and its `ActionPlugin` disagree about the key, this array
   * comes back EMPTY rather than borrowing the plugin's actions — an empty
   * array is the honest report that this token unlocks nothing, and the UI
   * says so instead of inventing a list.
   *
   * Always empty for a `dynamic` service: its actions do not exist until a
   * credential is connected and the upstream server is asked.
   */
  actions: PluginActionSummary[];
}

export interface PluginSummary {
  name: string;
  version: string;
  /** Human-readable name from the plugin manifest, e.g. "Grafana Cloud".
   * Absent for most bundled plugins — the client falls back to its own
   * display-name map keyed on `name`. */
  displayName?: string;
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

/**
 * `GET /api/skills`, optionally filtered to one workspace with
 * `?ownerType=&ownerId=`. Send both parameters or neither; an owner the
 * caller cannot reach answers 404, the same as an owner that does not exist.
 *
 * A filtered listing carries that owner's stored skills only. Plugin skills
 * belong to no owner, so they appear in the unfiltered listing alone.
 *
 * The Library's own controls narrow the catalog through three more
 * parameters, and the server applies all three so a control answers about
 * the catalog and not about the page in hand:
 *   - `?scope=personal|team|org|plugin` — one library scope. It names a CLASS
 *     of owners where `ownerType`/`ownerId` pin ONE owner by id, so sending
 *     both answers 400.
 *   - `?kind=skill|prompt` — prompts run their body; plain skills load it as
 *     context. A plugin skill is always a plain skill.
 *   - `?q=` — case-insensitive substring over name and description.
 *
 * Keyset-paginated with `?limit=` (default 24, maximum 100) and `?cursor=`.
 * `cursor` is opaque: pass back a `nextCursor` this listing returned, and
 * never build one. `nextCursor` is `null` on the last page. Plugin skills
 * sort ahead of every stored row, so they fill the first page.
 */
export interface ListSkillsResponse {
  skills: SkillSummary[];
  nextCursor: string | null;
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
 * A sync reads a public repository with no credential, and a private
 * repository with the credential the source's owner holds — a person's own
 * GitHub account for a personal or team source, and the org's GitHub App for
 * an org source (`packages/api/src/services/skill-source-credential.ts`).
 * Nothing on this wire type carries a credential, and `lastMessage` never
 * carries token material.
 */
export interface SkillSourceSummary {
  id: string;
  /** `owner/repo`. */
  repo: string;
  /** Branch, tag, or commit. Empty means the default branch. */
  ref: string;
  /** Narrows the scan to one directory. Empty scans the whole repository,
   * which is the normal case: sync finds a `SKILL.md` at any depth. */
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

/**
 * `GET /api/skills/sources`, taking the same `?ownerType=&ownerId=` filter
 * `ListSkillsResponse` documents, with the same rules: both parameters or
 * neither, and 404 for an owner the caller cannot reach.
 *
 * Keyset-paginated the same way, with `?limit=` (default 20, maximum 100)
 * and an opaque `?cursor=`. Sources sort by repository name, then
 * subdirectory. `nextCursor` is `null` on the last page.
 */
export interface ListSkillSourcesResponse {
  sources: SkillSourceSummary[];
  nextCursor: string | null;
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
  /** `SKILL.md` files the sync found, before names collided and before any
   * file was parsed. Zero with `source.status: "ok"` cannot happen: a sync
   * that finds nothing reports `warning` and says why on
   * `source.lastMessage`. This count is what separates "the repository holds
   * no skill" from "it holds skills and every one of them was skipped". */
  discovered: number;
  /**
   * `SKILL.md` files found under a directory the scan skips — dependency
   * trees, build output, test trees, and downloaded agent plugins.
   *
   * Reported here and not on the source row, because a repository can hold
   * hundreds of these legitimately and a standing warning about them would
   * train people to ignore the row. The one case that DOES reach the row is
   * an excluded path whose skill this source already mirrors: that is the
   * exclusion rule taking a skill away, and it warns per path.
   */
  excluded: number;
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
  /**
   * Whether the identity provider's groups become teams at each
   * single-sign-on login. Off by default.
   *
   * The client reads it to know whether an `origin: "idp"` team is a LIVE
   * mirror or a dormant one. A dormant mirror keeps its members and its
   * work, but nothing reasserts it, so the client returns the team controls
   * that a live mirror hides.
   */
  ssoTeamSync: boolean;
}

export interface OrgResponse {
  id: string;
  name: string;
  createdAt: number;
  features: OrgFeaturesWire;
  /**
   * Top-level group paths the team sync mirrors, e.g. `["/platform"]` —
   * the per-group half of `features.ssoTeamSync`. A group outside this
   * list never becomes a team; an existing mirror of a de-listed group
   * goes dormant (kept, with its members, updated by nothing). Never-set
   * reads as `[]`: both mirror nothing. When `valet.yaml` declares
   * `auth.sso.teams.groups`, the file overwrites this list at every boot.
   */
  ssoTeamGroups: string[];
  callerRole: "admin" | "member";
}

/** Whitelisted fields only — unknown top-level keys 400. */
export interface PatchOrgRequest {
  name?: string;
  features?: Partial<OrgFeaturesWire>;
  /** Replaces the whole mirrored-group list; entries are `/name` paths. */
  ssoTeamGroups?: string[];
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
  /** True when `POST .../deliver` works for this provider: the transport can
   * look the caller up by email and DM them the code. */
  codeDelivery: boolean;
  /** True when `GET .../members` works: the transport has a member
   * directory for the "find me by name" fallback. */
  memberSearch: boolean;
}

export interface ListIdentityLinksResponse {
  links: IdentityLinkStatus[];
}

export interface StartIdentityLinkResponse {
  /** The link code, for providers where the user types it (e.g. Slack DM). */
  code: string;
  /** One-tap delivery URL when the provider supports it (Telegram t.me). */
  deepLink?: string;
  /** How to deliver the code — from the plugin's identityLink.instructions. */
  instructions: string;
  expiresInSeconds: number;
}

/** One workspace member from `GET .../members` — the "find me by name"
 * fallback for users whose provider email differs from their Valet email. */
export interface LinkMemberEntry {
  externalId: string;
  /** Human name (Slack: real name, falling back to the handle). */
  displayName: string;
  /** Provider-side handle (Slack: the username). */
  handle: string;
}

export interface ListLinkMembersResponse {
  members: LinkMemberEntry[];
}

/** Optional body of `POST .../deliver`. Empty/absent = resolve the caller by
 * their Valet email. With `externalId`, DM that member instead — the
 * "find me by name" path. `displayName` only shapes the card copy. */
export interface DeliverIdentityLinkRequest {
  externalId?: string;
  displayName?: string;
}

/** 200 body of `POST /api/me/identity-links/:provider/deliver`: the bot DMed
 * the target account an anchor message. The DM carries NO code — `code`
 * exists only in this authenticated response, and the user carries it into
 * the chat themselves. That trip is the ownership proof. */
export interface DeliverIdentityLinkResponse {
  delivered: true;
  /** Provider-side account the DM went to (Slack: the `U…` user id). */
  externalId: string;
  displayName?: string;
  /** The code to send back to the bot. Shown only here, never DMed. */
  code: string;
  /** The exact reply to send back (Slack: `link <code>` with the real
   * code). The card renders it verbatim as one copyable line; the
   * transport's parser accepts it unchanged. */
  replyText: string;
  expiresInSeconds: number;
}

/** 202 body of `POST .../deliver`: the caller's email names nobody in the
 * provider workspace. Not an error — the client falls back to show-code. */
export interface DeliverIdentityLinkFallback {
  reason: "email_not_in_workspace";
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
  /** Where the config came from: `"org"` for the org's own credential row
   * (manifest flow), `"environment"` for the deployment-wide `GITHUB_APP_*`
   * fallback. Absent when unconfigured. An environment-sourced config
   * cannot be removed through the API — unset the variables instead. */
  source?: "org" | "environment";
  app?: GithubAppInfo;
  installations: GithubAppInstallationSummary[];
  webhook: { mode: "public" | "manual" };
  /** When this org's installations were last read from GitHub, in epoch ms.
   * `null` when none has been read yet. It lets the settings page say how
   * fresh the list is, so "it is not updating" is answerable without a log.
   * Derived from the newest installation row, so it also moves when the
   * manual button or a webhook writes. */
  installationsCheckedAt: number | null;
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

/**
 * Body of `POST /api/org/github-app/credential` — the second setup path, for
 * an admin whose GitHub App already exists. An App name is global on GitHub,
 * so a second creation attempt with the same name is refused on GitHub's own
 * page, which the manifest flow cannot explain. This path connects the App
 * that is already there instead.
 *
 * The response is `GetGithubAppResponse`, which carries no secret material —
 * nothing sent here is ever readable back through the API.
 */
export interface PostGithubAppCredentialRequest {
  appId: string;
  /** The app's PEM private key, raw or base64-encoded. */
  privateKey: string;
  /** Both are read from GitHub when omitted — `GET /app` reports them. */
  appSlug?: string;
  oauthClientId?: string;
  /** Needed only for per-user GitHub sign-in. GitHub never reports it, so it
   * cannot be filled in for the admin. */
  oauthClientSecret?: string;
  /** Needed only for webhook event delivery. */
  webhookSecret?: string;
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

/**
 * The org App's state, readable by any org member.
 *
 * `GET /api/org/github-app` answers the same question in much more detail,
 * but it is org-admin-only — so a member had no way to learn that the App
 * they depend on is missing or uninstalled. This is the projection a
 * connect surface needs and nothing more: no app id, no slug, no
 * installation logins, no secrets.
 */
export interface GetGithubOrgStatusResponse {
  /** The org has a GitHub App — its own credential row, or the
   * deployment-wide `GITHUB_APP_*` fallback. This is the same read
   * `POST /api/me/github/connect` makes, so `false` means that call 409s. */
  configured: boolean;
  /** GitHub accounts the App is installed on. Counts the same rows the
   * admin page tables, so the two surfaces never disagree. Zero with
   * `configured: true` is the created-but-never-installed state. */
  installationCount: number;
  /** How many of `installationCount` GitHub suspended. A suspended
   * installation reaches no repository, so a count equal to
   * `installationCount` means the App reaches nothing. */
  suspendedCount: number;
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
//
// `PostSandboxGitCredentialRequest` has no TypeScript importer on purpose.
// Its producer is the POSIX `sh` helper that `engine/git-credential-helper.ts`
// generates, and the route hand-parses the body as `Record<string, unknown>`.
// This interface is the only machine-readable statement of that contract.
// Do not delete it as unused.

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

/** `GET /api/sources/for-repo?fullName=owner/repo` — any authed org
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
  /** `teamId` is required when `orchestrator` is `"team"`, and refused
   * otherwise — the two fields are one choice, and a `teamId` alongside
   * `"user"` would name a team the delivery never reaches. */
  | { kind: "orchestrator"; orchestrator?: "user" | "team" | "org"; teamId?: string };

export interface EventSubscriptionWire {
  id: string;
  name: string;
  ownerType: "user" | "team" | "org";
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
  /** Epoch ms of the next scheduled retry, while one is still coming. The
   * column is already selected server-side; without it on the wire a
   * failing delivery and a dead one look identical, and "retries in 8
   * minutes" is the sentence that stops someone escalating. */
  nextAttemptAt?: number | null;
  /** The subscription's display name, so a delivery row can say what it
   * was trying to reach without a second request. */
  subscriptionName?: string;
}

/** `POST /api/events/:id/redeliver` — queue a fresh delivery for an event
 * whose earlier attempts failed or were given up on. Always writes NEW
 * delivery rows: the workflow dispatcher derives a run id from the delivery
 * id and returns early when that run exists, so reusing an id would report
 * success and start nothing. */
export interface RedeliverEventResponse {
  /** Delivery rows created, one per currently-enabled matching subscription. */
  created: number;
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

export type ActionInvocationStatusWire = "pending" | "allowed" | "denied" | "approved" | "rejected" | "error" | "completed" | "cancelled" | "timeout";

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

// ── REST: Slack agent app setup ──────────────────────────────────────────
//
// `GET /api/org/slack` — org-admin only. Returns the app manifest an
// operator pastes into Slack's app-creation form, plus the connection state
// of the org's Slack credential. Slack's `apps.manifest.create` needs an
// app-configuration token this deployment does not hold, so the flow is
// paste-in rather than API-driven.
//
// The manifest targets Slack's agent messaging experience: the feature key
// is `agent_view`, and the app subscribes `app_home_opened` /
// `app_context_changed` / `message.im`. See `services/slack-app.ts`.

/** Slack's app-manifest schema — only the fields this flow sets.
 * https://docs.slack.dev/reference/app-manifest/ */
export interface SlackAppManifestWire {
  display_information: {
    /** Maximum 35 characters; Slack rejects the whole manifest above that. */
    name: string;
    /** Maximum 140 characters. */
    description?: string;
    background_color?: string;
  };
  features: {
    /** The agent messaging experience. The older `assistant_view` is
     * deprecated, and its `assistant_description` is renamed here. */
    agent_view: {
      /** Maximum 300 characters. */
      agent_description: string;
      suggested_prompts: { title: string; message: string }[];
    };
    app_home: {
      home_tab_enabled: boolean;
      messages_tab_enabled: boolean;
      /** Must be false. True disables the composer, and the user cannot
       * type to the agent at all. */
      messages_tab_read_only_enabled: boolean;
    };
    bot_user: { display_name: string; always_online: boolean };
  };
  oauth_config: {
    /** Callback for the Slack (personal) user-OAuth flow. Omitted when the
     * deployment has no public URL; the operator adds one by hand before
     * the user flow can run. */
    redirect_urls?: string[];
    /** `user` is the Slack (personal) scope bundle. Slack grants a user
     * token only the scopes declared here, so a stale manifest fails every
     * connect with a scope-shortfall error. */
    scopes: { bot: string[]; user: string[] };
  };
  settings: {
    /** `request_url` is omitted in Socket Mode. */
    event_subscriptions: { request_url?: string; bot_events: string[] };
    interactivity: { is_enabled: boolean; request_url?: string };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
}

export interface GetSlackAppResponse {
  /** `webhook` when this deployment has a public URL Slack can reach;
   * `socket_mode` otherwise, which is the local-development path. */
  ingress: "webhook" | "socket_mode";
  /** The events + interactivity URL in the manifest. `null` in Socket Mode. */
  requestUrl: string | null;
  /** Where the operator pastes the manifest. */
  createUrl: string;
  manifest: SlackAppManifestWire;
  /** Scopes the connection refuses to save without. */
  requiredScopes: string[];
  /** Scopes the manifest requests; each missing one costs one feature. */
  optionalScopes: string[];
  /** An org Slack credential exists. */
  connected: boolean;
  /** Workspace the credential belongs to, recorded at connect time. */
  teamName?: string;
  teamId?: string;
  /** Requested scopes the installed app did not grant, from the scope list
   * recorded at connect time. Empty when nothing is missing. */
  missingScopes: string[];
}

// ── REST: LLM proxy usage (`/api/proxy/*`) ───────────────────────────────
//
// Dashboard read surface for the LLM recording gateway. Gating:
//   - org members see only their own rows.
//   - org admins see all rows in their org.
// A row outside the caller's org 404s (never 403 — same convention as
// `routes/llm-providers.ts`).

/** Aggregate bucket by a single dimension. */
export interface ProxyUsageBucket {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface ProxyUserBucket extends ProxyUsageBucket {
  userId: string;
}

export interface ProxyModelBucket extends ProxyUsageBucket {
  model: string | null;
}

export interface ProxyHarnessBucket extends ProxyUsageBucket {
  harness: string | null;
}

/**
 * `GET /api/proxy/usage/summary` — token and cost aggregates for the
 * requested time window. Members see only their own rows; org admins see
 * the whole org.
 */
export interface ProxyUsageSummary {
  windowMs: number;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  byUser: ProxyUserBucket[];
  byModel: ProxyModelBucket[];
  byHarness: ProxyHarnessBucket[];
}

/**
 * `GET /api/proxy/requests` list item — metadata only, no request or
 * response bodies.
 */
export interface ProxyRequestListItem {
  id: string;
  createdAt: number;
  orgId: string;
  userId: string;
  apiKeyId: string;
  providerKind: "anthropic" | "openai";
  model: string | null;
  harness: string | null;
  endpoint: string;
  stream: boolean;
  statusCode: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number | null;
  latencyMs: number | null;
  error: string | null;
}

/**
 * `GET /api/proxy/requests/:id` — full row including request and response
 * bodies and the parsed representation.
 */
export interface ProxyRequestDetail extends ProxyRequestListItem {
  requestBody: string;
  responseBody: string | null;
  parsed: unknown;
  parseVersion: number | null;
  parseError: string | null;
  providerResponseId: string | null;
  previousResponseId: string | null;
}
