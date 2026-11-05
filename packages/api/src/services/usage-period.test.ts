import { describe, expect, it } from "vitest";
import { resolveUsagePeriod } from "./usage-period.js";

const NOW = Date.UTC(2024, 2, 15, 12);

function period(query: Parameters<typeof resolveUsagePeriod>[0]) {
  const result = resolveUsagePeriod(query, NOW);
  if (!result.ok) throw new Error(result.error.code);
  return result.period;
}

describe("resolveUsagePeriod", () => {
  it("uses exact UTC month boundaries", () => {
    expect(period({ month: "2024-02" })).toEqual({
      startMs: Date.UTC(2024, 1, 1),
      endMs: Date.UTC(2024, 2, 1),
      label: "2024-02",
      kind: "month",
    });
  });

  it("rolls December into the next UTC year", () => {
    const december = period({ month: "2023-12" });
    expect(december.startMs).toBe(Date.UTC(2023, 11, 1));
    expect(december.endMs).toBe(Date.UTC(2024, 0, 1));
  });

  it("includes leap day and keeps the end exclusive", () => {
    const leap = period({ start: "2024-02-28", end: "2024-02-29" });
    expect(leap.startMs).toBe(Date.UTC(2024, 1, 28));
    expect(leap.endMs).toBe(Date.UTC(2024, 2, 1));
    expect(leap.endMs - leap.startMs).toBe(2 * 86_400_000);
  });

  it("ends the current month after the current UTC day", () => {
    expect(period({ month: "2024-03" }).endMs).toBe(Date.UTC(2024, 2, 16));
  });

  it.each([
    [{ start: "2024-03-10", end: "2024-03-09" }, "reversed_range"],
    [{ start: "2024-03-10", end: "2024-03-16" }, "future_range"],
    [{ start: "2022-01-01", end: "2024-01-01" }, "range_too_large"],
    [{ start: "2024-02-30", end: "2024-03-01" }, "invalid_date"],
    [{ month: "2024-13" }, "invalid_date"],
    [{ month: "0099-01" }, "invalid_date"],
    [{ month: "2024-04" }, "future_range"],
    [{ start: "2024-03-01" }, "invalid_period"],
    [{ window: "7d", month: "2024-02" }, "invalid_period"],
  ] as const)("rejects invalid period %#", (query, code) => {
    const result = resolveUsagePeriod(query, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });
});
