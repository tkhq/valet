import { cardClass } from "./card";
import type { ReactNode } from "react";
import { relativeTime } from "~/lib/relative-time";
import { cn } from "~/lib/cn";

/**
 * One row of a work list: a title with its badge, a second line that starts
 * with the time and continues with the detail, and the row's actions on the
 * right. Every list of threads, runs, or channel activity renders through it,
 * so the lists line up, and the time is always the second line's first word,
 * at any width. A row has no status dot: a badge carries status, and every
 * row in an attention list already needs the reader.
 */
export function WorkRow({ title, badge, time, detail, actions }: {
  title: ReactNode; badge?: ReactNode; time?: number; detail?: ReactNode; actions?: ReactNode;
}) {
  // Content starts 20px in, the same line as a card's body (`cardClass`).
  return <div className="flex items-center gap-4 py-3 pl-5 pr-3">
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 break-words text-sm font-medium [&_a:hover]:underline">{title}</span>
        {badge}
      </div>
      {(time !== undefined || detail) && <div className="mt-1 break-words text-sm text-muted">
        {time !== undefined && <span className="tabular-nums">{relativeTime(time)}</span>}
        {time !== undefined && detail ? " · " : null}
        {detail}
      </div>}
    </div>
    {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
  </div>;
}

/** A titled list of `WorkRow`s in one bordered box. */
export function WorkSection({ title, count, icon, actions, children }: {
  title: string; count?: number; icon?: ReactNode; actions?: ReactNode; children: ReactNode;
}) {
  return <section aria-label={title}>
    <div className="mb-3 flex items-center gap-2">
      {icon}<h2 className="font-display text-lg">{title}</h2>
      {count !== undefined && <span className="text-xs text-muted">{count}</span>}
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
    <WorkList>{children}</WorkList>
  </section>;
}

/** A bordered list of `WorkRow`s, without a heading. */
export function WorkList({ children }: { children: ReactNode }) {
  return <div className={cn(cardClass, "divide-y divide-line")}>{children}</div>;
}
