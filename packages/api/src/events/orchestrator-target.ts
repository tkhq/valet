/**
 * The dispatcher's orchestrator delivery target: get-or-create the
 * subscription owner's DEFAULT assistant session and submit the event as a
 * `SignalContent` prompt on its "events" thread — same delivery path
 * `ChannelHost.handleMessage` uses for inbound channel messages.
 * `dispatchId` (`event:{deliveryId}`) makes the submit idempotent across
 * delivery retries.
 *
 * Why not `admitSignal`: its edge ACL authorizes SESSION -> session edges
 * (parent/child, orchestrator -> orchestrator) and requires a live sender
 * session — an event delivery has no sender session, so there is no edge
 * vocabulary for it (the channel ingress has the same shape and also
 * submits directly). The second-layer defense `admitSignal` would have
 * provided is replicated here: before submitting, the resolved session's
 * durable org is asserted against the event's org, and a mismatch is
 * drop-logged (`event_drop_log`, reason `event_target_mismatch`) and
 * thrown instead of delivered — a subscription-matching bug can't silently
 * deliver an event into another org's assistant.
 */
import type { SignalContent } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { EngineHost } from "../engine/host.js";
import { ensureDefaultAssistantSession } from "../assistants/service.js";
import { writeDropLog } from "../orchestrator/signals.js";
import type { OrchestratorDeliverFn } from "./dispatcher.js";

/**
 * The thread a non-channel event delivery lands on — the owner's default
 * assistant "events" firehose. Named so the outbound reply path can recognise
 * it without a magic string (`ChannelHost.deliverAssistantMessage`).
 */
export const EVENTS_THREAD_KEY = "events";

/**
 * Which assistant thread an event signal lands on. A channel-originated signal
 * binds to a thread keyed by its Slack thread (`slack:{channel}:{threadTs}`),
 * so one Slack thread maps to one assistant thread: a top-level mention opens a
 * new thread, and a later message in the same Slack thread routes to the same
 * one. Everything else (GitHub, Linear, a timer) shares the "events" firehose.
 */
export function threadKeyForSignal(signal: SignalContent): string {
  return signal.origin?.threadKey ?? EVENTS_THREAD_KEY;
}

export function buildOrchestratorTarget(deps: { db: AppDb; engineHost: EngineHost }): OrchestratorDeliverFn {
  return async ({ orgId, ownerType, ownerId, actorUserId, signal, dispatchId }) => {
    // A subscription names an OWNER, never one assistant of that owner, so
    // this resolves the owner's default — the target automation gets when
    // nobody chose.
    const { session } = await ensureDefaultAssistantSession(
      { db: deps.db, engineHost: deps.engineHost },
      { type: ownerType, id: ownerId },
      { actorUserId, orgId },
    );
    const data = await session.toData();
    if (data.orgId !== orgId) {
      await writeDropLog(deps.db, {
        orgId,
        reason: "event_target_mismatch",
        conversationKey: dispatchId,
        detail: `assistant session ${session.id} belongs to org ${data.orgId}, event belongs to org ${orgId}`,
      });
      throw new Error(`event delivery refused: assistant org mismatch (${data.orgId} != ${orgId})`);
    }
    await session.thread(threadKeyForSignal(signal)).submitPrompt(signal, { dispatchId });
  };
}
