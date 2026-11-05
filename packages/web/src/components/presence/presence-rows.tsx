/**
 * Rows for the lines of presence on the overview, a place page, and the workflow drawer:
 * each line reads as its Part C sentence and opens its page
 * (docs/specs/2026-10-16-presence-hub-design.md Part C step 2, Part D).
 */
import { Link } from "@tanstack/react-router";
import type { EventSubscriptionWire, PresencePlaceWire, TeamSummary } from "@valet/api/wire";
import type { AssistantThreadPolicy } from "@valet/shared";
import { usePinnedThreadTitles } from "~/api/rule";
import { useMe, useTeams } from "~/api/settings";
import { useTriggerCatalog, useWorkflows } from "~/api/workflows";
import { Badge, WorkRow } from "~/components/primitives";
import { ProblemBadge } from "./problem-badge";
import { partsText, presenceSentenceParts, type PresenceSentenceOptions, type SentencePart, type ThreadTitles } from "./sentences";
import { useSentenceNames } from "./use-sentence-names";

/**
 * The sentence for each line of presence. It reads the event picker's labels, the
 * workflow names, the org members' names, and the titles of pinned threads. `knownThreads` adds
 * titles the caller already has, such as a place page's threads. The
 * returned function takes `presenceSentence` options, such as `{ place:
 * false }` for a row under an overview block.
 */
export function usePresenceSentence(
  subs: readonly EventSubscriptionWire[],
  knownThreads: ThreadTitles = {},
): (sub: EventSubscriptionWire, options?: PresenceSentenceOptions) => string {
  const parts = usePresenceSentenceParts(subs, knownThreads);
  return (sub, options) => partsText(parts(sub, options));
}

/** The sentence for each line of presence as parts, for a row that shows
 * its places, threads, workflows, and people as tokens. See `usePresenceSentence`.
 * `knownPlaces` adds places the caller already has, such as a place page's
 * own channel, so a channel filter without a label reads its name. */
export function usePresenceSentenceParts(
  subs: readonly EventSubscriptionWire[],
  knownThreads: ThreadTitles = {},
  knownPlaces: readonly Pick<PresencePlaceWire, "subject" | "label">[] = [],
): (sub: EventSubscriptionWire, options?: PresenceSentenceOptions) => SentencePart[] {
  const catalog = useTriggerCatalog();
  const workflows = useWorkflows();
  const pinned = usePinnedThreadTitles(subs.map((sub) => (sub.target.kind === "assistant" ? sub.target.thread : undefined)));
  const threads: ThreadTitles = { ...knownThreads, ...pinned };
  const names = useSentenceNames(knownPlaces);
  const workflowNames = workflows.data?.workflows ?? [];
  return (sub, options) => presenceSentenceParts(sub, catalog.data?.catalog, workflowNames, threads, names, options);
}

/** The teams fields the gates and owner names read. A team the viewer
 * cannot see has no name here. */
export type TeamLike = Pick<TeamSummary, "id" | "callerRole"> & Partial<Pick<TeamSummary, "name">>;

/** A team's name, or `the team` when the viewer's team list does not name it. */
export function teamName(teams: readonly TeamLike[] | undefined, teamId: string): string {
  const name = teams?.find((team) => team.id === teamId)?.name?.trim();
  return name !== undefined && name.length > 0 ? name : "the team";
}

/** True when a team line paused this personal line. */
export function pausedByTeam(sub: EventSubscriptionWire): boolean {
  return !sub.enabled && sub.target.kind === "assistant" && sub.target.overlapPausedAt !== undefined;
}

/**
 * The team whose line paused this personal line, when the viewer's lines
 * name exactly one: an enabled team assistant line of the viewer's teams that
 * listens for one of the same events. The server does not record the team,
 * so more than one candidate reads as `the team`.
 */
export function pausingTeamId(
  sub: EventSubscriptionWire,
  subs: readonly EventSubscriptionWire[],
  teams: readonly TeamLike[] | undefined,
): string | undefined {
  const mine = new Set((teams ?? []).filter((team) => team.callerRole !== null).map((team) => team.id));
  const keys = new Set(sub.eventKeys);
  const owners = new Set(
    subs
      .filter((other) => other.ownerType === "team" && other.enabled && other.target.kind === "assistant" && mine.has(other.ownerId))
      .filter((other) => other.eventKeys.some((key) => keys.has(key)))
      .map((other) => other.ownerId),
  );
  return owners.size === 1 ? [...owners][0] : undefined;
}

/** Coverage copy for a personal line that a team line paused (Part C step 3). */
export function pausedByTeamText(team: string): string {
  return `Paused: ${team} already listens for this.`;
}

/**
 * Mirrors the server's mutation gate (`canMutateSubscription` in
 * packages/api/src/routes/events.ts): a personal line belongs to its owner,
 * a team line to the team's members, and any org member may change an org
 * line. Until the viewer or the teams load, the line reads as editable; the
 * server still refuses a change it does not allow.
 */
export function lineReadOnly(
  sub: Pick<EventSubscriptionWire, "ownerType" | "ownerId">,
  meId: string | undefined,
  teams: readonly TeamLike[] | undefined,
): boolean {
  if (sub.ownerType === "user") return meId !== undefined && sub.ownerId !== meId;
  if (sub.ownerType === "team") return teams !== undefined && !teams.some((team) => team.id === sub.ownerId && team.callerRole !== null);
  return false;
}

/** Who may change a line, for a viewer who may not. */
export function lineReadOnlyText(
  sub: Pick<EventSubscriptionWire, "ownerType" | "ownerId">,
  teams: readonly TeamLike[] | undefined,
): string {
  if (sub.ownerType === "team") return `Only members of ${teamName(teams, sub.ownerId)} can change this.`;
  return "Only its owner can change this.";
}

/** The viewer's access to a line: read-only or not, the words that say
 * who may change it, and the viewer's teams. */
export function useLineAccess(sub: EventSubscriptionWire): {
  readOnly: boolean;
  readOnlyText: string;
  teams: readonly TeamLike[] | undefined;
} {
  const me = useMe();
  const teamsQ = useTeams();
  const teams = teamsQ.data?.teams;
  return { readOnly: lineReadOnly(sub, me.data?.id, teams), readOnlyText: lineReadOnlyText(sub, teams), teams };
}

/**
 * True for a line the assistant proposed that no person has turned on yet.
 * The api stores a proposal off, with a `proposal-` id, and with `replaces`
 * when it updates another line. An enable clears `replaces`, and any edit
 * moves `updatedAt`, so a proposal with no `replaces` stops reading as one
 * once a person changed it.
 */
export function isProposal(sub: EventSubscriptionWire): boolean {
  if (sub.enabled) return false;
  if (sub.target.kind === "assistant" && sub.target.replaces !== undefined) return true;
  return sub.id.startsWith("proposal-") && sub.updatedAt === sub.createdAt;
}

/** The Delete confirm's description. A team or org line names its owner first. */
export function deleteLineDescription(
  sub: Pick<EventSubscriptionWire, "ownerType" | "ownerId">,
  teams: readonly TeamLike[] | undefined,
): string {
  const base = "Valet stops listening for this here. Its past activity stays.";
  if (sub.ownerType === "team") return `This is ${teamName(teams, sub.ownerId)}'s line. ${base}`;
  if (sub.ownerType === "org") return `This is the organization's line. ${base}`;
  return base;
}

/** A team or org line says whose it is. A personal line shows nothing. */
export function OwnerBadge({ ownerType }: { ownerType: "user" | "team" | "org" }) {
  if (ownerType === "user") return null;
  return <Badge variant="neutral">{ownerType === "team" ? "Team" : "Org"}</Badge>;
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

/** A paused line says so beside its sentence. */
export function PausedBadge({ sub }: { sub: EventSubscriptionWire }) {
  if (sub.enabled) return null;
  return isProposal(sub) ? <Badge variant="accent">Proposed</Badge> : <Badge variant="neutral">Paused</Badge>;
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
