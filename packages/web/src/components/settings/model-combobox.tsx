import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { Input, Badge } from "~/components/primitives";
import { useModelTiers, useModels } from "~/api/settings";
import { curatedForCatalogId, type ModelOption } from "~/lib/models";
import { isSizeTier, SIZE_TIERS, TIER_LABELS, tierSubtitle } from "~/lib/model-tiers";
import type { ModelInfo } from "@valet/api/wire";
import { matchesNeedle } from "~/lib/text-match";

/**
 * Text `Input` + filtered popover list — the model typeahead (split-settings
 * design, "You · Assistant" default-model control). A "Size" group renders
 * first — five tier rows (xs..xl, org-configured via
 * `GET /api/org/model-tiers`, same `tierSubtitle` helper the chat
 * `ModelPicker` uses) that submit the bare tier token (e.g. `"l"`) rather
 * than a concrete model id; the engine resolves the tier at run time. Below
 * that, options come from the org catalog (`GET /api/models`, Task 4/8),
 * filtered to APPROVED models for everyone — this settings surface has no
 * admin reveal (org admins manage the approved list on the org models page
 * itself). The currently selected `value` stays labeled even if it has
 * since lost approval or left the catalog — only the option LIST is
 * approval-filtered, never the display of what is already chosen. Entries
 * whose id matches a curated `MODEL_CATALOG` tier (bare or
 * `anthropic/`-namespaced) render with the friendly label + tier badge;
 * everything else renders with its catalog `name` + provider hint.
 * Selecting a model option always submits the catalog's own `id` verbatim
 * — the curated list only supplies display labels, never overrides the id
 * being written. When `value` is a tier token, the input displays
 * `TIER_LABELS[value]`.
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
  emptyLabel = "System default",
  disabled = false,
}: {
  value: string | null;
  onSelect: (id: string) => void;
  onClear: () => void;
  /** Names what the cleared state falls back to, for both the placeholder
   * and the clear row — the fallback differs per surface (personal: team
   * then the cascade's next tier; team: the cascade's next tier). */
  emptyLabel?: string;
  /** Disables the input — a disabled `<input>` cannot receive focus, so
   * this also keeps the dropdown from opening. */
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const modelsQ = useModels();
  const tierMapQ = useModelTiers();

  const models = modelsQ.data?.models ?? [];
  // `isKnownValue`/`selectedEntry` must still recognize an unapproved (or
  // since-removed) selected value — only the OPTION LIST below is
  // approval-filtered, so `registryIds` stays keyed on the full catalog.
  const registryIds = useMemo(() => new Set(models.map((m) => m.id)), [models]);
  const approvedModels = useMemo(() => models.filter((m) => m.approved), [models]);

  const matches = useMemo(
    () => approvedModels.filter((m) => matchesQuery(m.id, m.name, query)),
    [approvedModels, query],
  );
  const curatedMatches = matches
    .map((m) => ({ m, curated: curatedForCatalogId(m.id) }))
    .filter((p): p is { m: ModelInfo; curated: ModelOption } => !!p.curated);
  const otherMatches = matches.filter((m) => !curatedForCatalogId(m.id));

  // The Size group hides when the query matches no tier label or token —
  // same substring matcher the model list search uses.
  const filteredTiers = useMemo(() => {
    if (query.trim().length === 0) return [...SIZE_TIERS];
    return SIZE_TIERS.filter((t) => matchesNeedle(query, [TIER_LABELS[t], t]));
  }, [query]);

  const selectedEntry = models.find((m) => m.id === value);
  const selectedCurated = curatedForCatalogId(value);
  const selectedTier = isSizeTier(value) ? value : undefined;
  const displayValue = value
    ? (selectedTier ? TIER_LABELS[selectedTier] : (selectedCurated?.label ?? selectedEntry?.name ?? value))
    : "";
  const isKnownValue = !value || !!selectedTier || registryIds.has(value) || !!selectedCurated;

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

  const hasResults =
    filteredTiers.length > 0 || curatedMatches.length > 0 || otherMatches.length > 0 || !!value;

  return (
    <div className="relative">
      <Input
        value={open ? query : displayValue}
        placeholder={emptyLabel}
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
        disabled={disabled}
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
              {emptyLabel}
            </button>
          )}
          {filteredTiers.length > 0 && (
            <div>
              <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
                Size
              </div>
              {filteredTiers.map((tier) => {
                const subtitle = tierSubtitle(tier, tierMapQ.data, models);
                return (
                  <button
                    key={tier}
                    type="button"
                    role="option"
                    aria-selected={value === tier}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => select(tier)}
                    className="flex w-full flex-col items-stretch gap-0.5 px-3 py-1.5 text-left text-sm hover:bg-ink-wash"
                  >
                    <span className="flex items-center gap-2">
                      {value === tier && <Check className="h-3.5 w-3.5 text-moss" />}
                      <span className="text-ink">{TIER_LABELS[tier]}</span>
                    </span>
                    {subtitle && (
                      <span className="pl-[22px] text-xs text-muted leading-snug">{subtitle}</span>
                    )}
                  </button>
                );
              })}
            </div>
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
              <Badge variant={speedClassBadgeVariant(curated.speedClass)}>{curated.speedClass}</Badge>
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
          {!hasResults &&
            (models.length === 0 && !modelsQ.isLoading ? (
              <div className="px-3 py-1.5 text-sm text-muted">
                No models available. Configure an LLM provider in the organization's Models
                settings.
              </div>
            ) : (
              <div className="px-3 py-1.5 text-sm text-muted">No matching models.</div>
            ))}
        </div>
      )}
      {value && !isKnownValue && modelsQ.data !== undefined && (
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

function speedClassBadgeVariant(
  speedClass: ModelOption["speedClass"],
): "neutral" | "accent" | "success" {
  if (speedClass === "powerful") return "accent";
  if (speedClass === "balanced") return "success";
  return "neutral";
}
