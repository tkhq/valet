/**
 * "Only once every N hours" for a line: `target.oncePerHours`. A line with
 * the limit that already made a delivery inside the window skips a matching
 * event. Ingest checks it after the match (`ingest.ts`); the receipt records
 * the skip as `rate_limited`. The limit applies to any line, and the
 * builder offers it for `slack.user_online`, where a person who drifts
 * between away and active would otherwise start many runs a day.
 *
 * The check reads the line's own `event_deliveries` rows through the
 * `(subscription_id, created_at)` index. It stores nothing new.
 */
import { and, eq, gte, ne } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { eventDeliveries } from "../schema/index.js";

export const MAX_ONCE_PER_HOURS = 168;

/** The write check for `target.oncePerHours`, or null when it is valid or absent. */
export function validateOncePerHours(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_ONCE_PER_HOURS) {
    return `oncePerHours must be a whole number of hours from 1 to ${MAX_ONCE_PER_HOURS}. Remove it to run on every event.`;
  }
  return null;
}

/** The line's limit in hours, or null when the line has none. */
export function oncePerHoursOf(target: unknown): number | null {
  if (typeof target !== "object" || target === null) return null;
  const value = (target as { oncePerHours?: unknown }).oncePerHours;
  return validateOncePerHours(value) === null && typeof value === "number" ? value : null;
}

/** True when the line has a limit and made a delivery inside the window. */
export async function oncePerHoursBlocks(db: AppDb, sub: { id: string; target: unknown }, now: number): Promise<boolean> {
  const hours = oncePerHoursOf(sub.target);
  if (hours === null) return false;
  const [recent] = await db
    .select({ id: eventDeliveries.id })
    .from(eventDeliveries)
    .where(and(
      eq(eventDeliveries.subscriptionId, sub.id),
      gte(eventDeliveries.createdAt, now - hours * 3_600_000),
      ne(eventDeliveries.status, "skipped"),
    ))
    .limit(1);
  return recent !== undefined;
}
