/**
 * IANA timezone validation (TKAI-584). `Intl` is the source of truth for
 * known zones. The name check rejects UTC offsets such as "+05:00" and
 * abbreviations such as "EST", which `Intl` may also accept.
 */
const IANA_NAME = /^(?:UTC|GMT|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/;

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !IANA_NAME.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
