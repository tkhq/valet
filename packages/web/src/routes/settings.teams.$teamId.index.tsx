import { createFileRoute } from "@tanstack/react-router";
import { useOrgDirectory } from "~/api/settings";
import { ErrorRow, LoadingRow } from "~/components/primitives";
import { TeamsPanel } from "~/components/settings/teams-panel";

/** A team's General tab: members, defaults, Slack home channel, and
 * connections, all in the team panel. */
export const Route = createFileRoute("/settings/teams/$teamId/")({
  component: TeamGeneralTab,
});

function TeamGeneralTab() {
  const { teamId } = Route.useParams();
  const directory = useOrgDirectory();
  if (directory.isLoading) return <LoadingRow label="Loading team settings…" />;
  if (directory.error != null || !directory.data) {
    return <ErrorRow>Failed to load the member directory. Reload the page to try again.</ErrorRow>;
  }
  return <TeamsPanel orgMembers={directory.data.users} teamId={teamId} page />;
}
