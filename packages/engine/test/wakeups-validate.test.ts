import { describe, expect, it } from "vitest";
import {
  validateBackground,
  validateWakeAt,
  validateHold,
  validateWatch,
  sleepRefusal,
  wakeupsLimitRefusal,
  wakeupsUnavailable,
} from "../src/wakeups/validate.js";

const limits = { leaseMaxHours: 72, timerMaxHours: 720, perSession: 20, watchMaxEventsPerHour: 120 };

describe("validateBackground", () => {
  it("accepts a deadline inside the lease max and a reason", () => {
    expect(validateBackground({ background: true, deadline_hours: 48, reason: "proof build" }, limits)).toEqual({ ok: true, value: { deadlineHours: 48, reason: "proof build" } });
  });
  it("refuses a missing deadline, a missing reason, or a deadline over the max with the B3 text", () => {
    const text = "[bash_background] Set deadline_hours (1 to 72) and reason when background is true.";
    expect(validateBackground({ background: true, reason: "x" }, limits)).toEqual({ ok: false, text });
    expect(validateBackground({ background: true, deadline_hours: 2 }, limits)).toEqual({ ok: false, text });
    expect(validateBackground({ background: true, deadline_hours: 100, reason: "x" }, limits)).toEqual({ ok: false, text });
    expect(validateBackground({ background: true, deadline_hours: 0.5, reason: "x" }, limits)).toEqual({ ok: false, text });
  });
});

describe("validateWakeAt", () => {
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);
  it("accepts after_seconds in range", () => {
    expect(validateWakeAt({ after_seconds: 7200, prompt: "Check the proof report" }, now, limits)).toEqual({ ok: true, value: { fireAt: now + 7_200_000, prompt: "Check the proof report" } });
  });
  it("accepts an ISO `at` in the future", () => {
    expect(validateWakeAt({ at: "2026-10-08T14:00:00Z", prompt: "p" }, now, limits)).toEqual({ ok: true, value: { fireAt: now + 7_200_000, prompt: "p" } });
  });
  it("refuses both or neither, under 60s, past, or over timerMaxHours", () => {
    for (const bad of [{ prompt: "p" }, { at: "2026-10-08T14:00:00Z", after_seconds: 60, prompt: "p" }, { after_seconds: 30, prompt: "p" }, { at: "2026-10-08T11:00:00Z", prompt: "p" }, { after_seconds: 720 * 3600 + 1, prompt: "p" }, { after_seconds: 60, prompt: "" }]) {
      const r = validateWakeAt(bad, now, limits);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.text.startsWith("[wake_at]")).toBe(true);
    }
  });
});

describe("validateHold and validateWatch", () => {
  it("bound hours by leaseMaxHours and require a reason", () => {
    expect(validateHold({ hours: 72, reason: "soak" }, limits).ok).toBe(true);
    expect(validateHold({ hours: 73, reason: "soak" }, limits).ok).toBe(false);
    expect(validateHold({ hours: 1, reason: "" }, limits).ok).toBe(false);
    expect(validateWatch({ reason: "ci", max_hours: 72 }, limits).ok).toBe(true);
    expect(validateWatch({ reason: "ci", max_hours: 0 }, limits).ok).toBe(false);
  });
});

describe("sleepRefusal", () => {
  it("refuses sleep over 300 seconds only", () => {
    expect(sleepRefusal("sleep 301")).toBe("[bash_sleep] Do not block a turn on sleep for more than 5 minutes. Call wake_at to start a new turn later, then end your turn.");
    expect(sleepRefusal("  sleep 3000 && echo hi")).not.toBeNull();
    expect(sleepRefusal("sleep 300")).toBeNull();
    expect(sleepRefusal("echo sleep 999")).toBeNull();
  });

  it("refuses a long sleep after a command separator or with a unit (fix wave 3, UX prompt 4)", () => {
    expect(sleepRefusal("cd /workspace && sleep 600")).not.toBeNull();
    expect(sleepRefusal("make; sleep 900; make check")).not.toBeNull();
    expect(sleepRefusal("sleep 10m")).not.toBeNull();
    expect(sleepRefusal("sleep 2h")).not.toBeNull();
    expect(sleepRefusal("sleep 4m")).toBeNull();
    expect(sleepRefusal("sleep 30s && make")).toBeNull();
  });
});

describe("wakeupsLimitRefusal", () => {
  it("names the knob and says the count is per thread", () => {
    expect(wakeupsLimitRefusal(20, 20)).toBe("[wakeups_limit] This thread already has 20 active wakeups and holds (limit 20 per thread, set by sandbox.wakeupsPerSession). Cancel one of them with wakeup_cancel.");
  });
});

describe("validateWakeAt `at` without an offset (fix wave 3, UX L1)", () => {
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);
  it("refuses a time with no offset and names the Z form", () => {
    expect(validateWakeAt({ at: "2026-10-08T14:00:00", prompt: "p" }, now, limits)).toEqual({
      ok: false,
      text: "[wake_at] Give at with a UTC offset, for example 2026-10-08T14:00:00Z or 2026-10-08T14:00:00+02:00.",
    });
    expect(validateWakeAt({ at: "2026-10-08T14:00:00+02:00", prompt: "p" }, now, limits).ok).toBe(false);
    expect(validateWakeAt({ at: "2026-10-08T14:30:00+02:00", prompt: "p" }, Date.UTC(2026, 9, 8, 11, 0, 0), limits).ok).toBe(true);
  });
});

describe("wakeupsUnavailable (fix wave 3, UX prompt 13)", () => {
  it("names a corrective action that fits each tool", () => {
    expect(wakeupsUnavailable("bash")).toBe("[wakeups_unavailable] This session cannot run background work. Run the command in the foreground.");
    expect(wakeupsUnavailable("wake_at")).toBe("[wakeups_unavailable] This session cannot schedule wakeups. Tell the person to check back later instead.");
  });
});
