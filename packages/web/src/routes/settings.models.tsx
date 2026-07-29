import { createFileRoute } from "@tanstack/react-router";
import { LlmProvidersSection } from "~/components/settings/llm-providers-section";
import { ModelPreferencesSection } from "~/components/settings/model-preferences-section";

/**
 * `/settings/models` — single-user-mode home for provider/model
 * configuration. Same sections as `/settings/organization/models`, but
 * reachable WITHOUT the organizations feature flag: in stub/local mode the
 * seeded `local-user` is an org admin of `local-org`, so every
 * `/api/org/llm-providers` route already authorizes — only the org rail
 * group's gating made this surface unreachable. The rail shows this entry
 * under "You" precisely when the Organization group is hidden (see
 * `settings-rail.tsx`), so the two routes never both appear.
 */
export const Route = createFileRoute("/settings/models")({
  component: SettingsModelsPage,
});

export function SettingsModelsPage() {
  return (
    <div className="space-y-10">
      <LlmProvidersSection />
      <ModelPreferencesSection />
    </div>
  );
}
