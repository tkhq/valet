/**
 * "A team owns this" — one badge, wherever the product says it.
 *
 * Workflows, skills, and skill repositories all carry an owner, and every
 * list used to resolve the owning team's name for itself. Four copies drifted
 * into four looks, and the skill card never resolved the name at all.
 *
 * The badge links to the team's assistant. An owned row is the shortest path
 * to the assistant that owns it, so a flat list also becomes a way in. The
 * `?team=` search param on `/chat` selects that assistant.
 *
 * A personal row gets no badge: everything on these pages already belongs to
 * the reader, so a badge on each one carries no information.
 */
import { Link } from "@tanstack/react-router";
import { useTeams } from "~/api/settings";
import { Badge, Tooltip } from "~/components/primitives";

export function OwnerBadge({
  ownerType,
  ownerId,
}: {
  /** The wire types allow `org`, which no route creates yet. It reads as
   * personal here — one unowned-looking row beats a badge nothing links to. */
  ownerType: "user" | "team" | "org";
  /** Team id when `ownerType` is `team`; the user id otherwise. */
  ownerId: string;
}) {
  const teams = useTeams();
  if (ownerType !== "team") return null;

  // Not found means the caller cannot see this team, or the id is stale. The
  // row is still team-owned, so name the kind instead of printing an empty
  // badge or dropping the only ownership signal the reader gets.
  const team = (teams.data?.teams ?? []).find((t) => t.id === ownerId);
  const label = team?.name ?? "Team";
  const tip = team ? `Open ${team.name}'s assistant` : "Open this team's assistant";

  return (
    <Tooltip content={tip}>
      {/* `relative` keeps the badge above a card that covers itself with an
          overlay link (see `SkillCard`), which would otherwise swallow the
          click. */}
      <Link to="/chat" search={{ team: ownerId }} className="relative shrink-0">
        <Badge variant="accent">{label}</Badge>
      </Link>
    </Tooltip>
  );
}
