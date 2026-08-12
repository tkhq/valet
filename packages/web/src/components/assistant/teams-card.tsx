import { Link } from "@tanstack/react-router";
import { Users } from "lucide-react";
import { useOrg, useTeams } from "~/api/settings";
import { eligibleTeams } from "~/components/session/assistant-rail";
import { Spinner } from "~/components/primitives";

/**
 * Dashboard teams card — one row per team you belong to, each a direct
 * jump to that team's assistant.
 *
 * This exists because the `/chat` sidebar is collapsible and remembers it
 * (`valet:sidebar-collapsed`). The rail is the primary way teams stay
 * visible; a user who collapsed it would otherwise have no standing signal
 * that team assistants exist at all. The dashboard is the one surface
 * everyone lands on.
 *
 * Renders nothing when the caller belongs to no team, so a solo user's
 * dashboard is unchanged rather than showing empty scaffolding.
 */
export function TeamsCard() {
  const orgQ = useOrg();
  const teamsQ = useTeams();

  const teams = eligibleTeams(teamsQ.data?.teams, orgQ.data?.features.organizations);
  const resolved = orgQ.data !== undefined && teamsQ.data !== undefined;

  if (teamsQ.isLoading || orgQ.isLoading) {
    return (
      <section className="rounded-lg border border-line bg-paper flex flex-col min-h-0">
        <header className="px-4 py-3 border-b border-line">
          <h2 className="font-display text-base text-ink">Your teams</h2>
        </header>
        <div className="px-4 py-3 flex items-center gap-2 text-xs text-muted">
          <Spinner size={14} /> Loading…
        </div>
      </section>
    );
  }

  // Not a member of anything: no card at all. An empty "Your teams" panel
  // would be scaffolding for a feature this user does not have.
  if (!resolved || teams.length === 0) return null;

  return (
    <section className="rounded-lg border border-line bg-paper flex flex-col min-h-0">
      <header className="px-4 py-3 border-b border-line">
        <h2 className="font-display text-base text-ink">Your teams</h2>
      </header>

      <ul className="flex-1 overflow-y-auto max-h-64 divide-y divide-line">
        {teams.map((team) => (
          <li key={team.id}>
            <Link
              to="/chat"
              search={{ team: team.id }}
              className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-ink-wash/60 focus-visible:outline-none focus-visible:bg-ink-wash"
            >
              <Users className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{team.name}</span>
              <span className="shrink-0 text-xs text-muted">
                {team.memberCount} {team.memberCount === 1 ? "member" : "members"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
