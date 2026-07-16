/**
 * Wires the shared EventStream's producers into the attention router
 * (decision 19's "Wired producers"). Two subscriptions:
 *
 *  - `submission_stuck` → kind 'escalation', routed to the stuck session's
 *    own owner. Title names the session (its app-row title if one exists,
 *    otherwise the session id) and the thread.
 *  - `decision_gate` raised in a `purpose: 'child'` session → kind
 *    'approval', routed to the PARENT session's owner audience (decision
 *    19 / orchestrator spec "Approval routing" — a child's gate surfaces to
 *    whoever spawned the work, not the child itself, which has no
 *    independent audience). `href` points at the child session
 *    (`/sessions/{childSessionId}`, encoded — session ids contain colons).
 *
 * Subscribe callbacks must never throw back into the EventStream's fan-out
 * — every handler is wrapped in try/catch that logs and swallows.
 */
import { eq } from "drizzle-orm";
import type { DeliveredBusEvent, EventStream, SessionStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions } from "../schema/index.js";
import { routeAttention, type AttentionChannelDeliverer, type AttentionDeps } from "./attention.js";

export interface AttentionWiringDeps extends AttentionDeps {
  db: AppDb;
  engineStore: SessionStore;
  eventStream: EventStream;
  channels?: AttentionChannelDeliverer[];
}

async function sessionLabel(db: AppDb, sessionId: string): Promise<string> {
  const rows = await db
    .select({ title: agentSessions.title })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  const row = rows[0];
  return row?.title || sessionId;
}

async function handleSubmissionStuck(deps: AttentionWiringDeps, delivered: DeliveredBusEvent): Promise<void> {
  if (delivered.event.type !== "submission_stuck") return;
  const { sessionId, threadId, queueItemId } = delivered.event;

  const sessionData = await deps.engineStore.getSession(sessionId);
  if (!sessionData) return;

  const label = await sessionLabel(deps.db, sessionId);
  await routeAttention(deps, {
    kind: "escalation",
    urgency: "high",
    owner: sessionData.owner,
    sessionId,
    title: `Stuck submission in "${label}" (thread ${threadId})`,
    body: `Queue item ${queueItemId} hasn't settled after ${delivered.event.attemptCount} attempt(s).`,
    href: `/sessions/${encodeURIComponent(sessionId)}`,
    dedupeKey: queueItemId,
  });
}

async function handleDecisionGate(deps: AttentionWiringDeps, delivered: DeliveredBusEvent): Promise<void> {
  if (delivered.event.type !== "decision_gate") return;
  const childSessionId = delivered.sessionId;
  const { gate } = delivered.event;

  const childData = await deps.engineStore.getSession(childSessionId);
  if (!childData || childData.purpose !== "child" || !childData.parentSessionId) return;

  const parentData = await deps.engineStore.getSession(childData.parentSessionId);
  if (!parentData) return;

  await routeAttention(deps, {
    kind: "approval",
    urgency: "high",
    owner: parentData.owner,
    sessionId: childSessionId,
    title: gate.title,
    body: gate.body,
    href: `/sessions/${encodeURIComponent(childSessionId)}`,
    dedupeKey: gate.id,
  });
}

/**
 * Subscribes the wired producers above onto `deps.eventStream`. Call once
 * at boot (main.ts). Returns the combined unsubscribe.
 */
export function wireAttentionRouter(deps: AttentionWiringDeps): () => void {
  const unsubStuck = deps.eventStream.subscribe(
    { eventTypes: ["submission_stuck"] },
    (delivered) => {
      handleSubmissionStuck(deps, delivered).catch((err) => {
        console.error("attention router: submission_stuck handler failed:", err);
      });
    },
  );

  const unsubGate = deps.eventStream.subscribe({ eventTypes: ["decision_gate"] }, (delivered) => {
    handleDecisionGate(deps, delivered).catch((err) => {
      console.error("attention router: decision_gate handler failed:", err);
    });
  });

  return () => {
    unsubStuck();
    unsubGate();
  };
}
