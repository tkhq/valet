/**
 * The dispatcher's orchestrator delivery target: get-or-create the
 * subscription owner's orchestrator session and submit the event as a
 * `SignalContent` prompt on its "events" thread — same delivery path
 * `ChannelHost.handleMessage` uses for inbound channel messages.
 * `dispatchId` (`event:{deliveryId}`) makes the submit idempotent across
 * delivery retries.
 */
import type { AppDb } from "../lib/drizzle.js";
import type { EngineHost } from "../engine/host.js";
import { ensureOrchestratorSession } from "../orchestrator/ensure.js";
import type { OrchestratorDeliverFn } from "./dispatcher.js";

export function buildOrchestratorTarget(deps: { db: AppDb; engineHost: EngineHost }): OrchestratorDeliverFn {
  return async ({ orgId, ownerType, ownerId, signal, dispatchId }) => {
    const { session } = await ensureOrchestratorSession(
      { db: deps.db, engineHost: deps.engineHost },
      { type: ownerType, id: ownerId },
      { actorUserId: ownerId, orgId },
    );
    await session.thread("events").submitPrompt(signal, { dispatchId });
  };
}
