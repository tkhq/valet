import { useState } from "react";
import type { ModelInfo } from "@valet/api/wire";
import { Checkbox, Spinner, Switch } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { useApprovedModels, useModels, usePutApprovedModels } from "~/api/settings";
import { apiErrorMessage } from "~/api/policies";
import { curatedForCatalogId } from "~/lib/models";

/** Catalog models grouped by provider, in catalog order. Grouped by
 * `providerId` (not `providerName`) — two configured providers can share a
 * display name. */
function groupByProvider(catalog: ModelInfo[]): { providerId: string; providerName: string; models: ModelInfo[] }[] {
  const groups: { providerId: string; providerName: string; models: ModelInfo[] }[] = [];
  const byId = new Map<string, { providerId: string; providerName: string; models: ModelInfo[] }>();
  for (const model of catalog) {
    let group = byId.get(model.providerId);
    if (!group) {
      group = { providerId: model.providerId, providerName: model.providerName, models: [] };
      byId.set(model.providerId, group);
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}

/**
 * Organization · Models — approved-model restriction (model-selector-
 * overhaul, Task 13). `GET`/`PUT /api/org/approved-models` stores `null`
 * (unrestricted, the default) or an explicit list. Turning the switch on
 * seeds the list from the curated models present in the catalog; the
 * checkbox list below edits it directly. The API rejects an empty list, so
 * unchecking the last model is blocked client-side with a corrective
 * message instead of round-tripping a 400.
 */
export function ApprovedModelsSection() {
  const modelsQ = useModels();
  const approvedQ = useApprovedModels();
  const putApproved = usePutApprovedModels();
  const [error, setError] = useState<string | null>(null);

  const catalog = modelsQ.data?.models ?? [];
  const approved = approvedQ.data?.approved ?? null;
  const restricted = approved !== null;

  function setRestricted(next: boolean) {
    setError(null);
    if (!next) {
      putApproved.mutate({ approved: null }, { onError: (err) => setError(apiErrorMessage(err)) });
      return;
    }
    const seeded = catalog.filter((m) => curatedForCatalogId(m.id)).map((m) => m.id);
    putApproved.mutate({ approved: seeded }, { onError: (err) => setError(apiErrorMessage(err)) });
  }

  function toggle(id: string, checked: boolean) {
    const current = approved ?? [];
    const next = checked ? [...current, id] : current.filter((existing) => existing !== id);
    if (next.length === 0) {
      setError("Keep at least one model approved, or turn off the restriction.");
      return;
    }
    setError(null);
    putApproved.mutate({ approved: next }, { onError: (err) => setError(apiErrorMessage(err)) });
  }

  return (
    <Section
      title="Approved models"
      description="Restrict members to an approved model list. Off, members can use any active model."
    >
      {(modelsQ.isLoading || approvedQ.isLoading) && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {(modelsQ.error || approvedQ.error) && (
        <p className="py-4 text-sm text-danger-500">Failed to load approved models.</p>
      )}

      {modelsQ.data && approvedQ.data && (
        <div className="space-y-4 py-4">
          <label className="flex items-center gap-3 text-sm text-ink">
            <Switch
              checked={restricted}
              onCheckedChange={setRestricted}
              aria-label="Restrict members to approved models"
            />
            Restrict members to approved models
          </label>

          {error && <p className="text-xs text-danger-500">{error}</p>}

          {restricted && (
            <div className="space-y-4">
              {groupByProvider(catalog).map((group) => (
                <div key={group.providerId} className="space-y-1">
                  <div className="text-xs font-medium uppercase tracking-wider text-muted">
                    {group.providerName}
                  </div>
                  {group.models.map((model) => {
                    const checked = (approved ?? []).includes(model.id);
                    return (
                      <label key={model.id} className="flex items-center gap-2 py-1 text-sm text-ink">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) => toggle(model.id, next)}
                          aria-label={model.name}
                        />
                        {model.name}
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
