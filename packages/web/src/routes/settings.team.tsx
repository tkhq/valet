import { Navigate, createFileRoute } from "@tanstack/react-router";
import { useOrg, useTeams } from "~/api/settings";
import { LoadingRow } from "~/components/primitives";
import { eligibleTeams } from "~/components/session/assistant-rail";
import { useWorkspaceScope } from "~/lib/workspace-scope";

/**
 * `/settings/team` predates per-team settings pages. It opens the team the
 * switcher holds, or Profile when the switcher is on the personal workspace.
 */
export const Route = createFileRoute("/settings/team")({
  component: TeamSettingsRedirect,
});

export function TeamSettingsRedirect() {
  const { teamId } = useWorkspaceScope();
  const teamsQ = useTeams();
  const orgQ = useOrg();
  if (teamId === undefined) return <Navigate to="/settings/profile" replace />;
  // The switcher keeps a stored team while membership loads, and that team
  // can be one the caller left or that was deleted. Redirect only to a team
  // the caller is on, or the team page would refuse the caller.
  if (teamsQ.isLoading || orgQ.isLoading) return <LoadingRow label="Loading team settings…" />;
  const member = eligibleTeams(teamsQ.data?.teams, orgQ.data?.features.organizations).some((team) => team.id === teamId);
  if (!member) return <Navigate to="/settings/profile" replace />;
  return <Navigate to="/settings/teams/$teamId" params={{ teamId }} replace />;
}
