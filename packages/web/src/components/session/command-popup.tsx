/**
 * CommandPopup — a filtered list of slash commands shown while the composer
 * contains a lone command token (e.g. "/sta"). Pure presentational: no network
 * calls, no state. The composer owns selection state and keyboard handling.
 *
 * Commands are grouped by source: builtin → skill → template → plugin.
 */
import type { CommandInfo } from "@valet/api/wire";

const SOURCE_ORDER: CommandInfo["source"][] = [
  "builtin",
  "skill",
  "template",
  "plugin",
];

const SOURCE_LABEL: Record<CommandInfo["source"], string> = {
  builtin: "Built-in",
  skill: "Skill",
  template: "Template",
  plugin: "Plugin",
};

export interface CommandPopupProps {
  /** Full filtered list to display. Caller applies prefix filter before passing. */
  commands: CommandInfo[];
  /** Current partial name (without leading slash), used only for aria labelling. */
  query: string;
  /** Index into `commands` of the currently highlighted row. */
  selectedIndex: number;
  /** Called with the command name (no leading slash) when the user confirms a row. */
  onSelect: (name: string) => void;
  /** Called when the user presses Esc or the popup should close. */
  onClose: () => void;
}

export function CommandPopup({
  commands,
  query,
  selectedIndex,
  onSelect,
}: CommandPopupProps) {
  if (commands.length === 0) return null;

  // Group by source in display order.
  const groups: { source: CommandInfo["source"]; items: CommandInfo[] }[] = [];
  for (const source of SOURCE_ORDER) {
    const items = commands.filter((c) => c.source === source);
    if (items.length > 0) groups.push({ source, items });
  }

  // Compute a flat index offset per group so we can find selectedIndex.
  let flatOffset = 0;

  return (
    <div
      role="listbox"
      aria-label={`Slash command suggestions for /${query}`}
      className="absolute bottom-full left-0 right-0 mb-1 z-50 rounded-md border border-[--border] bg-[--bg] shadow-lg overflow-hidden max-h-72 overflow-y-auto"
    >
      {groups.map(({ source, items }) => {
        const groupOffset = flatOffset;
        flatOffset += items.length;
        return (
          <div key={source}>
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted border-b border-[--border]">
              {SOURCE_LABEL[source]}
            </div>
            {items.map((cmd, i) => {
              const flatIndex = groupOffset + i;
              const isSelected = flatIndex === selectedIndex;
              return (
                <div
                  key={cmd.name}
                  role="option"
                  aria-selected={isSelected}
                  className={`flex items-start gap-2 px-3 py-1.5 cursor-pointer text-sm ${
                    isSelected ? "bg-[--accent] text-[--accent-fg]" : "hover:bg-[--hover]"
                  }`}
                  onMouseDown={(e) => {
                    // Prevent textarea blur before we can call onSelect.
                    e.preventDefault();
                    onSelect(cmd.name);
                  }}
                >
                  <span className="font-mono font-medium shrink-0">/{cmd.name}</span>
                  <span className="text-muted truncate">{cmd.description}</span>
                  {cmd.argHint && (
                    <span className="ml-auto font-mono text-xs text-muted shrink-0 opacity-70">
                      {cmd.argHint}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
