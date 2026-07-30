import { createFileRoute } from "@tanstack/react-router";
import { LlmProvidersSection } from "~/components/settings/llm-providers-section";
import { ModelPreferencesSection } from "~/components/settings/model-preferences-section";
import { OrgPermissionGuard } from "./settings.organization";

/**
 * `/settings/organization/models` — Organization · Models (llm-providers
 * design, plan Task 7). Provider CRUD/keys above, ordered model
 * preferences below. Gated on `providers:manage` (RBAC design) — the
 * `/settings/organization` layout only checks "any org permission", so an
 * operator (providers/infra/credentials) can reach this page while a
 * members-only caller cannot.
 */
export const Route = createFileRoute("/settings/organization/models")({
  component: OrganizationModelsPage,
});

export function OrganizationModelsPage() {
  return (
    <OrgPermissionGuard permission="providers:manage">
      <div className="space-y-10">
        <LlmProvidersSection />
        <ModelPreferencesSection />
      </div>
    </OrgPermissionGuard>
  );
}
