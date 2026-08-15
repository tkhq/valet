import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { usePlugins } from "~/api/integrations";
import { Badge, Input, Spinner } from "~/components/primitives";
import { RiskBadge } from "~/components/workflows/risk-badge";
import { cn } from "~/lib/cn";

/** One row in the combobox listbox. */
export interface ComboItem {
  id: string;
  label: string;
  sublabel?: string;
  badge?: ReactNode;
}

/**
 * Typeahead combobox for service and action targets on policy forms.
 *
 * - `mode="service"`: one row per distinct service; badge shows action count.
 * - `mode="action"`: flat list of every action across all services; badge is
 *   a `RiskBadge`; sublabel carries the fully-qualified action id.
 *
 * Mechanics ported from the v1 `TypeaheadCombobox`
 * (`packages/client/src/components/settings/action-policy-dialog.tsx`):
 * mousedown-preventDefault on rows so blur doesn't fire before click,
 * click-outside commits free text and closes, highlight resets to the first
 * row on filter change, highlighted row scrolled with `scrollIntoView({ block:
 * "nearest" })`.
 *
 * Built without Radix DropdownMenu (its focus trap kills typing).
 */
export function ServiceActionCombobox({
  mode,
  value,
  onChange,
  id,
  placeholder,
}: {
  mode: "service" | "action";
  value: string;
  onChange: (v: string) => void;
  id?: string;
  placeholder?: string;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);

  const pluginsQ = usePlugins();
  const loading = pluginsQ.isLoading;
  const plugins = pluginsQ.data?.plugins ?? [];

  const listboxId = id ? `${id}-listbox` : "sac-listbox";

  // Derive items from plugin catalog
  const catalogItems = useMemo((): ComboItem[] => {
    if (mode === "service") {
      const seen = new Set<string>();
      const out: ComboItem[] = [];
      for (const plugin of plugins) {
        for (const svc of plugin.services) {
          if (!seen.has(svc.service)) {
            seen.add(svc.service);
            const count = svc.actions.length;
            out.push({
              id: svc.service,
              label: svc.service,
              badge: <Badge variant="neutral">{count} actions</Badge>,
            });
          }
        }
      }
      return out;
    }
    // action mode — flat list, service name in sublabel
    const out: ComboItem[] = [];
    for (const plugin of plugins) {
      for (const svc of plugin.services) {
        for (const action of svc.actions) {
          out.push({
            id: action.id,
            label: action.name,
            sublabel: `${action.id} · ${svc.service}`,
            badge: <RiskBadge level={action.riskLevel} />,
          });
        }
      }
    }
    return out;
  }, [mode, plugins]);

  // Filter on query
  const filtered = useMemo((): ComboItem[] => {
    const q = query.toLowerCase().trim();
    if (!q) return catalogItems;
    return catalogItems.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q) ||
        (item.sublabel?.toLowerCase().includes(q) ?? false),
    );
  }, [catalogItems, query]);

  // Whether query matches a catalog item exactly
  const queryMatchesCatalog = useMemo(() => {
    const q = query.trim();
    if (!q) return false;
    return catalogItems.some(
      (item) => item.id === q || item.label.toLowerCase() === q.toLowerCase(),
    );
  }, [catalogItems, query]);

  // Show free-text pinned row when query is non-empty and not in catalog
  const showFreeText = query.trim().length > 0 && !queryMatchesCatalog;

  // Total navigable rows: filtered catalog items + optional free-text row
  const totalRows = filtered.length + (showFreeText ? 1 : 0);
  const freeTextIndex = filtered.length; // index of the free-text row if present

  // Reset highlight to 0 when the filtered list changes
  useEffect(() => {
    setHighlightedIndex(0);
  }, [filtered.length, showFreeText]);

  // Scroll highlighted item into view (scrollIntoView may be absent in jsdom)
  useEffect(() => {
    if (!open || !listboxRef.current) return;
    const children = listboxRef.current.children;
    const el = children[highlightedIndex] as HTMLElement | undefined;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex, open]);

  // Click-outside: commit free text if applicable, then close
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (listboxRef.current?.contains(target) || inputRef.current?.contains(target)) {
        return;
      }
      if (showFreeText) {
        onChange(query.trim());
        setQuery("");
      }
      setOpen(false);
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [showFreeText, query, onChange]);

  function select(id: string) {
    onChange(id);
    setQuery("");
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }

    // Enter with no dropdown: commit free text if typed
    if (!open || totalRows === 0) {
      if (e.key === "Enter" && query.trim()) {
        e.preventDefault();
        select(query.trim());
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIndex((i) => Math.min(i + 1, totalRows - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (showFreeText && highlightedIndex === freeTextIndex) {
          select(query.trim());
        } else if (filtered[highlightedIndex]) {
          select(filtered[highlightedIndex].id);
        } else if (query.trim()) {
          select(query.trim());
        }
        break;
    }
  }

  // The display value when closed: selected item's label or raw value
  const selectedItem = catalogItems.find((item) => item.id === value);
  const displayValue = open ? query : (selectedItem?.label ?? value);

  const optionId = (index: number) => `${listboxId}-opt-${index}`;
  const activeDescendant =
    open && totalRows > 0 ? optionId(highlightedIndex) : undefined;

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeDescendant}
        aria-autocomplete="list"
        value={displayValue}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => {
          setQuery("");
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        autoComplete="off"
      />
      {open && (
        <div
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          className="absolute z-20 mt-1 w-full max-h-60 overflow-auto rounded-md border border-line bg-paper shadow-lg"
        >
          {loading && (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted">
              <Spinner size={14} />
              <span>Loading catalog…</span>
            </div>
          )}
          {!loading &&
            filtered.map((item, i) => (
              <div
                key={item.id}
                id={optionId(i)}
                role="option"
                aria-selected={value === item.id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  select(item.id);
                }}
                onMouseEnter={() => setHighlightedIndex(i)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 px-3 py-2 text-sm",
                  i === highlightedIndex ? "bg-ink-wash" : "hover:bg-ink-wash",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-ink truncate">{item.label}</span>
                    {item.sublabel && (
                      <span className="shrink-0 font-mono text-[11px] text-muted truncate">
                        {item.sublabel}
                      </span>
                    )}
                    {!item.sublabel && (
                      <span className="shrink-0 font-mono text-[11px] text-muted">{item.id}</span>
                    )}
                  </div>
                </div>
                {item.badge && <span className="shrink-0">{item.badge}</span>}
              </div>
            ))}
          {!loading && showFreeText && (
            <div
              id={optionId(freeTextIndex)}
              role="option"
              aria-selected={false}
              onMouseDown={(e) => {
                e.preventDefault();
                select(query.trim());
              }}
              onMouseEnter={() => setHighlightedIndex(freeTextIndex)}
              className={cn(
                "flex cursor-pointer items-center gap-1 border-t border-line px-3 py-2 text-sm text-muted",
                highlightedIndex === freeTextIndex ? "bg-ink-wash" : "hover:bg-ink-wash",
              )}
            >
              Use &ldquo;{query.trim()}&rdquo; — not in the installed catalog
            </div>
          )}
          {!loading && !showFreeText && filtered.length === 0 && query.trim() && (
            <div className="px-3 py-2 text-sm text-muted">
              No matches for &ldquo;{query}&rdquo;. Press Enter to use it as a literal id.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
