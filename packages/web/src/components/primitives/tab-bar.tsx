import { useRef, type ReactNode } from "react";
import { cn } from "~/lib/cn";
import { CONTROL_SIZE, type ControlSize } from "./control.js";

export interface TabDef<Id extends string> {
  id: Id;
  label: string;
  /** A disabled tab stays in the strip. A click or an arrow key does not select it. */
  disabled?: boolean;
  /** Shown after the label inside the tab, such as a `StatusDot` for a pending decision. */
  badge?: ReactNode;
  /** Shown after the tab, outside its button, such as the tab's close button. */
  action?: ReactNode;
  /** The full text of a long label. A label wider than 12rem truncates. */
  title?: string;
}

/** Deterministic id for the tab button / panel pair — callers wrap their
 * section in an element with this id + `role="tabpanel"` to complete the
 * ARIA tabs contract (`aria-controls`/`aria-labelledby`). */
export function tabPanelId(tablistLabel: string, tabId: string): string {
  const slug = tablistLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `tabpanel-${slug}-${tabId}`;
}

/** The class of a tab strip. Its bottom rule is an inset shadow, so the
 * active tab's underline paints over it and the strip is as tall as its tabs.
 * If the strip sits in a row that draws its own rule, pass `shadow-none`. */
export const TAB_STRIP_CLASS = "flex min-w-0 max-w-full gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--line)]";

/** The look of one tab. `LinkTabs` uses it too, so route tabs match. */
export function tabClass(active: boolean, size: ControlSize = "md"): string {
  return cn(
    "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 transition-colors touch-manipulation",
    CONTROL_SIZE[size],
    size === "sm" ? "px-2.5" : "px-3",
    "disabled:cursor-not-allowed disabled:opacity-50",
    active ? "border-ink font-medium text-ink" : "border-transparent text-muted hover:text-ink",
  );
}

/**
 * Underline-style tab strip for switching page sections held in local
 * state. For sections that deserve deep links, use child routes instead.
 * `size` follows `CONTROL_SIZE`: `sm` for a strip in a toolbar or a pane
 * header, `md` for page sections.
 *
 * Implements the ARIA tabs keyboard contract: Left/Right move focus and
 * selection between tabs (roving tabindex — only the active tab is in the
 * page's tab order), Home/End jump to the first/last tab. The keys skip
 * disabled tabs.
 */
export function TabBar<Id extends string>({
  tabs,
  active,
  onSelect,
  label,
  id = label,
  size = "md",
  className,
}: {
  tabs: readonly TabDef<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
  /** Accessible name for the tablist. */
  label: string;
  /** The seed for each tab's panel id. If the strip can show more than once
   * on a page, pass a `useId()` value. */
  id?: string;
  size?: ControlSize;
  className?: string;
}) {
  const refs = useRef(new Map<Id, HTMLButtonElement>());
  const enabled = tabs.filter((t) => !t.disabled);

  function handleKeyDown(e: React.KeyboardEvent, tabId: Id) {
    const index = enabled.findIndex((t) => t.id === tabId);
    let nextIndex: number | null = null;
    if (e.key === "ArrowRight") nextIndex = (index + 1) % enabled.length;
    else if (e.key === "ArrowLeft") nextIndex = (index - 1 + enabled.length) % enabled.length;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = enabled.length - 1;
    if (nextIndex === null) return;
    e.preventDefault();
    const next = enabled[nextIndex].id;
    onSelect(next);
    refs.current.get(next)?.focus();
  }

  return (
    <div role="tablist" aria-label={label} className={cn(TAB_STRIP_CLASS, className)}>
      {tabs.map((t) => {
        const tab = (
          <button
            key={t.id}
            ref={(el) => {
              if (el) refs.current.set(t.id, el);
              else refs.current.delete(t.id);
            }}
            type="button"
            role="tab"
            id={`${tabPanelId(id, t.id)}-tab`}
            aria-selected={active === t.id}
            aria-controls={tabPanelId(id, t.id)}
            tabIndex={active === t.id ? 0 : -1}
            disabled={t.disabled}
            title={t.title}
            onClick={() => onSelect(t.id)}
            onKeyDown={(e) => handleKeyDown(e, t.id)}
            className={tabClass(active === t.id, size)}
          >
            <span className="max-w-48 truncate">{t.label}</span>
            {t.badge}
          </button>
        );
        return t.action ? (
          <div key={t.id} className="flex shrink-0 items-center">
            {tab}
            {t.action}
          </div>
        ) : tab;
      })}
    </div>
  );
}
