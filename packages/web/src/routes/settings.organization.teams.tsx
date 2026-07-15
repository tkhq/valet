import { createFileRoute } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";

/**
 * `/settings/organization/teams` — Organization · Teams. Placeholder stub,
 * reachable only through the `settings.organization.tsx` guard; Task 7
 * wires the teams panel over the existing `/api/teams` routes here.
 */
export const Route = createFileRoute("/settings/organization/teams")({
  component: OrganizationTeamsPage,
});

export function OrganizationTeamsPage() {
  return (
    <Section title="Teams" description="Group members for scoped session access.">
      <p className="py-4 text-sm text-muted">Team management lands here next.</p>
    </Section>
  );
}
