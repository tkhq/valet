/**
 * The trigger cadence of a workflow template, in words.
 *
 * The card shows a sentence, but the template ships a cron expression, and
 * the sentence is derived from it rather than authored beside it. One source
 * of truth: the string the install arms is the string the card describes, so
 * the card cannot promise a cadence the schedule does not keep.
 *
 * The grammar covers the shapes templates use — a fixed minute and hour, on
 * every day, on weekdays, or on named days. Anything else falls back to the
 * raw expression. A cron a reader has to decode is a poor card; a cron a card
 * describes wrongly is worse.
 */
import type { WorkflowTemplateSchedule } from "@valet/api/wire";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** 12-hour clock with a leading-zero minute — "9:05 AM", "1:00 PM". */
function formatTime(hour: number, minute: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/** A whole number inside a range, or null for anything else (`*`, lists,
 * steps, ranges). */
function fixedNumber(field: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;
  const value = Number(field);
  return value >= min && value <= max ? value : null;
}

/** The "on which days" half of the sentence, or null when the day-of-week
 * field is a shape this grammar does not cover. */
function describeDays(dayOfWeek: string): string | null {
  if (dayOfWeek === "*") return "Every day";
  if (dayOfWeek === "1-5") return "Every weekday";
  if (dayOfWeek === "0,6" || dayOfWeek === "6,0") return "Every weekend day";
  const day = fixedNumber(dayOfWeek, 0, 7);
  // Cron accepts both 0 and 7 for Sunday.
  if (day !== null) return `Every ${DAY_NAMES[day % 7]}`;
  return null;
}

/**
 * A sentence for the card, e.g. "Every weekday at 9:00 AM UTC". Returns the
 * on-demand wording when the template arms no schedule, and the raw cron when
 * the expression is outside the grammar above.
 */
export function describeCadence(schedule: WorkflowTemplateSchedule | null): string {
  if (schedule === null) return "Runs when you start it";

  const fields = schedule.cron.trim().split(/\s+/);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const raw = `${schedule.cron} (${schedule.timezone})`;
  if (fields.length !== 5 || minute === undefined || hour === undefined) return raw;
  if (dayOfMonth !== "*" || month !== "*") return raw;

  const m = fixedNumber(minute, 0, 59);
  const h = fixedNumber(hour, 0, 23);
  if (m === null || h === null) return raw;

  const days = describeDays(dayOfWeek ?? "*");
  if (days === null) return raw;

  return `${days} at ${formatTime(h, m)} ${schedule.timezone}`;
}
