import { createFileRoute } from "@tanstack/react-router";
import { useOrgDirectory } from "~/api/settings";
import { ErrorRow, LoadingRow } from "~/components/primitives";
import { TeamSlackSetupCard } from "~/components/events/team-slack-setup";
import { TeamsPanel } from "~/components/settings/teams-panel";

/** A team's General tab: the Slack setup prompt until the team listens
 * somewhere, then members, defaults, Slack home channel, and connections. */
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
  return <div className="space-y-6">
    <TeamSlackSetupCard key={teamId} teamId={teamId} />
    <TeamsPanel orgMembers={directory.data.users} teamId={teamId} page />
  </div>;
}
