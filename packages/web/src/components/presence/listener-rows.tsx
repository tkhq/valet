/**
 * Listener rows for the place page and the **All listeners** table: each
 * listener reads as its Part C sentence and opens the listener page
 * (docs/specs/2026-10-16-presence-hub-design.md Part C step 1).
 */
import { Link } from "@tanstack/react-router";
import type { EventSubscriptionWire } from "@valet/api/wire";
import { usePinnedThreadTitles } from "~/api/presence";
import { useTriggerCatalog, useWorkflows } from "~/api/workflows";
import { Badge, WorkRow } from "~/components/primitives";
import { ProblemBadge } from "./problem-badge";
import { listenerSentence, type ThreadTitles } from "./sentences";

/**
 * The sentence for each listener. It reads the event picker's labels, the
 * workflow names, and the titles of pinned threads. `knownThreads` adds
 * titles the caller already has, such as a place page's threads.
 */
export function useListenerSentence(
  listeners: readonly EventSubscriptionWire[],
  knownThreads: ThreadTitles = {},
): (sub: EventSubscriptionWire) => string {
  const catalog = useTriggerCatalog();
  const workflows = useWorkflows();
  const pinned = usePinnedThreadTitles(listeners);
  const threads: ThreadTitles = { ...knownThreads, ...pinned };
  const workflowNames = workflows.data?.workflows ?? [];
  return (sub) => listenerSentence(sub, catalog.data?.catalog, workflowNames, threads);
}

/** A paused listener says so beside its sentence. */
export function PausedBadge({ sub }: { sub: EventSubscriptionWire }) {
  return sub.enabled ? null : <Badge variant="neutral">Paused</Badge>;
}

/** A listener's badges in every list: paused, and a problem such as an
 * archived pinned thread (spec Part C step 5). */
export function ListenerBadges({ sub }: { sub: EventSubscriptionWire }) {
  if (sub.enabled && !sub.problem) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <PausedBadge sub={sub} />
      <ProblemBadge problem={sub.problem} />
    </span>
  );
}

/** One listener as a work row: the sentence, linked to the listener page. */
export function ListenerRow({ sub, sentence }: { sub: EventSubscriptionWire; sentence: string }) {
  return (
    <WorkRow
      title={<Link to="/presence/listeners/$id" params={{ id: sub.id }}>{sentence}</Link>}
      badge={<ListenerBadges sub={sub} />}
      detail={sub.name}
    />
  );
}
