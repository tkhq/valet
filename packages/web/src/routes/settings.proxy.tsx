import { createFileRoute } from "@tanstack/react-router";
import { useProxySettings } from "~/api/proxy-usage";
import { useOrg } from "~/api/settings";
import { Section } from "~/components/settings/section";
import { ProxyGovernance } from "~/components/proxy/proxy-governance";
import { OnboardingPanel } from "~/components/usage/OnboardingPanel";

/**
 * `/settings/proxy` — personal proxy page visible to every user. Lets any
 * user generate a proxy key and see setup snippets. When the org has
 * `features.organizations` enabled, governance controls are read-only (managed
 * by admins); in single-user mode they are interactive.
 */
export const Route = createFileRoute("/settings/proxy")({
  component: SettingsProxyPage,
});

export function SettingsProxyPage() {
  const orgQ = useOrg();
  const settingsQ = useProxySettings();

  const singleUser = orgQ.data?.features.organizations !== true;

  return (
    <div className="space-y-10">
      <Section
        title="Proxy"
        description="Route your Claude Code / Codex traffic through Valet for spend tracking and recording."
      >
        <ProxyGovernance editable={singleUser} />
      </Section>

      <OnboardingPanel settingsQuery={settingsQ} showGatewayStatus={false} />
    </div>
  );
}
