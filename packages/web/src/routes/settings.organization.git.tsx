import { createFileRoute } from "@tanstack/react-router";
import { GitSettingsPanel } from "~/components/settings/git-settings-panel";

export const Route = createFileRoute("/settings/organization/git")({
  component: () => <GitSettingsPanel scope="organization" />,
});
