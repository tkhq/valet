import { createFileRoute } from "@tanstack/react-router";
import { GitSettingsPanel } from "~/components/settings/git-settings-panel";
import { useWorkspaceScope } from "~/lib/workspace-scope";

export const Route = createFileRoute("/settings/git")({ component: GitSettingsPage });

function GitSettingsPage() {
  const { teamId } = useWorkspaceScope();
  return <GitSettingsPanel scope={teamId ? "team" : "user"} teamId={teamId} />;
}
