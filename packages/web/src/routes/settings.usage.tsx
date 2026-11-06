import { createFileRoute } from "@tanstack/react-router";
import { PinnedWorkspaceScope } from "~/lib/workspace-scope";
import { UsagePage } from "./usage";

/**
 * `/settings/usage` — your own workspace's spend, with the org toggle for
 * an org admin. A team's spend lives on `/settings/teams/$teamId/usage`.
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
