import { createFileRoute } from "@tanstack/react-router";
import { GithubAppSection } from "~/components/settings/github-app-section";
import { Section } from "~/components/settings/section";
import { OrgPermissionGuard } from "./settings.organization";

/**
 * `/settings/organization/github` — Organization · GitHub (GitHub/repo
 * integration plan, Task 5/11): App-manifest setup, installations, webhook
 * mode. Gated on `infra:manage` (RBAC design) — matches the API's
 * `github-app.ts` route gate.
 */
export const Route = createFileRoute("/settings/organization/github")({
  component: OrganizationGithubPage,
});

export function OrganizationGithubPage() {
  return (
    <OrgPermissionGuard permission="infra:manage">
      <Section
        title="GitHub"
        description="Connect a GitHub App so the assistant can clone and push to your org's repos."
      >
        <GithubAppSection />
      </Section>
    </OrgPermissionGuard>
  );
}
