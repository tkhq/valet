/**
 * The one way an event or a followed message is delivered to an assistant:
 * resolve the session, assert its org against the delivery's org (the
 * second-layer defense `admitSignal` would have provided — an event has no
 * sender session, so there is no edge to authorize), then submit the signal on
 * the named thread. Both the dispatcher's orchestrator target
 * (`orchestrator-target.ts`) and the follow-router (`channels/follow-router.ts`)
 * go through here, so the org check and delivery shape can never drift between
 * them.
 *
 * The workspace owner determines the assistant.
 */
import { isDeepStrictEqual } from "node:util";
import type { ChannelOrigin, Principal, PromptAuthor, Session, SignalContent } from "@valet/engine";
import { ensureAssistantExecution, loadAssistantBySessionId } from "../assistants/service.js";
import type { EngineHost } from "../engine/host.js";
import { and, eq, sql } from "drizzle-orm";
import { agentSessions } from "../schema/index.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import type { AppDb } from "../lib/drizzle.js";
import { writeDropLog } from "../orchestrator/signals.js";
import { recordChannelMessage, type InboundChannelMessage } from "../services/channel-messages.js";

/**
 * Per-thread delivery serialization (TKAI-284 item 3). The first-turn seed
 * check reads the thread, then fetches a transcript (a slow provider call),
 * then submits — two rapid mentions on one brand-new thread could both pass
 * the empty check during the other's fetch and both prepend the transcript.
 * Chaining deliveries per assistant thread closes that window. In-process
 * state is sufficient: the api runs single-replica (see the issue), and a
 * restart between the two deliveries is covered by the unsettled-submission
 * arm of the seed gate below.
 */
const deliveryChains = new Map<string, Promise<void>>();

export interface AssistantDeliveryDeps {
  db: AppDb;
  engineHost: EngineHost;
  /**
   * Seed a channel thread's earlier messages on the assistant's FIRST turn in
   * it. Wired only on the mention path (`orchestrator-target`); the follow
   * path never delivers first, so it leaves this unset.
   */
  fetchThreadContext?: (origin: ChannelOrigin) => Promise<string | null>;
}

export interface AssistantDeliveryArgs {
  orgId: string;
  owner: Principal;
  actorUserId: string;
  threadKey: string;
  target?: { sessionId: string; threadId: string };
  signal: SignalContent;
  dispatchId: string;
  /** Drop-log reason if the resolved assistant belongs to another org. */
  mismatchReason: string;
  /** The channel message this delivery carries, recorded once it lands. */
  inbound?: InboundChannelMessage;
  /** Who wrote the message, when that is not `actorUserId` (`newcomerAuthor`). */
  author?: PromptAuthor;
}

export async function deliverToAssistantThread(
  deps: AssistantDeliveryDeps,
  args: AssistantDeliveryArgs,
): Promise<void> {
  // A delivery can outlive a routing upgrade. The admitted dispatch belongs
  // to its original runtime, even if today's route selects another one.
  if (args.dispatchId.startsWith("event:") && await recoverAdmittedEvent(deps, args)) return;
  // Serialize by runtime session and thread so delivery paths share one queue.
  let session: Session;
  if (args.target) {
    const assistant = await loadAssistantBySessionId(deps.db, args.target.sessionId);
    if (!assistant || assistant.archivedAt !== null || assistant.orgId !== args.orgId
      || assistant.ownerType !== args.owner.type || assistant.ownerId !== args.owner.id) {
      throw new Error("The original conversation is unavailable. Restore its owner before retrying delivery.");
    }
    const [row] = await deps.db.select().from(agentSessions).where(and(eq(agentSessions.id, args.target.sessionId),
      eq(agentSessions.orgId, args.orgId), eq(agentSessions.ownerType, args.owner.type), eq(agentSessions.ownerId, args.owner.id))).limit(1);
    if (!row || row.status === "deleted") throw new Error("The original session is unavailable. Start a new conversation.");
    session = await deps.engineHost.sessionFor(row.id, await loadSessionMeta(deps.db, row));
  } else {
    ({ session } = await ensureAssistantExecution(deps, args.owner, {
      actorUserId: args.actorUserId, orgId: args.orgId,
    }, args.threadKey));
  }
  const key = `${session.id}:${args.threadKey}`;
  const prior = deliveryChains.get(key) ?? Promise.resolve();
  const run = prior.then(() => deliverToAssistantThreadInner(deps, args, session));
  // The stored tail swallows the failure (the caller gets it from `run`) and
  // removes itself once it is still the tail, so the map does not keep one
  // settled promise per thread ever delivered to.
  const tail: Promise<void> = run
    .catch(() => undefined)
    .then(() => {
      if (deliveryChains.get(key) === tail) deliveryChains.delete(key);
    });
  deliveryChains.set(key, tail);
  return run;
}

/** Recover an existing admission without resubmitting or replaying its tools. */
async function recoverAdmittedEvent(deps: AssistantDeliveryDeps, args: AssistantDeliveryArgs): Promise<boolean> {
  const result = await deps.db.execute(sql`
    SELECT q.id, q.session_id, q.thread_id, q.content, q.status, s.owner_type, s.owner_id
    FROM engine_queue_items q JOIN agent_sessions s ON s.id = q.session_id
    WHERE q.dispatch_id = ${args.dispatchId} AND s.org_id = ${args.orgId}
    LIMIT 2`) as { rows: Array<{ id: string; session_id: string; thread_id: string; content: unknown; status: string; owner_type: string; owner_id: string }> };
  if (result.rows.length === 0) return false;
  if (result.rows.length !== 1) throw new Error("This event has multiple admitted submissions. Inspect the original submissions before retrying delivery.");
  const prior = result.rows[0]!;
  if (prior.owner_type !== args.owner.type || prior.owner_id !== args.owner.id) {
    throw new Error("The original event owner differs from this delivery. Inspect its subscription before retrying delivery.");
  }
  const content: unknown = typeof prior.content === "string" ? JSON.parse(prior.content) : prior.content;
  if (typeof content !== "object" || content === null || !("body" in content) || typeof content.body !== "string") {
    throw new Error("The original event submission has different content. Inspect its receipt before retrying delivery.");
  }
  // First channel admissions include fetched history. Compare the original
  // signal beneath that known wrapper without fetching mutable history again.
  const body = content.body === args.signal.body ? content.body
    : content.body.startsWith("Conversation so far in this thread:\n") && content.body.endsWith(`\n\n---\n\n${args.signal.body}`)
      ? args.signal.body : content.body;
  const expected: unknown = JSON.parse(JSON.stringify({ ...args.signal, tagName: args.signal.tagName ?? "signal" }));
  const tagName = "tagName" in content ? content.tagName ?? "signal" : "signal";
  if (!isDeepStrictEqual({ ...content, body, tagName }, expected)) {
    throw new Error("The original event submission has different content. Inspect its receipt before retrying delivery.");
  }
  if (prior.status !== "settled") {
    const [row] = await deps.db.select().from(agentSessions).where(and(eq(agentSessions.id, prior.session_id), eq(agentSessions.orgId, args.orgId))).limit(1);
    if (!row || row.status === "deleted") throw new Error("The original event session was deleted. Inspect its submission before retrying delivery.");
    // Session recovery already owns queued, interrupted, and approval-blocked
    // work. Restoring it never requires another prompt admission here.
    await deps.engineHost.sessionFor(row.id, await loadSessionMeta(deps.db, row));
  }
  if (args.inbound) await recordChannelMessage(deps.db, {
    ...args.inbound, orgId: args.orgId, sessionId: prior.session_id, threadId: prior.thread_id, direction: "in",
  });
  return true;
}

async function deliverToAssistantThreadInner(
  deps: AssistantDeliveryDeps,
  args: AssistantDeliveryArgs,
  session: Session,
): Promise<void> {
  const data = await session.toData();
  if (data.orgId !== args.orgId) {
    await writeDropLog(deps.db, {
      orgId: args.orgId,
      reason: args.mismatchReason,
      conversationKey: args.dispatchId,
      detail: `assistant session ${session.id} belongs to org ${data.orgId}, delivery belongs to org ${args.orgId}`,
    });
    throw new Error(`delivery refused: assistant org mismatch (${data.orgId} != ${args.orgId})`);
  }
  const thread = args.target ? session.threadById(args.target.threadId) : await deps.engineHost.ensureFreshThread(session, args.threadKey, {
    userId: data.userId,
    orgId: data.orgId,
    workspace: data.workspace,
  }, args.actorUserId);
  if (!thread) throw new Error("The original thread is unavailable. Restore it before retrying delivery.");
  let signal = args.signal;
  // On the assistant's FIRST turn in a channel thread, prepend the thread's
  // earlier messages so it participates in the group conversation with full
  // context instead of the lone trigger message. Later messages already stream
  // in on the same thread, so a thread that already has entries never re-seeds.
  // "First" is entries AND unsettled submissions both empty: an admitted-but-
  // unclaimed submission has written no entry yet, and a second mention racing
  // it must not seed the transcript a second time. (In-process ordering is
  // handled by the per-thread chain in `deliverToAssistantThread`; the
  // submission check covers an api restart between admit and claim.)
  if (deps.fetchThreadContext && signal.origin) {
    const store = session.providers.store;
    const existing = await store.getEntries(session.id, thread.id);
    if (existing.length === 0) {
      const unsettled = await store.listUnsettledSubmissions(session.id);
      if (!unsettled.some((item) => item.threadId === thread.id)) {
        const transcript = await deps.fetchThreadContext(signal.origin);
        if (transcript) {
          signal = { ...signal, body: `Conversation so far in this thread:\n${transcript}\n\n---\n\n${signal.body}` };
        }
      }
    }
  }
  if (args.target) {
    const result = await deps.db.execute(sql`
      SELECT s.id FROM agent_sessions s
      JOIN engine_threads t ON t.session_id = s.id AND t.id = ${args.target.threadId}
      LEFT JOIN session_threads m ON m.session_id = s.id AND m.id = t.id
      LEFT JOIN assistant_executions x ON x.session_id = s.id
      LEFT JOIN assistants a ON a.id = x.assistant_id
      LEFT JOIN engine_threads g ON g.session_id = a.session_id AND g.id = x.governing_thread_id
      LEFT JOIN session_threads gm ON gm.session_id = a.session_id AND gm.id = g.id
      WHERE s.id = ${args.target.sessionId} AND s.org_id = ${args.orgId} AND s.status <> 'deleted'
        AND s.owner_type = ${args.owner.type} AND s.owner_id = ${args.owner.id} AND m.archived_at IS NULL
        AND (x.session_id IS NULL OR (a.archived_at IS NULL AND g.id IS NOT NULL AND gm.archived_at IS NULL))
      LIMIT 1`) as { rows: Array<{ id: string }> };
    if (!result.rows.length) throw new Error("The original conversation was archived or deleted. Restore it before retrying delivery.");
  }
  await thread.submitPrompt(signal, {
    dispatchId: args.dispatchId,
    author: args.author ?? { id: args.actorUserId },
  });
  if (args.inbound) {
    await recordChannelMessage(deps.db, {
      ...args.inbound, orgId: args.orgId, sessionId: session.id, threadId: thread.id, direction: "in",
    });
  }
}
