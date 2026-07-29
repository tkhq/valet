import { useState } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import type { ModelInfo } from "@valet/api/wire";
import { Badge, Button, Input, Spinner } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { useLlmProviderPreferences, useModels, usePutLlmProviderPreferences } from "~/api/settings";

/**
 * Organization · Models — ordered model preferences (llm-providers design,
 * plan Task 7). Rows come from the explicit `preferences` array
 * (`GET .../preferences`); the first row is the org default model. Active
 * catalog models (`useModels()`) not yet in the list are added via a search
 * typeahead (the earlier flat "Available models" list scaled to the whole
 * catalog and drowned the page). No drag-and-drop — up/down buttons
 * reorder, matching the plan's explicit no-new-dependency constraint.
 */
export function ModelPreferencesSection() {
  const modelsQ = useModels();
  const prefsQ = useLlmProviderPreferences();
  const putPrefs = usePutLlmProviderPreferences();
  const [saveError, setSaveError] = useState<string | null>(null);

  const preferences = prefsQ.data?.preferences ?? [];
  const catalog = modelsQ.data?.models ?? [];
  const catalogById = new Map(catalog.map((m) => [m.id, m]));
  const unlisted = catalog.filter((m) => !preferences.includes(m.id));

  function save(next: string[]) {
    setSaveError(null);
    putPrefs.mutate(
      { preferences: next },
      { onError: (err) => setSaveError(err instanceof Error ? err.message : String(err)) },
    );
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
      {saveError && <p className="text-xs text-danger-500">{saveError}</p>}

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

          {unlisted.length > 0 && <AddModelTypeahead options={unlisted} onAdd={add} />}
        </div>
      )}
    </Section>
  );
}

/**
 * Search-to-add typeahead over the active catalog models not yet in the
 * preference list. Same hand-rolled input+filtered-list pattern as
 * `ModelCombobox` (no Popover/Command primitive in this package; disclosed
 * tradeoff there applies here too). The list opens on focus/typing, caps at
 * 30 rows with a "narrow the search" hint, and stays open after an add so
 * several models can be added in one sitting.
 */
function AddModelTypeahead({
  options,
  onAdd,
}: {
  options: ModelInfo[];
  onAdd: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const q = query.trim().toLowerCase();
  const matches = options.filter(
    (m) =>
      q === "" ||
      m.id.toLowerCase().includes(q) ||
      m.name.toLowerCase().includes(q) ||
      m.providerName.toLowerCase().includes(q),
  );

  return (
    <div className="space-y-1">
      <div className="text-xs font-medium uppercase tracking-wider text-muted">Add a model</div>
      <Input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setQuery("");
            setOpen(false);
          }
        }}
        placeholder={`Search ${options.length} models — name, id, or provider…`}
        aria-label="Search models to add"
      />
      {open && (
        <div className="max-h-56 overflow-y-auto rounded border border-line">
          {matches.slice(0, 30).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onAdd(m.id)}
              className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm text-ink hover:bg-ink-wash"
            >
              <span className="truncate">{m.name}</span>
              <span className="ml-2 shrink-0 text-xs text-muted">{m.providerName}</span>
            </button>
          ))}
          {matches.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted">No matching models.</p>
          )}
          {matches.length > 30 && (
            <p className="px-2 py-1.5 text-xs text-muted">
              {matches.length - 30} more — narrow the search.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
