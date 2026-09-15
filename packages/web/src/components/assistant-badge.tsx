/**
 * "This assistant owns the row" — one badge, wherever a list holds work an
 * assistant does.
 *
 * Workflows and event subscriptions used to badge the owning TEAM and link
 * to that team's default assistant (`OwnerBadge`). A team can own many
 * assistants now, so the team name no longer answers the question the row
 * raises: which assistant runs this. The badge links to
 * `/assistants/$assistantId`, the screen where the assistant's model,
 * persona and tools are set. Chat is one click further on, from the editor.
 *
 * What it READS by depends on whether the assistant has a name. A persona,
 * or a renamed default, reads as itself. An unnamed default reads as its
 * owner (the team name, "Org" for an org row): "Default Orchestrator" on
 * every row of a cross-workspace list names nothing, while the owner name is
 * the signal the badge carried before. The tooltip names the assistant in
 * both cases.
 *
 * The caller resolves the assistant, because only the caller knows where
 * the row pins one: a workflow reads `definition.assistantId`, a
 * subscription reads `target.assistantId`. With no pinned id the badge
 * falls back to the owner's default assistant, which is the assistant those
 * rows run as.
 *
 * Resolution is client-side, from the assistants list the page already
 * loads. That list carries the reader's own assistants and their teams';
 * `GET /api/assistants` excludes org-owned ones, so an org row resolves
 * nothing today and takes the unresolved path. The org branch stays for the
 * day the route lists them. When the list holds no match — a stale id, or an assistant the
 * caller may not open — a team row keeps the team-name badge without a
 * link, so the ownership signal survives a failed lookup.
 *
 * A personal row whose assistant is the reader's own default gets no badge:
 * everything on a personal page already belongs to the reader, so the badge
 * only earns its place when another assistant answers instead.
 */
import { Link } from "@tanstack/react-router";
import type { AssistantSummary } from "@valet/api/wire";
import { defaultAssistantFor, useAssistants } from "~/api/assistants";
import { useMe, useTeams } from "~/api/settings";
import { assistantLabel } from "~/lib/assistant-name";
import { canAdministerOwner } from "~/lib/assistant-access";
import { Badge, Tooltip } from "~/components/primitives";

/** The name a row reads by when its assistant has none of its own. The
 * owner here is the ASSISTANT's owner, which is the principal an unnamed
 * default stands for. Undefined for a person: the reader has no name for
 * one here, and "Personal" is already the subscriptions list's word for a
 * colleague's row. Such a row keeps the assistant's own placeholder name. */
function ownerLabel(
  ownerType: "user" | "team" | "org",
  team: { name: string } | undefined,
): string | undefined {
  if (ownerType === "team") return team?.name ?? "Team";
  if (ownerType === "org") return "Org";
  return undefined;
}

/**
 * The assistant a badge names: the pinned one, or the owner's default. A
 * list that renders an ownership label of its own asks this first, so it
 * does not print the owner twice beside a badge that says the same thing.
 */
export function badgeAssistant(
  assistants: AssistantSummary[] | undefined,
  ownerType: "user" | "team" | "org",
  ownerId: string,
  assistantId: string | undefined,
): AssistantSummary | undefined {
  return assistantId === undefined
    ? defaultAssistantFor(assistants, ownerType, ownerId)
    : assistants?.find((a) => a.id === assistantId);
}

export function AssistantBadge({
  ownerType,
  ownerId,
  assistantId,
}: {
  /** Owner of the ROW. It names the fallback badge, and it decides whether a
   * personal row stays quiet. */
  ownerType: "user" | "team" | "org";
  /** Team id when `ownerType` is `team`, org id when `org`, the user id
   * otherwise. */
  ownerId: string;
  /** The assistant the row pins, when it pins one. Absent resolves the
   * owner's default assistant, which is what an unpinned row runs as. */
  assistantId?: string;
}) {
  const teams = useTeams();
  const assistants = useAssistants();
  const me = useMe();

  const assistant = badgeAssistant(assistants.data?.assistants, ownerType, ownerId, assistantId);

  const listedTeams = teams.data?.teams ?? [];
  const team = ownerType === "team" ? listedTeams.find((t) => t.id === ownerId) : undefined;

  if (assistant === undefined) {
    // Nothing to link to. A team row still names its owner, which is what
    // the badge said before assistants had names of their own; a personal or
    // org row had no badge then either.
    if (ownerType !== "team") return null;
    const label = ownerLabel(ownerType, team);
    return (
      <Tooltip content={label}>
        <Badge variant="accent" className="shrink-0">
          {label}
        </Badge>
      </Tooltip>
    );
  }

  // Quiet only for the ROW OWNER's own default assistant, and only for the
  // reader who owns the row. An unresolved reader counts as the owner: on a
  // personal list every row is theirs, the badge must not flash in and out
  // while identity loads, and an identity that never resolves must not badge
  // every personal row instead. A row whose assistant belongs to somebody
  // else keeps its badge from the first frame, because the assistant clause
  // below fails, not this one.
  const viewerId = me.data?.id;
  const readerOwnsRow = viewerId === undefined || viewerId === ownerId;
  if (
    ownerType === "user" &&
    assistant.isDefault &&
    assistant.owner.id === ownerId &&
    readerOwnsRow
  ) {
    return null;
  }

  // An unnamed default assistant has no name of its own, and "Default
  // Orchestrator" on every row of a cross-workspace list tells the reader
  // nothing. Such a row reads as its owner, which is the name the badge
  // carried before. A named assistant, persona or renamed default, reads as
  // itself. The tooltip names the assistant either way.
  const name = assistantLabel(assistant);
  const named = (assistant.name ?? "").trim() !== "";
  // The owner an unnamed default stands for is the ASSISTANT's owner, which
  // a pinned id can put outside the row's own workspace.
  const assistantTeam =
    assistant.owner.type === "team"
      ? listedTeams.find((t) => t.id === assistant.owner.id)
      : undefined;
  const label =
    named || !assistant.isDefault
      ? name
      : (ownerLabel(assistant.owner.type, assistantTeam) ?? name);
  // The tooltip names the team the BADGE names, so the two agree on a row
  // whose assistant belongs to another workspace.
  const tooltipTeam = assistantTeam ?? team;
  // A reader who cannot administer the assistant lands on the editor in
  // read-only mode, so the tooltip must not promise an edit. Same predicate
  // the editor gates itself with.
  const verb = canAdministerOwner(assistant.owner, me.data, listedTeams) ? "Edit" : "Open";
  return (
    <Tooltip content={tooltipTeam ? `${verb} ${name} · ${tooltipTeam.name}` : `${verb} ${name}`}>
      {/* `relative` keeps the badge above a row that covers itself with an
          overlay link, which would otherwise swallow the click. */}
      <Link
        to="/assistants/$assistantId"
        params={{ assistantId: assistant.id }}
        className="relative shrink-0"
      >
        <Badge variant="accent">{label}</Badge>
      </Link>
    </Tooltip>
  );
}
