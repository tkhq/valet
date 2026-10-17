import { UNATTENDED_DELIVERY_KEY, type Presence } from "@valet/shared";
/**
 * The one way an event or a followed message is delivered to an assistant:
 * resolve the session, assert its org against the delivery's org (the
 * second-layer defense `admitSignal` would have provided — an event has no
 * sender session, so there is no edge to authorize), then submit the signal on
 * its destination thread. The dispatcher's assistant target
 * (`assistant-target.ts`), the scheduler, and the follow-router
 * (`channels/follow-router.ts`)
 * go through here, so the org check and delivery shape can never drift between
 * them.
 *
 * The workspace owner determines the assistant.
 */
import { isDeepStrictEqual } from "node:util";
import type { ChannelOrigin, Principal, PromptAuthor, Session, SignalContent, Thread } from "@valet/engine";
import { ensureAssistantExecution, loadAssistantBySessionId } from "../assistants/service.js";
import type { EngineHost } from "../engine/host.js";
import { and, eq, sql } from "drizzle-orm";
import { agentSessions, assistantExecutions, assistants, type AssistantRow } from "../schema/index.js";
import { SLACK_CHANNELS_METADATA_KEY } from "../services/thread-access.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import type { AppDb } from "../lib/drizzle.js";
import { writeDropLog } from "../orchestrator/signals.js";
import { recordChannelMessage, type InboundChannelMessage } from "../services/channel-messages.js";
import type { DestinationReason } from "./destination.js";
import { reopenThread, seedThreadTitle } from "./delivery-thread.js";

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
   * it. Wired only on the mention path (`assistant-target`); the follow
   * path never delivers first, so it leaves this unset.
   */
  fetchThreadContext?: (origin: ChannelOrigin) => Promise<string | null>;
}

/**
 * Where one delivery lands. A `key` resolves to a thread only at delivery
 * time, and creates it with `title` when it is new (spec Part B step 3). A
 * `target` names a thread that already exists. A resolver `Destination`
 * other than a skip fits this type.
 */
export type DeliveryDestination =
  | { kind: "key"; key: string; title?: string }
  | { kind: "target"; sessionId: string; threadId: string; reason?: DestinationReason };

/** The dead-letter text for an `existing` pin that cannot receive a delivery (spec Part B step 4). */
export const PIN_UNAVAILABLE_MESSAGE = "Pick another thread for this rule in Presence.";

/** A rule's pinned thread is archived, deleted, or outside the owner's live runtime. */
export class PinUnavailableError extends Error {
  constructor() {
    super(PIN_UNAVAILABLE_MESSAGE);
    this.name = "PinUnavailableError";
  }
}

/** The thread a delivery landed in. `recovered` marks a retry that found
 * the delivery already admitted and submitted nothing new. */
export interface DeliveredThread {
  sessionId: string;
  threadId: string;
  recovered?: true;
}

export interface AssistantDeliveryArgs {
  orgId: string;
  owner: Principal;
  actorUserId: string;
  destination: DeliveryDestination;
  signal: SignalContent;
  presence?: Presence;
  /**
   * No person waits on this delivery: an automated event or a schedule. Its
   * turn refuses questions and approvals at once instead of parking the
   * thread, so one stuck delivery cannot hold back the ones queued after it.
   */
  unattended?: boolean;
  dispatchId: string;
  /** Drop-log reason if the resolved assistant belongs to another org. */
  mismatchReason: string;
  /** The channel message this delivery carries, recorded once it lands. */
  inbound?: InboundChannelMessage;
  /** Who wrote the message, when that is not `actorUserId` (`newcomerAuthor`). */
  author?: PromptAuthor;
  /** The Slack channel this delivery's content came from. The thread records
   * it, so the channel's privacy gates reads of the thread whatever its key
   * (`services/thread-access.ts`). */
  slackChannel?: string;
}

/** The assistant row of `sessionId` for `orgId` and `owner`, when it is live
 * and not archived. `deliverToAssistantThread`'s explicit-target check and
 * `isDeliverableTarget` below share it. */
async function resolveLiveAssistant(
  db: AppDb,
  orgId: string,
  owner: Principal,
  sessionId: string,
): Promise<AssistantRow | undefined> {
  const assistant = await loadAssistantBySessionId(db, sessionId);
  if (!assistant || assistant.archivedAt !== null || assistant.orgId !== orgId
    || assistant.ownerType !== owner.type || assistant.ownerId !== owner.id) {
    return undefined;
  }
  return assistant;
}

/** True when `target`'s thread is live. The session is not deleted and the
 * thread is not archived. For an execution session, its assistant and
 * governing thread are not archived either. `deliverToAssistantThread`'s
 * pre-submit check and `isDeliverableTarget` below share it. */
async function isTargetThreadLive(
  db: AppDb,
  orgId: string,
  owner: Principal,
  target: { sessionId: string; threadId: string },
): Promise<boolean> {
  const result = await db.execute(sql`
      SELECT s.id FROM agent_sessions s
      JOIN engine_threads t ON t.session_id = s.id AND t.id = ${target.threadId}
      LEFT JOIN session_threads m ON m.session_id = s.id AND m.id = t.id
      LEFT JOIN assistant_executions x ON x.session_id = s.id
      LEFT JOIN assistants a ON a.id = x.assistant_id
      LEFT JOIN engine_threads g ON g.session_id = a.session_id AND g.id = x.governing_thread_id
      LEFT JOIN session_threads gm ON gm.session_id = a.session_id AND gm.id = g.id
      WHERE s.id = ${target.sessionId} AND s.org_id = ${orgId} AND s.status <> 'deleted'
        AND s.owner_type = ${owner.type} AND s.owner_id = ${owner.id} AND m.archived_at IS NULL
        AND (x.session_id IS NULL OR (a.archived_at IS NULL AND g.id IS NOT NULL AND gm.archived_at IS NULL))
      LIMIT 1`) as { rows: Array<{ id: string }> };
  return result.rows.length > 0;
}

/**
 * True when `target` would resolve for `deliverToAssistantThread`. The
 * session names a live, non-archived assistant or execution of `owner` in
 * `orgId`, and its thread is not archived. Incident mention routing
 * (`watching-waiter.ts`) reuses this gate. It never chooses a watching
 * waiter that would dead-letter here.
 */
export async function isDeliverableTarget(
  deps: { db: AppDb },
  orgId: string,
  owner: Principal,
  target: { sessionId: string; threadId: string },
): Promise<boolean> {
  if (!(await resolveLiveAssistant(deps.db, orgId, owner, target.sessionId))) return false;
  return isTargetThreadLive(deps.db, orgId, owner, target);
}

/**
 * Deliver `args.signal` to its destination and return the thread it landed
 * in. A pinned `existing` target that fails `isDeliverableTarget` throws
 * `PinUnavailableError` before any thread is resolved, so a dead-letter
 * creates no thread (INV-D3).
 */
export async function deliverToAssistantThread(
  deps: AssistantDeliveryDeps,
  args: AssistantDeliveryArgs,
): Promise<DeliveredThread> {
  // A delivery can outlive a routing upgrade. The admitted dispatch belongs
  // to its original runtime, even if today's route selects another one.
  if (args.dispatchId.startsWith("event:")) {
    const recovered = await recoverAdmittedEvent(deps, args);
    if (recovered) return recovered;
  }
  const destination = args.destination;
  // Serialize by runtime session and thread so delivery paths share one queue.
  let session: Session;
  if (destination.kind === "target") {
    // A pin never falls back to another mode (spec Part B step 4).
    if (destination.reason === "policy_existing" && !(await isDeliverableTarget(deps, args.orgId, args.owner, destination))) {
      throw new PinUnavailableError();
    }
    if (!(await resolveLiveAssistant(deps.db, args.orgId, args.owner, destination.sessionId))) {
      throw new Error("The original conversation is unavailable. Restore its owner before retrying delivery.");
    }
    const [row] = await deps.db.select().from(agentSessions).where(and(eq(agentSessions.id, destination.sessionId),
      eq(agentSessions.orgId, args.orgId), eq(agentSessions.ownerType, args.owner.type), eq(agentSessions.ownerId, args.owner.id))).limit(1);
    if (!row || row.status === "deleted") throw new Error("The original session is unavailable. Start a new conversation.");
    session = await deps.engineHost.sessionFor(row.id, await loadSessionMeta(deps.db, row));
  } else {
    ({ session } = await ensureAssistantExecution(deps, args.owner, {
      actorUserId: args.actorUserId, orgId: args.orgId,
    }, destination.key, destination.title ? { title: destination.title } : undefined));
  }
  const key = `${session.id}:${destination.kind === "key" ? destination.key : `thread:${destination.threadId}`}`;
  const prior = deliveryChains.get(key) ?? Promise.resolve();
  const run = prior.then(() => deliverToAssistantThreadInner(deps, args, session));
  // The stored tail swallows the failure (the caller gets it from `run`) and
  // removes itself once it is still the tail, so the map does not keep one
  // settled promise per thread ever delivered to.
  const tail: Promise<void> = run
    .then(() => undefined, () => undefined)
    .then(() => {
      if (deliveryChains.get(key) === tail) deliveryChains.delete(key);
    });
  deliveryChains.set(key, tail);
  return run;
}

/** Recover an existing admission without resubmitting or replaying its tools.
 * Returns the thread the admission landed in, or null when none exists. */
async function recoverAdmittedEvent(deps: AssistantDeliveryDeps, args: AssistantDeliveryArgs): Promise<DeliveredThread | null> {
  const result = await deps.db.execute(sql`
    SELECT q.id, q.session_id, q.thread_id, q.content, q.status, s.owner_type, s.owner_id
    FROM engine_queue_items q JOIN agent_sessions s ON s.id = q.session_id
    WHERE q.dispatch_id = ${args.dispatchId} AND s.org_id = ${args.orgId}
    LIMIT 2`) as { rows: Array<{ id: string; session_id: string; thread_id: string; content: unknown; status: string; owner_type: string; owner_id: string }> };
  if (result.rows.length === 0) return null;
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
  return { sessionId: prior.session_id, threadId: prior.thread_id, recovered: true };
}

/**
 * Record a Slack channel on the delivery thread and, for a team execution
 * session, on its governing thread in the assistant's root session. The
 * team's thread list shows the governing thread, so it needs the same gate.
 */
async function recordSlackChannel(deps: AssistantDeliveryDeps, session: Session, thread: Thread, channel: string): Promise<void> {
  await thread.addToMetadataList(SLACK_CHANNELS_METADATA_KEY, channel);
  const [governing] = await deps.db.select({ sessionId: assistants.sessionId, threadId: assistantExecutions.governingThreadId })
    .from(assistantExecutions).innerJoin(assistants, eq(assistants.id, assistantExecutions.assistantId))
    .where(eq(assistantExecutions.sessionId, session.id)).limit(1);
  if (!governing) return;
  const [row] = await deps.db.select().from(agentSessions).where(eq(agentSessions.id, governing.sessionId)).limit(1);
  if (!row) return;
  const root = await deps.engineHost.sessionFor(row.id, await loadSessionMeta(deps.db, row));
  await root.threadById(governing.threadId)?.addToMetadataList(SLACK_CHANNELS_METADATA_KEY, channel);
}

async function deliverToAssistantThreadInner(
  deps: AssistantDeliveryDeps,
  args: AssistantDeliveryArgs,
  session: Session,
): Promise<DeliveredThread> {
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
  const destination = args.destination;
  const thread = destination.kind === "target" ? session.threadById(destination.threadId) : await deps.engineHost.ensureFreshThread(session, destination.key, {
    userId: data.userId,
    orgId: data.orgId,
    workspace: data.workspace,
  }, args.actorUserId, destination.title ? { title: destination.title } : undefined);
  if (!thread) throw new Error("The original thread is unavailable. Restore it before retrying delivery.");
  if (destination.kind === "key") {
    // A thread found by key reopens on delivery (spec Part B step 4), and a
    // new one shows its policy title in the thread list.
    if (destination.title) {
      await seedThreadTitle(deps.db, { sessionId: session.id, threadId: thread.id, createdAt: thread.toThreadData().createdAt }, destination.title);
    }
    await reopenThread(deps.db, session.id, thread.id);
  }
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
  if (destination.kind === "target") {
    if (!(await isTargetThreadLive(deps.db, args.orgId, args.owner, destination))) {
      throw new Error("The original conversation was archived or deleted. Restore it before retrying delivery.");
    }
  }
  // Record the content's Slack channel before the content lands, so a
  // reader outside a private channel never sees it (thread-access.ts).
  if (args.slackChannel) await recordSlackChannel(deps, session, thread, args.slackChannel);
  const metadata = {
    ...(args.presence ? { presence: args.presence } : {}),
    ...(args.unattended ? { [UNATTENDED_DELIVERY_KEY]: true } : {}),
  };
  await thread.submitPrompt(signal, {
    dispatchId: args.dispatchId,
    ...(Object.keys(metadata).length ? { metadata } : {}),
    author: args.author ?? { id: args.actorUserId },
  });
  if (args.inbound) {
    await recordChannelMessage(deps.db, {
      ...args.inbound, orgId: args.orgId, sessionId: session.id, threadId: thread.id, direction: "in",
    });
  }
  return { sessionId: session.id, threadId: thread.id };
}
