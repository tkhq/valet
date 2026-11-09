import { describe, it, expect } from "vitest";
import { journalHasEntries } from "./bootstrap.js";

describe("journalHasEntries", () => {
  it("reads a date heading alone as no entry", () => {
    expect(journalHasEntries("# 2026-10-20\n")).toBe(false);
    expect(journalHasEntries("\n  # 2026-10-20  \n   \n")).toBe(false);
    expect(journalHasEntries("")).toBe(false);
  });

  it("reads any line under the heading as an entry, a heading included", () => {
    expect(journalHasEntries("# 2026-10-20\n\n- Saved the short-answers preference.\n")).toBe(true);
    expect(journalHasEntries("# 2026-10-20\n## 14:30 Fixed the Slack reply bug\n")).toBe(true);
    expect(journalHasEntries("# 2026-10-20\n\n## Notes\n")).toBe(true);
    expect(journalHasEntries("#tag without a heading space")).toBe(true);
  });
});
