import { cn } from "~/lib/cn";

export interface TabDef<Id extends string> {
  id: Id;
  label: string;
}

/**
 * Underline-style tab strip for switching page sections held in local
 * state. For sections that deserve deep links, use child routes instead.
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
  /** Accessible name for the tablist. */
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onSelect(t.id)}
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
