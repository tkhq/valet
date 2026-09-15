import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { usePolicyDraftContexts } from "~/api/policy-authoring";
import { useOrgDirectory } from "~/api/settings";
import { ErrorRow, LoadingRow } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { TeamsPanel } from "~/components/settings/teams-panel";
import { PolicyBuilder } from "~/components/settings/policy-builder/policy-builder";
import { useWorkspaceScope } from "~/lib/workspace-scope";

export const Route = createFileRoute("/settings/team")({
  component: TeamSettingsPage,
});

export function TeamSettingsPage() {
  const { teamId } = useWorkspaceScope();
  if (teamId === undefined) return <Navigate to="/settings/profile" replace />;
  // Drop drafts and open confirmation dialogs before changing their target.
  return <SelectedTeamSettings key={teamId} teamId={teamId} />;
}

function SelectedTeamSettings({ teamId }: { teamId: string }) {
  const directory = useOrgDirectory();
  const contexts = usePolicyDraftContexts(teamId);

  return (
    <div className="space-y-10">
      <Section title="Team" description="Settings for the selected team workspace.">
        <div className="py-3">
          <Link to="/assistants" className="text-sm text-moss underline-offset-2 hover:underline">
            Edit assistant
          </Link>
        </div>
        {directory.isLoading ? <LoadingRow label="Loading team settings…" /> : directory.error != null ? <ErrorRow>Failed to load the member directory. Reload the page to try again.</ErrorRow> : directory.data ? <TeamsPanel orgMembers={directory.data.users} teamId={teamId} /> : <ErrorRow>Team settings are unavailable. Select another workspace or reload the page.</ErrorRow>}
      </Section>
      {contexts.error ? <ErrorRow>Policy contexts are unavailable. Reload the page to try again.</ErrorRow> : contexts.data ? <PolicyBuilder contexts={contexts.data.contexts} owner={{ kind: "team", id: teamId }} /> : <LoadingRow label="Loading policy contexts…" />}
    </div>
  );
}
