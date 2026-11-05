import { createFileRoute } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";
import { ApiKeysSection } from "~/components/settings/api-keys-section";
import { PinnedWorkspaceScope } from "~/lib/workspace-scope";
import { SettingsProxyPage } from "./settings.proxy";

/**
 * `/settings/api-keys` — the personal workspace's API keys and proxy. It
 * pins personal scope, so it never shows a team's keys whatever the
 * switcher holds. A team's keys live on `/settings/teams/$teamId/access`,
 * which renders the same two sections under that team's scope.
 */
export const Route = createFileRoute("/settings/api-keys")({
  component: PersonalAccessPage,
});

export function PersonalAccessPage() {
  return (
    <PinnedWorkspaceScope teamId={undefined}>
      <AccessSections />
    </PinnedWorkspaceScope>
  );
}

/** API keys, then proxy, for whichever scope the caller pinned. */
export function AccessSections() {
  return (
    <div className="space-y-10">
      <ApiKeysPage />
      <SettingsProxyPage />
    </div>
  );
}

export function ApiKeysPage() {
  return (
    <Section
      title="API keys"
      description="Create keys to call the Valet API from scripts. To connect a coding agent such as Claude Code, use Agent access instead."
    >
      <ApiKeysSection />
    </Section>
  );
}
