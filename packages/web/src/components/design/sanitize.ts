/**
 * Artifact sanitization (Valet Design spec, Resolved Decision 1).
 *
 * The client renders `.dc.html` bytes directly — no iframe, no preview
 * server — so the sanitizer is the load-bearing control. DOMPurify, not a
 * hand-rolled whitelist: it is maintained against browser parser quirks
 * (mXSS) that a bespoke parser will miss. The app's own CSP is the
 * backstop; a per-shadow-root CSP is not enforceable.
 *
 * Two layers close the external-reference channel:
 *   1. Attributes: `ALLOWED_URI_REGEXP` (DESIGN_ALLOWED_URI) filters
 *      `href`/`src`/etc.
 *   2. CSS: DOMPurify does not inspect stylesheet text, so hooks run
 *      `sanitizeCssText` over every `<style>` element and every `style`
 *      attribute — stripping `@import` and neutralizing external `url()`
 *      targets. See `sanitizeCssText`.
 */
import DOMPurify from "dompurify";

/**
 * URI allowlist for `href`/`src` and CSS `url()`: `data:` URLs,
 * same-document fragments, and scheme-less relative paths. Everything
 * else — `javascript:`, `https://`, protocol-relative `//host` — is
 * stripped. The artifact is self-contained by format; an external
 * reference is either an exfil channel or a broken link, so neither
 * survives.
 */
export const DESIGN_ALLOWED_URI = /^(?:data:|#|(?!\/\/)(?![a-zA-Z][a-zA-Z0-9+.-]*:).*)/;

const FORBID_TAGS = ["script", "iframe", "object", "embed", "base", "form"];

/**
 * Check one CSS URL target against the allowlist. Beyond
 * DESIGN_ALLOWED_URI, reject any target that still contains a backslash
 * or a control character: after `decodeAlnumEscapes` those only remain
 * when an escape encodes a non-alphanumeric character — the smuggling
 * space for split schemes (`http\A s:`) — so when in doubt, strip.
 */
function cssUrlAllowed(raw: string): boolean {
  const url = raw.trim();
  if (url === "") return true;
  for (const ch of url) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\\" || code < 0x20 || code === 0x7f) return false;
  }
  return DESIGN_ALLOWED_URI.test(url);
}

/**
 * Decode CSS escapes that encode ASCII letters/digits (`\69` → `i`,
 * `\72 ` → `r`, `\i` → `i`). This is semantics-preserving CSS, and it
 * un-hides smuggled tokens (`u\72l(`, `@\69mport`) before the scans
 * below. Escapes for every other character (`\3c` = `<`, `\22` = `"`)
 * stay ENCODED on purpose: decoding them could change how the stylesheet
 * text serializes back into the document.
 */
function decodeAlnumEscapes(css: string): string {
  return css
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?/g, (match, hex: string) => {
      const cp = Number.parseInt(hex, 16);
      const alnum =
        (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
      return alnum ? String.fromCharCode(cp) : match;
    })
    // Identifier escapes: `\` + a NON-hex letter is that letter (`\r` → r).
    // `\` + a hex digit (a-f, A-F, 0-9) is always a hex escape — handled
    // above, and deliberately left encoded when it maps outside [0-9a-z].
    .replace(/\\([g-zG-Z])/g, "$1");
}

/**
 * `url(...)` / `src(...)` function tokens: quoted or bare target, with
 * tolerance for an unterminated token at end of text (a truncation trick
 * must not skip the scan). `src()` is the CSS Fonts 4 alias of `url()`.
 */
const CSS_URL_FN =
  /\b(?:url|src)\(\s*(?:"((?:\\[\s\S]|[^"\\])*)(?:"|$)|'((?:\\[\s\S]|[^'\\])*)(?:'|$)|([^)'"]*))\s*(?:\)|$)/gi;

/** CSS string literal (double- or single-quoted, escape-aware). */
const CSS_STRING = /"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'/g;

/**
 * Neutralize bare string arguments inside `image-set(...)` — the one
 * remaining CSS context where a plain string loads like `url()`. Nested
 * `url()` calls were already handled by the CSS_URL_FN pass. The span is
 * found with a paren-depth scan because image-set nests functions.
 */
function sanitizeImageSetStrings(css: string): string {
  const open = /\b(?:-webkit-)?image-set\(/gi;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = open.exec(css))) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < css.length && depth > 0) {
      const c = css[i];
      if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      i += 1;
    }
    const innerEnd = depth === 0 ? i - 1 : i;
    const cleaned = css
      .slice(start, innerEnd)
      .replace(CSS_STRING, (str, dq: string | undefined, sq: string | undefined) =>
        cssUrlAllowed(dq ?? sq ?? "") ? str : '""',
      );
    out += css.slice(last, start) + cleaned + (depth === 0 ? ")" : "");
    last = i;
    open.lastIndex = i;
  }
  return out + css.slice(last);
}

/**
 * Sanitize CSS text — the pass DOMPurify does not do. Applied to every
 * `<style>` element and every `style` attribute (see the hooks in
 * `getPurifier`). In order:
 *
 *   1. Remove comments. In CSS a comment is token-separating whitespace,
 *      so replacing it with a space is semantics-preserving, and it stops
 *      comment-split tricks from hiding an at-rule or a url target.
 *   2. Decode alphanumeric escapes (see `decodeAlnumEscapes`), so
 *      `@\69mport` and `u\72l(` cannot dodge the scans.
 *   3. Strip every `@import` rule outright (through its semicolon).
 *      `@import` loads external stylesheets AND plain-string form needs
 *      no `url()` token, so the rule goes as a whole.
 *   4. Check every `url()`/`src()` target against `cssUrlAllowed`
 *      (data:, #fragment, scheme-less relative). A failing or suspicious
 *      target becomes `url("")` — a guaranteed no-op load.
 *   5. Apply the same allowlist to bare strings inside `image-set()`.
 *
 * This kills `@import url(https://evil)`, external `@font-face` sources,
 * and `background: url(https://tracker/x)` — the exfiltration/tracking
 * channels — and with them the hung external font that would stall
 * `document.fonts.ready`.
 */
export function sanitizeCssText(css: string): string {
  let out = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  out = decodeAlnumEscapes(out);
  // No block form of @import exists; strip through the terminating
  // semicolon, or to end of text when the rule is left unterminated.
  out = out.replace(/@import\b[^;{]*(?:;|(?=\{)|$)/gi, "");
  out = out.replace(
    CSS_URL_FN,
    (match, dq: string | undefined, sq: string | undefined, bare: string | undefined) =>
      cssUrlAllowed(dq ?? sq ?? bare ?? "") ? match : 'url("")',
  );
  return sanitizeImageSetStrings(out);
}

type Purifier = ReturnType<typeof DOMPurify>;

let purifier: Purifier | null = null;

/**
 * Dedicated DOMPurify instance with the CSS hooks attached. Instance-
 * scoped (not the shared default) so the hooks cannot leak into any other
 * DOMPurify caller; lazy so importing this module in a windowless (node)
 * environment stays safe.
 */
function getPurifier(): Purifier {
  if (purifier) return purifier;
  const p = DOMPurify(window);
  p.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style") {
      node.textContent = sanitizeCssText(node.textContent ?? "");
    }
  });
  p.addHook("afterSanitizeAttributes", (node) => {
    const style = node.getAttribute("style");
    if (style !== null) node.setAttribute("style", sanitizeCssText(style));
  });
  purifier = p;
  return p;
}

/**
 * Sanitize a full `.dc.html` document to a safe HTML string.
 *
 * `WHOLE_DOCUMENT` keeps the `<head>`'s `<style>` blocks (the artifact's
 * own styling) in the output; the renderer's `shadowRoot.innerHTML`
 * assignment then flattens the html/head/body wrappers via fragment
 * parsing while keeping styles and body content in order. `data-vdid`
 * attributes survive because DOMPurify allows `data-*` by default
 * (`ALLOW_DATA_ATTR: true`); `on*` event handlers are stripped by default.
 * The hooks in `getPurifier` run `sanitizeCssText` over style elements
 * and style attributes before DOMPurify serializes.
 */
function sanitizeDesignHtmlUncached(content: string): string {
  return getPurifier().sanitize(content, {
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

/**
 * Memoized sanitize: the canvas plus every slide thumbnail sanitize the
 * SAME document per revision (N+1 DOMPurify passes). Keyed by string
 * identity with a small LRU — one artifact per canvas, a few revisions in
 * flight at most.
 */
const sanitizeCache = new Map<string, string>();
export function sanitizeDesignHtml(html: string): string {
  const hit = sanitizeCache.get(html);
  if (hit !== undefined) return hit;
  const out = sanitizeDesignHtmlUncached(html);
  sanitizeCache.set(html, out);
  if (sanitizeCache.size > 4) {
    const oldest = sanitizeCache.keys().next().value;
    if (oldest !== undefined) sanitizeCache.delete(oldest);
  }
  return out;
}
