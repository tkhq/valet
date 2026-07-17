import { ArrowDown, ArrowUp, X } from "lucide-react";
import { Badge, Button, Spinner } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { useLlmProviderPreferences, useModels, usePutLlmProviderPreferences } from "~/api/settings";

/**
 * Organization · Models — ordered model preferences (llm-providers design,
 * plan Task 7). Rows come from the explicit `preferences` array
 * (`GET .../preferences`); the first row is the org default model. Active
 * catalog models (`useModels()`) not yet in the list are offered below with
 * an "add" affordance. No drag-and-drop — up/down buttons reorder, matching
 * the plan's explicit no-new-dependency constraint.
 */
export function ModelPreferencesSection() {
  const modelsQ = useModels();
  const prefsQ = useLlmProviderPreferences();
  const putPrefs = usePutLlmProviderPreferences();

  const preferences = prefsQ.data?.preferences ?? [];
  const catalog = modelsQ.data?.models ?? [];
  const catalogById = new Map(catalog.map((m) => [m.id, m]));
  const unlisted = catalog.filter((m) => !preferences.includes(m.id));

  function save(next: string[]) {
    putPrefs.mutate({ preferences: next });
  }

  function moveUp(index: number) {
    if (index <= 0) return;
    const next = [...preferences];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    save(next);
  }

  function moveDown(index: number) {
    if (index >= preferences.length - 1) return;
    const next = [...preferences];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    save(next);
  }

  function remove(id: string) {
    save(preferences.filter((p) => p !== id));
  }

  function add(id: string) {
    save([...preferences, id]);
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
        <p className="py-4 text-sm text-danger-500">Failed to load model preferences.</p>
      )}

      {modelsQ.data && prefsQ.data && (
        <div className="space-y-4 py-4">
          <div className="divide-y divide-line">
            {preferences.length === 0 && (
              <p className="py-2 text-sm text-muted">No preferred models yet.</p>
            )}
            {preferences.map((id, i) => {
              const model = catalogById.get(id);
              const label = model?.name ?? id;
              return (
                <div key={id} className="flex items-center gap-2 py-2">
                  {i === 0 && <Badge variant="accent">Default</Badge>}
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{label}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Move ${label} up`}
                    disabled={i === 0}
                    onClick={() => moveUp(i)}
                  >
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Move ${label} down`}
                    disabled={i === preferences.length - 1}
                    onClick={() => moveDown(i)}
                  >
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${label}`}
                    onClick={() => remove(id)}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </div>
              );
            })}
          </div>

          {unlisted.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-medium uppercase tracking-wider text-muted">
                Available models
              </div>
              <div className="divide-y divide-line">
                {unlisted.map((m) => (
                  <div key={m.id} className="flex items-center gap-2 py-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">{m.name}</span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => add(m.id)}>
                      Add
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
