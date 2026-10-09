// Pure validation for wakeup tool arguments (spec 2026-10-08: sandbox
// scratch, wakeups, and leases). No I/O, no clock reads beyond the `now`
// callers pass in. Consumed by the wakeup tools (Task 6) and the `bash`
// background/sleep extension (Task 7).

import type { WakeupLimits } from "./types.js";

export type Validation<T> = { ok: true; value: T } | { ok: false; text: string };

export const BACKGROUND_REFUSAL = (max: number) =>
  `[bash_background] Set deadline_hours (1 to ${max}) and reason when background is true.`;

export const SLEEP_REFUSAL = "[bash_sleep] Use wake_at to pause for more than 5 minutes.";

export const WAKEUPS_UNAVAILABLE = "[wakeups_unavailable] this session cannot schedule wakeups. Run the work in the foreground.";

/** The cap counts per thread (fix wave 2, M14): one thread cannot use up another's. */
export function wakeupsLimitRefusal(n: number, cap: number): string {
  return `[wakeups_limit] This thread already has ${n} active wakeups and holds (limit ${cap}, sandbox.wakeupsPerSession). Cancel one of them with wakeup_cancel.`;
}

function trimmedOrEmpty(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function isHoursInRange(value: number | undefined, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= max;
}

export function validateBackground(
  args: { background?: boolean; deadline_hours?: number; reason?: string },
  limits: WakeupLimits,
): Validation<{ deadlineHours: number; reason: string }> {
  const text = BACKGROUND_REFUSAL(limits.leaseMaxHours);
  const reason = trimmedOrEmpty(args.reason);
  if (!isHoursInRange(args.deadline_hours, limits.leaseMaxHours) || reason.length < 1 || reason.length > 200) {
    return { ok: false, text };
  }
  return { ok: true, value: { deadlineHours: args.deadline_hours as number, reason } };
}

export function validateWatch(
  args: { reason: string; max_hours: number },
  limits: WakeupLimits,
): Validation<{ reason: string; maxHours: number }> {
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
    const parsed = Date.parse(args.at as string);
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
  const reason = trimmedOrEmpty(args.reason);
  if (reason.length < 1 || reason.length > 200) {
    return { ok: false, text: "[hold_sandbox] Set reason (1 to 200 characters)." };
  }
  if (!isHoursInRange(args.hours, limits.leaseMaxHours)) {
    return { ok: false, text: `[hold_sandbox] Set hours (1 to ${limits.leaseMaxHours}).` };
  }
  return { ok: true, value: { hours: args.hours, reason } };
}

export function sleepRefusal(command: string): string | null {
  const match = /^\s*sleep\s+(\d+)/.exec(command);
  if (!match) return null;
  const seconds = Number(match[1]);
  return seconds > 300 ? SLEEP_REFUSAL : null;
}
