import { createFileRoute } from "@tanstack/react-router";
import { PresencePlaceholder } from "~/components/presence/page-shell";

/** `/presence/workflows`: the Workflows tab. It replaces the `/workflows` list. */
export const Route = createFileRoute("/presence/workflows/")({
  component: WorkflowsTab,
});

export function WorkflowsTab() {
  return <PresencePlaceholder>This tab lists your workflows.</PresencePlaceholder>;
}
