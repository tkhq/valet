import { createFileRoute } from "@tanstack/react-router";
import { ApprovedModelsSection } from "~/components/settings/approved-models-section";
import { LlmProvidersSection } from "~/components/settings/llm-providers-section";
import { ModelPreferencesSection } from "~/components/settings/model-preferences-section";
import { ModelTiersSection } from "~/components/settings/model-tiers-section";
import { ReasoningSection } from "~/components/settings/reasoning-section";

/**
 * `/settings/organization/models` — Organization · Models (llm-providers
 * design, plan Task 7; tier map/approved models/reasoning added by
 * model-selector-overhaul, Task 13). Provider CRUD/keys, ordered model
 * preferences, the size-tier map, the approved-model restriction, and
 * org-wide reasoning defaults, in that order. Renders inside
 * `/settings/organization`'s `OrgRouteGuard` — no per-page admin re-check.
 */
export const Route = createFileRoute("/settings/organization/models")({
  component: OrganizationModelsPage,
});

export function OrganizationModelsPage() {
  return (
    <div className="space-y-10">
      <LlmProvidersSection />
      <ModelPreferencesSection />
      <ModelTiersSection />
      <ApprovedModelsSection />
      <ReasoningSection />
    </div>
  );
}
