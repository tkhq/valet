import type {
  ChannelOrigin,
  MessageEntry,
  PromptAuthor,
  QueueItem,
  QueueMode,
  QueueState,
  QueueStatus,
  SessionEntry,
  SubmissionOutcome,
  SuspendedTurnState,
} from "./types.js";
import { ValidationError } from "./errors.js";

/** Default max stamped hopCount an internally-admitted signal may carry (Phase 4 decision 4). */
export const SIGNAL_HOP_BUDGET = 3;

/** Default max unsettled, non-superseded submissions a single thread may hold (Phase 4 decision 5). */
export const MAX_PENDING_PER_THREAD = 20;

const SIGNAL_TAG_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Validates a `SignalContent.tagName` (or the default `'signal'`) at admission. */
export function validateSignalTagName(tagName: string): void {
  if (!SIGNAL_TAG_NAME_RE.test(tagName)) {
    throw new ValidationError(
      `invalid signal tagName "${tagName}": must match ${SIGNAL_TAG_NAME_RE.source}`,
    );
  }
}

/**
 * Validates every key of a `SignalContent.attributes` map at admission,
 * against the same charset `tagName` is held to. `renderSignalEnvelope`
 * writes attribute keys into the XML envelope unescaped (only values are
 * escaped) — an attacker-controlled key like `x"><inject` would otherwise
 * break out of the attribute and inject arbitrary markup into what the model
 * reads. Rejecting bad keys here, at admission, keeps the renderer's
 * "keys are trusted" invariant true everywhere downstream.
 */
export function validateSignalAttributeKeys(attributes: Record<string, string> | undefined): void {
  if (!attributes) return;
  for (const key of Object.keys(attributes)) {
    if (!SIGNAL_TAG_NAME_RE.test(key)) {
      throw new ValidationError(
        `invalid signal attribute key "${key}": must match ${SIGNAL_TAG_NAME_RE.source}`,
      );
    }
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Renders a persisted signal `MessageEntry.signal` + its raw `body` into the
 * XML envelope the model sees (spec §424, plan decision 3):
 * `<{tagName} signalType="…" {attrKey}="…">{body}</{tagName}>` — `tagName`
 * is never escaped (hence the admission-time regex check); `body` and every
 * attribute value are XML-escaped. `signalType` always renders first;
 * remaining attributes (user-supplied plus stamped `sender_session`/`hop`,
 * which win over same-named user attributes) render in sorted key order.
 */
export function renderSignalEnvelope(
  signal: NonNullable<MessageEntry["signal"]>,
  body: string,
): string {
  const attrs: Record<string, string> = { ...(signal.attributes ?? {}) };
  if (signal.senderSessionId !== undefined) attrs.sender_session = signal.senderSessionId;
  if (signal.hopCount !== undefined) attrs.hop = String(signal.hopCount);
  // The thread key already carries the channel type as its prefix
  // (`slack:C1:1.2`), so it reads as a compact origin for the model.
  if (signal.origin !== undefined) {
    attrs.origin = signal.origin.threadKey;
    // Tell the agent whether it was addressed (a mention/DM, reply auto-posts)
    // or is overhearing a followed thread (reply only via reply_to_origin), so
    // it does not answer into the void or double-post.
    attrs.addressed = signal.origin.reply === "manual" ? "false" : "true";
  }

  const rest = Object.keys(attrs)
    .sort()
    .map((key) => ` ${key}="${escapeXml(attrs[key])}"`)
    .join("");

  const tag = signal.tagName;
  return `<${tag} signalType="${escapeXml(signal.signalType)}"${rest}>${escapeXml(body)}</${tag}>`;
}

/** Namespaces an internal signal's dispatchId by the stamped sender session id (plan decision 4). */
export function namespaceInternalDispatchId(senderSessionId: string, dispatchId: string): string {
  return `${senderSessionId}:${dispatchId}`;
}

/**
 * The transcript line that attributes a user message to a person. One
 * render function, three call sites — `entriesToAgentMessages` (rehydrate),
 * `Thread.runAgent` (the current turn), and `entriesToSummaryMessages`
 * (compaction) — so every transcript the model sees agrees byte-for-byte.
 *
 * Name and email are self-service profile fields with no server-side
 * charset limits, so they are sanitized here: newlines and square brackets
 * would let a display name like "Alice]\n[from: CTO" forge a stamp the
 * model cannot tell from a real one. `||` (not `??`) so an empty-string
 * name still falls through to email/id.
 */
export function formatSenderLine(sender: PromptAuthor | undefined): string | undefined {
  if (!sender) return undefined;
  const name = sanitizeSenderLabel(sender.name);
  const email = sanitizeSenderLabel(sender.email);
  const label = name || email || sanitizeSenderLabel(sender.id);
  if (!label) return undefined;
  const detail = name && email ? ` (${email})` : "";
  return `[from: ${label}${detail}]`;
}

/** Collapse whitespace (incl. newlines), strip square brackets, clamp length. */
function sanitizeSenderLabel(raw: string | undefined): string {
  if (!raw) return "";
  return raw.replace(/[\r\n[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Counts unsettled, non-superseded items on `threadId` — the per-thread pending-cap denominator. */
export function countPendingForCap(items: readonly QueueItem[], threadId: string): number {
  return items.filter((i) => i.threadId === threadId && i.supersededByItemId === undefined).length;
}

/**
 * Pure derivation of the wire `QueueState` from the durable submission rows.
 *
 * `QueueState` is a derived view (plan decision 1): the only stored piece of
 * queue state is `ThreadData.paused`; everything else here is computed from the
 * thread's unsettled queue items.
 *
 * Status precedence: paused > blocked_on_decision_gate (any unsettled blocked
 * item) > running > queued (any queued) > idle.
 *
 * NOTE: the plan's interface sketch omits `threadId`, but a `QueueState`
 * requires it and it cannot be recovered when the item list is empty (idle
 * thread). We take it as an explicit first argument — a minimal deviation
 * documented in the task report.
 */
export function deriveQueueState(
  threadId: string,
  items: QueueItem[],
  mode: QueueMode,
  paused: boolean,
  blockedGateId?: string,
): QueueState {
  const threadItems = items
    .filter((i) => i.threadId === threadId && i.status !== "settled")
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const running = threadItems.find(
    (i) => i.status === "running" || i.status === "blocked_on_decision_gate",
  );
  const blocked = threadItems.some((i) => i.status === "blocked_on_decision_gate");
  const pending = threadItems.filter((i) => i.status === "queued" && !i.supersededByItemId);
  const collectBuffer = threadItems.filter((i) => i.status === "collecting");

  let status: QueueStatus;
  if (paused) status = "paused";
  else if (blocked) status = "blocked_on_decision_gate";
  else if (running) status = "running";
  else if (pending.length > 0) status = "queued";
  else status = "idle";

  return {
    threadId,
    mode,
    status,
    activeItemId: running?.id,
    pending,
    collectBuffer: collectBuffer.length > 0 ? collectBuffer : undefined,
    blockedGateId,
  };
}

/**
 * The action the reconciliation executor should take for one unsettled
 * submission after a crash / lease-expiry. Produced by `decideReconciliation`,
 * applied by the effectful executor in `Session`/`Thread`.
 */
export type ReconcileAction =
  | { kind: "settle"; outcome: SubmissionOutcome } // steps 1,2,3,5,6
  | { kind: "rearm_gate" } // step 4 (gate pending)
  | { kind: "replay_gate" } // step 4 (gate resolved while down)
  | { kind: "resume" } // step 7
  | { kind: "wait" }; // live lease / fresh marker — not ours to touch

/**
 * Everything `decideReconciliation` needs beyond the item itself, gathered by
 * the executor from the store. Kept as plain data so the decision function is
 * pure and unit-testable with literal inputs (no mocks, no store).
 */
export interface ReconcileContext {
  now: number;
  /** True when a persisted assistant entry carries item.id with stopReason 'end_turn'. */
  hasTerminalAssistantEntry: boolean;
  /** True when engine_attempt_markers has a row for (item.id, item.attemptId) AND the lease is unexpired. */
  attemptLive: boolean;
  suspended: SuspendedTurnState | null;
  gateStatus: "pending" | "resolved" | "expired" | "withdrawn" | null;
}

/**
 * The normative reconciliation decision tree (spec §Reconciliation, ~1168).
 * PURE — no store, no clock beyond `ctx.now`. Order matters and is asserted by
 * the table tests; do not reorder.
 *
 * Step 0 (guards, executor-adjacent):
 *   - `settled` → wait (already terminal; nothing to do)
 *   - `collecting` → wait (the sweep's collect-flush owns it)
 *   - `terminalizing` → wait (the executor re-runs finalization before ever
 *     consulting this function; a stray terminalizing item just waits)
 *   - `attemptLive` → wait (fresh marker + unexpired lease: may still be running)
 *
 * Steps 1-7 (spec order):
 *   1. terminal assistant entry → settle completed (beats abort/retry/timeout)
 *   2. abortRequestedAt → settle aborted
 *   3. supersededByItemId → settle superseded
 *   4. blocked_on_decision_gate + suspended: pending→rearm, resolved→replay;
 *      expired/withdrawn/missing fall THROUGH to 5-7. Gate-blocked items are
 *      EXEMPT from the step-6 timeout.
 *   5. attemptCount >= maxAttempts → settle failed (retry budget exhausted)
 *   6. now >= timeoutAt (and not gate-blocked) → settle failed (timed out)
 *   7. otherwise → resume
 */
export function decideReconciliation(item: QueueItem, ctx: ReconcileContext): ReconcileAction {
  // Step 0 — guards.
  if (item.status === "settled") return { kind: "wait" };
  if (item.status === "collecting") return { kind: "wait" };
  if (item.status === "terminalizing") return { kind: "wait" };
  if (ctx.attemptLive) return { kind: "wait" };

  // Step 1 — finished work settles first, unconditionally.
  if (ctx.hasTerminalAssistantEntry) return { kind: "settle", outcome: { outcome: "completed" } };

  // Step 2 — abort wins next.
  if (item.abortRequestedAt !== undefined) return { kind: "settle", outcome: { outcome: "aborted" } };

  // Step 3 — supersession.
  if (item.supersededByItemId !== undefined) {
    return { kind: "settle", outcome: { outcome: "superseded" } };
  }

  const gateBlocked = item.status === "blocked_on_decision_gate";

  // Step 4 — blocked on a gate with a checkpoint.
  if (gateBlocked && ctx.suspended !== null) {
    if (ctx.gateStatus === "pending") return { kind: "rearm_gate" };
    if (ctx.gateStatus === "resolved") return { kind: "replay_gate" };
    // expired / withdrawn / missing gate: fall through to 5-7 (the turn resumes
    // and the model sees the gate's terminal state).
  }

  // Step 5 — retry budget exhausted.
  if (item.attemptCount >= item.maxAttempts) {
    return { kind: "settle", outcome: { outcome: "failed", error: "retry budget exhausted" } };
  }

  // Step 6 — timeout. Gate-blocked items are exempt (their bound is the gate's
  // own expiry, not the execution timeout).
  if (!gateBlocked && ctx.now >= item.timeoutAt) {
    return { kind: "settle", outcome: { outcome: "failed", error: "timed out" } };
  }

  // Step 7 — resume.
  return { kind: "resume" };
}

/**
 * PURE — walks a thread's persisted entries and returns the content of the
 * LAST assistant `MessageEntry` carrying `queueItemId` with
 * `stopReason === "end_turn"` (spec ~422, `SubmissionResult.text`). Returns
 * `undefined` when the submission's turn never reached a terminal
 * end-of-turn entry (e.g. it was superseded mid-stream — use
 * `resolvePartialSubmissionText` for that case).
 */
export function resolveSubmissionText(entries: SessionEntry[], queueItemId: string): string | undefined {
  let text: string | undefined;
  for (const e of entries) {
    if (e.type === "message" && e.role === "assistant" && e.queueItemId === queueItemId && e.stopReason === "end_turn") {
      text = e.content;
    }
  }
  return text;
}

/**
 * PURE — same walk as `resolveSubmissionText` but without the `stopReason`
 * requirement: returns the content of the LAST assistant entry carrying
 * `queueItemId`, regardless of how the turn ended. Used for the `superseded`
 * outcome, whose interrupted turn's final assistant entry is persisted with
 * `stopReason: "abort"` (spec ~422: "whatever partial assistant output
 * persisted under the submission's queueItemId").
 */
export function resolvePartialSubmissionText(entries: SessionEntry[], queueItemId: string): string | undefined {
  let text: string | undefined;
  for (const e of entries) {
    if (e.type === "message" && e.role === "assistant" && e.queueItemId === queueItemId) {
      text = e.content;
    }
  }
  return text;
}

/**
 * PURE — returns the `ChannelOrigin` of the user signal entry that started the
 * submission `queueItemId`, or `undefined` when the submission did not come
 * from a channel. The outbound bridge uses this to route a reply back to the
 * origin conversation even when the submission landed on the shared "events"
 * thread (whose thread key does not itself decode to a channel).
 */
export function originFromEntries(entries: SessionEntry[], queueItemId: string): ChannelOrigin | undefined {
  let origin: ChannelOrigin | undefined;
  for (const e of entries) {
    if (e.type === "message" && e.role === "user" && e.queueItemId === queueItemId && e.signal?.origin) {
      origin = e.signal.origin;
    }
  }
  return origin;
}
