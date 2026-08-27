import type {
  DecisionGate,
  DecisionGateRequest,
  DecisionResolution,
  DecisionWithdrawReason,
  SessionStore,
} from "./types.js";

/**
 * Per-thread tracker for live decision-gate Promises. Tools awaiting a gate
 * register a resolver here; engine.resolveDecision/withdraw/expire wakes the
 * matching tool execution.
 *
 * V1 contract: a tool that calls ctx.requestDecision(...) blocks until the
 * gate transitions out of `pending`. Resolution returns the `DecisionResolution`.
 * Withdrawal throws `DecisionGateWithdrawnError`. Expiry throws
 * `DecisionGateExpiredError`. A propagated throw becomes an error tool result
 * that the model reads — pi-agent-core continues the loop, it does not end
 * the turn. Tools that must NOT let the model retry (the approval path in
 * plugin-catalog) catch expiry and return a terminal "do not retry" result
 * instead.
 *
 * Terminal stickiness: within one queue item, a denial or an expiry is final
 * for its dedupe scope. A later requestDecision in the same scope returns the
 * stored denial (or re-throws expiry) instead of opening a fresh gate — see
 * `findStickyTerminalGate`. Without this, an agent that retries after a deny
 * or an unanswered gate mints ordinal+1 (or a new args-hash identity) forever:
 * a 72h-expiry gate resurrects itself every 72h.
 *
 * Restart-safe re-entrancy: when SuspendedTurnState is reloaded from a
 * persistent store (reconcileGate/armPendingGateForRestart/replayBlocked in
 * thread.ts), the tool is re-invoked from scratch with ctx.suspendedDecision
 * populated, and this manager's first call short-circuits (shouldShortCircuit)
 * to return the stored resolution without opening a second gate.
 */
export class DecisionGateWithdrawnError extends Error {
  constructor(public readonly gateId: string, public readonly reason: DecisionWithdrawReason) {
    super(`decision gate ${gateId} withdrawn (${reason})`);
    this.name = "DecisionGateWithdrawnError";
  }
}

export class DecisionGateExpiredError extends Error {
  /**
   * `ordinal` is the expired gate's ordinal, carried so audit records can
   * link the failure back to the gate row (the policy sink keys gated
   * records on it). The message reaches the model as an error tool result
   * when a tool does not catch this error, so it names the corrective
   * action.
   */
  constructor(public readonly gateId: string, public readonly ordinal?: number) {
    super(
      `decision gate ${gateId} expired before anyone answered. ` +
        "Do not retry this request in this turn. Tell the user it was not " +
        "answered; they can ask again in a new message.",
    );
    this.name = "DecisionGateExpiredError";
  }
}

interface PendingGate {
  gate: DecisionGate;
  resolve: (resolution: DecisionResolution) => void;
  reject: (err: Error) => void;
}

export class GateManager {
  private pending = new Map<string, PendingGate>();
  private timers = new Map<string, NodeJS.Timeout>();

  register(gate: DecisionGate, onExpire: (gateId: string) => void): Promise<DecisionResolution> {
    return new Promise((resolve, reject) => {
      this.pending.set(gate.id, { gate, resolve, reject });
      if (gate.expiresAt) {
        const ms = gate.expiresAt - Date.now();
        if (ms <= 0) {
          this.expire(gate.id);
          onExpire(gate.id);
          return;
        }
        const timer = setTimeout(() => {
          this.expire(gate.id);
          onExpire(gate.id);
        }, ms);
        // unref so the timer doesn't keep the process alive in tests
        const t = timer as { unref?: () => void };
        if (typeof t.unref === "function") t.unref();
        this.timers.set(gate.id, timer);
      }
    });
  }

  resolve(gateId: string, resolution: DecisionResolution): boolean {
    const p = this.pending.get(gateId);
    if (!p) return false;
    this.cleanup(gateId);
    this.pending.delete(gateId);
    p.resolve(resolution);
    return true;
  }

  withdraw(gateId: string, reason: DecisionWithdrawReason): boolean {
    const p = this.pending.get(gateId);
    if (!p) return false;
    this.cleanup(gateId);
    this.pending.delete(gateId);
    p.reject(new DecisionGateWithdrawnError(gateId, reason));
    return true;
  }

  expire(gateId: string): boolean {
    const p = this.pending.get(gateId);
    if (!p) return false;
    this.cleanup(gateId);
    this.pending.delete(gateId);
    p.reject(new DecisionGateExpiredError(gateId, p.gate.ordinal));
    return true;
  }

  isPending(gateId: string): boolean {
    return this.pending.has(gateId);
  }

  pendingForThread(threadId: string): DecisionGate[] {
    const result: DecisionGate[] = [];
    for (const p of this.pending.values()) {
      if (p.gate.threadId === threadId) result.push(p.gate);
    }
    return result;
  }

  private cleanup(gateId: string): void {
    const timer = this.timers.get(gateId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(gateId);
    }
  }
}

export function isDecisionGateWithdrawn(err: unknown): err is DecisionGateWithdrawnError {
  return err instanceof DecisionGateWithdrawnError;
}

export function isDecisionGateExpired(err: unknown): err is DecisionGateExpiredError {
  return err instanceof DecisionGateExpiredError;
}

export interface GateContext {
  sessionId: string;
  threadId: string;
  queueItemId: string;
  resumeKey: string;
}

/** Default expiry windows per gate type; every gate gets an expiresAt. */
export const GATE_EXPIRY_DEFAULT_MS = {
  approval: 72 * 60 * 60 * 1000,
  question: 72 * 60 * 60 * 1000,
  credential_request: 24 * 60 * 60 * 1000,
} as const;

/** Prefix shared by every gate for a (queueItemId, resumeKey) pair, across ordinals. */
export function gateIdPrefix(ctx: GateContext): string {
  return `gate:${ctx.sessionId}:${ctx.threadId}:${ctx.queueItemId}:${ctx.resumeKey}:`;
}

export function deterministicGateId(ctx: GateContext & { ordinal: number }): string {
  return `${gateIdPrefix(ctx)}${ctx.ordinal}`;
}

/**
 * Returns whether the engine should short-circuit `requestDecision` and
 * return a stored resolution from a replayed tool execution.
 *
 * The replay checkpoint carries a single gate id for this suspension point;
 * matching on the (sessionId, threadId, queueItemId, resumeKey) prefix ties the
 * re-run tool call to that gate without re-deriving the ordinal.
 *
 * Pure function — kept testable in isolation from Thread/Agent timing.
 */
export function shouldShortCircuit(args: {
  ctx: GateContext;
  suspendedDecision:
    | { gateId: string; ordinal: number; resolution?: DecisionResolution }
    | undefined;
}): { match: true; resolution: DecisionResolution } | { match: false } {
  const { ctx, suspendedDecision } = args;
  if (!suspendedDecision) return { match: false };
  // Exact match on the fully-derived id (including ordinal), not a prefix
  // check — resumeKeys may contain ':' and be colon-prefixes of one another
  // (e.g. "read:/x" vs "read:/x:confirm"), so prefix matching can join the
  // wrong gate.
  const expectedGateId = deterministicGateId({ ...ctx, ordinal: suspendedDecision.ordinal });
  if (suspendedDecision.gateId !== expectedGateId) return { match: false };
  if (!suspendedDecision.resolution) return { match: false };
  return { match: true, resolution: suspendedDecision.resolution };
}

/**
 * The latest (highest-ordinal) gate for an exact (queueItemId, resumeKey)
 * pair, from an already-fetched gate list. Pure sibling of the store's
 * `getLatestGateForResume`, so one queue-item read can serve both the
 * ordinal resolution and the sticky-terminal scan.
 */
export function latestGateForResume(
  gates: DecisionGate[],
  queueItemId: string,
  resumeKey: string,
): DecisionGate | null {
  let latest: DecisionGate | null = null;
  for (const g of gates) {
    if (g.queueItemId !== queueItemId || g.resumeKey !== resumeKey) continue;
    if (!latest || g.ordinal > latest.ordinal) latest = g;
  }
  return latest;
}

/**
 * True when `resolution` approves `gate`: the engine's built-in "approve"
 * action, or a gate action that carries `approves: true` (host-supplied
 * extra actions persist that flag on the gate row). Mirrors plugin-catalog's
 * `isApprovedResolution`, but reads the persisted gate instead of the live
 * PolicyDecision — the two MUST classify a resolution the same way, or a
 * host rejection action escapes denial stickiness.
 */
function resolutionApproves(gate: DecisionGate, resolution: DecisionResolution): boolean {
  if (resolution.actionId === "approve") return true;
  return gate.actions.some((a) => a.approves === true && a.id === resolution.actionId);
}

/**
 * Sticky terminal outcome for a new gate request, computed over the thread's
 * persisted gates. Within one queue item (one turn), a human denial or an
 * unanswered expiry is FINAL for its dedupe scope:
 *
 * - `denied` — a resolved APPROVAL gate in scope carries a non-approving
 *   resolution (the built-in "deny", or a host extra action without
 *   `approves: true`). The caller returns that stored resolution instead of
 *   opening a new gate. Question and credential gates are exempt: their
 *   resolutions are answers, not verdicts on an action.
 * - `expired` — a gate in scope (any type) expired unanswered. The caller
 *   throws `DecisionGateExpiredError` for that gate instead of opening a
 *   new one.
 *
 * Scope: a gate is in scope when it belongs to the same queue item and —
 * when the request supplied an explicit `dedupeKey` — its resumeKey equals
 * that key or starts with `${dedupeKey}:`. The colon-prefix form collapses
 * args-hashed resumeKeys (`service.action:<argsHash>`) onto their tool id,
 * so a re-issued call with tweaked args cannot dodge the decision. Without
 * an explicit dedupeKey the scope is the EXACT resumeKey only — resumeKeys
 * are free-form and may be colon-prefixes of one another (`read:/x` vs
 * `read:/x:confirm`, ask_approval titles), so prefix matching on the default
 * would collapse genuinely distinct decisions.
 *
 * A denial wins over an expiry when both exist; among several of the same
 * kind the newest (highest updatedAt) wins — only pre-stickiness rows can
 * produce several, since after the first sticky outcome no new gate opens
 * in that scope.
 *
 * Approvals and withdrawals are NOT sticky: a retried call after an approval
 * legitimately mints a fresh ordinal (a new human decision), and withdrawal
 * is engine-initiated (steer/abort), not a human verdict on the action.
 *
 * Pure function — kept testable in isolation from Thread/Agent timing.
 */
export function findStickyTerminalGate(
  gates: DecisionGate[],
  args: { queueItemId: string; resumeKey: string; dedupeKey?: string },
):
  | { kind: "denied"; gate: DecisionGate; resolution: DecisionResolution }
  | { kind: "expired"; gate: DecisionGate }
  | undefined {
  const { queueItemId, resumeKey, dedupeKey } = args;
  const inScope = (g: DecisionGate): boolean => {
    if (g.queueItemId !== queueItemId) return false;
    if (dedupeKey === undefined) return g.resumeKey === resumeKey;
    return g.resumeKey === dedupeKey || g.resumeKey.startsWith(`${dedupeKey}:`);
  };
  let denied: DecisionGate | undefined;
  let expired: DecisionGate | undefined;
  for (const g of gates) {
    if (!inScope(g)) continue;
    if (
      g.type === "approval" &&
      g.status === "resolved" &&
      g.resolution?.actionId &&
      g.resolution.actionId !== "pending" &&
      !resolutionApproves(g, g.resolution)
    ) {
      if (!denied || g.updatedAt > denied.updatedAt) denied = g;
    } else if (g.status === "expired") {
      if (!expired || g.updatedAt > expired.updatedAt) expired = g;
    }
  }
  if (denied?.resolution) return { kind: "denied", gate: denied, resolution: denied.resolution };
  if (expired) return { kind: "expired", gate: expired };
  return undefined;
}

/** Terminal outcome for a gate row + its DAG entry. */
export type GateTerminalOutcome =
  | { status: "resolved"; resolution: DecisionResolution }
  | { status: "withdrawn"; reason: DecisionWithdrawReason }
  | { status: "expired" };

/**
 * Persist a gate's terminal status: the row and its DAG entry, in one shape
 * for every terminalization site (live resolve, expiry, withdrawal, failed
 * open, restart reconcile, orphan repair). Events stay with the callers —
 * their eventKey/queueItemId options differ per site. Returns the terminal
 * gate for callers that emit it.
 */
export async function persistTerminalGate(
  store: SessionStore,
  sessionId: string,
  threadId: string,
  gate: DecisionGate,
  outcome: GateTerminalOutcome,
): Promise<DecisionGate> {
  const terminal: DecisionGate = {
    ...gate,
    status: outcome.status,
    // The resolution lands on the ROW (not only the DAG entry) so the sticky
    // terminal check can read the outcome without a DAG scan.
    ...(outcome.status === "resolved" ? { resolution: outcome.resolution } : {}),
    updatedAt: Date.now(),
  };
  await store.saveDecisionGate(sessionId, threadId, terminal);
  await store.updateDecisionGateEntry(sessionId, threadId, gate.id, {
    gate: terminal,
    ...(outcome.status === "resolved"
      ? {
          resolution: outcome.resolution,
          resolvedAt: new Date(outcome.resolution.resolvedAt).toISOString(),
        }
      : outcome.status === "withdrawn"
        ? { withdrawnReason: outcome.reason }
        : { resolvedAt: new Date().toISOString() }),
  });
  return terminal;
}

export function fromRequest(
  req: DecisionGateRequest,
  gateCtx: GateContext & { ordinal: number },
): DecisionGate {
  if (!req.resumeKey) {
    throw new Error(
      "DecisionGateRequest.resumeKey is required for restart-safe gates. " +
        "Tools must supply a stable key per suspension point.",
    );
  }
  const now = Date.now();
  return {
    id: deterministicGateId(gateCtx),
    sessionId: gateCtx.sessionId,
    threadId: gateCtx.threadId,
    queueItemId: gateCtx.queueItemId,
    resumeKey: gateCtx.resumeKey,
    ordinal: gateCtx.ordinal,
    type: req.type,
    title: req.title,
    body: req.body,
    actions:
      req.actions ??
      (req.type === "approval"
        ? [
            { id: "approve", label: "Approve", style: "primary" },
            { id: "deny", label: "Deny", style: "danger" },
          ]
        : []),
    expiresAt: req.expiresAt ?? now + GATE_EXPIRY_DEFAULT_MS[req.type],
    status: "pending",
    context: req.context,
    origin: req.origin,
    createdAt: now,
    updatedAt: now,
  };
}
