import { createFileRoute } from "@tanstack/react-router";
import { PresenceDetailPage, PresencePlaceholder } from "~/components/presence/page-shell";

/** `/presence/workflows/$workflowId`: one workflow in the editor. It replaces
 * `/workflows/$workflowId`. */
export const Route = createFileRoute("/presence/workflows/$workflowId")({
  component: PresenceWorkflowPage,
});

export function PresenceWorkflowPage() {
  return (
    <PresenceDetailPage back="/presence/workflows" backLabel="Workflows" title="Workflow">
      <PresencePlaceholder>This page shows the workflow editor.</PresencePlaceholder>
    </PresenceDetailPage>
  );
}
