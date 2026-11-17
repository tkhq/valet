import { createFileRoute } from "@tanstack/react-router";
import { Section, SectionHeading } from "~/components/settings/section";
import { AgentAccessSection, AgentSetupCard } from "~/components/settings/agent-access-section";
import { ApiKeysSection } from "~/components/settings/api-keys-section";
import { SettingsProxyPage } from "~/components/settings/proxy-section";
import { PinnedWorkspaceScope, useWorkspaceScope } from "~/lib/workspace-scope";

/**
 * `/settings/access`: everything that lets a tool or script act for the
 * personal workspace: connected agents, coding-tool setup, API keys, and the
 * proxy. It pins personal scope, so it never shows a team's keys whatever
 * the switcher holds. A team's keys live on `/settings/teams/$teamId/access`,
 * which renders the same page under that team's scope without the agents.
 */
export const Route = createFileRoute("/settings/access")({
  component: PersonalAccessPage,
});

export function PersonalAccessPage() {
  return (
    <PinnedWorkspaceScope teamId={undefined}>
      <AccessSections />
    </PinnedWorkspaceScope>
  );
}

/**
 * The Access page for whichever scope the caller pinned, in this order:
 * Connected agents (personal only), Set up a coding tool, API keys, Proxy.
 * The page title matches the rail label. Under the team tab of the same name
 * it stays for screen readers only.
 */
export function AccessSections() {
  const { teamId } = useWorkspaceScope();
  const personal = teamId === undefined;
  return (
    <div className="space-y-10">
      <SectionHeading title="Access" />
      {personal && (
        <Section
          title="Connected agents"
          description="Apps and CLIs that act as you through MCP or valet login. They cannot approve requests or change policies. Disconnect one to sign it out now."
        >
          <AgentAccessSection />
        </Section>
      )}
      <SettingsProxyPage setupIntro={personal ? <AgentSetupCard /> : undefined}>
        <ApiKeysPage />
      </SettingsProxyPage>
    </div>
  );
}

export function ApiKeysPage() {
  return (
    <Section title="API keys" description="API keys let scripts call the Valet API. For model requests from a coding tool, use Set up a coding tool above.">
      <ApiKeysSection />
    </Section>
  );
}
