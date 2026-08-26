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
 * `DecisionGateExpiredError`. Tools should let these errors propagate so the
 * agent loop ends the turn cleanly.
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
  constructor(public readonly gateId: string) {
    super(`decision gate ${gateId} expired`);
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
    p.reject(new DecisionGateExpiredError(gateId));
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
  const terminal: DecisionGate = { ...gate, status: outcome.status, updatedAt: Date.now() };
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
