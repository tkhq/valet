import { Check, ChevronDown, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/primitives";
import { useMe, useModelTiers, useModels, useOrgReasoning } from "~/api/settings";
import { curatedForCatalogId } from "~/lib/models";
import { SIZE_TIERS, TIER_LABELS, isSizeTier, labelFor, tierSubtitle, type SizeTier } from "~/lib/model-tiers";
import { REASONING_LABELS, levelsUpTo, reasoningLabelFor } from "~/lib/reasoning";
import type { GetModelTiersResponse, ModelInfo } from "@valet/api/wire";
import { cn } from "~/lib/cn";
import { matchesNeedle } from "~/lib/text-match";

/**
 * Model selector — a filterable, provider-grouped, keyboard-navigable
 * picker inspired by the V1 client's `/model` overlay. It renders as a
 * small ghost button with the current model's short label and a chevron,
 * so it fits in a tight header.
 *
 * A "Size" group renders first — five tier rows (xs..xl, org-configured via
 * `GET /api/org/model-tiers`) that submit the bare tier token
 * (e.g. `"l"`) rather than a concrete model id; the engine resolves the
 * tier at run time. They join the same keyboard-nav list as the model rows
 * below, always occupying the first `SIZE_TIERS.length` slots.
 *
 * Options come from the org catalog (`GET /api/models`, Task 4/8), listed
 * in response order. The baseline list is approved-only for EVERYONE
 * (org model preferences are gone; approval is the only gate left) —
 * except a model already pinned as `currentId` is always shown, even if it
 * has since lost approval, so the picker never renders as if the current
 * pin doesn't exist. By default Anthropic entries also collapse to the
 * curated tier list (one row per newest tier) so
 * `anthropic/claude-3-5-haiku-20241022` and its many aliases don't crowd
 * the picker. The "Show all"/"show N more" toggle reveals the rest, but
 * its reach differs by role: for an org admin it reveals the FULL catalog,
 * including unapproved entries (the server has a matching admin bypass, so
 * they can still select one); for a member it only reveals the remaining
 * APPROVED non-curated entries — an unapproved model never appears for a
 * member, including while searching. Non-Anthropic providers always show
 * in the curated-collapsed baseline — they can never be a duplicate of a
 * Claude tier. Entries matching a curated `MODEL_CATALOG` tier (bare or
 * `anthropic/`-namespaced) render with their curated label + description;
 * others render with the catalog `name` + provider hint. Selecting an item
 * always submits the catalog's own id verbatim.
 *
 * A reasoning row renders above the footer count line when
 * `onSelectReasoning` is supplied: segmented buttons for "Default" plus
 * every level up to the org's configured max. Levels the current
 * model/tier doesn't support (per `ModelInfo.thinkingLevels`) render
 * disabled; an undefined `thinkingLevels` disables nothing, since that
 * means support is unknown, not absent.
 *
 * Keyboard: ↑/↓ move highlight, Enter selects, / focuses search (from
 * anywhere in the dropdown). Search matches name/id/provider substrings
 * for models, and label/token for tiers.
 *
 * `currentId` may be a value that is no longer in the catalog — it is
 * still labeled rather than blanked. An undefined `currentId` reads as
 * "Inherit": the session has no model of its own and follows the account
 * default.
 */
export interface ModelPickerProps {
  currentId?: string;
  /** Called when the user picks a model or a size tier. Returns the model
   * id, or the bare tier token ("xs"|"s"|"m"|"l"|"xl"). */
  onSelect: (id: string) => void;
  /** Current reasoning/thinking level, or undefined for "Default". */
  currentReasoning?: string;
  /** Called when the user picks a reasoning level; `null` means "Default".
   * The reasoning row only renders when this is supplied. */
  onSelectReasoning?: (level: string | null) => void;
  /** Disable interactions (e.g. while a mutation is in flight). */
  disabled?: boolean;
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
  if (query.trim().length === 0) return models;
  return models.filter((m) => matchesNeedle(query, [m.name, m.id, m.providerName]));
}

/** The full "show more" reveal scope for a role: an org admin's reveal is
 * the whole catalog (the server has a matching admin bypass, so they can
 * still select an unapproved model); a member's reveal is still approved
 * entries only — a member never reaches an unapproved model, in the
 * baseline or the reveal, search included. Callers that need to keep a
 * currently-pinned model visible (even if it lost approval) must add it
 * back themselves — this helper stays a pure two-input filter. */
export function visibleModels(models: ModelInfo[], isAdmin: boolean): ModelInfo[] {
  return isAdmin ? models : models.filter((m) => m.approved);
}

/** Available thinking levels for whatever `currentId` currently names — a
 * concrete model's own `thinkingLevels`, or (for a tier) the tier's first
 * target's `thinkingLevels`. `undefined` means "unknown support", which the
 * reasoning row must treat as "disable nothing", not "no support". */
function thinkingLevelsFor(
  currentId: string | undefined,
  tierMap: GetModelTiersResponse | undefined,
  models: ModelInfo[],
): string[] | undefined {
  if (!currentId) return undefined;
  if (isSizeTier(currentId)) {
    const first = tierMap?.[currentId]?.[0];
    if (!first) return undefined;
    return models.find((m) => m.id === first)?.thinkingLevels;
  }
  return models.find((m) => m.id === currentId)?.thinkingLevels;
}

type FlatEntry = { kind: "tier"; tier: SizeTier } | { kind: "model"; model: ModelInfo };

export function ModelPicker({
  currentId,
  onSelect,
  currentReasoning,
  onSelectReasoning,
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
  const meQ = useMe();
  const isAdmin = meQ.data?.orgRole === "admin";
  const tierMapQ = useModelTiers();
  const orgReasoningQ = useOrgReasoning();

  // Readmit the current pin regardless of approval — a user must never see
  // the picker act as if their own pinned model doesn't exist, even after
  // it loses approval underneath them.
  function withPinReadmitted(scoped: ModelInfo[]): ModelInfo[] {
    if (!currentId || scoped.some((m) => m.id === currentId)) return scoped;
    const pinned = models.find((m) => m.id === currentId);
    return pinned ? [...scoped, pinned] : scoped;
  }

  // The baseline scope, for EVERYONE: approved entries only. This is what
  // renders before any reveal, and what a member's "show more"/search stays
  // within — an unapproved model never appears for a member.
  const approvedScoped = useMemo(
    () => withPinReadmitted(models.filter((m) => m.approved)),
    [models, currentId],
  );
  // The full reveal scope, gated by role: an admin's reveal is the whole
  // catalog (the server has a matching admin bypass); a member's reveal is
  // the same approved-only set as the baseline.
  const roleScoped = useMemo(
    () => withPinReadmitted(visibleModels(models, isAdmin)),
    [models, isAdmin, currentId],
  );

  // Collapse Anthropic aliases by default unless `showAll` or query is
  // active — a search should peek into the wider scope so a user typing
  // "haiku-3-5-2024" can still find that pinned alias without toggling.
  const revealAll = showAll || query.trim().length > 0;
  const catalogForRole = revealAll ? roleScoped : approvedScoped;
  const filteredModels = useMemo(() => {
    const baseline = revealAll
      ? catalogForRole
      : catalogForRole.filter((m) => {
          if (m.id === currentId) return true;
          if (!isAnthropic(m.id)) return true;
          return !!curatedForCatalogId(m.id);
        });
    return filterModels(baseline, query);
  }, [catalogForRole, revealAll, query, currentId]);
  // What a full reveal would show for this role, same query — the source of
  // truth for "how many more" (curated-collapse AND, for an admin,
  // approval), so the affordance appears whenever either would add rows.
  const fullyRevealedModels = useMemo(() => filterModels(roleScoped, query), [roleScoped, query]);

  // The Size group hides when the query matches no tier label or token —
  // same substring matcher the model list search uses.
  const filteredTiers = useMemo(() => {
    if (query.trim().length === 0) return [...SIZE_TIERS];
    return SIZE_TIERS.filter((t) => matchesNeedle(query, [TIER_LABELS[t], t]));
  }, [query]);

  const grouped = useMemo(() => groupByProvider(filteredModels), [filteredModels]);
  const flat: FlatEntry[] = useMemo(
    () => [
      ...filteredTiers.map((tier): FlatEntry => ({ kind: "tier", tier })),
      ...filteredModels.map((model): FlatEntry => ({ kind: "model", model })),
    ],
    [filteredTiers, filteredModels],
  );
  const hiddenCount = fullyRevealedModels.length - filteredModels.length;

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

  const triggerLabel = currentId
    ? isSizeTier(currentId)
      ? TIER_LABELS[currentId]
      : labelFor(currentId, models)
    : "Inherit";
  const reasoningLevels = levelsUpTo(orgReasoningQ.data?.max);
  const activeThinkingLevels = thinkingLevelsFor(currentId, tierMapQ.data, models);

  function isLevelDisabled(level: string): boolean {
    if (!activeThinkingLevels) return false;
    return !activeThinkingLevels.includes(level);
  }

  function commitHighlighted() {
    const entry = flat[highlightIndex];
    if (!entry) return;
    onSelect(entry.kind === "tier" ? entry.tier : entry.model.id);
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
          <span className="truncate text-xs">
            {triggerLabel}
            {currentReasoning && ` · ${reasoningLabelFor(currentReasoning)}`}
          </span>
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
          {filteredTiers.length > 0 && (
            <div>
              <DropdownMenuLabel className="sticky top-0 bg-paper/95 backdrop-blur-sm py-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-muted">
                Size
              </DropdownMenuLabel>
              {filteredTiers.map((tier, idx) => {
                const isHighlighted = idx === highlightIndex;
                const isSelected = currentId === tier;
                const subtitle = tierSubtitle(tier, tierMapQ.data, models);
                return (
                  <button
                    key={tier}
                    type="button"
                    data-model-index={idx}
                    data-row-kind="tier"
                    onMouseEnter={() => setHighlightIndex(idx)}
                    onMouseDown={(e) => {
                      // Prevent input blur from stealing focus before we
                      // commit — otherwise the click can race the close.
                      e.preventDefault();
                      onSelect(tier);
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
                      <span className="text-sm font-medium">{TIER_LABELS[tier]}</span>
                      {isSelected && (
                        <span className="text-[9px] font-medium uppercase tracking-wide text-moss/80">
                          current
                        </span>
                      )}
                    </div>
                    {subtitle && (
                      <div className="pl-[22px] text-xs text-muted leading-snug">{subtitle}</div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {grouped.map(({ provider, entries }) => (
            <div key={provider}>
              <DropdownMenuLabel className="sticky top-0 bg-paper/95 backdrop-blur-sm py-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-muted">
                {provider}
              </DropdownMenuLabel>
              {entries.map((m) => {
                const idx = filteredTiers.length + filteredModels.indexOf(m);
                const isHighlighted = idx === highlightIndex;
                const isSelected = m.id === currentId;
                const curated = curatedForCatalogId(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    data-model-index={idx}
                    data-row-kind="model"
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
        <div className="sticky bottom-0 bg-paper border-t border-line">
          {onSelectReasoning && (
            <div className="flex flex-wrap items-center gap-1 px-3 py-1.5 border-b border-line">
              <span className="text-[10px] text-muted mr-0.5">Reasoning</span>
              <button
                type="button"
                aria-label="Default reasoning"
                aria-pressed={currentReasoning === undefined}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelectReasoning(null);
                }}
                className={cn(
                  "rounded-full border border-line px-2 py-0.5 text-[10px] transition-colors",
                  currentReasoning === undefined
                    ? "bg-moss-wash text-ink border-moss"
                    : "text-muted hover:text-ink",
                )}
              >
                Default
              </button>
              {reasoningLevels.map((level) => {
                const levelDisabled = isLevelDisabled(level);
                const active = currentReasoning === level;
                return (
                  <button
                    key={level}
                    type="button"
                    aria-label={`${REASONING_LABELS[level]} reasoning`}
                    aria-pressed={active}
                    disabled={levelDisabled}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onSelectReasoning(level);
                    }}
                    className={cn(
                      "rounded-full border border-line px-2 py-0.5 text-[10px] transition-colors",
                      levelDisabled
                        ? "opacity-40 cursor-not-allowed"
                        : active
                          ? "bg-moss-wash text-ink border-moss"
                          : "text-muted hover:text-ink",
                    )}
                  >
                    {REASONING_LABELS[level]}
                  </button>
                );
              })}
            </div>
          )}
          <div className="px-3 py-1.5 text-[10px] text-muted">
            <span>
              {filteredModels.length} of {roleScoped.length} models
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
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
