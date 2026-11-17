import { useProxySettings } from "~/api/proxy-usage";
import { useOrg } from "~/api/settings";
import { ErrorRow, LoadingRow } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { ProxyGovernance } from "~/components/proxy/proxy-governance";
import { TeamProxySettings } from "~/components/proxy/team-proxy-settings";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { OnboardingPanel } from "~/components/usage/OnboardingPanel";

/**
 * Proxy settings for the scope the page pins: personal on
 * `/settings/api-keys`, a team on `/settings/teams/$teamId/access`. Lets any
 * user generate a proxy key and see setup snippets. When the org has
 * `features.organizations` enabled, governance controls are read-only (managed
 * by admins); in single-user mode they are interactive.
 */
export function SettingsProxyPage() {
  const { teamId } = useWorkspaceScope();
  return teamId ? <TeamProxySettings key={teamId} teamId={teamId} /> : <PersonalProxySettings />;
}

function PersonalProxySettings() {
  const orgQ = useOrg();
  const settingsQ = useProxySettings();

  if (orgQ.error || settingsQ.error) return <ErrorRow>Could not load proxy settings. Reload this page to try again.</ErrorRow>;
  if (!orgQ.data || !settingsQ.data) return <LoadingRow label="Loading proxy settings…" />;

  const singleUser = orgQ.data?.features.organizations === false;

  return (
    <div className="min-w-0 max-w-full space-y-10">
      <Section
        title="Proxy"
        description="Route model requests from your coding tools through Valet for spend tracking and recording."
      >
        <ProxyGovernance editable={singleUser} />
      </Section>

      <OnboardingPanel settingsQuery={settingsQ} showGatewayStatus={false} />
    </div>
  );
}
