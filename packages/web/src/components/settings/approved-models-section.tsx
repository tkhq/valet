import { useState } from "react";
import type { ModelInfo } from "@valet/api/wire";
import { Checkbox, Spinner, Switch } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { useApprovedModels, useModelTiers, useModels, usePutApprovedModels } from "~/api/settings";
import { apiErrorMessage } from "~/api/policies";
import { curatedForCatalogId, sameModelSpec } from "~/lib/models";
import { SIZE_TIERS } from "~/lib/model-tiers";
import type { WireTierMap } from "@valet/api/wire";

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

/** Every model id named by any tier's ordered target list, deduped. */
function tierEnrolledIds(tiers: WireTierMap): string[] {
  const ids = new Set<string>();
  for (const tier of SIZE_TIERS) {
    for (const id of tiers[tier]) ids.add(id);
  }
  return [...ids];
}

/**
 * Organization · Models — approved-model restriction (model-selector-
 * overhaul, Task 13). `GET`/`PUT /api/org/approved-models` stores `null`
 * (unrestricted, the default) or an explicit list. Turning the switch on
 * seeds the list from the union of every model enrolled in the org's tier
 * map and the curated models present in the catalog, filtered to ids the
 * catalog actually has and deduped — a tier-enrolled model MUST start
 * checked, or the very next tier-map edit would 400 (the tier-map PATCH
 * validates targets against the approved list). The checkbox list below
 * edits the approved list directly. The API rejects an empty list, so
 * unchecking the last model is blocked client-side with a corrective
 * message instead of round-tripping a 400.
 */
export function ApprovedModelsSection() {
  const modelsQ = useModels();
  const approvedQ = useApprovedModels();
  const tiersQ = useModelTiers();
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
    // `.has(id)` alone would miss a bare-spelled Anthropic tier target
    // (`"claude-haiku-4-5"`) when the catalog lists it namespaced
    // (`"anthropic/claude-haiku-4-5"`) — match through the same bare/
    // namespaced normalization `isApproved` (server-side) uses, or a
    // bare-spelled enrolled target gets dropped from the seed and then
    // fails its own tier-map's approval check.
    const inCatalog = (id: string) => catalog.some((m) => sameModelSpec(m.id, id));
    const enrolled = tiersQ.data ? tierEnrolledIds(tiersQ.data) : [];
    const curated = catalog.filter((m) => curatedForCatalogId(m.id)).map((m) => m.id);
    const seeded = [...new Set([...enrolled, ...curated])].filter(inCatalog);
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
      {(modelsQ.isLoading || approvedQ.isLoading || tiersQ.isLoading) && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {(modelsQ.error || approvedQ.error || tiersQ.error) && (
        <p className="py-4 text-sm text-danger-500">Failed to load approved models.</p>
      )}

      {modelsQ.data && approvedQ.data && tiersQ.data && (
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
