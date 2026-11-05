/**
 * The one cron rule every schedule path shares: the install path, the
 * schedule tools, repository sync, and `valet validate`. Pure, so a caller
 * outside the server graph can check a cron the scheduler will fire.
 */
import { CronExpressionParser } from "cron-parser";

/**
 * Validates a 5-field cron expression + IANA timezone and returns the next
 * fire time strictly after `from`. Returns an error string instead of
 * throwing so tool callers surface it as lint-style feedback.
 */
export function nextFireAt(
  cron: string,
  timezone: string,
  from: number,
): { ok: true; at: number } | { ok: false; error: string } {
  if (cron.trim().split(/\s+/).length !== 5) {
    return {
      ok: false,
      error: `cron must be a 5-field expression (minute hour day-of-month month day-of-week), got ${JSON.stringify(cron)}`,
    };
  }
  try {
    // Timezone validity check — cron-parser silently falls back on some
    // invalid tz strings; Intl throws, which is the behavior we want.
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    return { ok: false, error: `Unknown timezone ${JSON.stringify(timezone)}. Use an IANA name like "America/Denver".` };
  }
  try {
    const interval = CronExpressionParser.parse(cron, { currentDate: new Date(from), tz: timezone });
    return { ok: true, at: interval.next().getTime() };
  } catch (err) {
    return { ok: false, error: `invalid cron ${JSON.stringify(cron)}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
