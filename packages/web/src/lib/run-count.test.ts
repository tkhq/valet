import { describe, expect, it } from "vitest";
import { runCountLabel } from "./run-count";

describe("runCountLabel", () => {
  it("counts the page, and marks it with + when older runs exist", () => {
    expect(runCountLabel(undefined)).toBeUndefined();
    expect(runCountLabel({ runs: [] })).toBe("0");
    expect(runCountLabel({ runs: [], nextCursor: "1:wfrun_0" })).toBe("0+");
  });
});
