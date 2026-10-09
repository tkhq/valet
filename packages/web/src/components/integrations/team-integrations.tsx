import { useMe, useOrgDirectory, useTeams } from "~/api/settings";
import { ErrorRow, LoadingRow, pageClass } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { IntegrationLimitNotice } from "./integration-limit-notice";
import { Section } from "~/components/settings/section";
import { TeamConnectionSetup } from "./team-connection-setup";
import { TeamCredentials } from "./team-credentials";
import { PullFromPersonal } from "./pull-from-personal";
import { TeamOnePasswordToken } from "~/components/settings/team-onepassword-token";

/** Team summaries come from the member-visible endpoint, never the personal catalog. */
export function TeamIntegrations({ teamId, notice }: { teamId: string; notice?: string }) {
  const teamsQ = useTeams();
  const meQ = useMe();
  const directoryQ = useOrgDirectory();
  const team = teamsQ.data?.teams.find((row) => row.id === teamId);
  const loading = teamsQ.isLoading || meQ.isLoading;
  const failed = teamsQ.error || meQ.error;
  const canMutate = meQ.data?.orgRole === "admin" || team?.callerRole === "admin";

  return (
    <div className="flex-1 overflow-y-auto">
      <div className={cn(pageClass, "max-w-3xl")}>
        <h1 className="text-2xl font-medium text-ink">Integrations</h1>
        {team && <p className="mt-1 text-sm text-muted">{team.name} workspace</p>}
        {notice && <p role="status" className="mt-4 text-sm text-ink">{notice}</p>}
        <IntegrationLimitNotice owner={{ ownerType: "team", ownerId: teamId }} canClear={canMutate} />
        <div className="mt-8 space-y-10">
          {loading && <LoadingRow label="Loading team integrations…" />}
          {!loading && failed && (
            <ErrorRow>Could not load team integrations. Reload the page to try again.</ErrorRow>
          )}
          {!loading && !failed && !team && (
            <ErrorRow>This team is unavailable. Select another workspace or ask a team admin to restore your access.</ErrorRow>
          )}
          {!loading && !failed && team && (
            <>
              <Section
                title="Connected"
                description="Team actions use the acting member's own account first, then the team connection. Using another member's account asks them first."
              >
                {!canMutate && (
                  <p className="py-3.5 text-sm text-muted">Only team or organization admins can remove team connections.</p>
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
                <div className="flex flex-wrap items-center gap-3 py-3.5">
                  <PullFromPersonal teamId={teamId} teamName={team.name} />
                  <p className="text-sm text-muted">Shares one of your own connections with this team.</p>
                </div>
              </Section>
              {/* The team's own 1Password service account sits with the other
                  connections: it is what makes op:// references and
                  valet-secrets work for this team's sessions. */}
              <TeamConnectionSetup teamId={teamId} canManage={canMutate}>
                <TeamOnePasswordToken key={teamId} teamId={teamId} teamName={team.name} canMutate={canMutate} />
              </TeamConnectionSetup>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
