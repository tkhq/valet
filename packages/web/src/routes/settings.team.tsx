import { Navigate, createFileRoute } from "@tanstack/react-router";
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
  if (teamId === undefined) return <Navigate to="/settings/profile" replace />;
  return <Navigate to="/settings/teams/$teamId" params={{ teamId }} replace />;
}
