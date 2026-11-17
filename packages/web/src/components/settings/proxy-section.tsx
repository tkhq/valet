import type { ReactNode } from "react";
import { useProxySettings } from "~/api/proxy-usage";
import { useOrg } from "~/api/settings";
import { ErrorRow, LoadingRow } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { ProxyAccessLayout } from "~/components/proxy/proxy-access-layout";
import { ProxyGovernance } from "~/components/proxy/proxy-governance";
import { TeamProxySettings } from "~/components/proxy/team-proxy-settings";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { OnboardingPanel } from "~/components/usage/OnboardingPanel";

/**
 * The proxy parts of an Access page, for the scope the page pins: personal
 * on `/settings/access`, a team on `/settings/teams/$teamId/access`. It lays
 * out "Set up a coding tool" (`setupIntro` above the proxy flow), then
 * `children` (the page's API keys), then the Proxy section. One gate covers
 * both proxy parts, so a failure shows once.
 *
 * Any user can generate a proxy key and see setup snippets. When the org has
 * `features.organizations` enabled, governance controls show disabled with
 * a managed note; in single-user mode they are interactive.
 */
export function SettingsProxyPage({ setupIntro, children }: { setupIntro?: ReactNode; children?: ReactNode }) {
  const { teamId } = useWorkspaceScope();
  return teamId
    ? <TeamProxySettings key={teamId} teamId={teamId} setupIntro={setupIntro}>{children}</TeamProxySettings>
    : <PersonalProxySettings setupIntro={setupIntro}>{children}</PersonalProxySettings>;
}

function PersonalProxySettings({ setupIntro, children }: { setupIntro?: ReactNode; children?: ReactNode }) {
  const orgQ = useOrg();
  const settingsQ = useProxySettings();
  const failed = orgQ.error || settingsQ.error;
  const ready = orgQ.data && settingsQ.data;
  const singleUser = orgQ.data?.features.organizations === false;

  return (
    <ProxyAccessLayout
      setupIntro={setupIntro}
      setup={failed
        ? <ErrorRow>Could not load proxy settings. Reload this page to try again.</ErrorRow>
        : ready ? <OnboardingPanel settingsQuery={settingsQ} showGatewayStatus={false} /> : <LoadingRow label="Loading proxy settings…" />}
      proxy={!failed && ready && (
        <Section
          title="Proxy"
          description="Route model requests from your coding tools through Valet for spend tracking and recording."
        >
          <ProxyGovernance editable={singleUser} />
        </Section>
      )}
    >
      {children}
    </ProxyAccessLayout>
  );
}
