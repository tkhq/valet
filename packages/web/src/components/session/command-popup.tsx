/**
 * CommandPopup — a grouped, keyboard-navigable suggestion list above the
 * composer. Pure presentational: no network calls, no state. The composer
 * owns selection state and keyboard handling, and adapts its two data
 * sources (slash commands, argument completions) into `PopupItem`s.
 */
import type { WireCommandInfo } from "@valet/api/wire";
import type { CommandRecency } from "~/lib/command-recency";

export interface PopupItem {
  /** Stable identity, passed to onSelect (a command name or an argument value). */
  id: string;
  /** Monospace primary text (e.g. "/status" or "claude-opus-4-8"). */
  label: string;
  /** Muted description beside the label. */
  detail?: string;
  /** Right-aligned monospace hint (e.g. "[model-id]"). */
  hint?: string;
  /** Group header this item renders under; groups keep first-appearance order. */
  group: string;
}

const SOURCE_ORDER: WireCommandInfo["source"][] = [
  "builtin",
  "skill",
  "plugin",
];

const SOURCE_LABEL: Record<WireCommandInfo["source"], string> = {
  builtin: "Built-in",
  skill: "Skill",
  plugin: "Plugin",
};

/**
 * Adapt registry commands (already prefix-filtered) into popup items.
 *
 * `recency` (command name → last-used epoch ms, from `~/lib/command-recency`)
 * floats what the user actually uses to the top. Groups must stay contiguous —
 * the popup renders group-by-group while ↑/↓ walk the flat item order, so a
 * command sorted away from its group would break keyboard navigation. Recency
 * therefore sorts at two levels: groups by their most recently used command,
 * then commands within a group. Sort is stable, so untouched commands keep
 * the registry's order (built-in → skill → plugin, registration order within).
 * Contiguity holds even when two groups share one max stamp: any cross-group
 * tie falls through to the deterministic `SOURCE_ORDER` comparison, so every
 * member of one source still sorts to the same side of the other's.
 */
export function commandsToItems(
  commands: WireCommandInfo[],
  recency: CommandRecency = {},
): PopupItem[] {
  const groupRecency = new Map<WireCommandInfo["source"], number>();
  for (const c of commands) {
    const used = recency[c.name] ?? 0;
    if (used > (groupRecency.get(c.source) ?? 0)) groupRecency.set(c.source, used);
  }
  const ordered = [...commands].sort((a, b) => {
    const byGroup = (groupRecency.get(b.source) ?? 0) - (groupRecency.get(a.source) ?? 0);
    if (byGroup !== 0) return byGroup;
    const bySource = SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source);
    if (bySource !== 0) return bySource;
    return (recency[b.name] ?? 0) - (recency[a.name] ?? 0);
  });
  return ordered.map((c) => ({
    id: c.name,
    label: `/${c.name}`,
    detail: c.description,
    hint: c.argHint,
    group: SOURCE_LABEL[c.source],
  }));
}

export interface CommandPopupProps {
  /** Items to display, already filtered. Empty + no notice renders nothing. */
  items: PopupItem[];
  /**
   * Passive hint shown when a command's argument cannot be enumerated
   * (e.g. "[instructions]"). Rendered as a single muted row, not selectable.
   */
  notice?: string;
  /** Accessible label for the listbox. */
  ariaLabel: string;
  /** Index into `items` of the currently highlighted row. */
  selectedIndex: number;
  /** Called with the item id when the user confirms a row. */
  onSelect: (id: string) => void;
  /** Called with a row's index when the pointer moves over it. */
  onHover: (index: number) => void;
}

export function CommandPopup({
  items,
  notice,
  ariaLabel,
  selectedIndex,
  onSelect,
  onHover,
}: CommandPopupProps) {
  if (items.length === 0 && !notice) return null;

  // Group by `group` in first-appearance order.
  const groups: { group: string; items: { item: PopupItem; flatIndex: number }[] }[] = [];
  items.forEach((item, flatIndex) => {
    const last = groups.find((g) => g.group === item.group);
    if (last) last.items.push({ item, flatIndex });
    else groups.push({ group: item.group, items: [{ item, flatIndex }] });
  });

  return (
    <div
      role="listbox"
      aria-label={ariaLabel}
      className="absolute bottom-full left-0 right-0 mb-1 z-50 rounded-md border border-[--border] bg-[--bg] shadow-lg overflow-hidden max-h-72 overflow-y-auto"
    >
      {groups.map(({ group, items: groupItems }) => (
        <div key={group}>
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted border-b border-[--border]">
            {group}
          </div>
          {groupItems.map(({ item, flatIndex }) => {
            const isSelected = flatIndex === selectedIndex;
            return (
              <div
                key={item.id}
                role="option"
                aria-selected={isSelected}
                ref={(el) => {
                  // Keep the highlighted row visible as ↑/↓ move it past
                  // the popup's max-height fold. Guarded: JSDOM (tests)
                  // does not implement scrollIntoView.
                  if (isSelected && el && typeof el.scrollIntoView === "function") {
                    el.scrollIntoView({ block: "nearest" });
                  }
                }}
                className={`flex items-start gap-2 px-3 py-1.5 cursor-pointer text-sm ${
                  // bg-ink-wash-strong is the app's press/selected wash.
                  // (An invented var like --accent silently paints nothing —
                  // that bug shipped once; see theme.css's wash comment.)
                  isSelected ? "bg-ink-wash-strong" : ""
                }`}
                onMouseDown={(e) => {
                  // Prevent textarea blur before we can call onSelect.
                  e.preventDefault();
                  onSelect(item.id);
                }}
                onMouseMove={() => {
                  // Pointer and keyboard share ONE highlight. mousemove, not
                  // mouseenter: arrow-driven scrollIntoView shifts rows under
                  // a stationary cursor, and a spurious mouseenter would
                  // yank the selection back to wherever the pointer sits.
                  if (!isSelected) onHover(flatIndex);
                }}
              >
                <span className="font-mono font-medium shrink-0">{item.label}</span>
                {item.detail && <span className="text-muted truncate">{item.detail}</span>}
                {item.hint && (
                  <span className="ml-auto font-mono text-xs text-muted shrink-0 opacity-70">
                    {item.hint}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {notice && (
        <div className="px-3 py-1.5 text-sm text-muted font-mono" data-testid="popup-notice">
          {notice}
        </div>
      )}
    </div>
  );
}
