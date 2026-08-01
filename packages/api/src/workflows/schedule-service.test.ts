import { describe, expect, it } from "vitest";
import { nextFireAt } from "./schedule-service.js";
import { scheduledRunId } from "./scheduler.js";

describe("nextFireAt", () => {
  const base = Date.UTC(2026, 0, 15, 12, 30, 0); // 2026-01-15T12:30:00Z (Thursday)

  it("computes the next occurrence strictly after `from`", () => {
    const result = nextFireAt("0 * * * *", "UTC", base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new Date(result.at).toISOString()).toBe("2026-01-15T13:00:00.000Z");
    }
  });

  it("respects the timezone", () => {
    // 09:00 in Denver (UTC-7 in January) = 16:00 UTC.
    const result = nextFireAt("0 9 * * *", "America/Denver", base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new Date(result.at).toISOString()).toBe("2026-01-15T16:00:00.000Z");
    }
  });

  it("rejects non-5-field expressions", () => {
    const result = nextFireAt("0 * * *", "UTC", base);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("5-field");
  });

  it("rejects unparseable field values", () => {
    const result = nextFireAt("99 * * * *", "UTC", base);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("invalid cron");
  });

  it("rejects unknown timezones with an IANA hint", () => {
    const result = nextFireAt("0 * * * *", "Mars/Olympus_Mons", base);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("IANA");
  });
});

describe("scheduledRunId", () => {
  it("is deterministic per (schedule, slot) and distinct across slots", () => {
    const a = scheduledRunId("0a1b2c3d-4e5f-6789-abcd-ef0123456789", 1000);
    expect(a).toBe(scheduledRunId("0a1b2c3d-4e5f-6789-abcd-ef0123456789", 1000));
    expect(a).not.toBe(scheduledRunId("0a1b2c3d-4e5f-6789-abcd-ef0123456789", 2000));
    expect(a).toMatch(/^wfrun_sch_[a-z0-9]{8}_1000$/);
  });
});
