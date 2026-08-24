import { describe, expect, it } from "vitest";
import {
  countSlides,
  extractTokenRefs,
  parseHeader,
  parseMetaBlock,
  validateDcHtml,
  writeMetaBlock,
  MAX_ARTIFACT_BYTES,
} from "./dc-html.js";
import { listTemplates, readTemplateStarter } from "./templates.js";

const DOC = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="valet-design" content="v=1; template=slides">
  <style>h1 { color: var(--color-primary); } p { color: var(--color-muted, #555); }</style>
</head>
<body>
  <section><h1>One</h1><aside>notes</aside></section>
  <section><h2>Two</h2></section>
</body>
<!-- valet-design:meta
{
  "v": 1,
  "template": "slides",
  "revision": "r-001"
}
-->
</html>`;

describe("dc-html header", () => {
  it("parses the valet-design meta tag", () => {
    expect(parseHeader(DOC)).toEqual({ v: 1, template: "slides" });
  });

  it("returns null when the tag is missing", () => {
    expect(parseHeader("<html><head></head></html>")).toBeNull();
  });

  it("validation refuses unknown versions", () => {
    const doc = DOC.replace("v=1", "v=9");
    const result = validateDcHtml(doc);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("v=9");
  });

  it("validation refuses oversized documents", () => {
    const doc = DOC + "x".repeat(MAX_ARTIFACT_BYTES);
    const result = validateDcHtml(doc);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("cap");
  });

  it("validation passes the sample document", () => {
    expect(validateDcHtml(DOC)).toMatchObject({ ok: true, header: { v: 1, template: "slides" } });
  });
});

describe("meta block", () => {
  it("parses the trailing comment JSON", () => {
    expect(parseMetaBlock(DOC)).toMatchObject({ v: 1, template: "slides", revision: "r-001" });
  });

  it("writeMetaBlock replaces in place and round-trips", () => {
    const next = writeMetaBlock(DOC, { v: 1, template: "slides", revision: "r-002" });
    expect(parseMetaBlock(next)).toMatchObject({ revision: "r-002" });
    // Still exactly one meta block.
    expect(next.match(/valet-design:meta/g)).toHaveLength(1);
  });

  it("writeMetaBlock appends before </html> when absent", () => {
    const bare = "<html><body><p>x</p></body></html>";
    const next = writeMetaBlock(bare, { v: 1, template: "document" });
    expect(parseMetaBlock(next)).toMatchObject({ template: "document" });
    expect(next.trim().endsWith("</html>")).toBe(true);
  });
});

describe("token refs and slides", () => {
  it("extracts var(--*) references, deduped and sorted", () => {
    expect(extractTokenRefs(DOC)).toEqual(["--color-muted", "--color-primary"]);
  });

  it("counts sections as slides", () => {
    expect(countSlides(DOC)).toBe(2);
  });
});

describe("template starters", () => {
  it("every shipped template is a valid v1 artifact", () => {
    for (const template of listTemplates()) {
      const { starter, prompt } = readTemplateStarter(template);
      const result = validateDcHtml(starter);
      expect(result.ok, `${template}: ${result.errors.join("; ")}`).toBe(true);
      expect(result.header?.template).toBe(template);
      expect(prompt.length).toBeGreaterThan(0);
    }
  });

  it("unknown template names throw with the valid list", () => {
    expect(() => readTemplateStarter("nope")).toThrow(/Valid templates/);
  });
});
