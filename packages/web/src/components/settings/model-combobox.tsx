import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { Input, Badge } from "~/components/primitives";
import { useModels } from "~/api/settings";
import { MODEL_CATALOG, findModel, type ModelOption } from "~/lib/models";

/**
 * Text `Input` + filtered popover list — the model typeahead (split-settings
 * design, "You · Assistant" default-model control). Filters case-insensitive
 * on both id and label; curated `MODEL_CATALOG` matches surface first (with
 * their friendly label + tier badge), remaining `GET /api/models` registry
 * ids follow below by raw id. A "System default" row clears the override
 * when one is set.
 *
 * Built with a plain filtered list under the input rather than a
 * Popover/Command primitive — this package's `components/primitives/` has
 * no Radix Popover or Command component, and hand-rolling full
 * roving-focus keyboard nav for one control isn't worth a new dependency
 * (per task brief: click-to-select is an acceptable, disclosed tradeoff).
 * Basic keyboard support (Escape to close, click-away close) is covered;
 * arrow-key list navigation is not.
 */
export function ModelCombobox({
  value,
  onSelect,
  onClear,
}: {
  value: string | null;
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const modelsQ = useModels();

  const registryIds = useMemo(
    () => new Set((modelsQ.data?.models ?? []).map((m) => m.id)),
    [modelsQ.data],
  );

  const curatedMatches = useMemo(() => filterCurated(MODEL_CATALOG, query), [query]);
  const curatedIds = useMemo(() => new Set(MODEL_CATALOG.map((m) => m.id)), []);
  const otherMatches = useMemo(
    () =>
      (modelsQ.data?.models ?? [])
        .filter((m) => !curatedIds.has(m.id))
        .filter((m) => matchesQuery(m.id, m.name, query))
        .map((m) => m.id),
    [modelsQ.data, curatedIds, query],
  );

  const selectedCatalog = findModel(value);
  const displayValue = value ? (selectedCatalog?.label ?? value) : "";

  function select(id: string) {
    onSelect(id);
    setQuery("");
    setOpen(false);
  }

  function clear() {
    onClear();
    setQuery("");
    setOpen(false);
  }

  const hasResults = curatedMatches.length > 0 || otherMatches.length > 0 || !!value;

  return (
    <div className="relative">
      <Input
        value={open ? query : displayValue}
        placeholder="System default"
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        onBlur={() => {
          // Delay so a click on a list item registers before we close.
          setTimeout(() => setOpen(false), 120);
        }}
        aria-label="Default model"
        role="combobox"
        aria-expanded={open}
      />
      {open && (
        <div
          role="listbox"
          aria-label="Model results"
          className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded border border-line bg-paper py-1 shadow-lg"
        >
          {value && (
            <button
              type="button"
              role="option"
              aria-selected={false}
              onMouseDown={(e) => e.preventDefault()}
              onClick={clear}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-muted hover:bg-ink-wash"
            >
              System default
            </button>
          )}
          {curatedMatches.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={value === m.id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => select(m.id)}
              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-ink-wash"
            >
              <span className="flex items-center gap-2">
                {value === m.id && <Check className="h-3.5 w-3.5 text-moss" />}
                <span className="text-ink">{m.label}</span>
              </span>
              <Badge variant={tierBadgeVariant(m.tier)}>{m.tier}</Badge>
            </button>
          ))}
          {otherMatches.map((id) => (
            <button
              key={id}
              type="button"
              role="option"
              aria-selected={value === id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => select(id)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-ink-wash"
            >
              {value === id && <Check className="h-3.5 w-3.5 text-moss" />}
              <span className="text-muted">{id}</span>
            </button>
          ))}
          {!hasResults && (
            <div className="px-3 py-1.5 text-sm text-muted">No matching models.</div>
          )}
        </div>
      )}
      {value && !registryIds.has(value) && !curatedIds.has(value) && !modelsQ.isLoading && (
        <p className="mt-1 text-xs text-danger-500">
          &quot;{value}&quot; isn&apos;t in the current model registry.
        </p>
      )}
    </div>
  );
}

function filterCurated(catalog: readonly ModelOption[], query: string): ModelOption[] {
  if (!query.trim()) return [...catalog];
  return catalog.filter((m) => matchesQuery(m.id, m.label, query));
}

function matchesQuery(id: string, label: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return id.toLowerCase().includes(q) || label.toLowerCase().includes(q);
}

function tierBadgeVariant(tier: ModelOption["tier"]): "neutral" | "accent" | "success" {
  if (tier === "powerful") return "accent";
  if (tier === "balanced") return "success";
  return "neutral";
}
