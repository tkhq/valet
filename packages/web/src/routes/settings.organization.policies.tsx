import { createFileRoute } from "@tanstack/react-router";
import { PoliciesSection } from "~/components/settings/policies-section";

/**
 * `/settings/organization/policies` — Organization · Policies
 * (action-policies plan, Task 5). Renders inside `/settings/organization`'s
 * `OrgRouteGuard` — no per-page admin re-check.
 */
export const Route = createFileRoute("/settings/organization/policies")({
  component: OrganizationPoliciesPage,
});

export function OrganizationPoliciesPage() {
  return <PoliciesSection />;
}
