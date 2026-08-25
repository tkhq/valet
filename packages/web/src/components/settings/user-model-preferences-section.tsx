import { useState } from "react";
import { Spinner } from "~/components/primitives";
import { OrderedModelList } from "~/components/settings/ordered-model-list";
import { useMe, useModels, usePatchMe } from "~/api/settings";

/**
 * You · Assistant — per-user ordered model preferences. Distinct from the
 * org-level `ModelPreferencesSection` (`/api/org/llm-providers/preferences`,
 * admin-only): this list lives on the user row, saves through
 * `PATCH /api/me { modelPreferences }`, and is consulted by the session
 * builder AFTER `defaultModel` and BEFORE the org list (see
 * `EngineHost.resolveModelForBuild`). The list UI is shared
 * (`OrderedModelList`). `maxItems={20}` matches the PATCH /api/me cap.
 */
export function UserModelPreferencesSection() {
  const modelsQ = useModels();
  const meQ = useMe();
  const patchMe = usePatchMe();
  const [saveError, setSaveError] = useState<string | null>(null);

  const preferences = meQ.data?.modelPreferences ?? [];
  const catalog = modelsQ.data?.models ?? [];

  function save(next: string[]) {
    setSaveError(null);
    patchMe.mutate(
      { modelPreferences: next },
      { onError: (err) => setSaveError(err instanceof Error ? err.message : String(err)) },
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-ink">Model preferences</div>
      <p className="text-xs text-muted">
        This list is the order of models for new conversations when you have no
        default model. Your default model wins over this list. Valet uses the org
        list after yours.
      </p>

      {(modelsQ.isLoading || meQ.isLoading) && (
        <div className="flex items-center gap-2 py-2 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {(modelsQ.error || meQ.error) && (
        <p className="py-2 text-sm text-danger-500">
          Could not load model preferences. Refresh the page.
        </p>
      )}
      {saveError && <p className="text-xs text-danger-500">{saveError}</p>}

      {modelsQ.data && meQ.data && (
        <div className="space-y-3">
          <OrderedModelList
            preferences={preferences}
            catalog={catalog}
            firstBadge="First"
            maxItems={20}
            onChange={save}
          />
        </div>
      )}
    </div>
  );
}
