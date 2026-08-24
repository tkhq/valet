/**
 * Marp DeckSerializer (spec §Ports / DeckSerializer, v1 `marp`).
 *
 * Forward: Marp Markdown → .dc.html. `@marp-team/marp-core` renders the
 * deck; its per-slide `<section>` output maps 1:1 onto the .dc.html slide
 * structure, presenter-note comments become `<aside>` children, and the
 * theme CSS is inlined in `<style>`. `applyVdids` then addresses every
 * element.
 *
 * Reverse: .dc.html → Marp Markdown. Lossy by design — the artifact is
 * canonical, Markdown is a view. Unmapped elements are listed in the
 * conversion report, never silently dropped.
 */
import { Marp } from "@marp-team/marp-core";
import { parse, type HTMLElement } from "node-html-parser";
import { writeMetaBlock, DC_HTML_VERSION } from "./dc-html.js";
import { applyVdids } from "./vdid.js";

export interface MarpConversion {
  /** The converted document (dc.html for forward, markdown for reverse). */
  output: string;
  /** Human-readable conversion notes: unmapped features, dropped nodes. */
  report: string[];
}

/** Convert Marp Markdown to a .dc.html slides artifact. */
export function marpToDcHtml(markdown: string, opts: { createdBy?: string } = {}): MarpConversion {
  const marp = new Marp({ inlineSVG: false, html: true });
  const { html, css, comments } = marp.render(markdown);
  const report: string[] = [];

  const root = parse(html, { comment: true });
  const sections = root.querySelectorAll("section");
  if (sections.length === 0) {
    report.push("No slides found in the Markdown input; produced an empty deck.");
  }

  // Presenter notes: marp-core returns one string[] per slide.
  sections.forEach((section, i) => {
    const notes = (comments[i] ?? []).join("\n").trim();
    if (notes.length > 0) {
      const aside = parse(`<aside></aside>`).querySelector("aside");
      if (aside) {
        aside.set_content(escapeHtml(notes));
        section.appendChild(aside);
      }
    }
  });

  const body = sections.map((s) => s.toString()).join("\n");
  const doc = [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    '  <meta charset="utf-8">',
    `  <meta name="valet-design" content="v=${DC_HTML_VERSION}; template=slides">`,
    `  <style>\n${css}\n  </style>`,
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
  ].join("\n");

  const { html: addressed, report: vdidReport } = applyVdids(doc);
  if (vdidReport.collisions.length > 0) {
    report.push(`vdid collisions suffixed: ${vdidReport.collisions.join(", ")}`);
  }

  const withMeta = writeMetaBlock(addressed, {
    v: DC_HTML_VERSION,
    template: "slides",
    ...(opts.createdBy ? { created_by: opts.createdBy } : {}),
    import_reports: [{ type: "marp", report: report.join("\n") || "clean import" }],
  });

  return { output: withMeta, report };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function childMarkdown(el: HTMLElement, report: string[]): string {
  const parts: string[] = [];
  for (const child of el.childNodes) {
    // node-html-parser types childNodes as bare Node without a
    // discriminant; tagName is undefined on text nodes, which the checks
    // below rely on (bad third-party types).
    const node = child as HTMLElement;
    if (node.nodeType === 3) {
      parts.push(node.rawText);
      continue;
    }
    if (!node.tagName) continue;
    switch (node.tagName.toLowerCase()) {
      case "strong":
      case "b":
        parts.push(`**${node.text.trim()}**`);
        break;
      case "em":
      case "i":
        parts.push(`*${node.text.trim()}*`);
        break;
      case "code":
        parts.push(`\`${node.text}\``);
        break;
      case "a":
        parts.push(`[${node.text.trim()}](${node.getAttribute("href") ?? ""})`);
        break;
      case "br":
        parts.push("\n");
        break;
      default:
        parts.push(node.text);
    }
  }
  return parts.join("").trim();
}

function blockToMarkdown(el: HTMLElement, report: string[]): string | null {
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "h1":
      return `# ${childMarkdown(el, report)}`;
    case "h2":
      return `## ${childMarkdown(el, report)}`;
    case "h3":
      return `### ${childMarkdown(el, report)}`;
    case "h4":
      return `#### ${childMarkdown(el, report)}`;
    case "h5":
      return `##### ${childMarkdown(el, report)}`;
    case "h6":
      return `###### ${childMarkdown(el, report)}`;
    case "p":
      return childMarkdown(el, report);
    case "ul":
      return el
        .querySelectorAll(":scope > li")
        .map((li) => `- ${childMarkdown(li, report)}`)
        .join("\n");
    case "ol":
      return el
        .querySelectorAll(":scope > li")
        .map((li, i) => `${i + 1}. ${childMarkdown(li, report)}`)
        .join("\n");
    case "img":
      return `![${el.getAttribute("alt") ?? ""}](${el.getAttribute("src") ?? ""})`;
    case "pre":
      return `\`\`\`\n${el.text.replace(/\n$/, "")}\n\`\`\``;
    case "blockquote":
      return el.text
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "hr":
      return null; // Slide boundaries come from sections, not hr.
    case "table": {
      report.push("table flattened to text (Markdown tables not reconstructed)");
      return el.text.trim();
    }
    case "aside":
      return `<!--\n${el.text.trim()}\n-->`;
    case "figure": {
      const img = el.querySelector("img");
      return img ? blockToMarkdown(img, report) : null;
    }
    default:
      report.push(`unmapped <${tag}> flattened to text`);
      return el.text.trim() || null;
  }
}

/** Convert a .dc.html slides artifact back to Marp Markdown. */
export function dcHtmlToMarp(dcHtml: string): MarpConversion {
  const report: string[] = [];
  const root = parse(dcHtml, { comment: true });
  const sections = root.querySelectorAll("section");

  const slides = sections.map((section) => {
    const blocks: string[] = [];
    for (const child of section.childNodes) {
      // Same node-html-parser Node-union narrowing as childMarkdown above.
      const el = child as HTMLElement;
      if (!el.tagName) continue;
      const md = blockToMarkdown(el, report);
      if (md !== null && md.length > 0) blocks.push(md);
    }
    return blocks.join("\n\n");
  });

  const output = `---\nmarp: true\n---\n\n${slides.join("\n\n---\n\n")}\n`;
  return { output, report };
}
