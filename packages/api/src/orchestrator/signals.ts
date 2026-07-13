/**
 * Signal edge ACL (Phase 4 decision 16). `admitSignal` is the ONLY path
 * through which host code admits a `SignalContent` on another session's
 * behalf — route handlers never call `session.prompt`/`thread.submitPrompt`
 * directly with `internalSender` set. Authorizes the edge against durable
 * engine session state, drop-logs every rejection, then admits via the
 * engine's own stamping/hop-budget/dispatchId-namespacing machinery
 * (decision 4).
 *
 * Thread targeting (`threadKey`): callers pass either an engine THREAD ID
 * (child settlement — `child_watches.parent_thread_id` is a thread id, not
 * a key) or a thread KEY (cross-orchestrator signals, `signal:{senderId}`
 * convention). `resolveThread` below tries `session.threadById` first
 * (works for ids; returns null for keys since key strings never collide
 * with the engine's `th-...` id format) and falls back to `session.thread`
 * (get-or-create by key). This is the single seam that reconciles both
 * callers without admitSignal needing to know which one it was handed.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  parseOrchestratorSessionId,
  ValidationError as EngineValidationError,
  type PromptReceipt,
  type Principal,
  type Session,
  type SessionData,
  type SessionStore,
  type SignalContent,
  type Thread,
} from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { eventDropLog } from "../schema/index.js";
import type { EngineHost } from "../engine/host.js";

export interface AdmitSignalDeps {
  db: AppDb;
  engineHost: EngineHost;
  engineStore: SessionStore;
}

export interface AdmitSignalArgs {
  from: { sessionId: string; owner: Principal };
  /** Recipient session id. */
  to: string;
  /** Engine thread id OR thread key on the recipient session — see module doc. */
  threadKey: string;
  content: SignalContent;
  /** Idempotent admission key, required (the engine namespaces it by `from.sessionId`). */
  dispatchId: string;
  /** The sender's own current hop count, if it is itself relaying a signal. */
  hopCount?: number;
}

/** Thrown when the edge ACL denies a signal admission. */
export class SignalEdgeDeniedError extends Error {
  readonly code = "edge_denied";
  readonly statusCode = 403;
  constructor(from: string, to: string, reason: string) {
    super(`signal denied: ${from} -> ${to} (${reason})`);
    this.name = "SignalEdgeDeniedError";
  }
}

/**
 * Shared `event_drop_log` writer — used here and by `ChildWatcher`
 * (children.ts) for its own permanent-failure drop-log entries, so every
 * Phase 4 drop-log row goes through one insert shape.
 */
export async function writeDropLog(
  db: AppDb,
  fields: { orgId: string; reason: string; conversationKey?: string; detail: string },
): Promise<void> {
  await db
    .insert(eventDropLog)
    .values({
      id: randomUUID(),
      orgId: fields.orgId,
      reason: fields.reason,
      conversationKey: fields.conversationKey ?? null,
      detail: fields.detail,
      createdAt: Date.now(),
    })
    .run();
}

/**
 * Edge authorization (decision 16). Returns the two sessions' durable
 * `SessionData` rows on success (callers reuse them — no need to re-fetch).
 * Throws `SignalEdgeDeniedError` (and drop-logs) on denial.
 */
async function authorizeEdge(
  deps: AdmitSignalDeps,
  args: AdmitSignalArgs,
): Promise<{ fromData: SessionData; toData: SessionData }> {
  const [fromData, toData] = await Promise.all([
    deps.engineStore.getSession(args.from.sessionId),
    deps.engineStore.getSession(args.to),
  ]);

  if (!fromData || !toData) {
    const orgId = fromData?.orgId ?? toData?.orgId ?? "unknown";
    const detail = `session missing: from=${args.from.sessionId} (${fromData ? "ok" : "missing"}) to=${args.to} (${toData ? "ok" : "missing"})`;
    await writeDropLog(deps.db, { orgId, reason: "edge_denied", conversationKey: args.dispatchId, detail });
    throw new SignalEdgeDeniedError(args.from.sessionId, args.to, "session not found");
  }

  // (a) parent <-> child, either direction.
  const isParentChild =
    toData.parentSessionId === args.from.sessionId || fromData.parentSessionId === args.to;
  if (isParentChild) return { fromData, toData };

  // (b) orchestrator -> orchestrator, same org only. Uses the decision-1
  // helper (never an ad-hoc prefix check) to recognize orchestrator ids.
  const fromIsOrchestrator = parseOrchestratorSessionId(args.from.sessionId) !== null;
  const toIsOrchestrator = parseOrchestratorSessionId(args.to) !== null;
  if (fromIsOrchestrator && toIsOrchestrator) {
    if (fromData.orgId !== toData.orgId) {
      await writeDropLog(deps.db, {
        orgId: fromData.orgId,
        reason: "edge_denied",
        conversationKey: args.dispatchId,
        detail: `cross-org orchestrator signal denied: ${fromData.orgId} -> ${toData.orgId}`,
      });
      throw new SignalEdgeDeniedError(args.from.sessionId, args.to, "cross-org");
    }
    // org -> user delegation is always allowed within one org.
    if (fromData.owner.type === "org" && toData.owner.type === "user") {
      return { fromData, toData };
    }
    // user -> user requires an org policy opt-in that doesn't exist yet
    // (no policy table this phase) — hardcode DENY per decision 16 until
    // Phase 5+ adds the opt-in. Every other same-org owner-type combo
    // (team <-> user, org <-> team, ...) is likewise undecided and falls
    // through to the default deny below rather than being guessed at.
  }

  // (c) same-org workflow/task dispatch (Phase 5 caller). Not implemented
  // this phase — left as a marker for the workflow host to extend:
  //
  //   if (isWorkflowDispatch(args) && fromData.orgId === toData.orgId) {
  //     return { fromData, toData };
  //   }

  await writeDropLog(deps.db, {
    orgId: fromData.orgId,
    reason: "edge_denied",
    conversationKey: args.dispatchId,
    detail: `no authorized edge: ${args.from.sessionId} -> ${args.to}`,
  });
  throw new SignalEdgeDeniedError(args.from.sessionId, args.to, "no authorized edge");
}

/**
 * Resolves `threadKey` against a live session — id first, then key
 * (get-or-create). See module doc for why both shapes are accepted.
 */
function resolveThread(session: Session, threadKey: string): Thread {
  return session.threadById(threadKey) ?? session.thread(threadKey);
}

/**
 * Authorizes and admits a `SignalContent` on behalf of `args.from` onto
 * `args.to`'s `args.threadKey` thread. The engine stamps sender identity,
 * enforces the hop budget, and namespaces `dispatchId` — this function's
 * job is purely the app-layer edge ACL plus drop-log bookkeeping around it.
 */
export async function admitSignal(deps: AdmitSignalDeps, args: AdmitSignalArgs): Promise<PromptReceipt> {
  const { toData } = await authorizeEdge(deps, args);

  const session = await deps.engineHost.sessionFor(args.to, {
    userId: toData.userId,
    orgId: toData.orgId,
    workspace: toData.workspace,
  });
  const thread = resolveThread(session, args.threadKey);

  try {
    return await thread.submitPrompt(args.content, {
      dispatchId: args.dispatchId,
      // Internal signals always queue behind in-flight work. User-owned
      // orchestrator threads run queueMode 'steer' (decision 17) — without
      // this override, a child.settled signal admitted mid-turn would
      // SUPERSEDE and abort the parent's own running turn (steer semantics),
      // which is backwards for an observed event: signals are context for
      // the next turn, never an interrupt.
      queueMode: "followup",
      internalSender: { sessionId: args.from.sessionId, owner: args.from.owner, hopCount: args.hopCount },
    });
  } catch (err) {
    if (err instanceof EngineValidationError && /hop budget/i.test(err.message)) {
      await writeDropLog(deps.db, {
        orgId: toData.orgId,
        reason: "hop_budget",
        conversationKey: args.dispatchId,
        detail: err.message,
      });
    }
    throw err;
  }
}
