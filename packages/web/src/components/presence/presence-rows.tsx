/**
 * Rows for the lines of presence on a place page and in the workflow drawer:
 * each line reads as its Part C sentence and opens its page
 * (docs/specs/2026-10-16-presence-hub-design.md Part C step 2, Part D).
 */
import { Link } from "@tanstack/react-router";
import type { EventSubscriptionWire } from "@valet/api/wire";
import { usePinnedThreadTitles } from "~/api/rule";
import { useTriggerCatalog, useWorkflows } from "~/api/workflows";
import { Badge, WorkRow } from "~/components/primitives";
import { ProblemBadge } from "./problem-badge";
import { presenceSentence, type ThreadTitles } from "./sentences";

/**
 * The sentence for each line of presence. It reads the event picker's labels, the
 * workflow names, and the titles of pinned threads. `knownThreads` adds
 * titles the caller already has, such as a place page's threads.
 */
export function usePresenceSentence(
  subs: readonly EventSubscriptionWire[],
  knownThreads: ThreadTitles = {},
): (sub: EventSubscriptionWire) => string {
  const catalog = useTriggerCatalog();
  const workflows = useWorkflows();
  const pinned = usePinnedThreadTitles(subs.map((sub) => (sub.target.kind === "assistant" ? sub.target.thread : undefined)));
  const threads: ThreadTitles = { ...knownThreads, ...pinned };
  const workflowNames = workflows.data?.workflows ?? [];
  return (sub) => presenceSentence(sub, catalog.data?.catalog, workflowNames, threads);
}

/** A paused line says so beside its sentence. */
export function PausedBadge({ sub }: { sub: EventSubscriptionWire }) {
  return sub.enabled ? null : <Badge variant="neutral">Paused</Badge>;
}

/** A line's badges in every list: paused, and a problem such as an
 * archived pinned thread (spec Part C step 5). */
export function PresenceBadges({ sub }: { sub: EventSubscriptionWire }) {
  if (sub.enabled && !sub.problem) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <PausedBadge sub={sub} />
      <ProblemBadge problem={sub.problem} />
    </span>
  );
}

/** One line of presence as a work row: the sentence, linked to its page. */
export function PresenceRow({ sub, sentence }: { sub: EventSubscriptionWire; sentence: string }) {
  return (
    <WorkRow
      title={<Link to="/presence/rules/$id" params={{ id: sub.id }}>{sentence}</Link>}
      badge={<PresenceBadges sub={sub} />}
      detail={sub.name}
    />
  );
}
