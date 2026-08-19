import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { Input, Badge } from "~/components/primitives";
import { useModels } from "~/api/settings";
import { curatedForCatalogId, type ModelOption } from "~/lib/models";
import type { ModelInfo } from "@valet/api/wire";
import { matchesNeedle } from "~/lib/text-match";

/**
 * Text `Input` + filtered popover list — the model typeahead (split-settings
 * design, "You · Assistant" default-model control). Options come from the
 * org catalog (`GET /api/models`, Task 4/8) — already preference-ordered.
 * Entries whose id matches a curated `MODEL_CATALOG` tier (bare or
 * `anthropic/`-namespaced) render with the friendly label + tier badge;
 * everything else renders with its catalog `name` + provider hint.
 * Selecting an option always submits the catalog's own `id` verbatim — the
 * curated list only supplies display labels, never overrides the id being
 * written.
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

  const models = modelsQ.data?.models ?? [];
  const registryIds = useMemo(() => new Set(models.map((m) => m.id)), [models]);

  const matches = useMemo(() => models.filter((m) => matchesQuery(m.id, m.name, query)), [models, query]);
  const curatedMatches = matches
    .map((m) => ({ m, curated: curatedForCatalogId(m.id) }))
    .filter((p): p is { m: ModelInfo; curated: ModelOption } => !!p.curated);
  const otherMatches = matches.filter((m) => !curatedForCatalogId(m.id));

  const selectedEntry = models.find((m) => m.id === value);
  const selectedCurated = curatedForCatalogId(value);
  const displayValue = value ? (selectedCurated?.label ?? selectedEntry?.name ?? value) : "";
  const isKnownValue = !value || registryIds.has(value) || !!selectedCurated;

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
          {curatedMatches.map(({ m, curated }) => (
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
                <span className="text-ink">{curated.label}</span>
              </span>
              <Badge variant={tierBadgeVariant(curated.tier)}>{curated.tier}</Badge>
            </button>
          ))}
          {otherMatches.map((m) => (
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
                <span className="text-ink">{m.name}</span>
              </span>
              <span className="text-xs text-muted">{m.providerName}</span>
            </button>
          ))}
          {!hasResults && (
            <div className="px-3 py-1.5 text-sm text-muted">No matching models.</div>
          )}
        </div>
      )}
      {value && !isKnownValue && !modelsQ.isLoading && (
        <p className="mt-1 text-xs text-danger-500">
          &quot;{value}&quot; isn&apos;t in the current model registry.
        </p>
      )}
    </div>
  );
}

function matchesQuery(id: string, label: string, query: string): boolean {
  return matchesNeedle(query, [id, label]);
}

function tierBadgeVariant(tier: ModelOption["tier"]): "neutral" | "accent" | "success" {
  if (tier === "powerful") return "accent";
  if (tier === "balanced") return "success";
  return "neutral";
}
