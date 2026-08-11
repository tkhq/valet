import { useRef } from "react";
import { cn } from "~/lib/cn";

export interface TabDef<Id extends string> {
  id: Id;
  label: string;
}

/** Deterministic id for the tab button / panel pair — callers wrap their
 * section in an element with this id + `role="tabpanel"` to complete the
 * ARIA tabs contract (`aria-controls`/`aria-labelledby`). */
export function tabPanelId(tablistLabel: string, tabId: string): string {
  const slug = tablistLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `tabpanel-${slug}-${tabId}`;
}

/**
 * Underline-style tab strip for switching page sections held in local
 * state. For sections that deserve deep links, use child routes instead.
 *
 * Implements the ARIA tabs keyboard contract: Left/Right move focus and
 * selection between tabs (roving tabindex — only the active tab is in the
 * page's tab order), Home/End jump to the first/last tab.
 */
export function TabBar<Id extends string>({
  tabs,
  active,
  onSelect,
  label,
}: {
  tabs: readonly TabDef<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
  /** Accessible name for the tablist, and the seed for each tab's panel id. */
  label: string;
}) {
  const refs = useRef(new Map<Id, HTMLButtonElement>());

  function focusAndSelect(id: Id) {
    onSelect(id);
    refs.current.get(id)?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent, index: number) {
    let nextIndex: number | null = null;
    if (e.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    e.preventDefault();
    focusAndSelect(tabs[nextIndex].id);
  }

  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-line">
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            if (el) refs.current.set(t.id, el);
            else refs.current.delete(t.id);
          }}
          type="button"
          role="tab"
          id={`${tabPanelId(label, t.id)}-tab`}
          aria-selected={active === t.id}
          aria-controls={tabPanelId(label, t.id)}
          tabIndex={active === t.id ? 0 : -1}
          onClick={() => onSelect(t.id)}
          onKeyDown={(e) => handleKeyDown(e, i)}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
            active === t.id
              ? "border-ink font-medium text-ink"
              : "border-transparent text-muted hover:text-ink",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
