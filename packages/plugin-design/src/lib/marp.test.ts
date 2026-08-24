import { describe, expect, it } from "vitest";
import { dcHtmlToMarp, marpToDcHtml } from "./marp.js";
import { countSlides, parseHeader, parseMetaBlock, validateDcHtml } from "./dc-html.js";

const MD = `---
marp: true
---

# Pitch Deck

Series B Fundraise

<!-- Welcome slide. -->

---

## The Problem

- Market is fragmented
- Costs are rising

<!-- Spend 2 minutes here. -->
`;

describe("marp → dc.html", () => {
  it("converts slides to sections with notes as asides", () => {
    const { output } = marpToDcHtml(MD);
    expect(validateDcHtml(output).ok).toBe(true);
    expect(parseHeader(output)).toEqual({ v: 1, template: "slides" });
    expect(countSlides(output)).toBe(2);
    expect(output).toContain("<aside>Welcome slide.</aside>");
    expect(output).toContain("Spend 2 minutes here.");
  });

  it("stamps vdids and writes an import report", () => {
    const { output } = marpToDcHtml(MD);
    expect(output).toMatch(/data-vdid="[0-9a-f_]+"/);
    const meta = parseMetaBlock(output);
    expect(meta?.import_reports?.[0]?.type).toBe("marp");
  });
});

describe("dc.html → marp round trip", () => {
  it("preserves headings, lists, and notes", () => {
    const { output: dc } = marpToDcHtml(MD);
    const { output: md } = dcHtmlToMarp(dc);
    expect(md).toContain("# Pitch Deck");
    expect(md).toContain("## The Problem");
    expect(md).toContain("- Market is fragmented");
    expect(md).toContain("Welcome slide.");
    // Two slides → one separator between them.
    expect(md.split("\n---\n").length).toBeGreaterThanOrEqual(2);
  });

  it("second-generation import equals the first structurally", () => {
    const gen1 = marpToDcHtml(MD).output;
    const gen2 = marpToDcHtml(dcHtmlToMarp(gen1).output).output;
    expect(countSlides(gen2)).toBe(countSlides(gen1));
  });
});
