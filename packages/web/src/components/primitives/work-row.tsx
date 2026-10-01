import { cardClass } from "./card";
import type { ReactNode } from "react";
import { relativeTime } from "~/lib/relative-time";
import { cn } from "~/lib/cn";

/**
 * One row of a work list: a status mark, a title link with an optional badge,
 * optional detail, and a right-hand column with the time and actions. Every
 * list of threads, runs, or channel activity renders through it, so the lists
 * line up: titles start at the same inset whether or not a row has a mark, and
 * the actions and time sit in one vertically centered column, time last.
 */
export function WorkRow({ title, badge, time, detail, leading, actions }: {
  title: ReactNode; badge?: ReactNode; time?: number; detail?: ReactNode; leading?: ReactNode; actions?: ReactNode;
}) {
  // Content starts 20px in, the same line as a card's body (`cardClass`); the
  // status mark sits in that gutter.
  return <div className="relative flex items-center gap-3 py-3 pl-5 pr-4">
    {leading && <span className="absolute left-1.5 top-[1.15rem] flex">{leading}</span>}
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 break-words text-sm font-medium [&_a:hover]:underline">{title}</span>
        {badge}
      </div>
      {detail && <div className="mt-1 break-words text-sm text-muted">{detail}</div>}
    </div>
    {(time !== undefined || actions) && <div className="flex shrink-0 items-center gap-3">
      {actions && <div className="flex items-center gap-1">{actions}</div>}
      {/* Last and fixed-width, so times line up down a list whatever the actions are. */}
      {time !== undefined && <span className="w-16 text-right text-xs tabular-nums text-muted">{relativeTime(time)}</span>}
    </div>}
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
