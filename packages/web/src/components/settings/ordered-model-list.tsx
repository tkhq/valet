import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import type { ModelInfo } from "@valet/api/wire";
import { Badge, Button, Input } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { matchesNeedle } from "~/lib/text-match";

/**
 * Ordered model-id list + search-to-add typeahead shared by the org
 * `ModelPreferencesSection` and the user `UserModelPreferencesSection`.
 * The explicit `preferences` array is authoritative. Up/down buttons
 * reorder (no drag-and-drop dependency). `firstBadge` labels row 0
 * ("Default" on the org list, "First" on the user list). `maxItems`,
 * when set, hides the add typeahead at that length (user list is 20;
 * the org list has no cap).
 */
export function OrderedModelList({
  preferences,
  catalog,
  firstBadge,
  maxItems,
  onChange,
}: {
  preferences: string[];
  catalog: ModelInfo[];
  firstBadge: string;
  maxItems?: number;
  onChange: (next: string[]) => void;
}) {
  const catalogById = new Map(catalog.map((m) => [m.id, m]));
  const unlisted = catalog.filter((m) => !preferences.includes(m.id));
  const atCap = maxItems !== undefined && preferences.length >= maxItems;

  function moveUp(index: number) {
    if (index <= 0) return;
    const next = [...preferences];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    onChange(next);
  }

  function moveDown(index: number) {
    if (index >= preferences.length - 1) return;
    const next = [...preferences];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    onChange(next);
  }

  return (
    <>
      <div className="divide-y divide-line">
        {preferences.length === 0 && (
          <p className="py-2 text-sm text-muted">No preferred models yet.</p>
        )}
        {preferences.map((id, i) => {
          const model = catalogById.get(id);
          const label = model?.name ?? id;
          return (
            <div key={id} className="flex items-center gap-2 py-2">
              {i === 0 && <Badge variant="accent">{firstBadge}</Badge>}
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
                onClick={() => onChange(preferences.filter((p) => p !== id))}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          );
        })}
      </div>

      {unlisted.length > 0 && !atCap && (
        <AddModelTypeahead
          options={unlisted}
          onAdd={(id) => {
            if (maxItems !== undefined && preferences.length >= maxItems) return;
            onChange([...preferences, id]);
          }}
        />
      )}
      {atCap && unlisted.length > 0 && (
        <p className="py-2 text-xs text-muted">
          This list can hold {maxItems} models. Remove one to add another.
        </p>
      )}
    </>
  );
}

/**
 * Search-to-add typeahead over the active catalog models not yet in the
 * preference list. Hand-rolled input + filtered list (no popover/command
 * primitive in this package). The list opens on focus/typing, caps at 30
 * rows, and stays open after an add so several models can be added in one
 * sitting.
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
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const listboxRef = useRef<HTMLDivElement>(null);

  const listboxId = useId();
  const matches = options.filter((m) => matchesNeedle(query, [m.id, m.name, m.providerName]));
  const visible = matches.slice(0, 30);
  const optionId = (index: number) => `${listboxId}-opt-${index}`;
  const activeDescendant =
    open && visible.length > 0 ? optionId(highlightedIndex) : undefined;

  useEffect(() => {
    setHighlightedIndex(0);
  }, [query, options]);

  useEffect(() => {
    if (!open || !listboxRef.current) return;
    const el = listboxRef.current.children[highlightedIndex] as HTMLElement | undefined;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex, open]);

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      setQuery("");
      setOpen(false);
      return;
    }
    if (!open || visible.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((i) => Math.min(i + 1, visible.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const picked = visible[highlightedIndex];
      if (picked) onAdd(picked.id);
    }
  }

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
        onKeyDown={handleKeyDown}
        placeholder={`Search ${options.length} models — name, id, or provider…`}
        aria-label="Search models to add"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={activeDescendant}
        aria-autocomplete="list"
        autoComplete="off"
      />
      {open && (
        <div
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          aria-label="Model results"
          className="max-h-56 overflow-y-auto rounded border border-line"
        >
          {visible.map((m, i) => (
            <button
              key={m.id}
              id={optionId(i)}
              type="button"
              role="option"
              aria-selected={i === highlightedIndex}
              onMouseEnter={() => setHighlightedIndex(i)}
              onClick={() => onAdd(m.id)}
              className={cn(
                "flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm text-ink",
                i === highlightedIndex ? "bg-ink-wash" : "hover:bg-ink-wash",
              )}
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
