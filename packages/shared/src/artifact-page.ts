/**
 * The artifact page primitive (2026-09-02 artifact-pages design).
 *
 * One published artifact is content plus a format. `markdown` renders through
 * the app's own `Markdown` component, in the app's document. `html` is a
 * self-contained document that Valet wraps in the shell built here and renders
 * inside a sandboxed frame.
 *
 * This module lives in `@valet/shared` because both halves need the same
 * strings: the api validates and downloads through them, the web client renders
 * through them. A second copy of the CSP is a copy that drifts. Keep it
 * dependency-free and browser-safe — the web bundle imports it.
 */

/** How a viewer must render an artifact's stored bytes. */
export type ArtifactFormat = "markdown" | "html";

export const ARTIFACT_FORMATS: readonly ArtifactFormat[] = ["markdown", "html"];

export function isArtifactFormat(value: unknown): value is ArtifactFormat {
  return value === "markdown" || value === "html";
}

/**
 * Cap on one artifact's stored content, matching `design_edit`'s existing
 * limit. Content lives in a Postgres `text` column, not a blob store, so this
 * is a real bound and not a formality. Embedded raster images are the only
 * realistic way to approach it.
 */
export const ARTIFACT_MAX_CONTENT_BYTES = 2 * 1024 * 1024;

/**
 * The Content Security Policy every published `html` artifact runs under,
 * emitted as a `<meta http-equiv>` tag in the shell.
 *
 * `connect-src 'none'` is the load-bearing directive. A published page has no
 * backend, so denying fetch/XHR/WebSocket outright removes the exfiltration
 * channel a sanitizer cannot see: a page that reads its own DOM still cannot
 * send what it read anywhere.
 *
 * `'unsafe-inline'` and `'unsafe-eval'` are deliberate. The whole document is
 * attacker-authored in the threat model, so a nonce protects nothing — the
 * containment boundary is the frame's opaque origin (no `allow-same-origin`),
 * not this directive. Charting libraries commonly compile expressions, hence
 * `'unsafe-eval'`.
 *
 * The two script hosts are the CDNs the agent is told it may use for a library
 * it cannot inline. A deployment that blocks them should reject fast: unlike a
 * blocked font, a blocked library has no fallback and a slow drop just hangs
 * the page.
 */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com data:",
  "img-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
].join("; ");

/**
 * The frame sandbox for a published `html` artifact.
 *
 * `allow-same-origin` is absent, and that omission is the security argument:
 * without it the frame runs in an opaque origin, so it cannot read the app's
 * cookies or storage, cannot reach `window.parent`'s DOM, and sends no
 * credentials. `allow-top-navigation` is absent too, so the page cannot
 * navigate the tab out from under the reader.
 */
export const ARTIFACT_FRAME_SANDBOX =
  "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals";

/** Byte length of a string as UTF-8, without pulling in Node's Buffer. */
export function artifactContentBytes(content: string): number {
  return new TextEncoder().encode(content).length;
}

/**
 * The publish-time size check. Returns the message to show the caller, or
 * `null` when the content fits. The message names the corrective action,
 * because the caller can act on it.
 */
export function artifactSizeError(content: string): string | null {
  const bytes = artifactContentBytes(content);
  if (bytes <= ARTIFACT_MAX_CONTENT_BYTES) return null;
  const mib = (bytes / (1024 * 1024)).toFixed(1);
  return `This artifact is ${mib} MiB, over the ${ARTIFACT_MAX_CONTENT_BYTES / (1024 * 1024)} MiB limit. Embed fewer raster images, or draw diagrams as inline SVG instead.`;
}

/** How much of an HTML document is scanned for a `<title>`. */
const TITLE_SCAN_BYTES = 8 * 1024;

/**
 * The `<title>` of an HTML document, scanning only the head-sized prefix. A
 * document whose title sits past 8 KiB has it buried in the body, where it is
 * not a title.
 */
export function extractHtmlTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html.slice(0, TITLE_SCAN_BYTES));
  if (!match?.[1]) return undefined;
  const text = decodeBasicEntities(match[1]).replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : undefined;
}

/** The first ATX heading in a markdown document. */
export function extractMarkdownTitle(markdown: string): string | undefined {
  for (const line of markdown.split("\n", 200)) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

/** The five entities a title realistically carries. Not a general decoder —
 * the result is escaped again before it reaches any document. */
function decodeBasicEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Title resolution for a publish, in precedence order: what the caller asked
 * for, what the document declares, then the publish key's basename. Never
 * empty — an untitled page is unfindable in a list.
 */
export function resolveArtifactTitle(opts: {
  explicit?: string;
  content: string;
  format: ArtifactFormat;
  key: string;
}): string {
  const explicit = opts.explicit?.trim();
  if (explicit) return explicit;
  const fromContent =
    opts.format === "html" ? extractHtmlTitle(opts.content) : extractMarkdownTitle(opts.content);
  if (fromContent) return fromContent;
  const basename = opts.key.split("/").pop()?.replace(/\.[^.]+$/, "").trim();
  return basename && basename.length > 0 ? basename : "Untitled";
}

/**
 * At most two emoji, for the browser-tab icon. Anything else — markup, an
 * ASCII label, a third glyph — is dropped rather than rejected: an icon is
 * decoration, and failing a publish over it would be worse than showing none.
 */
export function normalizeArtifactIcon(raw: string | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 32) return "";
  if (/[<>&"'\\]/.test(trimmed)) return "";
  const glyphs = [...segmentGraphemes(trimmed)];
  if (glyphs.length === 0 || glyphs.length > 2) return "";
  // Every glyph must carry a pictographic codepoint. A bare letter or digit
  // renders as an unreadable smudge at favicon size.
  if (!glyphs.every((g) => /\p{Extended_Pictographic}/u.test(g))) return "";
  return glyphs.join("");
}

/** Grapheme clusters, so a flag or a ZWJ family counts as one icon. Falls back
 * to codepoints where `Intl.Segmenter` is unavailable at runtime (typed since
 * ES2022, but older browsers still lack it). */
function segmentGraphemes(text: string): Iterable<string> {
  if (typeof Intl.Segmenter !== "function") return [...text];
  const iterator = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text);
  return [...iterator].map((s) => s.segment);
}

/** HTML-escape for text that lands in an attribute or an element body. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** An emoji favicon as an inline SVG data URI, or `undefined` for no icon. */
export function artifactFaviconDataUri(icon: string): string | undefined {
  const normalized = normalizeArtifactIcon(icon);
  if (!normalized) return undefined;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text y="52" font-size="52">${escapeHtml(normalized)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export interface ArtifactDocumentInput {
  title: string;
  /** The self-contained HTML the agent published. Inserted verbatim. */
  content: string;
  description?: string;
  /** One or two emoji; anything else is dropped. */
  icon?: string;
  /**
   * Include the comment runtime (element addressing + pick/rect postMessage
   * bridge). The viewer passes true; a standalone download passes false so a
   * saved file carries no dead bridge code.
   */
  runtime?: boolean;
  /**
   * The viewer's explicit theme choice. Omit for the system default: the
   * root stays unstamped and the prefers-color-scheme media query governs.
   */
  theme?: "light" | "dark";
}

/**
 * Wrap a published `html` artifact in the document shell: the CSP, the tab
 * title and icon, a responsive viewport, and light/dark base tokens.
 *
 * The content is inserted verbatim. This function is not a sanitizer and must
 * not be mistaken for one — the containment boundary is the frame's opaque
 * origin plus this CSP, both of which live outside the bytes.
 *
 * Valet's head is ALWAYS the physically first markup, and the artifact's
 * bytes follow it whole — even when they are a full document of their own.
 * Never search the artifact for a `<head>` to splice into: any locator
 * (regex or otherwise) can be decoyed by a `<head>` inside a comment,
 * script, or attribute, landing the CSP in dead text while the real head
 * parses without it. Emitting the policy before any artifact-controlled
 * byte is the only ordering an attacker cannot influence, and a CSP meta
 * governs everything parsed after it. The parser tolerates the artifact's
 * stray doctype/html/head/body tokens: its meta/style/title still apply
 * (later styles win the cascade), only its `<title>` loses to ours — which
 * `resolveArtifactTitle` usually derived from it anyway.
 */
export function buildArtifactDocument(input: ArtifactDocumentInput): string {
  const head = buildHead(input);
  const themeAttr = input.theme ? ` data-theme="${input.theme}"` : "";
  return `<!doctype html>
<html lang="en"${themeAttr}>
<head>
${head}
</head>
${input.content}
</html>`;
}

/** The head Valet always contributes: policy, metadata, and the base sheet. */
function buildHead(input: ArtifactDocumentInput): string {
  const favicon = artifactFaviconDataUri(input.icon ?? "");
  const description = input.description?.trim();
  return [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(ARTIFACT_CSP)}">`,
    `<meta name="robots" content="noindex">`,
    `<title>${escapeHtml(input.title)}</title>`,
    description ? `<meta name="description" content="${escapeHtml(description)}">` : undefined,
    favicon ? `<link rel="icon" href="${favicon}">` : undefined,
    `<style>${ARTIFACT_BASE_CSS}</style>`,
    input.runtime ? `<script>${ARTIFACT_RUNTIME_JS}</script>` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/**
 * The dark token set, extracted once so the media-query block and the
 * explicit `data-theme="dark"` block cannot drift apart.
 */
const ARTIFACT_DARK_TOKENS = `color-scheme: dark;
  --artifact-bg: #14161a;
  --artifact-fg: #e8eaee;
  --artifact-muted: #98a0ad;
  --artifact-line: #2a2e36;
  --artifact-accent: #7fb28f;`;

/**
 * The base sheet. Deliberately small: it sets the ground the page sits on and
 * gets out of the way.
 *
 * Three viewer states share these tokens: system default (bare `:root` plus
 * the media query), explicit light (`data-theme="light"`, which only needs to
 * block the media query since the bare `:root` values are already light), and
 * explicit dark (`data-theme="dark"`, redefined outside the media query so it
 * applies regardless of the OS preference). Light values live on bare
 * `:root` so no color's only definition sits behind a media or attribute
 * block. `body` paints an explicit background: a transparent body borrows
 * the host's, which reads as broken in the opposite theme.
 */
const ARTIFACT_BASE_CSS = `
:root {
  color-scheme: light dark;
  --artifact-bg: #ffffff;
  --artifact-fg: #16181d;
  --artifact-muted: #5b6270;
  --artifact-line: #e3e5ea;
  --artifact-accent: #3d6b4f;
}
:root[data-theme="light"] { color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { ${ARTIFACT_DARK_TOKENS} }
}
:root[data-theme="dark"] { ${ARTIFACT_DARK_TOKENS} }
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--artifact-bg);
  color: var(--artifact-fg);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  line-height: 1.6;
  -webkit-text-size-adjust: 100%;
}
img, svg, video, canvas, iframe { max-width: 100%; height: auto; }
table { border-collapse: collapse; }
pre { overflow-x: auto; }
a { color: var(--artifact-accent); }
/* Typography for compiled-markdown pages. An html artifact that styles these
 * elements itself simply overrides this sheet — its styles come later. */
.valet-artifact-doc {
  max-width: 72ch;
  margin: 0 auto;
  padding: 3rem 1.5rem 5rem;
}
.valet-artifact-doc h1, .valet-artifact-doc h2, .valet-artifact-doc h3 {
  line-height: 1.25;
  margin: 1.6em 0 0.6em;
}
.valet-artifact-doc h1:first-child { margin-top: 0; }
.valet-artifact-doc code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
  background: color-mix(in srgb, var(--artifact-fg) 7%, transparent);
  border-radius: 4px;
  padding: 0.1em 0.35em;
}
.valet-artifact-doc pre {
  background: color-mix(in srgb, var(--artifact-fg) 6%, transparent);
  border: 1px solid var(--artifact-line);
  border-radius: 8px;
  padding: 0.9rem 1rem;
}
.valet-artifact-doc pre code { background: none; padding: 0; }
.valet-artifact-doc th, .valet-artifact-doc td {
  border: 1px solid var(--artifact-line);
  padding: 0.4rem 0.7rem;
  text-align: left;
}
.valet-artifact-doc blockquote {
  border-left: 3px solid var(--artifact-line);
  margin: 1em 0;
  padding: 0.1em 1em;
  color: var(--artifact-muted);
}
.valet-artifact-doc hr { border: 0; border-top: 1px solid var(--artifact-line); }
`.trim();

// ─── Comment runtime ─────────────────────────────────────────────────────

/**
 * Messages the frame posts to the parent. The parent must accept them only
 * from the frame's own `contentWindow` and validate every field — a hostile
 * page can fabricate all of these, which is why none carries authority: the
 * worst spoof is a mispositioned pin on the spoofing page's own render.
 */
export type ArtifactFrameMessage =
  | { type: "valet-artifact:ready" }
  | { type: "valet-artifact:pick"; vdid: string; rect: ArtifactAnchorRect; label: string }
  | { type: "valet-artifact:rects"; rects: Record<string, ArtifactAnchorRect> };

/** Messages the parent posts into the frame. */
export type ArtifactParentMessage =
  | { type: "valet-artifact:mode"; picking: boolean }
  | { type: "valet-artifact:anchors"; vdids: string[] }
  | { type: "valet-artifact:theme"; theme: "light" | "dark" | null };

export interface ArtifactAnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * The comment runtime, injected by the shell as an inline script. It is
 * Valet-authored code running INSIDE the untrusted document — a convenience,
 * never a boundary. It:
 *
 * 1. Assigns a deterministic `data-vdid` to every addressable element that
 *    lacks one (published design revisions arrive with theirs and keep them),
 *    hashing tag + role + leading text + occurrence, so every viewer of the
 *    same rendered bytes computes identical ids and comment anchors survive a
 *    republish of unchanged elements.
 * 2. In pick mode, outlines the hovered element and reports a click as a
 *    `pick` with the element's vdid, rect, and text label.
 * 3. Tracks the anchors the parent asks about and reports their rects on
 *    scroll and resize, so pins in app chrome follow the page.
 *
 * Kept dependency-free ES5-ish so it needs no build step; it ships as this
 * source string.
 */
export const ARTIFACT_RUNTIME_JS = `
(function () {
  "use strict";
  var SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,table,pre,blockquote,figure,img,svg,canvas,video,section,article,aside,div";
  var picking = false;
  var tracked = [];
  var hovered = null;

  function fnv(str, seed) {
    var h = seed >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ("00000000" + h.toString(16)).slice(-8);
  }

  function hasDirectText(el) {
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && /\\S/.test(n.nodeValue || "")) return true;
    }
    return false;
  }

  function addressable(el) {
    if (el.tagName === "DIV") return hasDirectText(el);
    return true;
  }

  function assignIds() {
    var seen = {};
    var els = document.body ? document.body.querySelectorAll(SELECTOR) : [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!addressable(el)) continue;
      if (el.getAttribute("data-vdid")) continue;
      var text = (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 32);
      var key = el.tagName + "|" + (el.getAttribute("role") || "") + "|" + text;
      var n = seen[key] || 0;
      seen[key] = n + 1;
      el.setAttribute("data-vdid", fnv(key + "|" + n, 2166136261) + fnv(n + "|" + key, 40389));
    }
  }

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }

  function labelOf(el) {
    var text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    return text ? text.slice(0, 80) : "<" + el.tagName.toLowerCase() + ">";
  }

  function post(msg) {
    // "*" because an opaque origin has no name; the payload carries nothing
    // secret and the parent filters by source window.
    window.parent.postMessage(msg, "*");
  }

  function postRects() {
    if (tracked.length === 0) return;
    var rects = {};
    for (var i = 0; i < tracked.length; i++) {
      var el = document.querySelector('[data-vdid="' + tracked[i].replace(/"/g, "") + '"]');
      if (el) rects[tracked[i]] = rectOf(el);
    }
    post({ type: "valet-artifact:rects", rects: rects });
  }

  var rafPending = false;
  function scheduleRects() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      postRects();
    });
  }

  function clearHover() {
    if (hovered) {
      hovered.style.outline = hovered.__valetPrevOutline || "";
      hovered = null;
    }
  }

  document.addEventListener("mouseover", function (e) {
    if (!picking) return;
    var el = e.target && e.target.closest ? e.target.closest("[data-vdid]") : null;
    if (el === hovered) return;
    clearHover();
    if (el) {
      el.__valetPrevOutline = el.style.outline;
      el.style.outline = "2px solid #4b8bf5";
      hovered = el;
    }
  }, true);

  document.addEventListener("click", function (e) {
    if (!picking) return;
    e.preventDefault();
    e.stopPropagation();
    var el = e.target && e.target.closest ? e.target.closest("[data-vdid]") : null;
    if (!el) return;
    post({
      type: "valet-artifact:pick",
      vdid: el.getAttribute("data-vdid"),
      rect: rectOf(el),
      label: labelOf(el),
    });
  }, true);

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || typeof d.type !== "string") return;
    if (d.type === "valet-artifact:mode") {
      picking = d.picking === true;
      if (!picking) clearHover();
      document.documentElement.style.cursor = picking ? "crosshair" : "";
    } else if (d.type === "valet-artifact:anchors") {
      tracked = [];
      if (Object.prototype.toString.call(d.vdids) === "[object Array]") {
        for (var i = 0; i < d.vdids.length && i < 500; i++) {
          if (typeof d.vdids[i] === "string") tracked.push(d.vdids[i]);
        }
      }
      postRects();
    } else if (d.type === "valet-artifact:theme") {
      if (d.theme === "light" || d.theme === "dark") {
        document.documentElement.setAttribute("data-theme", d.theme);
      } else {
        document.documentElement.removeAttribute("data-theme");
      }
    }
  });

  window.addEventListener("scroll", scheduleRects, true);
  window.addEventListener("resize", scheduleRects);

  function boot() {
    assignIds();
    post({ type: "valet-artifact:ready" });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
`.trim();
