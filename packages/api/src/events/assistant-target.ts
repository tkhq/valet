/**
 * The dispatcher's assistant delivery target: submit the event as a
 * `SignalContent` prompt on the thread its resolved destination names
 * (spec 2026-10-16-delivery-threads-and-claims-design.md, Part B), on the
 * owner's assistant. This is the same delivery path that
 * `ChannelHost.handleMessage` uses for inbound channel messages.
 * `dispatchId` (`event:{deliveryId}`) makes the submit idempotent across
 * delivery retries.
 *
 * Why not `admitSignal`: its edge ACL authorizes SESSION -> session edges
 * (parent/child, assistant -> assistant) and requires a live sender
 * session. An event delivery has no sender session, so there is no edge
 * vocabulary for it (the channel ingress has the same shape and also
 * submits directly). `deliverToAssistantThread` replicates the second-layer
 * defense that `admitSignal` would give: before it submits, it compares the
 * resolved session's durable org with the event's org. A mismatch is
 * drop-logged (`event_drop_log`, reason `event_target_mismatch`) and thrown,
 * so a subscription-matching bug cannot deliver an event into another org's
 * assistant.
 */
import type { ChannelOrigin } from "@valet/engine";
import type { EngineHost } from "../engine/host.js";
import type { AppDb } from "../lib/drizzle.js";
import { deliverToAssistantThread } from "./assistant-delivery.js";
import type { AssistantDeliverFn } from "./dispatcher.js";

export function buildAssistantTarget(deps: {
  db: AppDb;
  engineHost: EngineHost;
  /** Seed a channel thread's earlier messages on the assistant's first turn. */
  fetchThreadContext?: (origin: ChannelOrigin) => Promise<string | null>;
}): AssistantDeliverFn {
  return async ({ orgId, ownerType, ownerId, actorUserId, signal, dispatchId, destination, inbound, author, presence, slackChannel }) =>
    // Every subscription resolves the singleton runtime of its owner.
    deliverToAssistantThread(deps, {
      orgId,
      owner: { type: ownerType, id: ownerId },
      actorUserId,
      destination,
      signal,
      ...(presence ? { presence } : {}),
      dispatchId,
      mismatchReason: "event_target_mismatch",
      ...(inbound ? { inbound } : {}),
      ...(author ? { author } : {}),
      ...(slackChannel ? { slackChannel } : {}),
    });
}
