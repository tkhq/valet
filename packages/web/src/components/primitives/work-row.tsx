import { cardClass } from "./card";
import type { ReactNode } from "react";
import { relativeTime } from "~/lib/relative-time";
import { cn } from "~/lib/cn";

/**
 * One row of a work list: a status mark, a title with its badge, a second
 * line that starts with the time and continues with the detail, and the row's
 * actions on the right. Every list of threads, runs, or channel activity
 * renders through it, so the lists line up: titles start at the same inset
 * whether or not a row has a mark, and the time is always the second line's
 * first word, at any width.
 */
export function WorkRow({ title, badge, time, detail, leading, actions }: {
  title: ReactNode; badge?: ReactNode; time?: number; detail?: ReactNode; leading?: ReactNode; actions?: ReactNode;
}) {
  // Content starts 20px in, the same line as a card's body (`cardClass`). The
  // status mark sits centered in that gutter, on the title's line.
  return <div className="relative flex items-center gap-4 py-3 pl-5 pr-3">
    {leading && <span className="absolute left-[7px] top-[1.2rem] flex">{leading}</span>}
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
