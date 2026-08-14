import { createFileRoute } from "@tanstack/react-router";
import { PolicyOverridesSection } from "~/components/settings/policy-overrides-section";
import { GrantsSection } from "~/components/settings/grants-section";

/**
 * `/settings/policies` — You · Policies (action-policies plan, Task 5).
 * Per-user surface: MY policy overrides (own overrides on top of org
 * policy, bounds-checked at write time) and MY active runtime grants. Lives
 * under "You" rather than "Organization" — these rows are scoped to the
 * caller (`user.id`), not admin-managed org state, and the routes
 * (`/api/me/policy-overrides`, `/api/me/grants`) require no admin gate, so
 * they belong with the rest of the caller's own settings.
 */
export const Route = createFileRoute("/settings/policies")({
  component: PoliciesPage,
});

export function PoliciesPage() {
  return (
    <div className="space-y-10">
      <PolicyOverridesSection />
      <GrantsSection />
    </div>
  );
}
