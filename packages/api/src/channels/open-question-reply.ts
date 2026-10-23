/**
 * A person's reply in a channel thread answers the thread's open question (a
 * question Valet asked with no options to click), instead of waiting in the
 * queue behind the turn that asked it. The reply needs the same right as a
 * click on that thread's cards: the person may resolve the session's gates.
 */
import { eq, sql } from "drizzle-orm";
import type { Session, Thread } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { userPrincipal } from "../lib/request-principal.js";
import { agentSessions } from "../schema/index.js";
import { canResolveSessionGate, gateApprover } from "../services/session-access.js";
import { HOME_THREAD_KEY } from "../home/context.js";

export interface OpenQuestionReply {
  session: Session;
  thread: Thread;
  /** The Valet user who wrote the reply. */
  userId: string;
  text: string;
  channelType: string;
  channelId: string;
  /** The inbound message's dispatch id. A replay of an answered reply finds it on the gate. */
  dispatchId: string;
  now: number;
}

/**
 * True when this inbound message answered a gate. Dispatch ids are the
 * transport's event ids, so a replay after a restart, when no card or thread
 * points at the gate any more, still finds it.
 */
export async function replyAnswered(db: AppDb, dispatchId: string): Promise<boolean> {
  const rows = await db.execute(sql`SELECT 1 FROM engine_decision_gates
    WHERE status = 'resolved' AND resolution::jsonb -> 'source' ->> 'messageId' = ${dispatchId} LIMIT 1`) as { rows: unknown[] };
  return rows.rows.length > 0;
}

/**
 * Answers the thread's pending open question with `text`. Returns true when
 * the reply was the answer (now or on an earlier delivery of the same
 * message), and false when the caller should submit it as a message.
 */
export async function answerOpenQuestion(db: AppDb, reply: OpenQuestionReply): Promise<boolean> {
  const text = reply.text.trim();
  if (!text) return false;
  if (await replyAnswered(db, reply.dispatchId)) return true;
  // A question with options keeps its buttons. A gate that names one approver
  // (a shared account) answers to that person on their own card.
  let gate: ReturnType<Thread["pendingDecisionGates"]>[number] | undefined;
  for (const candidate of reply.thread.pendingDecisionGates()) {
    if (candidate.type !== "question" || candidate.actions.length !== 0 || gateApprover(candidate)) continue;
    if (reply.thread.key === HOME_THREAD_KEY) {
      const source = await reply.session.providers.store.getQueueItem(reply.session.id, candidate.queueItemId);
      if (source?.channel?.channelType !== reply.channelType || source.channel.channelId !== reply.channelId) continue;
    }
    gate = candidate;
    break;
  }
  if (!gate) return false;
  const [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, reply.session.id)).limit(1);
  if (!row || !(await canResolveSessionGate(db, row, userPrincipal(reply.userId)))) return false;
  try {
    await reply.session.resolveDecision(gate.id, {
      value: text,
      resolvedBy: reply.userId,
      resolvedAt: reply.now,
      source: { channelType: reply.channelType, channelId: reply.channelId, messageId: reply.dispatchId },
    });
  } catch (err) {
    console.warn(`[channels] reply could not answer open question ${gate.id}; it goes in as a message`, err);
    return false;
  }
  // Resolving a gate another answer already settled does not throw. The
  // stored resolution says whether this reply is the answer; when it is not,
  // the reply goes in as a message.
  return replyAnswered(db, reply.dispatchId);
}

/**
 * The card a Slack reply hangs under. A reply under a card carries the card's
 * own timestamp as its thread root, so the reply's conversation key ends with
 * the card's message id and shares the card's channel. `refs` maps
 * `<conversationKey>#<messageId>` to the card's gate.
 */
export function cardForReply<T>(refs: Iterable<[string, T]>, conversationKey: string): T | undefined {
  const cut = conversationKey.lastIndexOf(":");
  if (cut < 0) return undefined;
  const channel = conversationKey.slice(0, cut + 1);
  const root = conversationKey.slice(cut + 1);
  for (const [key, gate] of refs) {
    const hash = key.lastIndexOf("#");
    if (key.slice(hash + 1) === root && key.slice(0, hash).startsWith(channel)) return gate;
  }
  return undefined;
}
