import { useState } from "react";
import { Spinner } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { OrderedModelList } from "~/components/settings/ordered-model-list";
import { useLlmProviderPreferences, useModels, usePutLlmProviderPreferences } from "~/api/settings";

/**
 * Organization · Models — ordered model preferences (llm-providers design,
 * plan Task 7). Rows come from the explicit `preferences` array
 * (`GET .../preferences`); the first row is the org default model. Active
 * catalog models (`useModels()`) not yet in the list are added via a search
 * typeahead. No drag-and-drop — up/down buttons reorder, matching the
 * plan's explicit no-new-dependency constraint.
 */
export function ModelPreferencesSection() {
  const modelsQ = useModels();
  const prefsQ = useLlmProviderPreferences();
  const putPrefs = usePutLlmProviderPreferences();
  const [saveError, setSaveError] = useState<string | null>(null);

  const preferences = prefsQ.data?.preferences ?? [];
  const catalog = modelsQ.data?.models ?? [];

  function save(next: string[]) {
    setSaveError(null);
    putPrefs.mutate(
      { preferences: next },
      { onError: (err) => setSaveError(err instanceof Error ? err.message : String(err)) },
    );
  }

  return (
    <Section
      title="Model preferences"
      description="Order the models sessions choose from. The first is the org default."
    >
      {(modelsQ.isLoading || prefsQ.isLoading) && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {(modelsQ.error || prefsQ.error) && (
        <p className="py-4 text-sm text-danger-500">
          Could not load model preferences. Refresh the page.
        </p>
      )}
      {saveError && <p className="text-xs text-danger-500">{saveError}</p>}

      {modelsQ.data && prefsQ.data && (
        <div className="space-y-4 py-4">
          <OrderedModelList
            preferences={preferences}
            catalog={catalog}
            firstBadge="Default"
            onChange={save}
          />
        </div>
      )}
    </Section>
  );
}
