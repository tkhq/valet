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

/** Coding-tool setup, then API keys, for whichever scope the caller pinned. */
export function AccessSections() {
  return (
    <div className="space-y-10">
      <SettingsProxyPage />
      <ApiKeysPage />
    </div>
  );
}

export function ApiKeysPage() {
  return (
    <Section
      title="API keys"
      description="Use the proxy setup above for model traffic from coding tools. API keys below let scripts call the Valet API. Agent access connects tools to Valet through MCP."
    >
      <ApiKeysSection />
    </Section>
  );
}
