/**
 * Google Slides DeckSerializer (spec §Ports / DeckSerializer, v1
 * `gslides`; mapping table in Appendix A). The `.dc.html` is canonical;
 * Slides is a lossy view, and every drop lands in the conversion report,
 * never silently.
 *
 * vdid ↔ objectId: an exported element's Slides objectId is `vd_<vdid>`
 * (Slides objectIds allow [a-zA-Z0-9_-], 5–50 chars — a 16-hex vdid with
 * the prefix fits). Import recovers `data-vdid` by stripping the prefix,
 * so comment anchors survive the round trip (spec §Google Slides
 * Integration, "Mapping").
 *
 * The serializer is transport-free: it produces/consumes plain request
 * and presentation shapes. `plugin-google-workspace`'s slides-transport
 * owns the HTTP.
 */
import { parse, type HTMLElement } from "node-html-parser";
import { DC_HTML_VERSION, writeMetaBlock } from "./dc-html.js";
import { applyVdids } from "./vdid.js";

// Slide geometry (EMU). Standard 16:9 deck: 10" x 5.63".
const SLIDE_W = 9144000;
const SLIDE_H = 5143500;
const MARGIN = 457200; // 0.5"
const TITLE_H = 914400; // 1"
const BODY_TOP = MARGIN + TITLE_H + 152400;

export interface SlidesRequestChunk {
  requests: unknown[];
}

export interface GslidesExport {
  title: string;
  chunks: SlidesRequestChunk[];
  report: string[];
}

interface MinimalTextElement {
  textRun?: { content?: string };
  paragraphMarker?: { bullet?: unknown };
}

export interface MinimalPageElement {
  objectId: string;
  shape?: {
    placeholder?: { type?: string };
    text?: { textElements?: MinimalTextElement[] };
  };
  image?: { contentUrl?: string; sourceUrl?: string };
}

export interface MinimalPage {
  objectId: string;
  pageElements?: MinimalPageElement[];
  slideProperties?: { notesPage?: { pageElements?: MinimalPageElement[] } };
}

export interface MinimalPresentation {
  presentationId: string;
  title?: string;
  revisionId?: string;
  slides?: MinimalPage[];
}

function slideObjectId(vdid: string): string {
  return `vd_${vdid}`;
}

function vdidFromObjectId(objectId: string): string | null {
  return objectId.startsWith("vd_") ? objectId.slice(3) : null;
}

function textBoxRequests(
  objectId: string,
  slideId: string,
  text: string,
  opts: { top: number; height: number; fontSize?: number; bold?: boolean; bullets?: boolean },
): unknown[] {
  if (!text.trim()) return [];
  const requests: unknown[] = [
    {
      createShape: {
        objectId,
        shapeType: "TEXT_BOX",
        elementProperties: {
          pageObjectId: slideId,
          size: {
            width: { magnitude: SLIDE_W - 2 * MARGIN, unit: "EMU" },
            height: { magnitude: opts.height, unit: "EMU" },
          },
          transform: { scaleX: 1, scaleY: 1, translateX: MARGIN, translateY: opts.top, unit: "EMU" },
        },
      },
    },
    { insertText: { objectId, text } },
  ];
  if (opts.fontSize || opts.bold) {
    requests.push({
      updateTextStyle: {
        objectId,
        textRange: { type: "ALL" },
        style: {
          ...(opts.fontSize ? { fontSize: { magnitude: opts.fontSize, unit: "PT" } } : {}),
          ...(opts.bold ? { bold: true } : {}),
        },
        fields: [opts.fontSize ? "fontSize" : "", opts.bold ? "bold" : ""].filter(Boolean).join(","),
      },
    });
  }
  if (opts.bullets) {
    requests.push({
      createParagraphBullets: {
        objectId,
        textRange: { type: "ALL" },
        bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
      },
    });
  }
  return requests;
}

/**
 * Transpile a .dc.html deck into per-slide request chunks (Appendix A MUST
 * rows: headings, paragraphs, lists, images with fetchable URLs, speaker
 * notes are reported — the notes page id is unknown before creation).
 */
export function dcHtmlToSlidesChunks(dcHtml: string, fallbackTitle = "Valet Design export"): GslidesExport {
  const report: string[] = [];
  const root = parse(dcHtml, { comment: true });
  const title = root.querySelector("h1")?.text.trim() || fallbackTitle;
  const sections = root.querySelectorAll("section");
  if (sections.length === 0) {
    report.push("document has no <section> slides; exported the whole body as one slide");
  }
  const slides = sections.length > 0 ? sections : [root.querySelector("body") ?? root];

  const chunks: SlidesRequestChunk[] = slides.map((section, index) => {
    const sectionVdid = section.getAttribute?.("data-vdid") ?? `slide${index}`;
    const slideId = slideObjectId(sectionVdid);
    const requests: unknown[] = [
      {
        createSlide: {
          objectId: slideId,
          insertionIndex: index,
          slideLayoutReference: { predefinedLayout: "BLANK" },
        },
      },
    ];

    let cursor = MARGIN;
    let bodyLines: string[] = [];
    let bodyCounter = 0;

    const flushBody = (bullets: boolean) => {
      if (bodyLines.length === 0) return;
      const id = `${slideId}_b${bodyCounter++}`;
      // Clamp: a content-dense slide can push the cursor past the slide
      // bottom, and `SLIDE_H - cursor - MARGIN` then goes negative — an
      // invalid createShape size the Slides API rejects. Off-slide overflow
      // (positive height below the bottom edge) is legal, so clamp to a
      // minimum box instead of failing the chunk.
      const height = Math.max(
        Math.min(SLIDE_H - cursor - MARGIN, 500000 * bodyLines.length + 200000),
        300000,
      );
      requests.push(
        ...textBoxRequests(id, slideId, bodyLines.join("\n"), {
          top: cursor,
          height,
          fontSize: 14,
          bullets,
        }),
      );
      cursor += height + 100000;
      bodyLines = [];
    };

    for (const child of section.childNodes) {
      // node-html-parser Node-union narrowing: tagName is undefined on
      // text nodes (bad third-party types).
      const el = child as HTMLElement;
      if (!el.tagName) continue;
      const tag = el.tagName.toLowerCase();
      const vdid = el.getAttribute("data-vdid") ?? `${sectionVdid}_${bodyCounter}`;
      switch (tag) {
        case "h1":
        case "h2":
        case "h3": {
          flushBody(false);
          requests.push(
            ...textBoxRequests(slideObjectId(vdid), slideId, el.text.trim(), {
              top: cursor,
              height: TITLE_H,
              fontSize: tag === "h1" ? 28 : tag === "h2" ? 22 : 18,
              bold: true,
            }),
          );
          cursor = Math.max(cursor + TITLE_H + 100000, BODY_TOP);
          break;
        }
        case "p":
        case "blockquote":
        case "pre":
          bodyLines.push(el.text.trim());
          break;
        case "ul":
        case "ol": {
          flushBody(false);
          const items = el.querySelectorAll(":scope > li").map((li) => li.text.trim());
          bodyLines = items;
          flushBody(true);
          break;
        }
        case "img": {
          const src = el.getAttribute("src") ?? "";
          if (/^https?:\/\//.test(src)) {
            requests.push({
              createImage: {
                objectId: slideObjectId(vdid),
                url: src,
                elementProperties: {
                  pageObjectId: slideId,
                  size: {
                    width: { magnitude: SLIDE_W / 2, unit: "EMU" },
                    height: { magnitude: SLIDE_H / 2, unit: "EMU" },
                  },
                  transform: {
                    scaleX: 1,
                    scaleY: 1,
                    translateX: SLIDE_W / 4,
                    translateY: cursor,
                    unit: "EMU",
                  },
                },
              },
            });
          } else {
            report.push(
              `slide ${index + 1}: image with ${src.startsWith("data:") ? "embedded data:" : "non-http"} source not exported (Slides createImage needs a fetchable URL)`,
            );
          }
          break;
        }
        case "aside":
          report.push(`slide ${index + 1}: speaker notes not exported (notes page id unknown at create time)`);
          break;
        case "table":
          report.push(`slide ${index + 1}: <table> flattened to text`);
          bodyLines.push(el.text.trim());
          break;
        case "hr":
          break;
        default:
          report.push(`slide ${index + 1}: unmapped <${tag}> flattened to text`);
          bodyLines.push(el.text.trim());
      }
    }
    flushBody(false);
    return { requests };
  });

  return { title, chunks, report };
}

export interface GslidesImport {
  output: string;
  report: string[];
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function pageElementToHtml(el: MinimalPageElement, report: string[]): string | null {
  if (el.image) {
    const src = el.image.sourceUrl ?? el.image.contentUrl;
    if (!src) return null;
    // The canvas renderer blocks external URLs (sanitizer ruling, spec
    // Decision 1), so a Google-hosted image will not render in the canvas —
    // say so in the report instead of dropping it silently. The URL stays
    // in the artifact: a later export to Slides can still use it.
    report.push(
      `image ${el.objectId} kept as an external URL; it will not render in the canvas (external URLs are blocked) but survives re-export`,
    );
    return `<img src="${escapeAttr(src)}" alt="">`;
  }
  const textElements = el.shape?.text?.textElements ?? [];
  if (textElements.length === 0) {
    if (el.shape) report.push(`shape ${el.objectId} without text dropped`);
    return null;
  }
  const vdid = vdidFromObjectId(el.objectId);
  const vdidAttr = vdid ? ` data-vdid="${vdid}"` : "";
  const bulleted = textElements.some((t) => t.paragraphMarker?.bullet !== undefined);
  const text = textElements
    .map((t) => t.textRun?.content ?? "")
    .join("")
    .replace(/\n$/, "");
  if (!text.trim()) return null;
  if (bulleted) {
    const items = text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => `<li>${escapeHtml(line.trim())}</li>`)
      .join("");
    return `<ul${vdidAttr}>${items}</ul>`;
  }
  const isTitle = el.shape?.placeholder?.type === "TITLE" || el.shape?.placeholder?.type === "CENTERED_TITLE";
  const tag = isTitle ? "h2" : "p";
  return `<${tag}${vdidAttr}>${escapeHtml(text)}</${tag}>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Transpile a fetched presentation into a .dc.html slides artifact. */
export function slidesToDcHtml(presentation: MinimalPresentation): GslidesImport {
  const report: string[] = [];
  const sections = (presentation.slides ?? []).map((slide) => {
    const vdid = vdidFromObjectId(slide.objectId);
    const vdidAttr = vdid ? ` data-vdid="${vdid}"` : "";
    const body = (slide.pageElements ?? [])
      .map((el) => pageElementToHtml(el, report))
      .filter((html): html is string => html !== null)
      .join("\n    ");
    const notes = (slide.slideProperties?.notesPage?.pageElements ?? [])
      .flatMap((el) => el.shape?.text?.textElements ?? [])
      .map((t) => t.textRun?.content ?? "")
      .join("")
      .trim();
    const aside = notes ? `\n    <aside>${escapeHtml(notes)}</aside>` : "";
    return `  <section${vdidAttr}>\n    ${body}${aside}\n  </section>`;
  });

  const doc = [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    '  <meta charset="utf-8">',
    `  <meta name="valet-design" content="v=${DC_HTML_VERSION}; template=slides">`,
    "  <style>",
    "    body { margin: 0; font-family: system-ui, sans-serif; }",
    "    section { box-sizing: border-box; width: 100%; aspect-ratio: 16 / 9; padding: 4rem 5rem; border-bottom: 1px solid #e5e5ef; }",
    "    section aside { display: none; }",
    "  </style>",
    "</head>",
    "<body>",
    sections.join("\n"),
    "</body>",
    "</html>",
  ].join("\n");

  // applyVdids fills ids for elements the import couldn't recover (no
  // vd_ objectId); recovered ids are content-hash-stable so they persist.
  const { html } = applyVdids(doc);
  const withMeta = writeMetaBlock(html, {
    v: DC_HTML_VERSION,
    template: "slides",
    import_reports: [
      {
        type: "gslides",
        report: report.length > 0 ? report.join("\n") : "clean import",
      },
    ],
  });
  return { output: withMeta, report };
}
