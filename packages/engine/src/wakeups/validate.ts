// Pure validation for wakeup tool arguments (spec 2026-10-08: sandbox
// scratch, wakeups, and leases). No I/O, no clock reads beyond the `now`
// callers pass in. Consumed by the wakeup tools (Task 6) and the `bash`
// background/sleep extension (Task 7).

import type { ArmEventRequest, EventClause, WakeupLimits } from "./types.js";

export type Validation<T> = { ok: true; value: T } | { ok: false; text: string };

export const BACKGROUND_REFUSAL = (max: number) =>
  `[bash_background] Set deadline_hours (1 to ${max}) and reason when background is true.`;

export const SLEEP_REFUSAL =
  "[bash_sleep] Do not block a turn on sleep for more than 5 minutes. Call wake_at to start a new turn later, then end your turn.";

/** The tools that refuse when the host wires no wakeups seam. */
export type WakeupsTool =
  | "bash"
  | "watch"
  | "wake_at"
  | "hold_sandbox"
  | "process_read"
  | "wakeup_list"
  | "wakeup_cancel"
  | "wait_for_event";

/**
 * The refusal each tool returns when the session has no wakeups seam. The
 * corrective action fits the tool: a reminder cannot run in the
 * foreground (fix wave 3, UX prompt 13).
 */
export function wakeupsUnavailable(tool: WakeupsTool): string {
  switch (tool) {
    case "bash":
    case "watch":
      return "[wakeups_unavailable] This session cannot run background work. Run the command in the foreground.";
    case "wake_at":
      return "[wakeups_unavailable] This session cannot schedule wakeups. Tell the person to check back later instead.";
    case "hold_sandbox":
      return "[wakeups_unavailable] This session cannot hold its sandbox. Finish the work in this turn.";
    case "process_read":
    case "wakeup_list":
    case "wakeup_cancel":
      return "[wakeups_unavailable] This session has no background work.";
    case "wait_for_event":
      return "[wakeups_unavailable] This session cannot wait for events. Tell the person to check back later instead.";
  }
}

/** The `wake_at` text, kept under its old name for callers. */
export const WAKEUPS_UNAVAILABLE = wakeupsUnavailable("wake_at");

/** The cap counts per thread (fix wave 2, M14): one thread cannot use up another's. */
export function wakeupsLimitRefusal(n: number, cap: number): string {
  return `[wakeups_limit] This thread already has ${n} active wakeups and holds (limit ${cap} per thread, set by sandbox.wakeupsPerSession). Cancel one of them with wakeup_cancel.`;
}

/** An ISO time that ends in `Z` or a `+hh:mm` / `-hh:mm` offset. */
const ISO_WITH_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function trimmedOrEmpty(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function isHoursInRange(value: number | undefined, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= max;
}

/**
 * The refusal for the first field that holds a NUL byte, or null. Postgres
 * `text` rejects NUL, so the store write would fail with a raw driver error
 * the agent cannot act on (fix wave 4, data probable 4).
 */
function nulRefusal(tool: string, fields: Record<string, string | undefined>): string | null {
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === "string" && value.includes("\u0000")) {
      return `[${tool}] ${name} contains a NUL byte (\\0). Remove it and call the tool again.`;
    }
  }
  return null;
}

export function validateBackground(
  args: { background?: boolean; deadline_hours?: number; reason?: string; command?: string },
  limits: WakeupLimits,
): Validation<{ deadlineHours: number; reason: string }> {
  const nul = nulRefusal("bash_background", { command: args.command, reason: args.reason });
  if (nul) return { ok: false, text: nul };
  const text = BACKGROUND_REFUSAL(limits.leaseMaxHours);
  const reason = trimmedOrEmpty(args.reason);
  if (!isHoursInRange(args.deadline_hours, limits.leaseMaxHours) || reason.length < 1 || reason.length > 200) {
    return { ok: false, text };
  }
  return { ok: true, value: { deadlineHours: args.deadline_hours as number, reason } };
}

export function validateWatch(
  args: { reason: string; max_hours: number; command?: string },
  limits: WakeupLimits,
): Validation<{ reason: string; maxHours: number }> {
  const nul = nulRefusal("watch", { command: args.command, reason: args.reason });
  if (nul) return { ok: false, text: nul };
  const reason = trimmedOrEmpty(args.reason);
  if (reason.length < 1 || reason.length > 200) {
    return { ok: false, text: `[watch] Set reason (1 to 200 characters).` };
  }
  if (!isHoursInRange(args.max_hours, limits.leaseMaxHours)) {
    return { ok: false, text: `[watch] Set max_hours (1 to ${limits.leaseMaxHours}).` };
  }
  return { ok: true, value: { reason, maxHours: args.max_hours } };
}

export function validateWakeAt(
  args: { at?: string; after_seconds?: number; prompt: string },
  now: number,
  limits: WakeupLimits,
): Validation<{ fireAt: number; prompt: string }> {
  const nul = nulRefusal("wake_at", { prompt: args.prompt });
  if (nul) return { ok: false, text: nul };
  const prompt = trimmedOrEmpty(args.prompt);
  const hasAt = typeof args.at === "string";
  const hasAfter = typeof args.after_seconds === "number";
  const maxSeconds = limits.timerMaxHours * 3600;

  if (hasAt === hasAfter) {
    return { ok: false, text: "[wake_at] Set exactly one of at (ISO timestamp) or after_seconds (60 to " + maxSeconds + ")." };
  }
  if (prompt.length < 1 || prompt.length > 4000) {
    return { ok: false, text: "[wake_at] Set prompt (1 to 4000 characters)." };
  }

  let fireAt: number;
  if (hasAfter) {
    const seconds = args.after_seconds as number;
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > maxSeconds) {
      return { ok: false, text: `[wake_at] Set after_seconds between 60 and ${maxSeconds}.` };
    }
    fireAt = now + seconds * 1000;
  } else {
    const at = (args.at as string).trim();
    // Without an offset, Date.parse reads the time in the api's zone, which
    // the agent cannot see (fix wave 3, UX L1).
    if (/^\d{4}-\d{2}-\d{2}T/.test(at) && !ISO_WITH_OFFSET.test(at)) {
      return { ok: false, text: `[wake_at] Give at with a UTC offset, for example ${at}Z or ${at}+02:00.` };
    }
    const parsed = Date.parse(at);
    if (Number.isNaN(parsed) || parsed <= now) {
      return { ok: false, text: "[wake_at] Set at to a future ISO timestamp." };
    }
    const seconds = (parsed - now) / 1000;
    if (seconds > maxSeconds) {
      return { ok: false, text: `[wake_at] Set at no more than ${limits.timerMaxHours} hours ahead.` };
    }
    fireAt = parsed;
  }

  return { ok: true, value: { fireAt, prompt } };
}

export function validateHold(
  args: { hours: number; reason: string },
  limits: WakeupLimits,
): Validation<{ hours: number; reason: string }> {
  const nul = nulRefusal("hold_sandbox", { reason: args.reason });
  if (nul) return { ok: false, text: nul };
  const reason = trimmedOrEmpty(args.reason);
  if (reason.length < 1 || reason.length > 200) {
    return { ok: false, text: "[hold_sandbox] Set reason (1 to 200 characters)." };
  }
  if (!isHoursInRange(args.hours, limits.leaseMaxHours)) {
    return { ok: false, text: `[hold_sandbox] Set hours (1 to ${limits.leaseMaxHours}).` };
  }
  return { ok: true, value: { hours: args.hours, reason } };
}

const SLEEP_UNIT_SECONDS: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86_400 };

/**
 * Refuses a `sleep` of more than 5 minutes at the start of the command or
 * after a separator (`;`, `&&`, `||`, `|`, a newline), with an optional
 * s/m/h/d unit (fix wave 3, UX prompt 4). `echo sleep 999` is not a sleep.
 */
export function sleepRefusal(command: string): string | null {
  const re = /(?:^|[;&|\n])\s*sleep\s+(\d+(?:\.\d+)?)([smhd]?)\b/g;
  for (const match of command.matchAll(re)) {
    const seconds = Number(match[1]) * (SLEEP_UNIT_SECONDS[match[2] ?? ""] ?? 1);
    if (seconds > 300) return SLEEP_REFUSAL;
  }
  return null;
}

/** R9 (spec 2026-10-15, Part D1 errata): a workflow run has no `armEvent`. */
export const WAIT_FOR_EVENT_WORKFLOW_REFUSAL =
  "[wait_for_event] Workflow runs cannot wait for events. Use a workflow trigger instead.";

/** The most clauses one event waiter takes (spec Part D). */
export const WAIT_FOR_EVENT_MAX_CLAUSES = 8;

const MIN_INTERVAL_SECONDS = { min: 30, max: 3600 } as const;

const CLAUSES_REFUSAL =
  `[wait_for_event] Set on to 1 to ${WAIT_FOR_EVENT_MAX_CLAUSES} clauses, each with a key, for example [{ "key": "github.check_run.completed" }].`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** One clause, with only the known fields kept, or the refusal text. */
function validateClause(raw: unknown, index: number): Validation<EventClause> {
  if (!isRecord(raw) || typeof raw.key !== "string" || raw.key.trim() === "") {
    return { ok: false, text: CLAUSES_REFUSAL };
  }
  const n = index + 1;
  const clause: EventClause = { key: raw.key.trim() };
  for (const field of ["status", "from_status"] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    if (!isStringList(value)) {
      return { ok: false, text: `[wait_for_event] In clause ${n}: give ${field} as a list of strings, for example ["failure"].` };
    }
    clause[field] = value;
  }
  if (raw.actor !== undefined) {
    if (typeof raw.actor !== "string" || raw.actor === "") {
      return { ok: false, text: `[wait_for_event] In clause ${n}: give actor as a login or an external id.` };
    }
    clause.actor = raw.actor;
  }
  for (const field of ["bots", "include_self"] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      return { ok: false, text: `[wait_for_event] In clause ${n}: set ${field} to true or false.` };
    }
    clause[field] = value;
  }
  const nul = nulRefusal("wait_for_event", {
    [`clause ${n} key`]: clause.key,
    ...(clause.actor !== undefined ? { [`clause ${n} actor`]: clause.actor } : {}),
    ...Object.fromEntries([...(clause.status ?? []), ...(clause.from_status ?? [])].map((v, i) => [`clause ${n} status ${i + 1}`, v])),
  });
  if (nul) return { ok: false, text: nul };
  return { ok: true, value: clause };
}

/**
 * Validates `wait_for_event` arguments (spec 2026-10-15, Part D). Pure: the
 * subject is only trimmed here, and the host's arm checks parse it
 * (Part D1). `once` defaults to true. `min_interval_seconds` is stream mode
 * only and becomes `minIntervalMs`.
 */
export function validateWaitForEvent(args: unknown, limits: WakeupLimits): Validation<ArmEventRequest> {
  if (!isRecord(args)) {
    return { ok: false, text: "[wait_for_event] Give subject, on, reason, and max_hours." };
  }
  const subject = typeof args.subject === "string" ? args.subject.trim() : "";
  const reasonRaw = typeof args.reason === "string" ? args.reason : undefined;
  const nul = nulRefusal("wait_for_event", { subject, reason: reasonRaw });
  if (nul) return { ok: false, text: nul };
  if (subject === "") {
    return {
      ok: false,
      text: "[wait_for_event] Set subject to a GitHub, Slack, or Linear URL, for example https://github.com/acme/app/pull/42.",
    };
  }
  const on = args.on;
  if (!Array.isArray(on) || on.length < 1 || on.length > WAIT_FOR_EVENT_MAX_CLAUSES) {
    return { ok: false, text: CLAUSES_REFUSAL };
  }
  const clauses: EventClause[] = [];
  for (const [index, raw] of on.entries()) {
    const clause = validateClause(raw, index);
    if (!clause.ok) return clause;
    clauses.push(clause.value);
  }
  if (args.once !== undefined && typeof args.once !== "boolean") {
    return { ok: false, text: "[wait_for_event] Set once to true or false." };
  }
  for (const name of ["evaluate_current", "end_on_close"]) {
    if (args[name] !== undefined && typeof args[name] !== "boolean") {
      return { ok: false, text: `[wait_for_event] Set ${name} to true or false.` };
    }
  }
  const once = args.once ?? true;
  const reason = trimmedOrEmpty(reasonRaw);
  if (reason.length < 1 || reason.length > 200) {
    return { ok: false, text: "[wait_for_event] Set reason (1 to 200 characters)." };
  }
  const maxHours = typeof args.max_hours === "number" ? args.max_hours : undefined;
  if (maxHours === undefined || !isHoursInRange(maxHours, limits.timerMaxHours)) {
    return { ok: false, text: `[wait_for_event] Set max_hours (1 to ${limits.timerMaxHours}).` };
  }
  const value: ArmEventRequest = { subject, on: clauses, once, reason, maxHours,
    ...(typeof args.evaluate_current === "boolean" ? { evaluateCurrent: args.evaluate_current } : {}),
    ...(typeof args.end_on_close === "boolean" ? { endOnClose: args.end_on_close } : {}),
  };
  if (args.min_interval_seconds !== undefined) {
    if (once) {
      return {
        ok: false,
        text: "[wait_for_event] min_interval_seconds works only in stream mode. Set once to false, or remove min_interval_seconds.",
      };
    }
    const seconds = args.min_interval_seconds;
    if (
      typeof seconds !== "number" ||
      !Number.isInteger(seconds) ||
      seconds < MIN_INTERVAL_SECONDS.min ||
      seconds > MIN_INTERVAL_SECONDS.max
    ) {
      return {
        ok: false,
        text: `[wait_for_event] Set min_interval_seconds between ${MIN_INTERVAL_SECONDS.min} and ${MIN_INTERVAL_SECONDS.max}.`,
      };
    }
    value.minIntervalMs = seconds * 1000;
  }
  return { ok: true, value };
}
