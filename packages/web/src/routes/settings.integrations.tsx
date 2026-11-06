import { createFileRoute } from "@tanstack/react-router";
import { PinnedWorkspaceScope } from "~/lib/workspace-scope";
import { IntegrationsPage, readIntegrationsSearch } from "./integrations";

/**
 * `/settings/integrations` — your own workspace's Integrations. It pins
 * personal scope, so it never shows a team's connections whatever the
 * switcher holds. A team's live on `/settings/teams/$teamId/integrations`.
 */
export const Route = createFileRoute("/settings/integrations")({
  component: PersonalIntegrationsSettings,
  validateSearch: readIntegrationsSearch,
});

function PersonalIntegrationsSettings() {
  return (
    <PinnedWorkspaceScope teamId={undefined}>
      <IntegrationsPage />
    </PinnedWorkspaceScope>
  );
}
