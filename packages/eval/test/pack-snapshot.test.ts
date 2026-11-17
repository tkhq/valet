import { describe, expect, it } from "vitest";
import { diffSnapshots, type PackSnapshot } from "../src/pack-snapshot.js";

const snap = (over: Partial<PackSnapshot> = {}): PackSnapshot => ({
  caseId: "c",
  head: "abc",
  budgetChars: 48000,
  usedChars: 9000,
  items: [
    { section: "definitions", ref: "lib/a.ts:3", chars: 1000 },
    { section: "learned", ref: "code-review/learned/acme/site/x.md", chars: 700 },
  ],
  dropped: [{ section: "callers", ref: "parse", reason: "too common: 40 references" }],
  ...over,
});

describe("diffSnapshots", () => {
  it("reports nothing for the same pack, and ignores a small size change", () => {
    expect(diffSnapshots(snap(), snap())).toEqual([]);
    const items = snap().items.map((i) => (i.section === "definitions" ? { ...i, chars: 1010 } : i));
    expect(diffSnapshots(snap(), snap({ items }))).toEqual([]);
  });

  it("reports an item that left the pack and the reason it was left out", () => {
    const now = snap({
      items: snap().items.filter((i) => i.section !== "learned"),
      dropped: [...snap().dropped, { section: "learned", ref: "code-review/learned/acme/site/x.md", reason: "learned allowance (700 chars)" }],
    });
    expect(diffSnapshots(snap(), now)).toEqual([
      "- item learned: code-review/learned/acme/site/x.md (700 chars)",
      "+ left out learned: code-review/learned/acme/site/x.md (learned allowance (N chars))",
    ]);
  });

  it("reports a new item, a size change and a budget change", () => {
    const now = snap({
      budgetChars: 60000,
      items: [...snap().items.map((i) => (i.section === "definitions" ? { ...i, chars: 2000 } : i)), { section: "callers", ref: "run (changed)", chars: 400 }],
    });
    expect(diffSnapshots(snap(), now)).toEqual([
      "~ item definitions: lib/a.ts:3: 1000 -> 2000 chars",
      "+ item callers: run (changed) (400 chars)",
      "~ budget 48000 -> 60000 chars",
    ]);
  });
});
