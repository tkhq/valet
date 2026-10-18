/**
 * Time zones as a reader knows them: `Pacific Daylight Time (Los Angeles)`,
 * not `America/Los_Angeles`. The IANA name stays the stored value.
 */

/** The zone's long name now, such as `Pacific Daylight Time`. Falls back to the IANA name. */
export function zoneLongName(timeZone: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat(undefined, { timeZone, timeZoneName: "long" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** The city of an IANA name: `America/Los_Angeles` → `Los Angeles`. */
function zoneCity(timeZone: string): string {
  const last = timeZone.split("/").pop() ?? timeZone;
  return last.replace(/_/g, " ");
}

/** A zone as an option label: the long name, and the city when the name does not say it. */
export function zoneLabel(timeZone: string): string {
  const long = zoneLongName(timeZone);
  if (!timeZone.includes("/")) return long;
  return `${long} (${zoneCity(timeZone)})`;
}

/** The browser's zone, as an IANA name. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

let cached: readonly { value: string; label: string }[] | undefined;

/**
 * Every zone the browser knows, labeled, in IANA order. Built once: a label
 * needs one formatter per zone. `include` adds a zone the list lacks, such
 * as `UTC` on a browser that lists only regional names.
 */
export function timeZoneOptions(include: readonly string[] = []): readonly { value: string; label: string }[] {
  if (cached === undefined) {
    let zones: string[] = [];
    try {
      zones = Intl.supportedValuesOf("timeZone");
    } catch {
      zones = [];
    }
    cached = zones.map((value) => ({ value, label: zoneLabel(value) }));
  }
  const missing = include.filter((zone) => zone.length > 0 && !cached?.some((o) => o.value === zone));
  return [...missing.map((value) => ({ value, label: zoneLabel(value) })), ...cached];
}
