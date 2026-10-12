/** Runtime facts for the outbound prompt. Selection tokens need not be wire model IDs. */
export interface RuntimeModelContext {
  assignedSelection: string;
  activeSelection: string;
  provider: string;
  modelId: string;
  temporaryOverride?: "switch_model" | "role model" | "submission model" | "provider fallback";
}

/** Append current facts without changing the stored prompt or inferring a model tier. */
export function appendRuntimeModelContext(prompt: string | undefined, context: RuntimeModelContext): string {
  const override = context.temporaryOverride
    ? `${context.temporaryOverride}; expires when this turn ends`
    : "none";
  const section = `## Runtime model

These runtime facts describe this model call. Use them instead of earlier model statements in the transcript.
Selections are configured tier tokens or model IDs. Do not infer a tier from a concrete model ID.
Assigned selection: ${context.assignedSelection}
Active selection: ${context.activeSelection}
Current provider: ${context.provider}
Current model: ${context.modelId}
Temporary override: ${override}`;
  return prompt ? `${prompt}\n\n${section}` : section;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Return the local time text, or undefined if the timezone is unset or invalid. */
function localTime(ms: number, timeZone: string | undefined): string | undefined {
  if (!timeZone) return undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, hourCycle: "h23", weekday: "long",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", timeZoneName: "short",
    }).formatToParts(new Date(ms));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("weekday")} ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")} (${timeZone})`;
  } catch {
    return undefined;
  }
}

/**
 * Fixed block for the stable prompt prefix (TKAI-584). It depends only on the
 * persisted thread creation time and the user timezone, so it never changes
 * between calls. UTC time is to the minute.
 */
export function threadStartedSection(createdAtMs: number, userTimezone: string | undefined): string {
  const date = new Date(createdAtMs);
  const utc = `${date.toISOString().slice(0, 16)}:00Z`;
  const local = localTime(createdAtMs, userTimezone)
    ?? "unknown, the user timezone is not known. Do not guess it.";
  return `## Thread started

This thread started at the time below. This is not the current time. Time has passed since then, and the memory snapshot date is older still.
Thread started (UTC): ${utc} (${WEEKDAYS[date.getUTCDay()]})
Thread started (user local): ${local}
If you have a shell tool, run \`date -u\` when you need the exact current time.`;
}
