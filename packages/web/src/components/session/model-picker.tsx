import { Check, ChevronDown, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/primitives";
import { useModels } from "~/api/settings";
import { curatedForCatalogId } from "~/lib/models";
import type { ModelInfo } from "@valet/api/wire";
import { cn } from "~/lib/cn";

/**
 * Model selector with two render variants:
 *
 *   - "compact" (default): small ghost button showing the current model's
 *     short label + a chevron. Used in tight headers (session header,
 *     thread row inline edit).
 *   - "row": full-width row layout with label + description; the "thread
 *     override" indicator is a tiny dot when `isOverride` is true. Used in
 *     the thread sidebar.
 *
 * Options come from the org catalog (`GET /api/models`, Task 4/8), listed
 * in response order (already preference-ordered). Entries matching a
 * curated `MODEL_CATALOG` tier (bare or `anthropic/`-namespaced id) render
 * with their curated label + description; other entries render with the
 * catalog `name` + a provider hint. Selecting an item always submits the
 * catalog's own id verbatim.
 *
 * Pass `currentId` (string | undefined) — undefined renders as "Inherit
 * from session" when `inheritLabel` is given. `currentId` may be a value
 * that's no longer in the catalog (a session parked on a model whose
 * provider key was removed, or a legacy bare id) — it's still labeled
 * (curated match, else raw id) rather than blanked out.
 */
export interface ModelPickerProps {
  currentId?: string;
  variant?: "compact" | "row";
  /** Called when the user picks a model. Returns the model id. */
  onSelect: (id: string) => void;
  /** When given, renders an extra item that resets to the inherited default. */
  onClear?: () => void;
  /** Indicator next to compact label when this is an override. */
  isOverride?: boolean;
  /** Disable interactions (e.g. while a mutation is in flight). */
  disabled?: boolean;
  /** Label shown when currentId is undefined and onClear is set. */
  inheritLabel?: string;
}

function labelFor(id: string, models: ModelInfo[]): string {
  const curated = curatedForCatalogId(id);
  if (curated) return curated.label;
  return models.find((m) => m.id === id)?.name ?? id;
}

export function ModelPicker({
  currentId,
  variant = "compact",
  onSelect,
  onClear,
  isOverride,
  disabled,
  inheritLabel = "Inherit",
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const modelsQ = useModels();
  const models = modelsQ.data?.models ?? [];

  // Default: collapse the Anthropic entries to just the curated set (one row
  // per newest tier), plus the currently-selected model when it isn't
  // curated (so a session parked on a legacy id still surfaces its own
  // row). Non-Anthropic entries always show — a third-party model is never a
  // duplicate of a Claude tier. "Show all models" reveals the hidden
  // Anthropic aliases.
  const visibleModels = useMemo(() => {
    if (showAll) return models;
    return models.filter((m) => {
      if (m.id === currentId) return true;
      const isAnthropic = m.id.startsWith("anthropic/") || !m.id.includes("/");
      if (!isAnthropic) return true;
      return !!curatedForCatalogId(m.id);
    });
  }, [models, showAll, currentId]);
  const hiddenCount = models.length - visibleModels.length;

  const triggerLabel = currentId ? labelFor(currentId, models) : inheritLabel;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn(
            "font-normal gap-1.5",
            variant === "row" && "w-full justify-start",
          )}
          aria-label="Choose model"
        >
          <Sparkles
            className={cn(
              "h-3.5 w-3.5",
              isOverride
                ? "text-violet-600 dark:text-violet-400"
                : "text-muted",
            )}
            aria-hidden
          />
          <span className="truncate text-xs">
            {triggerLabel}
          </span>
          {isOverride && (
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-violet-500"
              aria-label="thread override"
            />
          )}
          <ChevronDown className="h-3.5 w-3.5 text-muted shrink-0 ml-auto" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[280px] max-h-[min(70vh,560px)] overflow-y-auto"
      >
        <DropdownMenuLabel>Model</DropdownMenuLabel>
        {modelsQ.isLoading && (
          <div className="px-2 py-1.5 text-xs text-muted">Loading models…</div>
        )}
        {!modelsQ.isLoading && models.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted">No models available.</div>
        )}
        {visibleModels.map((m) => {
          const active = m.id === currentId;
          const curated = curatedForCatalogId(m.id);
          return (
            <DropdownMenuItem
              key={m.id}
              onSelect={() => {
                onSelect(m.id);
                setOpen(false);
              }}
              className={cn(
                "flex flex-col items-stretch gap-0.5 py-1.5",
                active && "bg-neutral-100 dark:bg-neutral-800",
              )}
            >
              <div className="flex items-center gap-2">
                {active ? (
                  <Check className="h-3.5 w-3.5 text-accent-600 shrink-0" />
                ) : (
                  <span className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="text-sm font-medium">{curated?.label ?? m.name}</span>
                <span className="ml-auto font-mono text-[10px] text-muted/70">
                  {m.id}
                </span>
              </div>
              <div className="pl-[22px] text-xs text-muted leading-snug">
                {curated?.description ?? m.providerName}
              </div>
            </DropdownMenuItem>
          );
        })}
        {hiddenCount > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(e) => {
                // Keep the menu open — this is an in-place filter toggle,
                // not a model selection. Radix closes the menu by default on
                // select unless we call preventDefault().
                e.preventDefault();
                setShowAll(true);
              }}
              className="text-xs text-muted italic"
            >
              Show all {models.length} models ({hiddenCount} older/aliases)
            </DropdownMenuItem>
          </>
        )}
        {showAll && (
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setShowAll(false);
            }}
            className="text-xs text-muted italic"
          >
            Show recommended models only
          </DropdownMenuItem>
        )}
        {onClear && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                onClear();
                setOpen(false);
              }}
              className="text-muted"
            >
              <span className="text-xs italic">{inheritLabel}</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
