import type { ReactNode } from "react";

/**
 * A settings section: display-face heading, optional one-line description,
 * and a hairline-separated stack of children (typically `FieldRow`s). No
 * card box — the spec is explicit that the settings surface reads as open
 * stacks, not boxes-in-a-void (the enable-organizations card is the one
 * deliberate exception, built in Task 6).
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
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="font-display text-xl text-ink">{title}</h2>
        {description && <p className="text-sm text-muted">{description}</p>}
      </div>
      <div className="divide-y divide-line border-t border-line">{children}</div>
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
