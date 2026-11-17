import type { TeamSummary } from "@valet/api/wire";
import { BarChart3, KeyRound, LockKeyhole, Plug, Shield, Users } from "lucide-react";
import { useTeamApiKeys } from "~/api/api-keys";
import { useCredentials } from "~/api/integrations";
import { useTeamOnePasswordStatus } from "~/api/onepassword";
import { usePolicies } from "~/api/policies";
import { useSecrets } from "~/api/secrets";
import { LinkRow } from "~/components/primitives";
import { Section } from "./section";

/** "None", "1 key", or "3 keys". */
function count(n: number | undefined, noun: string): string | undefined {
  if (n === undefined) return undefined;
  return n === 0 ? "None" : `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The top of a team's General tab: one row per part of the team's settings,
 * each a link to its tab. A row shows the current value when a query the tab
 * already makes gives it. Members is a section lower on General, not a tab.
 * Usage hides for an org admin who is not on the team, because the usage API
 * answers only to members.
 */
export function TeamOverview({ team }: { team: TeamSummary }) {
  const teamId = team.id;
  const params = { teamId };
  const creds = useCredentials("team", { teamId }).data?.credentials;
  const onePassword = useTeamOnePasswordStatus(teamId).data?.tokenConnected === true;
  const secrets = useSecrets({ scope: "team", teamId }).data;
  const keys = useTeamApiKeys(teamId).data;
  const policies = usePolicies(teamId).data?.policies;
  // The Integrations tab shows one row per service, and 1Password as a row.
  const connected = creds && new Set(creds.map((row) => row.service)).size + (onePassword ? 1 : 0);

  return (
    <Section title="Overview">
      <LinkRow to="/settings/teams/$teamId" params={params} hash="members" icon={Users} title="Members"
        description="People on this team and their roles." value={count(team.memberCount, "member")} />
      <LinkRow to="/settings/teams/$teamId/integrations" params={params} icon={Plug} title="Integrations"
        description="Accounts that team actions use." value={connected === undefined ? undefined : connected === 0 ? "None" : `${connected} connected`} />
      <LinkRow to="/settings/teams/$teamId/secrets" params={params} icon={LockKeyhole} title="Secrets"
        description="Values that team runtimes read by reference." value={secrets && !secrets.enabled ? "Off" : count(secrets?.secrets.length, "secret")} />
      <LinkRow to="/settings/teams/$teamId/access" params={params} icon={KeyRound} title="Access"
        description="API keys and the model proxy for this team." value={count(keys?.length, "key")} />
      <LinkRow to="/settings/teams/$teamId/policies" params={params} icon={Shield} title="Policies"
        description="Team rules on top of organization policy." value={count(policies?.length, "rule")} />
      {team.callerRole !== null && (
        <LinkRow to="/settings/teams/$teamId/usage" params={params} icon={BarChart3} title="Usage"
          description="Model spend for this team." />
      )}
    </Section>
  );
}
