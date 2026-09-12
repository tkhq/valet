import { useProxySettings } from "~/api/proxy-usage";
import { useCreateTeamApiKey, useTeamApiKeys } from "~/api/api-keys";
import { useOrg, useTeams } from "~/api/settings";
import { Section } from "~/components/settings/section";
import { ProxyGovernance } from "~/components/proxy/proxy-governance";
import { OnboardingPanel, type OnboardingPanelProps } from "~/components/usage/OnboardingPanel";

/** Access failures unmount the flow even when queries retain cached data. */
export function TeamProxySettings({ teamId }: { teamId: string }) {
  const teamsQ = useTeams();
  const orgQ = useOrg();
  const keysQ = useTeamApiKeys(teamId);
  const settingsQ = useProxySettings();
  if (teamsQ.error || orgQ.error || keysQ.error || settingsQ.error) {
    return <p role="alert">Could not verify team proxy access. Reload this page to try again.</p>;
  }
  if (!teamsQ.data || !orgQ.data || !keysQ.data || !settingsQ.data) {
    return <p role="status">Loading team proxy settings…</p>;
  }
  const team = teamsQ.data.teams.find((candidate) => candidate.id === teamId);
  if (!team) return <p role="alert">This team is unavailable. Select another workspace.</p>;
  const canCreate = team.callerRole === "admin" || orgQ.data.callerRole === "admin";
  return (
    <div className="min-w-0 max-w-full space-y-10">
      <Section title="Proxy" description={`Route Claude Code or Codex traffic through ${team.name} for spend tracking and recording.`}>
        <ProxyGovernance editable={false} />
      </Section>
      <TeamOnboarding key={`${teamId}:${canCreate}`} teamId={teamId} canCreate={canCreate} settingsQuery={settingsQ} />
    </div>
  );
}

function TeamOnboarding({ teamId, canCreate, settingsQuery }: {
  teamId: string;
  canCreate: boolean;
  settingsQuery: OnboardingPanelProps["settingsQuery"];
}) {
  const createKey = useCreateTeamApiKey(teamId);
  return <OnboardingPanel settingsQuery={settingsQuery} showGatewayStatus={false} team creation={{
    create: (onSuccess) => createKey.mutate("proxy-key", { onSuccess }),
    isPending: createKey.isPending, error: createKey.error, canCreate,
  }} />;
}
