/**
 * The `.dc.html` artifact format (spec: docs/specs/2026-08-23-valet-design-design.md,
 * §"The Artifact Format"). A design artifact is one self-contained HTML
 * document with:
 *
 *   - `<meta name="valet-design" content="v=1; template=slides">` in <head>
 *   - `data-vdid` element addressing (see vdid.ts)
 *   - a trailing `<!-- valet-design:meta { ... } -->` JSON block
 *
 * Consumers refuse documents whose `v=` value they do not know. v1 is the
 * only version.
 */

export const DC_HTML_VERSION = 1;

/** Hard cap on artifact size. design_edit rejects anything larger. */
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

export const DESIGN_TEMPLATES = [
  "blank",
  "document",
  "slides",
  "wireframe",
  "resume",
  "html-email",
] as const;

export type DesignTemplate = (typeof DESIGN_TEMPLATES)[number];

export function isDesignTemplate(value: string): value is DesignTemplate {
  return (DESIGN_TEMPLATES as readonly string[]).includes(value);
}

export interface DcHtmlHeader {
  v: number;
  template: string;
}

export interface DcHtmlMetaBlock {
  v: number;
  template: string;
  created_at?: string;
  created_by?: string;
  revision?: string;
  design_system_provider?: string;
  import_reports?: Array<{ type: string; report: string }>;
  [key: string]: unknown;
}

const HEADER_RE = /<meta\s+name=["']valet-design["']\s+content=["']([^"']*)["']\s*\/?>/i;
const META_BLOCK_RE = /<!--\s*valet-design:meta\s*([\s\S]*?)-->/;

/** Parse the `<meta name="valet-design">` header. Returns null when the
 * tag is missing or its content does not parse. */
export function parseHeader(html: string): DcHtmlHeader | null {
  const match = HEADER_RE.exec(html);
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const part of match[1].split(";")) {
    const [key, value] = part.split("=").map((s) => s.trim());
    if (key && value !== undefined) fields.set(key, value);
  }
  const v = Number(fields.get("v"));
  const template = fields.get("template");
  if (!Number.isInteger(v) || !template) return null;
  return { v, template };
}

/** Parse the trailing meta comment block. Returns null when absent or
 * unparseable. */
export function parseMetaBlock(html: string): DcHtmlMetaBlock | null {
  const match = META_BLOCK_RE.exec(html);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as DcHtmlMetaBlock;
  } catch {
    return null;
  }
}

/** Replace (or append) the trailing meta comment block. */
export function writeMetaBlock(html: string, meta: DcHtmlMetaBlock): string {
  const block = `<!-- valet-design:meta\n${JSON.stringify(meta, null, 2)}\n-->`;
  if (META_BLOCK_RE.test(html)) return html.replace(META_BLOCK_RE, block);
  // Append before the closing </html> when present, else at the end.
  const close = html.lastIndexOf("</html>");
  if (close >= 0) return `${html.slice(0, close)}${block}\n${html.slice(close)}`;
  return `${html}\n${block}`;
}

export interface DcHtmlValidation {
  ok: boolean;
  errors: string[];
  header?: DcHtmlHeader;
}

/**
 * Validate a candidate artifact. Checks: size cap, header present, version
 * recognized. The meta block is advisory (absent on some imports), so a
 * missing block is not an error.
 */
export function validateDcHtml(html: string): DcHtmlValidation {
  const errors: string[] = [];
  const bytes = Buffer.byteLength(html);
  if (bytes > MAX_ARTIFACT_BYTES) {
    errors.push(
      `Artifact is ${bytes} bytes; the cap is ${MAX_ARTIFACT_BYTES}. Remove embedded images or split the document.`,
    );
  }
  const header = parseHeader(html);
  if (!header) {
    errors.push(
      'Missing or malformed <meta name="valet-design"> header. Add <meta name="valet-design" content="v=1; template=document"> to <head>.',
    );
  } else if (header.v !== DC_HTML_VERSION) {
    errors.push(`Unknown format version v=${header.v}. This build understands v=${DC_HTML_VERSION} only.`);
  }
  return { ok: errors.length === 0, errors, ...(header ? { header } : {}) };
}

/**
 * Scan artifact bytes for design-system token references (`var(--name)`).
 * This is the share-link stripping rule (spec Decision 3): the share
 * endpoint ships ONLY tokens the artifact references. Component references
 * are never included.
 */
export function extractTokenRefs(html: string): string[] {
  const out = new Set<string>();
  const re = /var\(\s*(--[a-zA-Z0-9_-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) out.add(match[1]);
  return [...out].sort();
}

/** Count top-level `<section>` slides. 0 for non-deck documents. */
export function countSlides(html: string): number {
  const matches = html.match(/<section\b/gi);
  return matches ? matches.length : 0;
}
