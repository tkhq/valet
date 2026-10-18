/**
 * Rows for the lines of presence on the overview, a place page, and the workflow drawer:
 * each line reads as its Part C sentence and opens its page
 * (docs/specs/2026-10-16-presence-hub-design.md Part C step 2, Part D).
 */
import { Link } from "@tanstack/react-router";
import type { EventSubscriptionWire } from "@valet/api/wire";
import type { AssistantThreadPolicy } from "@valet/shared";
import { usePinnedThreadTitles } from "~/api/rule";
import { useTriggerCatalog, useWorkflows } from "~/api/workflows";
import { Badge, WorkRow } from "~/components/primitives";
import { ProblemBadge } from "./problem-badge";
import { presenceSentence, type PresenceSentenceOptions, type ThreadTitles } from "./sentences";

/**
 * The sentence for each line of presence. It reads the event picker's labels, the
 * workflow names, and the titles of pinned threads. `knownThreads` adds
 * titles the caller already has, such as a place page's threads. The
 * returned function takes `presenceSentence` options, such as `{ place:
 * false }` for a row under an overview block.
 */
export function usePresenceSentence(
  subs: readonly EventSubscriptionWire[],
  knownThreads: ThreadTitles = {},
): (sub: EventSubscriptionWire, options?: PresenceSentenceOptions) => string {
  const catalog = useTriggerCatalog();
  const workflows = useWorkflows();
  const pinned = usePinnedThreadTitles(subs.map((sub) => (sub.target.kind === "assistant" ? sub.target.thread : undefined)));
  const threads: ThreadTitles = { ...knownThreads, ...pinned };
  const workflowNames = workflows.data?.workflows ?? [];
  return (sub, options) => presenceSentence(sub, catalog.data?.catalog, workflowNames, threads, options);
}

/** Coverage copy for a personal line that a team line paused (Part C step 3). */
export const PAUSED_BY_TEAM = "Paused: the team already listens for this.";

/** True when a team line paused this personal line. */
export function pausedByTeam(sub: EventSubscriptionWire): boolean {
  return !sub.enabled && sub.target.kind === "assistant" && sub.target.overlapPausedAt !== undefined;
}

/** Mirrors the server's mutation gate for a personal line: only its owner
 * changes it. The server checks a team or org line, and names the problem
 * when it refuses. */
export function lineReadOnly(sub: EventSubscriptionWire, meId: string | undefined): boolean {
  return sub.ownerType === "user" && meId !== undefined && sub.ownerId !== meId;
}

/** The workspace key whose threads the picker lists: `user` or a team id.
 * The org assistant has no thread list here. */
export function lineWorkspace(sub: EventSubscriptionWire): string | undefined {
  if (sub.ownerType === "user") return "user";
  if (sub.ownerType === "team") return sub.ownerId;
  return undefined;
}

/** The thread policy a line stores, for an assistant target. */
export function storedPolicy(sub: EventSubscriptionWire): AssistantThreadPolicy | undefined {
  return sub.target.kind === "assistant" ? sub.target.thread ?? undefined : undefined;
}

/** The title of a line's pinned thread, when it pins one and the title is known. */
export function pinnedTitle(sub: EventSubscriptionWire, titles: ThreadTitles): string | undefined {
  const pin = storedPolicy(sub);
  return pin?.mode === "existing" ? titles[pin.threadId]?.title ?? undefined : undefined;
}

/** True when a line sets an appearance: a display name or an avatar. */
export function hasAppearance(sub: EventSubscriptionWire): boolean {
  const appearance = sub.target.appearance;
  return Boolean(appearance?.displayName?.trim() || appearance?.avatarUrl?.trim());
}

/** The name a line appears as. A line that sets only an avatar appears as Valet. */
export function appearanceName(sub: EventSubscriptionWire): string {
  return sub.target.appearance?.displayName?.trim() || "Valet";
}

/** What a workflow target or an assistant target does, for the edit dialog's read-only line. */
export function targetLabel(sub: EventSubscriptionWire, workflowName: string | undefined): string {
  if (sub.target.kind === "workflow") return `Runs ${workflowName ?? "a workflow"}`;
  if (sub.target.assistant === "org") return "The organization's assistant";
  if (sub.target.assistant === "team") return "The team's assistant";
  return "Your assistant";
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
