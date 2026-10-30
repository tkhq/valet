import { ENTRY_USER_TIMEZONE_KEY, type MessageEntry } from "./types.js";

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
 * persisted thread creation time and the timezone stamped at creation, so it never changes
 * between calls. UTC time is to the minute.
 */
export function threadStartedSection(createdAtMs: number, userTimezone: string | undefined): string {
  const date = new Date(createdAtMs);
  const utc = `${date.toISOString().slice(0, 16)}:00Z`;
  const local = localTime(createdAtMs, userTimezone)
    ?? "unknown, the user timezone was not known when this thread started. Do not guess it.";
  return `## Thread started

This block shows when this thread started. It is not the current time.
Thread started (UTC): ${utc} (${WEEKDAYS[date.getUTCDay()]})
Thread started (user local): ${local}
Each user message starts with a [sent: …] line: the time it was sent in UTC and, when known, in the user's local time. The newest [sent: …] line is the current time, to within the length of this turn. Use it, not the thread start or dates in earlier messages, for "today", "tomorrow" and schedule times. A line with no user local time means the timezone was not known. Do not guess it.
A memory snapshot header, if present, shows the date the snapshot was built. That date is separate from the thread start.
If you have a shell tool, run \`date -u\` when you need the exact current time.`;
}

/**
 * When a user message was sent: the persisted entry `createdAt`, and the
 * user timezone the thread stamped on that entry (`ENTRY_USER_TIMEZONE_KEY`).
 */
export interface MessageTime {
  at: number;
  timezone?: string;
}

/**
 * The `[sent: …]` line on each user message in the model's transcript. It
 * gives every turn the current time without a per-call system prompt change:
 * it depends only on persisted entry fields, so a message renders the same
 * bytes on every later call and after a restart, and the cached prefix holds.
 */
export function messageTimeLine(time: MessageTime): string {
  const date = new Date(time.at);
  const iso = date.toISOString();
  const utc = `${WEEKDAYS[date.getUTCDay()]} ${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  const local = localTime(time.at, time.timezone);
  return local ? `[sent: ${utc}; user local: ${local}]` : `[sent: ${utc}]`;
}

/** The `MessageTime` a persisted user entry renders. An entry written before the stamp existed shows UTC only. */
export function entryMessageTime(entry: MessageEntry): MessageTime {
  const timezone = entry.metadata?.[ENTRY_USER_TIMEZONE_KEY];
  return { at: entry.createdAt, ...(typeof timezone === "string" ? { timezone } : {}) };
}
