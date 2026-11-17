import { createFileRoute } from "@tanstack/react-router";
import { LlmProvidersSection } from "~/components/settings/llm-providers-section";

/**
 * `/settings/models` — single-user-mode home for provider configuration:
 * the providers section of `/settings/organization/models`, reachable
 * WITHOUT the organizations feature flag. In stub/local mode the seeded
 * `local-user` is an org admin of `local-org`, so every
 * `/api/org/llm-providers` route already authorizes. The rail shows this
 * entry under Personal only while the Organization group is hidden (see
 * `settings-rail.tsx`), so the two routes never both appear.
 */
export const Route = createFileRoute("/settings/models")({
  component: SettingsModelsPage,
});

export function SettingsModelsPage() {
  return <LlmProvidersSection />;
}
