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

export interface MeResponse {
  user: User;
}

// ── REST: sessions ────────────────────────────────────────────────────────

export type SessionStatus = "active" | "archived" | "deleted";

export interface SessionSummary {
  id: string;
  workspace: string;
  status: SessionStatus;
  title?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionDetail extends SessionSummary {
  messageCount: number;
  /** Session-default model id. Threads inherit when they have no override. */
  model?: string;
}

export interface CreateSessionRequest {
  workspace: string;
  title?: string;
  /** Optional first user prompt; if set, server enqueues immediately after creation. */
  initialPrompt?: string;
}

export interface ListSessionsResponse {
  sessions: SessionSummary[];
}

export type CreateSessionResponse = SessionDetail;
export type GetSessionResponse = SessionDetail;

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
}

export interface TeamMemberSummary {
  userId: string;
  role: TeamRole;
}

export interface ListTeamsResponse {
  teams: TeamSummary[];
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
