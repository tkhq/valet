import { describe, expect, it } from "vitest";
import { stripMarkdown } from "./strip-markdown";

describe("stripMarkdown", () => {
  it("drops heading markers", () => {
    expect(stripMarkdown("## Demo Triage Workflow")).toBe("Demo Triage Workflow");
    expect(stripMarkdown("# 2026-08-01")).toBe("2026-08-01");
  });

  it("unwraps bold/italic/strikethrough", () => {
    expect(stripMarkdown("**SUPER COMPLEX WORKFLOW TEST**")).toBe("SUPER COMPLEX WORKFLOW TEST");
    expect(stripMarkdown("*emphasis* and _also_ and ~~gone~~")).toBe("emphasis and also and gone");
    expect(stripMarkdown("***both***")).toBe("both");
  });

  it("keeps inline code content without backticks", () => {
    expect(stripMarkdown("save `wf_ms9om4f6sbeqj6` now")).toBe("save wf_ms9om4f6sbeqj6 now");
  });

  it("keeps link labels, drops URLs; keeps image alt text", () => {
    expect(stripMarkdown("see [the docs](https://example.com)")).toBe("see the docs");
    expect(stripMarkdown("![diagram](x.png)")).toBe("diagram");
  });

  it("drops fence lines but keeps code content", () => {
    expect(stripMarkdown("```json\n{ \"a\": 1 }\n```")).toBe('{ "a": 1 }');
  });

  it("drops horizontal rules and blockquote markers", () => {
    expect(stripMarkdown("---\n> quoted text")).toBe("quoted text");
  });

  it("reduces list markers to item text", () => {
    expect(stripMarkdown("- first\n- second\n1. third")).toBe("first second third");
  });

  it("collapses paragraph breaks into a separator", () => {
    expect(stripMarkdown("first para\n\nsecond para")).toBe("first para — second para");
  });

  it("handles the real journal shape", () => {
    const journal = "# 2026-08-01\n\n## Demo Triage Workflow\n\n- Created workflow \"Demo triage\" (ID: `wf_x`) - Shape: trigger → set";
    expect(stripMarkdown(journal)).toBe(
      "2026-08-01 — Demo Triage Workflow — Created workflow \"Demo triage\" (ID: wf_x) - Shape: trigger → set",
    );
  });

  it("passes plain text through untouched", () => {
    expect(stripMarkdown("just a normal sentence.")).toBe("just a normal sentence.");
  });
});
