import { createFileRoute } from "@tanstack/react-router";
import { PoliciesSection } from "~/components/settings/policies-section";
import { ApiKeyPolicySection } from "~/components/settings/api-key-policy-section";

/**
 * `/settings/organization/policies` — Organization · Policies
 * (action-policies plan, Task 5), then the API key policy. Renders inside
 * `/settings/organization`'s `OrgRouteGuard`, so it has no per-page admin re-check.
 */
export const Route = createFileRoute("/settings/organization/policies")({
  component: OrganizationPoliciesPage,
});

export function OrganizationPoliciesPage() {
  return (
    <div className="space-y-10">
      <PoliciesSection />
      <ApiKeyPolicySection />
    </div>
  );
}
