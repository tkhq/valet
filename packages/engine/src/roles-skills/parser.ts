/**
 * Minimal markdown + YAML-frontmatter parser for role and skill artifacts.
 *
 * The frontmatter we care about is `key: value` pairs, plus ONE level of
 * nesting — that is the depth the Agent Skills spec needs for its
 * `metadata` map (https://agentskills.io/specification). We do NOT support
 * deeper nesting, lists, multi-line strings, or YAML anchors. If a future
 * role or skill needs them, swap in a real YAML parser and tighten this
 * module's API.
 */

/** A frontmatter value: a scalar, or a one-level map of scalars. */
export type FrontmatterValue = string | boolean | number | Record<string, string | boolean | number>;

export interface ParsedArtifact {
  frontmatter: Record<string, FrontmatterValue>;
  body: string;
}

const FRONTMATTER_OPEN = /^---\s*\n/;
const FRONTMATTER_CLOSE = /\n---\s*(?:\n|$)/;

export function parseMarkdownArtifact(content: string): ParsedArtifact {
  const open = content.match(FRONTMATTER_OPEN);
  if (!open || open.index !== 0) {
    return { frontmatter: {}, body: content };
  }
  const after = content.slice(open[0].length);
  const close = after.match(FRONTMATTER_CLOSE);
  if (!close || close.index === undefined) {
    return { frontmatter: {}, body: content };
  }
  const fmText = after.slice(0, close.index);
  const body = after.slice(close.index + close[0].length);
  return { frontmatter: parseFrontmatter(fmText), body };
}

function parseFrontmatter(text: string): Record<string, FrontmatterValue> {
  const out: Record<string, FrontmatterValue> = {};
  // The most recent key that had no value on its own line. An indented
  // `key: value` line after it belongs to that key's nested map.
  let openKey: string | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const valueRaw = line.slice(colon + 1).trim();
    const indented = /^[ \t]/.test(rawLine);

    if (indented && openKey !== null) {
      const existing = out[openKey];
      const map = isScalarMap(existing) ? existing : {};
      map[key] = parseValue(valueRaw);
      out[openKey] = map;
      continue;
    }

    out[key] = parseValue(valueRaw);
    // A key with no value may open a nested map. It stays an empty string
    // when nothing is indented under it.
    openKey = valueRaw === "" ? key : null;
  }
  return out;
}

function isScalarMap(value: FrontmatterValue | undefined): value is Record<string, string | boolean | number> {
  return typeof value === "object" && value !== null;
}

function parseValue(raw: string): string | boolean | number {
  if (raw === "") return "";
  // Strip matching surrounding quotes.
  const stripped =
    (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1)
      : raw;
  if (stripped === raw) {
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
    if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  }
  return stripped;
}

/**
 * Replace `{{name}}` placeholders with the corresponding value from `args`.
 * Whitespace inside the braces is allowed (`{{ name }}`). Unknown names
 * are left as-is rather than rendered as "undefined" so authoring errors
 * are visible to the LLM rather than silently swallowed.
 */
export function renderTemplate(body: string, args: Record<string, unknown> = {}): string {
  return body.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(args, name)) {
      const v = args[name];
      return v === undefined || v === null ? "" : String(v);
    }
    return match;
  });
}
