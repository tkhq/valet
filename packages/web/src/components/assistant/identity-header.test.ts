/**
 * `presenceStatusLine`: the one-line status under the presence mark
 * ("idle" / "thinking" / "working on N tasks").
 */
import { describe, expect, it } from "vitest";
import { presenceStatusLine } from "./identity-header";

describe("presenceStatusLine", () => {
  it("reports idle verbatim", () => {
    expect(presenceStatusLine("idle", 0)).toBe("idle");
  });

  it("reports thinking verbatim", () => {
    expect(presenceStatusLine("thinking", 0)).toBe("thinking");
  });

  it("reports working with a singular task count", () => {
    expect(presenceStatusLine("working", 1)).toBe("working on 1 task");
  });

  it("reports working with a plural task count", () => {
    expect(presenceStatusLine("working", 3)).toBe("working on 3 tasks");
  });
});
