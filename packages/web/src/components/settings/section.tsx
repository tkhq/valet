import { createContext, useContext, type ReactNode } from "react";

/**
 * The label of the route tab a page sits under, when it sits under one
 * (`LinkTabs` in the team and organization layouts). A section titled the
 * same as that tab keeps its heading for screen readers only, so the page
 * does not print the tab's name twice.
 */
export const ActiveTabLabel = createContext<string | undefined>(undefined);

/**
 * A settings section: a heading, an optional one-line description, and its
 * rows (typically `FieldRow`s) in one soft rounded group divided by
 * hairlines — the same grouped-row look as the thread UI's context panel
 * (settings-redesign spec, "Visual language"). No boxed cards inside it.
 */
export function Section({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: string;
  children: ReactNode;
}) {
  const tab = useContext(ActiveTabLabel);
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className={tab !== undefined && title === tab ? "sr-only" : "text-lg font-medium text-ink"}>{title}</h2>
        {description && <p className="text-sm text-muted">{description}</p>}
      </div>
      {/* The group pads its own top and bottom, so a child with no padding
          of its own (a note, a form) does not touch the rounded edge. A row
          with its own padding trims it at the ends to keep the same inset. */}
      <div className="divide-y divide-line rounded-2xl bg-ink-wash px-4 py-3">{children}</div>
    </section>
  );
}

/**
 * A titled part of one settings item, such as a section of an expanded team:
 * a small heading, an optional one-line description, and the part's actions
 * on the right. Every part uses it, so the parts read as one stack.
 */
export function SubSection({ title, description, actions, children }: {
  title: string; description?: string; actions?: ReactNode; children: ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1 space-y-0.5">
          <h3 className="text-sm font-medium text-ink">{title}</h3>
          {description && <p className="text-xs text-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
