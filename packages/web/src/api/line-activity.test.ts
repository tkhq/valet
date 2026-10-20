import { describe, expect, it } from "vitest";
import { LINE_ACTIVITY_AUTO_FETCHES, lineActivityPollMs, shouldFetchPastEmpty, trailingEmptyPages } from "./line-activity";

const empty = { entries: [] };
const full = { entries: [{ id: "d-1" }] };

describe("a line's Activity query", () => {
  it("polls only while at most one loaded page holds entries (S12)", () => {
    expect(lineActivityPollMs(undefined)).toBe(false);
    expect(lineActivityPollMs([full])).toBe(30_000);
    expect(lineActivityPollMs([empty])).toBe(30_000);
    expect(lineActivityPollMs([full, full])).toBe(false);
  });

  it("keeps polling a quiet line after the hook fetches past an empty first page", () => {
    expect(lineActivityPollMs([empty, full])).toBe(30_000);
    expect(lineActivityPollMs([empty, empty])).toBe(30_000);
    expect(lineActivityPollMs([empty, full, full])).toBe(false);
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
