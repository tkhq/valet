import { createFileRoute } from "@tanstack/react-router";
import { LlmProvidersSection } from "~/components/settings/llm-providers-section";
import { ModelPreferencesSection } from "~/components/settings/model-preferences-section";

/**
 * `/settings/organization/models` — Organization · Models (llm-providers
 * design, plan Task 7). Provider CRUD/keys above, ordered model
 * preferences below. Renders inside `/settings/organization`'s
 * `OrgRouteGuard` — no per-page admin re-check.
 */
export const Route = createFileRoute("/settings/organization/models")({
  component: OrganizationModelsPage,
});

export function OrganizationModelsPage() {
  return (
    <div className="space-y-10">
      <LlmProvidersSection />
      <ModelPreferencesSection />
    </div>
  );
}
