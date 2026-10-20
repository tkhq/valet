import { formatDateTime, formatWhen } from "~/lib/format-when";
import { relativeTime } from "~/lib/relative-time";

/**
 * A timestamp in a `<time>` element. The text is relative ("5m ago") or
 * absolute ("Aug 11, 09:00 PM"), and the `title` always shows the full date,
 * so a reader can hover a short time to see the exact one.
 */
export function Time({ ts, format = "relative", className }: {
  /** Epoch milliseconds. */
  ts: number;
  format?: "relative" | "absolute";
  className?: string;
}) {
  const date = new Date(ts);
  // `toISOString` throws on an invalid date. Leave `dateTime` off instead of
  // failing the whole row.
  const valid = !Number.isNaN(date.getTime());
  return (
    <time dateTime={valid ? date.toISOString() : undefined} title={formatDateTime(ts)} className={className}>
      {format === "relative" ? relativeTime(ts) : formatWhen(ts)}
    </time>
  );
}
