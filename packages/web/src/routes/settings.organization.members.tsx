import { createFileRoute } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";

/**
 * `/settings/organization/members` — Organization · Members. Placeholder
 * stub, reachable only through the `settings.organization.tsx` guard; Task
 * 7 wires the member roster + role select here.
 */
export const Route = createFileRoute("/settings/organization/members")({
  component: OrganizationMembersPage,
});

export function OrganizationMembersPage() {
  return (
    <Section title="Members" description="Everyone in your organization.">
      <p className="py-4 text-sm text-muted">The member roster lands here next.</p>
    </Section>
  );
}
