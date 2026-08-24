import { describe, expect, it } from "vitest";
import { dcHtmlToSlidesChunks, slidesToDcHtml, type MinimalPresentation } from "./gslides.js";
import { countSlides, parseMetaBlock, validateDcHtml } from "./dc-html.js";
import { applyVdids } from "./vdid.js";

const DECK = applyVdids(
  `<!DOCTYPE html><html><head><meta name="valet-design" content="v=1; template=slides"></head><body>
  <section><h1>Pitch</h1><p>Series B</p><aside>notes here</aside></section>
  <section><h2>Problem</h2><ul><li>One</li><li>Two</li></ul><img src="data:image/png;base64,AAAA" alt="chart"></section>
</body></html>`,
).html;

describe("dc.html → slides chunks", () => {
  it("emits one chunk per slide with vd_-prefixed object ids", () => {
    const { title, chunks, report } = dcHtmlToSlidesChunks(DECK);
    expect(title).toBe("Pitch");
    expect(chunks).toHaveLength(2);
    const first = JSON.stringify(chunks[0].requests);
    expect(first).toContain("createSlide");
    expect(first).toMatch(/"objectId":"vd_[0-9a-f_]+"/);
    expect(first).toContain("Pitch");
    // Unrepresentables surface in the report, never silently.
    expect(report.join(" ")).toContain("speaker notes");
    expect(report.join(" ")).toContain("data:");
  });

  it("bulleted lists get bullet requests", () => {
    const { chunks } = dcHtmlToSlidesChunks(DECK);
    expect(JSON.stringify(chunks[1].requests)).toContain("createParagraphBullets");
  });
});

describe("slides → dc.html", () => {
  const presentation: MinimalPresentation = {
    presentationId: "p1",
    revisionId: "rev9",
    slides: [
      {
        objectId: "vd_a1b2c3d4e5f60718",
        pageElements: [
          {
            objectId: "vd_1111222233334444",
            shape: {
              placeholder: { type: "TITLE" },
              text: { textElements: [{ textRun: { content: "Edited Title\n" } }] },
            },
          },
          {
            objectId: "gSlidesNativeShape1",
            shape: {
              text: {
                textElements: [
                  { textRun: { content: "Point one\n" }, paragraphMarker: { bullet: {} } },
                  { textRun: { content: "Point two\n" }, paragraphMarker: { bullet: {} } },
                ],
              },
            },
          },
        ],
        slideProperties: {
          notesPage: {
            pageElements: [
              { objectId: "n1", shape: { text: { textElements: [{ textRun: { content: "speak slowly" } }] } } },
            ],
          },
        },
      },
    ],
  };

  it("recovers vdids from vd_ object ids and produces a valid artifact", () => {
    const { output } = slidesToDcHtml(presentation);
    expect(validateDcHtml(output).ok).toBe(true);
    expect(countSlides(output)).toBe(1);
    // The externally edited title keeps its exported vdid (Scenario C).
    expect(output).toContain('data-vdid="1111222233334444"');
    expect(output).toContain("Edited Title");
    expect(output).toContain("<li>Point one</li>");
    expect(output).toContain("<aside>speak slowly</aside>");
    expect(parseMetaBlock(output)?.import_reports?.[0]?.type).toBe("gslides");
  });

  it("elements without vd_ ids get fresh content-hashed vdids", () => {
    const { output } = slidesToDcHtml(presentation);
    const ul = /<ul data-vdid="([0-9a-f_]+)"/.exec(output);
    expect(ul).not.toBeNull();
  });
});

describe("round trip", () => {
  it("export → import keeps slide count and section vdids", () => {
    const exported = dcHtmlToSlidesChunks(DECK);
    // Simulate what Slides would hold after applying the chunks: one page
    // per createSlide with its objectId.
    const slides = exported.chunks.map((chunk) => {
      const create = (chunk.requests[0] as { createSlide: { objectId: string } }).createSlide;
      return { objectId: create.objectId, pageElements: [] };
    });
    const { output } = slidesToDcHtml({ presentationId: "p1", slides });
    expect(countSlides(output)).toBe(countSlides(DECK));
    const sectionIds = [...DECK.matchAll(/<section data-vdid="([0-9a-f_]+)"/g)].map((m) => m[1]);
    for (const id of sectionIds) {
      expect(output).toContain(`<section data-vdid="${id}"`);
    }
  });
});
