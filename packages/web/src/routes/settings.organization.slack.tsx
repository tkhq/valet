import { createFileRoute } from "@tanstack/react-router";
import { SlackAppSection } from "~/components/settings/slack-app-section";
import { Section } from "~/components/settings/section";

/**
 * `/settings/organization/slack` — Organization · Slack: manifest-based app
 * setup and the org bot credential. Renders inside `/settings/organization`'s
 * `OrgRouteGuard` — no per-page admin re-check.
 */
export const Route = createFileRoute("/settings/organization/slack")({
  component: OrganizationSlackPage,
});

export function OrganizationSlackPage() {
  return (
    <Section
      title="Slack"
      description="Connect a Slack app so people can talk to the assistant from Slack."
    >
      <SlackAppSection />
    </Section>
  );
}
