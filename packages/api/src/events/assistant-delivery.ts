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
import type { ChannelOrigin, Principal, SignalContent } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { EngineHost } from "../engine/host.js";
import { ensureDefaultAssistantSession } from "../assistants/service.js";
import { writeDropLog } from "../orchestrator/signals.js";

export async function deliverToAssistantThread(
  deps: {
    db: AppDb;
    engineHost: EngineHost;
    /**
     * Seed a channel thread's earlier messages on the assistant's FIRST turn in
     * it. Wired only on the mention path (`orchestrator-target`); the follow
     * path never delivers first, so it leaves this unset.
     */
    fetchThreadContext?: (origin: ChannelOrigin) => Promise<string | null>;
  },
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
  const thread = session.thread(args.threadKey);
  let signal = args.signal;
  // On the assistant's FIRST turn in a channel thread, prepend the thread's
  // earlier messages so it participates in the group conversation with full
  // context instead of the lone trigger message. Later messages already stream
  // in on the same thread, so a thread that already has entries never re-seeds.
  if (deps.fetchThreadContext && signal.origin) {
    const existing = await session.providers.store.getEntries(session.id, thread.id);
    if (existing.length === 0) {
      const transcript = await deps.fetchThreadContext(signal.origin);
      if (transcript) {
        signal = { ...signal, body: `Conversation so far in this thread:\n${transcript}\n\n---\n\n${signal.body}` };
      }
    }
  }
  await thread.submitPrompt(signal, { dispatchId: args.dispatchId });
}
