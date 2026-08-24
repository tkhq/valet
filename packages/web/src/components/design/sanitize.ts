/**
 * Artifact sanitization (Valet Design spec, Resolved Decision 1).
 *
 * The client renders `.dc.html` bytes directly — no iframe, no preview
 * server — so the sanitizer is the load-bearing control. DOMPurify, not a
 * hand-rolled whitelist: it is maintained against browser parser quirks
 * (mXSS) that a bespoke parser will miss. The app's own CSP is the
 * backstop; a per-shadow-root CSP is not enforceable.
 */
import DOMPurify from "dompurify";

/**
 * URI allowlist for `href`/`src`: `data:` URLs, same-document fragments,
 * and scheme-less relative paths. Everything else — `javascript:`,
 * `https://`, protocol-relative `//host` — is stripped. The artifact is
 * self-contained by format; an external reference is either an exfil
 * channel or a broken link, so neither survives.
 */
export const DESIGN_ALLOWED_URI = /^(?:data:|#|(?!\/\/)(?![a-zA-Z][a-zA-Z0-9+.-]*:).*)/;

const FORBID_TAGS = ["script", "iframe", "object", "embed", "base", "form"];

/**
 * Sanitize a full `.dc.html` document to a safe HTML string.
 *
 * `WHOLE_DOCUMENT` keeps the `<head>`'s `<style>` blocks (the artifact's
 * own styling) in the output; the renderer's `shadowRoot.innerHTML`
 * assignment then flattens the html/head/body wrappers via fragment
 * parsing while keeping styles and body content in order. `data-vdid`
 * attributes survive because DOMPurify allows `data-*` by default
 * (`ALLOW_DATA_ATTR: true`); `on*` event handlers are stripped by default.
 */
export function sanitizeDesignHtml(content: string): string {
  return DOMPurify.sanitize(content, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS,
    ALLOWED_URI_REGEXP: DESIGN_ALLOWED_URI,
  });
}

/**
 * Read the format version from the artifact's meta tag:
 * `<meta name="valet-design" content="v=1; template=slides">`.
 * The renderer refuses unknown `v=` values (spec Decision 2). A missing
 * meta tag is tolerated — the server validated the document on write.
 */
export function checkDesignVersion(
  content: string,
): { ok: true } | { ok: false; version: string } {
  const meta = content.match(
    /<meta\s+name=["']valet-design["']\s+content=["']([^"']*)["']/i,
  );
  if (!meta) return { ok: true };
  const v = meta[1].match(/(?:^|;)\s*v=([^;\s]+)/);
  if (!v) return { ok: true };
  return v[1] === "1" ? { ok: true } : { ok: false, version: v[1] };
}

/** One slide of a `template=slides` artifact, parsed from the sanitized
 * document: `<section>` per slide, first heading as its label, `<aside>`
 * as speaker notes (spec §"Slides as Sections"). */
export interface SlideInfo {
  index: number;
  vdid: string | null;
  heading: string;
  notes: string;
}

/**
 * Extract the slide list from SANITIZED html. Only top-level `<section>`
 * elements count as slides; nested sections are slide content.
 */
export function parseSlides(sanitizedHtml: string): SlideInfo[] {
  const doc = new DOMParser().parseFromString(sanitizedHtml, "text/html");
  // Outermost sections at any depth (agents often add a wrapper div);
  // keep in lockstep with the renderer's topLevelSections.
  const sections = Array.from(doc.querySelectorAll("section")).filter(
    (el) => !el.parentElement?.closest("section"),
  );
  return sections.map((section, index) => {
    const headingEl = section.querySelector("h1, h2, h3, h4, h5, h6");
    const aside = section.querySelector("aside");
    return {
      index,
      vdid: section.getAttribute("data-vdid"),
      // data-label wins (the Claude Design attribute); first heading is
      // the fallback for decks that don't set it.
      heading:
        section.getAttribute("data-label")?.trim() ||
        headingEl?.textContent?.trim() ||
        `Slide ${index + 1}`,
      // data-speaker-notes wins over an <aside> child.
      notes:
        section.getAttribute("data-speaker-notes")?.trim() ||
        (aside?.textContent?.trim() ?? ""),
    };
  });
}
