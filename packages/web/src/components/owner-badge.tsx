/**
 * "A team owns this" — one badge, wherever the product says it.
 *
 * Workflows, skills, and skill repositories all carry an owner, and every
 * list used to resolve the owning team's name for itself. Four copies drifted
 * into four looks, and the skill card never resolved the name at all.
 *
 * The badge links to the team's default assistant. An owned row is the
 * shortest path to the assistant that owns it, so a flat list also becomes a
 * way in. The `?assistant=` search param on `/chat` selects it.
 *
 * A personal row gets no badge: everything on these pages already belongs to
 * the reader, so a badge on each one carries no information.
 */
import { Link } from "@tanstack/react-router";
import { useAssistants, defaultAssistantFor } from "~/api/assistants";
import { useTeams } from "~/api/settings";
import { Badge, Tooltip } from "~/components/primitives";

export function OwnerBadge({
  ownerType,
  ownerId,
}: {
  /** `org` is a real owner: `POST /api/event-subscriptions` writes one for
   * a target of `orchestrator: "org"`, and the subscriptions panel lists
   * those rows in every workspace. This badge still renders nothing for
   * one, because it links to the OWNING TEAM's assistant and an org has no
   * team to link to. A list that must label an org row labels it itself —
   * the subscriptions panel does. */
  ownerType: "user" | "team" | "org";
  /** Team id when `ownerType` is `team`; the user id otherwise. */
  ownerId: string;
}) {
  const teams = useTeams();
  const assistants = useAssistants();
  if (ownerType !== "team") return null;

  // Not found means the caller cannot see this team, or the id is stale. The
  // row is still team-owned, so name the kind instead of printing an empty
  // badge or dropping the only ownership signal the reader gets.
  const team = (teams.data?.teams ?? []).find((t) => t.id === ownerId);
  const label = team?.name ?? "Team";
  const tip = team ? `Open ${team.name}'s assistant` : "Open this team's assistant";

  // A team's session id now comes from the assistants list, so a badge shown
  // before that list lands has nothing to link to. It still names the owner,
  // which is the badge's first job; the link arrives with the list.
  const assistant = defaultAssistantFor(assistants.data?.assistants, "team", ownerId);
  if (assistant === undefined) {
    return (
      <Tooltip content={label}>
        <Badge variant="accent" className="shrink-0">
          {label}
        </Badge>
      </Tooltip>
    );
  }

  return (
    <Tooltip content={tip}>
      {/* `relative` keeps the badge above a card that covers itself with an
          overlay link (see `SkillCard`), which would otherwise swallow the
          click. */}
      <Link to="/chat" search={{ assistant: assistant.id }} className="relative shrink-0">
        <Badge variant="accent">{label}</Badge>
      </Link>
    </Tooltip>
  );
}
