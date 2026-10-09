import { createFileRoute } from "@tanstack/react-router";
import { PinnedWorkspaceScope } from "~/lib/workspace-scope";
import { AgentAccessSection } from "~/components/settings/agent-access-section";
import { Section } from "~/components/settings/section";

/** `/settings/agent-access` — the MCP apps and CLIs that can act as you. */
export const Route = createFileRoute("/settings/agent-access")({
  component: () => (
    <PinnedWorkspaceScope teamId={undefined}>
      <AgentAccessPage />
    </PinnedWorkspaceScope>
  ),
});

export function AgentAccessPage() {
  return (
    <Section
      title="Agent access"
      description="Apps and CLIs that act as you through MCP or valet login. They cannot approve requests or change policies. Disconnect one to sign it out now."
    >
      <AgentAccessSection />
    </Section>
  );
}
