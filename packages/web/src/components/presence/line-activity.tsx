/**
 * The Activity timeline of a line's page and a routine's page
 * (docs/specs/2026-10-16-presence-hub-design.md Part D step 1.7, Part E
 * step 2): entries grouped by day, newest first. An acted entry carries a
 * filled mark and the time it took at the right; a skipped entry carries a
 * hollow mark. Chips `All`, `Acted`, `Skipped` filter the kinds. `Show
 * earlier` loads the next page.
 */
import { useId, useState } from "react";
import { Button, EmptyRow, ErrorRow, FilterChips, LoadingRow } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { formatDate } from "~/lib/format-when";
import { Sentence } from "./sentence";
import type { SentencePart } from "./sentences";

/** One timeline entry, ready to render. */
export interface TimelineEntry {
  id: string;
  kind: "acted" | "skipped";
  at: number;
  parts: readonly SentencePart[];
  /** The right column: the time it took, or `gave up`. */
  took?: string;
  tookDanger?: boolean;
}

export type ActivityChip = "all" | "acted" | "skipped";

const CHIPS: readonly { value: ActivityChip; label: string }[] = [
  { value: "all", label: "All" },
  { value: "acted", label: "Acted" },
  { value: "skipped", label: "Skipped" },
];

const DAY_MS = 86_400_000;

function localDay(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** A day heading: `Today`, `Yesterday`, or the date. `now` pins the day in tests. */
export function dayHeading(at: number, now: number = Date.now()): string {
  const days = Math.round((localDay(now) - localDay(at)) / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return formatDate(at);
}

/** An entry's time of day, `14:02`. */
export function timeOfDay(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Entries grouped by day heading, in the order given (newest first). */
export function groupByDay(entries: readonly TimelineEntry[], now: number = Date.now()): { day: string; entries: TimelineEntry[] }[] {
  const groups: { day: string; entries: TimelineEntry[] }[] = [];
  for (const entry of entries) {
    const day = dayHeading(entry.at, now);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.day === day) last.entries.push(entry);
    else groups.push({ day, entries: [entry] });
  }
  return groups;
}

export function ActivityTimeline({
  entries,
  pending = false,
  error,
  hasMore = false,
  loadingMore = false,
  onShowEarlier,
  chips = true,
  empty = "Nothing yet. Activity appears here when an event reaches this line.",
}: {
  entries: readonly TimelineEntry[];
  pending?: boolean;
  /** The error text, which names its fix. */
  error?: string;
  hasMore?: boolean;
  loadingMore?: boolean;
  onShowEarlier?: () => void;
  /** False hides the chips, for a timeline that has no skipped entries. */
  chips?: boolean;
  empty?: string;
}) {
  const [chip, setChip] = useState<ActivityChip>("all");
  const headingId = useId();
  const shown = chip === "all" ? entries : entries.filter((entry) => entry.kind === chip);
  return (
    <section aria-labelledby={headingId}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-[13px] font-medium text-muted">Activity</h2>
        {chips && <FilterChips options={CHIPS} value={chip} onChange={setChip} label="Show" />}
      </div>
      {pending && <LoadingRow />}
      {error !== undefined && <ErrorRow>{error}</ErrorRow>}
      {!pending && error === undefined && entries.length === 0 && <EmptyRow>{empty}</EmptyRow>}
      {!pending && error === undefined && entries.length > 0 && shown.length === 0 && (
        <EmptyRow>{chip === "acted" ? "Nothing acted on here yet. Choose All to see every entry." : "Nothing skipped here yet. Choose All to see every entry."}</EmptyRow>
      )}
      {groupByDay(shown).map((group) => (
        <div key={group.day}>
          <h3 className="mb-1.5 mt-4 text-xs font-normal text-muted">{group.day}</h3>
          <ul>
            {group.entries.map((entry) => (
              <li
                key={entry.id}
                data-kind={entry.kind}
                className="grid grid-cols-[56px_minmax(0,1fr)_auto] items-baseline gap-3 border-b border-line py-2 text-[15px]"
              >
                <span className="text-[13px] tabular-nums text-muted">{timeOfDay(entry.at)}</span>
                <span className={cn("min-w-0 [overflow-wrap:anywhere]", entry.kind === "skipped" ? "text-muted" : "text-ink")}>
                  <span
                    aria-hidden="true"
                    data-mark={entry.kind}
                    className={cn(
                      "mr-2 inline-block h-2 w-2 rounded-full align-[1px]",
                      entry.kind === "acted" ? "bg-moss" : "border-[1.5px] border-muted",
                    )}
                  />
                  <Sentence parts={entry.parts} />
                </span>
                <span className={cn("text-[13px]", entry.tookDanger ? "text-danger-500" : "text-muted")}>{entry.took ?? ""}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {hasMore && onShowEarlier !== undefined && (
        <Button size="sm" variant="ghost" className="mt-2.5 text-muted" disabled={loadingMore} onClick={onShowEarlier}>
          Show earlier
        </Button>
      )}
    </section>
  );
}
