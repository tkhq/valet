import { createFileRoute } from "@tanstack/react-router";
import { PinnedWorkspaceScope } from "~/lib/workspace-scope";
import { UsagePage } from "./usage";

/**
 * `/settings/usage` — your own spend only. A team's spend lives on
 * `/settings/teams/$teamId/usage`, and the organization's on
 * `/settings/organization/usage`.
 */
export const Route = createFileRoute("/settings/usage")({
  component: PersonalUsageSettings,
});

function PersonalUsageSettings() {
  return (
    <PinnedWorkspaceScope teamId={undefined}>
      <UsagePage />
    </PinnedWorkspaceScope>
  );
}
