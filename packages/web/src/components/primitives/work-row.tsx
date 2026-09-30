import type { ReactNode } from "react";
import { relativeTime } from "~/lib/relative-time";

/**
 * One row of a work list: a title link, an optional badge, the time, and
 * optional detail and actions. Every list of threads, runs, or channel
 * activity renders through it, so the lists line up.
 */
export function WorkRow({ title, badge, time, detail, leading, actions }: {
  title: ReactNode; badge?: ReactNode; time?: number; detail?: ReactNode; leading?: ReactNode; actions?: ReactNode;
}) {
  return <div className="flex items-start gap-3 px-4 py-3">
    {leading !== undefined && <span className="mt-1.5 flex h-2 w-2 shrink-0">{leading}</span>}
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 break-words text-sm font-medium [&_a:hover]:underline">{title}</span>
        {badge}
        {time !== undefined && <span className="text-xs text-muted">{relativeTime(time)}</span>}
      </div>
      {detail && <p className="mt-1 break-words text-sm text-muted">{detail}</p>}
    </div>
    {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
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
    <div className="divide-y divide-line rounded-lg border border-line bg-paper">{children}</div>
  </section>;
}
