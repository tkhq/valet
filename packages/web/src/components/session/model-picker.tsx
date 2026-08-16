import { Check, ChevronDown, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/primitives";
import { useModels } from "~/api/settings";
import { curatedForCatalogId } from "~/lib/models";
import type { ModelInfo } from "@valet/api/wire";
import { cn } from "~/lib/cn";

/**
 * Model selector — a filterable, provider-grouped, keyboard-navigable
 * picker inspired by the V1 client's `/model` overlay. It renders as a
 * small ghost button with the current model's short label and a chevron,
 * so it fits in a tight header.
 *
 * Options come from the org catalog (`GET /api/models`, Task 4/8), listed
 * in response order (already preference-ordered). By default Anthropic
 * entries collapse to the curated tier list (one row per newest tier) so
 * `anthropic/claude-3-5-haiku-20241022` and its many aliases don't crowd
 * the picker; the "Show all" toggle reveals every entry. Non-Anthropic
 * providers always show — they can never be a duplicate of a Claude tier.
 * Entries matching a curated `MODEL_CATALOG` tier (bare or `anthropic/`-
 * namespaced) render with their curated label + description; others render
 * with the catalog `name` + provider hint. Selecting an item always submits
 * the catalog's own id verbatim.
 *
 * Keyboard: ↑/↓ move highlight, Enter selects, / focuses search (from
 * anywhere in the dropdown). Search matches name/id/provider substrings.
 *
 * `currentId` may be a value that is no longer in the catalog — it is
 * still labeled rather than blanked. An undefined `currentId` reads as
 * "Inherit": the session has no model of its own and follows the account
 * default.
 */
export interface ModelPickerProps {
  currentId?: string;
  /** Called when the user picks a model. Returns the model id. */
  onSelect: (id: string) => void;
  /** Disable interactions (e.g. while a mutation is in flight). */
  disabled?: boolean;
}

function labelFor(id: string, models: ModelInfo[]): string {
  const curated = curatedForCatalogId(id);
  if (curated) return curated.label;
  return models.find((m) => m.id === id)?.name ?? id;
}

function isAnthropic(id: string): boolean {
  return id.startsWith("anthropic/") || !id.includes("/");
}

interface GroupedEntry {
  provider: string;
  entries: ModelInfo[];
}

/** Group models by provider preserving encounter order for both providers
 * and entries within each provider. */
export function groupByProvider(models: ModelInfo[]): GroupedEntry[] {
  const map = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const list = map.get(m.providerName);
    if (list) list.push(m);
    else map.set(m.providerName, [m]);
  }
  return Array.from(map, ([provider, entries]) => ({ provider, entries }));
}

/** Substring match on name, id, and provider. Case-insensitive. Empty
 * query returns everything unchanged. */
export function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
  const q = query.toLowerCase().trim();
  if (!q) return models;
  return models.filter(
    (m) =>
      m.name.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      m.providerName.toLowerCase().includes(q),
  );
}

export function ModelPicker({
  currentId,
  onSelect,
  disabled,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const modelsQ = useModels();
  const models = modelsQ.data?.models ?? [];

  // Collapse Anthropic aliases by default unless `showAll` or query is
  // active — a search should peek into the whole catalog so a user typing
  // "haiku-3-5-2024" can still find that pinned alias without toggling.
  const filteredModels = useMemo(() => {
    const revealAll = showAll || query.trim().length > 0;
    const baseline = revealAll
      ? models
      : models.filter((m) => {
          if (m.id === currentId) return true;
          if (!isAnthropic(m.id)) return true;
          return !!curatedForCatalogId(m.id);
        });
    return filterModels(baseline, query);
  }, [models, showAll, query, currentId]);

  const grouped = useMemo(() => groupByProvider(filteredModels), [filteredModels]);
  const flat = filteredModels; // for keyboard nav indexing
  const hiddenCount = models.length - filteredModels.length;

  // Reset highlight when the filtered set changes.
  useEffect(() => {
    setHighlightIndex(0);
  }, [query, showAll, open]);

  // Auto-focus search when the menu opens; reset filter state on close.
  useEffect(() => {
    if (open) {
      // Radix mounts the content, then we focus. rAF is enough.
      requestAnimationFrame(() => searchRef.current?.focus());
    } else {
      setQuery("");
      setShowAll(false);
    }
  }, [open]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-model-index="${highlightIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex, open]);

  const triggerLabel = currentId ? labelFor(currentId, models) : "Inherit";

  function commitHighlighted() {
    const m = flat[highlightIndex];
    if (!m) return;
    onSelect(m.id);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, Math.max(flat.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commitHighlighted();
    } else if (e.key === "/" && document.activeElement !== searchRef.current) {
      // "/" from anywhere in the menu jumps back to the search box.
      e.preventDefault();
      searchRef.current?.focus();
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="font-normal gap-1.5"
          aria-label="Choose model"
        >
          <Sparkles className="h-3.5 w-3.5 text-muted" aria-hidden />
          <span className="truncate text-xs">{triggerLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted shrink-0 ml-auto" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[340px] max-h-[min(70vh,560px)] overflow-hidden p-0"
        // Keyboard nav is handled locally so Radix's own arrow-key
        // handling doesn't fight ours.
        onKeyDown={onKeyDown}
      >
        <div className="sticky top-0 z-10 bg-paper border-b border-line px-2 py-1.5">
          <div className="flex items-center gap-1.5 rounded border border-line bg-[--bg] px-2">
            <Search className="h-3.5 w-3.5 text-muted shrink-0" aria-hidden />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              className="h-7 w-full bg-transparent text-xs text-ink placeholder:text-muted focus:outline-none"
              aria-label="Search models"
            />
          </div>
        </div>
        <div ref={listRef} className="max-h-[440px] overflow-y-auto">
          {modelsQ.isLoading && (
            <div className="px-3 py-2 text-xs text-muted">Loading models…</div>
          )}
          {!modelsQ.isLoading && models.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted">No models available.</div>
          )}
          {!modelsQ.isLoading && models.length > 0 && flat.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted">No matching models.</div>
          )}
          {grouped.map(({ provider, entries }) => (
            <div key={provider}>
              <DropdownMenuLabel className="sticky top-0 bg-paper/95 backdrop-blur-sm py-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-muted">
                {provider}
              </DropdownMenuLabel>
              {entries.map((m) => {
                const idx = flat.indexOf(m);
                const isHighlighted = idx === highlightIndex;
                const isSelected = m.id === currentId;
                const curated = curatedForCatalogId(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    data-model-index={idx}
                    onMouseEnter={() => setHighlightIndex(idx)}
                    onMouseDown={(e) => {
                      // Prevent input blur from stealing focus before we
                      // commit — otherwise the click can race the close.
                      e.preventDefault();
                      onSelect(m.id);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full flex-col items-stretch gap-0.5 px-3 py-1.5 text-left transition-colors",
                      isHighlighted ? "bg-moss-wash text-ink" : "text-ink hover:bg-neutral-100 dark:hover:bg-neutral-800",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {isSelected ? (
                        <Check className="h-3.5 w-3.5 text-moss shrink-0" />
                      ) : (
                        <span className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <span className="text-sm font-medium">{curated?.label ?? m.name}</span>
                      {isSelected && (
                        <span className="text-[9px] font-medium uppercase tracking-wide text-moss/80">
                          current
                        </span>
                      )}
                      <span className="ml-auto font-mono text-[10px] text-muted/70 truncate max-w-[160px]">
                        {m.id}
                      </span>
                    </div>
                    {(curated?.description || m.providerName !== provider) && (
                      <div className="pl-[22px] text-xs text-muted leading-snug">
                        {curated?.description}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="sticky bottom-0 bg-paper border-t border-line px-3 py-1.5 text-[10px] text-muted">
          <span>
            {flat.length} of {models.length} models
            {hiddenCount > 0 && !showAll && !query && (
              <>
                {" · "}
                <button
                  type="button"
                  className="italic underline decoration-dotted hover:text-ink"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setShowAll(true);
                    searchRef.current?.focus();
                  }}
                >
                  show {hiddenCount} more
                </button>
              </>
            )}
            {showAll && !query && (
              <>
                {" · "}
                <button
                  type="button"
                  className="italic underline decoration-dotted hover:text-ink"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setShowAll(false);
                    searchRef.current?.focus();
                  }}
                >
                  recommended only
                </button>
              </>
            )}
          </span>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
