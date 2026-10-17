import { createFileRoute } from "@tanstack/react-router";
import { PresencePlaceholder } from "~/components/presence/page-shell";

/** `/presence/runs`: the Runs tab, the workflow runs of the workspace. */
export const Route = createFileRoute("/presence/runs/")({
  component: RunsTab,
});

export function RunsTab() {
  return <PresencePlaceholder>This tab lists workflow runs.</PresencePlaceholder>;
}
