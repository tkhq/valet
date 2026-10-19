import { describe, expect, it } from "vitest";
import { LINE_ACTIVITY_AUTO_FETCHES, lineActivityPollMs, shouldFetchPastEmpty, trailingEmptyPages } from "./line-activity";

const empty = { entries: [] };
const full = { entries: [{ id: "d-1" }] };

describe("a line's Activity query", () => {
  it("polls only while one page is loaded (S12)", () => {
    expect(lineActivityPollMs(undefined)).toBe(false);
    expect(lineActivityPollMs(1)).toBe(30_000);
    expect(lineActivityPollMs(2)).toBe(false);
  });

  it("counts the empty pages at the end", () => {
    expect(trailingEmptyPages([])).toBe(0);
    expect(trailingEmptyPages([full, empty, empty])).toBe(2);
    expect(trailingEmptyPages([empty, full])).toBe(0);
  });

  it("fetches past an empty page that has a cursor, at most three times in a row (S13)", () => {
    const base = { hasNextPage: true, fetching: false, failed: false };
    expect(shouldFetchPastEmpty({ ...base, pages: [empty] })).toBe(true);
    expect(shouldFetchPastEmpty({ ...base, pages: [full] })).toBe(false);
    expect(shouldFetchPastEmpty({ ...base, pages: Array.from({ length: LINE_ACTIVITY_AUTO_FETCHES }, () => empty) })).toBe(true);
    expect(shouldFetchPastEmpty({ ...base, pages: Array.from({ length: LINE_ACTIVITY_AUTO_FETCHES + 1 }, () => empty) })).toBe(false);
    expect(shouldFetchPastEmpty({ ...base, pages: [empty], hasNextPage: false })).toBe(false);
    expect(shouldFetchPastEmpty({ ...base, pages: [empty], fetching: true })).toBe(false);
    expect(shouldFetchPastEmpty({ ...base, pages: [empty], failed: true })).toBe(false);
  });
});
