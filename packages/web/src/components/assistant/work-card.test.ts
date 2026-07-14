/**
 * `activeChildrenLine` (decision 15): the "N tasks running under today's
 * thread" derivation. `WorkCard` receives an already-standalone-filtered
 * sessions list (server-side, decision 8) — this file only covers the
 * count-line derivation, which is the pure part.
 */
import { describe, expect, it } from "vitest";
import { activeChildrenLine } from "./work-card";

describe("activeChildrenLine", () => {
  it("returns null when nothing is running", () => {
    expect(activeChildrenLine(0)).toBeNull();
  });

  it("singularizes for exactly one task", () => {
    expect(activeChildrenLine(1)).toBe("1 task running under today's thread");
  });

  it("pluralizes for more than one task", () => {
    expect(activeChildrenLine(2)).toBe("2 tasks running under today's thread");
  });
});
