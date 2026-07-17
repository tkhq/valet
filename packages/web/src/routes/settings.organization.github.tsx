import { createFileRoute } from "@tanstack/react-router";
import { GithubAppSection } from "~/components/settings/github-app-section";
import { Section } from "~/components/settings/section";

/**
 * `/settings/organization/github` — Organization · GitHub (GitHub/repo
 * integration plan, Task 5/11): App-manifest setup, installations, webhook
 * mode. Renders inside `/settings/organization`'s `OrgRouteGuard` — no
 * per-page admin re-check.
 */
export const Route = createFileRoute("/settings/organization/github")({
  component: OrganizationGithubPage,
});

export function OrganizationGithubPage() {
  return (
    <Section
      title="GitHub"
      description="Connect a GitHub App so the assistant can clone and push to your org's repos."
    >
      <GithubAppSection />
    </Section>
  );
}
