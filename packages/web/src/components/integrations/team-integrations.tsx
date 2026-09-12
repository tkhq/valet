import { useMe, useOrgDirectory, useTeams } from "~/api/settings";
import { Button, ErrorRow, LoadingRow } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { PERSONAL, useWorkspaceScope } from "~/lib/workspace-scope";
import { TeamConnectionSetup } from "./team-connection-setup";
import { TeamCredentials } from "./team-credentials";

/** Team summaries come from the member-visible endpoint, never the personal catalog. */
export function TeamIntegrations({ teamId, notice }: { teamId: string; notice?: string }) {
  const teamsQ = useTeams();
  const meQ = useMe();
  const directoryQ = useOrgDirectory();
  const { setKey } = useWorkspaceScope();
  const team = teamsQ.data?.teams.find((row) => row.id === teamId);
  const loading = teamsQ.isLoading || meQ.isLoading;
  const failed = teamsQ.error || meQ.error;
  const canMutate = meQ.data?.orgRole === "admin" || team?.callerRole === "admin";

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
        <h1 className="font-display text-2xl text-ink">Integrations</h1>
        {notice && <p role="status" className="mt-4 text-sm text-ink">{notice}</p>}
        <div className="mt-10 space-y-6">
          {loading && <LoadingRow label="Loading team integrations…" />}
          {!loading && failed && (
            <ErrorRow>Could not load team integrations. Reload the page to try again.</ErrorRow>
          )}
          {!loading && !failed && !team && (
            <ErrorRow>This team is unavailable. Select another workspace or ask a team admin to restore your access.</ErrorRow>
          )}
          {!loading && !failed && team && (
            <Section title={team.name} description="Connections stored on this team or shared by its members.">
              <div className="space-y-8 pt-4">
                {!canMutate && (
                  <p className="text-sm text-muted">Only team or organization admins can remove team connections.</p>
                )}
                {directoryQ.isLoading && <LoadingRow label="Loading member names…" />}
                {directoryQ.error && (
                  <ErrorRow>Could not load member names. Member IDs are shown instead. Reload the page to try again.</ErrorRow>
                )}
                <TeamCredentials
                  cards
                  team={team}
                  orgMembers={directoryQ.error ? [] : directoryQ.data?.users ?? []}
                  canMutate={canMutate}
                />
                <TeamConnectionSetup teamId={teamId} canManage={canMutate} orgAdmin={meQ.data?.orgRole === "admin"} />

                <p className="text-sm text-muted">
                  Need to share a personal connection? Switch to Personal to share it explicitly.
                </p>
                <Button variant="secondary" onClick={() => setKey(PERSONAL)}>Switch to Personal</Button>
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
