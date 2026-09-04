import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useState } from "react";
import { Button, Spinner } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { AddModelTypeahead } from "~/components/settings/model-preferences-section";
import { useModelTiers, useModels, usePatchModelTiers } from "~/api/settings";
import { apiErrorMessage } from "~/api/policies";
import { SIZE_TIERS, TIER_LABELS, type SizeTier } from "~/lib/model-tiers";
import type { PatchModelTiersRequest } from "@valet/api/wire";

/** One-tier `PatchModelTiersRequest` — a computed `{ [tier]: next }` object
 * literal widens to a string index signature, so this switch keeps the
 * request typed against `PatchModelTiersRequest` without an `as` cast. */
function tierPatch(tier: SizeTier, next: string[]): PatchModelTiersRequest {
  switch (tier) {
    case "xs":
      return { xs: next };
    case "s":
      return { s: next };
    case "m":
      return { m: next };
    case "l":
      return { l: next };
    case "xl":
      return { xl: next };
  }
}

/**
 * Organization · Models — size-tier map (model-selector-overhaul, Task 13).
 * One row-group per `SIZE_TIERS` entry, each an ordered target list the
 * engine resolves at run time (`GET`/`PATCH /api/org/model-tiers`, always
 * five tiers). Reuses the up/down/remove row pattern and `AddModelTypeahead`
 * from `ModelPreferencesSection` per tier.
 */
export function ModelTiersSection() {
  const modelsQ = useModels();
  const tiersQ = useModelTiers();
  const patchTiers = usePatchModelTiers();
  const [saveError, setSaveError] = useState<string | null>(null);

  const catalog = modelsQ.data?.models ?? [];
  const catalogById = new Map(catalog.map((m) => [m.id, m]));
  const tiers = tiersQ.data;

  function save(tier: SizeTier, next: string[]) {
    setSaveError(null);
    patchTiers.mutate(tierPatch(tier, next), {
      onError: (err) => setSaveError(apiErrorMessage(err)),
    });
  }

  return (
    <Section
      title="Model tiers"
      description="Assign an ordered fallback list of models to each size tier. The engine resolves a tier to its first available target."
    >
      {(modelsQ.isLoading || tiersQ.isLoading) && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {(modelsQ.error || tiersQ.error) && (
        <p className="py-4 text-sm text-danger-500">Failed to load model tiers.</p>
      )}
      {saveError && <p className="text-xs text-danger-500">{saveError}</p>}

      {modelsQ.data && tiers && (
        <div className="divide-y divide-line">
          {SIZE_TIERS.map((tier) => {
            const targets = tiers[tier];
            const firstModel = targets[0] ? catalogById.get(targets[0]) : undefined;
            const unlisted = catalog.filter((m) => !targets.includes(m.id));

            function moveUp(index: number) {
              if (index <= 0) return;
              const next = [...targets];
              [next[index - 1], next[index]] = [next[index], next[index - 1]];
              save(tier, next);
            }

            function moveDown(index: number) {
              if (index >= targets.length - 1) return;
              const next = [...targets];
              [next[index], next[index + 1]] = [next[index + 1], next[index]];
              save(tier, next);
            }

            function remove(id: string) {
              save(
                tier,
                targets.filter((t) => t !== id),
              );
            }

            function add(id: string) {
              save(tier, [...targets, id]);
            }

            return (
              <div key={tier} className="space-y-2 py-4">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-sm font-medium text-ink">{TIER_LABELS[tier]}</h3>
                  {firstModel && <span className="text-xs text-muted">{firstModel.name}</span>}
                </div>

                <div className="divide-y divide-line">
                  {targets.length === 0 && (
                    <p className="py-2 text-sm text-muted">No targets set for this tier.</p>
                  )}
                  {targets.map((id, i) => {
                    const model = catalogById.get(id);
                    const label = model?.name ?? id;
                    return (
                      <div key={id} className="flex items-center gap-2 py-2">
                        <span className="min-w-0 flex-1 truncate text-sm text-ink">{label}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Move ${label} up in ${TIER_LABELS[tier]}`}
                          disabled={i === 0}
                          onClick={() => moveUp(i)}
                        >
                          <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Move ${label} down in ${TIER_LABELS[tier]}`}
                          disabled={i === targets.length - 1}
                          onClick={() => moveDown(i)}
                        >
                          <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove ${label} from ${TIER_LABELS[tier]}`}
                          onClick={() => remove(id)}
                        >
                          <X className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      </div>
                    );
                  })}
                </div>

                {unlisted.length > 0 && <AddModelTypeahead options={unlisted} onAdd={add} />}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
