/**
 * Element addressing (`data-vdid`) for .dc.html artifacts.
 *
 * A vdid is the first 16 hex chars of sha256 over the element's stable
 * attributes: tag name, aria role, and the first 32 bytes of its text.
 * Content-hashing (not positional numbering) is what lets a comment anchor
 * survive slide inserts, renumbering, and format round-trips: the element
 * keeps its id as long as its identity-bearing content is unchanged.
 *
 * Collisions (two elements with identical tag/role/text prefix) get a
 * `_1`, `_2`, ... suffix in document order, and every collision is listed
 * in the stability report so anchor drift is auditable.
 */
import { createHash } from "node:crypto";
import { parse, type HTMLElement } from "node-html-parser";

/** Tags that receive a `data-vdid`. Deliberately coarse: slides, block
 * content, and media — not inline runs or list items. */
const ADDRESSABLE_TAGS = new Set([
  "section",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "img",
  "ul",
  "ol",
  "table",
  "blockquote",
  "pre",
  "figure",
]);

export interface VdidReport {
  /** Total addressable elements found. */
  addressable: number;
  /** vdids that collided and were suffixed, in document order. */
  collisions: string[];
  /** vdids whose value changed from what the element previously carried. */
  regenerated: string[];
}

export function computeVdid(tag: string, role: string, text: string): string {
  const prefix = Buffer.from(text).subarray(0, 32).toString();
  const hash = createHash("sha256").update(`${tag}\n${role}\n${prefix}`).digest("hex");
  return hash.slice(0, 16);
}

function vdidFor(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role") ?? "";
  // For images the src is the identity-bearing content; text is empty.
  const text = tag === "img" ? (el.getAttribute("alt") ?? el.getAttribute("src") ?? "") : el.text.trim();
  return computeVdid(tag, role, text);
}

/**
 * Recompute `data-vdid` for every addressable element in the document.
 * Returns the rewritten HTML plus a stability report. Existing ids that
 * still match their content are untouched; changed content regenerates
 * the id (and the report records it).
 */
export function applyVdids(html: string): { html: string; report: VdidReport } {
  const root = parse(html, { comment: true });
  const seen = new Map<string, number>();
  const report: VdidReport = { addressable: 0, collisions: [], regenerated: [] };

  for (const el of root.querySelectorAll("*")) {
    if (!ADDRESSABLE_TAGS.has(el.tagName.toLowerCase())) continue;
    report.addressable += 1;

    const base = vdidFor(el);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const vdid = count === 0 ? base : `${base}_${count}`;
    if (count > 0) report.collisions.push(vdid);

    const previous = el.getAttribute("data-vdid");
    if (previous && previous !== vdid) report.regenerated.push(vdid);
    if (previous !== vdid) el.setAttribute("data-vdid", vdid);
  }

  return { html: root.toString(), report };
}

/** Find the element carrying `data-vdid` and return its outer HTML, or null. */
export function findByVdid(html: string, vdid: string): string | null {
  const root = parse(html);
  const el = root.querySelector(`[data-vdid="${vdid}"]`);
  return el ? el.toString() : null;
}
