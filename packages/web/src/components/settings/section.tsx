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
  title: string;
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
