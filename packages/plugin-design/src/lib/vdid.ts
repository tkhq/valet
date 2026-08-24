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
 * content, containers, and media — not inline runs or list items. `div`
 * is included because card/grid layouts are div-based and agents patch
 * them; identical sibling wrappers get deterministic collision suffixes. */
const ADDRESSABLE_TAGS = new Set([
  "section",
  "div",
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
  /** vdids newly stamped in this pass (elements that had none). */
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
 * Ensure every addressable element carries a `data-vdid`. An EXISTING id
 * is preserved verbatim — once assigned, an element keeps its id through
 * edits and format round trips, which is what keeps comment anchors alive
 * when text changes (Scenario C: an externally edited slide title keeps
 * the id its Slides objectId carried home). Only elements WITHOUT an id
 * get one, content-hashed from their stable attributes. Preserved ids
 * join the collision set so a new element can never mint a duplicate.
 */
export function applyVdids(html: string): { html: string; report: VdidReport } {
  const root = parse(html, { comment: true });
  const taken = new Set<string>();
  const report: VdidReport = { addressable: 0, collisions: [], regenerated: [] };

  const addressable: HTMLElement[] = [];
  for (const el of root.querySelectorAll("*")) {
    if (!ADDRESSABLE_TAGS.has(el.tagName.toLowerCase())) continue;
    addressable.push(el);
    const existing = el.getAttribute("data-vdid");
    if (existing) taken.add(existing);
  }
  report.addressable = addressable.length;

  for (const el of addressable) {
    if (el.getAttribute("data-vdid")) continue;
    const base = vdidFor(el);
    let vdid = base;
    for (let n = 1; taken.has(vdid); n++) {
      vdid = `${base}_${n}`;
    }
    if (vdid !== base) report.collisions.push(vdid);
    taken.add(vdid);
    el.setAttribute("data-vdid", vdid);
    report.regenerated.push(vdid);
  }

  return { html: root.toString(), report };
}

/** Find the element carrying `data-vdid` and return its outer HTML, or null. */
export function findByVdid(html: string, vdid: string): string | null {
  const root = parse(html);
  const el = root.querySelector(`[data-vdid="${vdid}"]`);
  return el ? el.toString() : null;
}
