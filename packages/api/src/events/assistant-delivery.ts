/**
 * The one way an event or a followed message is delivered to an owner's default
 * assistant: resolve the session, assert its org against the delivery's org
 * (the second-layer defense `admitSignal` would have provided — an event has no
 * sender session, so there is no edge to authorize), then submit the signal on
 * the named thread. Both the dispatcher's orchestrator target
 * (`orchestrator-target.ts`) and the follow-router (`channels/follow-router.ts`)
 * go through here, so the org check and delivery shape can never drift between
 * them.
 */
import type { Principal, SignalContent } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { EngineHost } from "../engine/host.js";
import { ensureDefaultAssistantSession } from "../assistants/service.js";
import { writeDropLog } from "../orchestrator/signals.js";

export async function deliverToAssistantThread(
  deps: { db: AppDb; engineHost: EngineHost },
  args: {
    orgId: string;
    owner: Principal;
    actorUserId: string;
    threadKey: string;
    signal: SignalContent;
    dispatchId: string;
    /** Drop-log reason if the resolved assistant belongs to another org. */
    mismatchReason: string;
  },
): Promise<void> {
  const { session } = await ensureDefaultAssistantSession(deps, args.owner, {
    actorUserId: args.actorUserId,
    orgId: args.orgId,
  });
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
  await session.thread(args.threadKey).submitPrompt(args.signal, { dispatchId: args.dispatchId });
}
