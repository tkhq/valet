/**
 * Markdown + YAML-frontmatter parser for role and skill artifacts.
 *
 * The frontmatter goes through the `yaml` package. Skill files come from
 * other people's repositories, so they use the whole of YAML — block
 * scalars for a long description, quoting, anchors — and a subset parser
 * turns anything it does not know into a wrong value rather than an error.
 *
 * Frontmatter is flattened to scalars and one-level maps of scalars, which
 * is the shape the Agent Skills spec defines
 * (https://agentskills.io/specification) and the shape the validator and
 * the loaders read. A value of any other shape (a list, a deeper map) is
 * dropped, so a caller never sees a type it cannot handle.
 */

import { parse as parseYaml } from "yaml";

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

/**
 * Reads the frontmatter block. Malformed YAML gives empty frontmatter
 * rather than an exception: the callers already report a missing `name` or
 * `description` with an actionable message, and that message is more use
 * than a parser stack trace.
 */
function parseFrontmatter(text: string): Record<string, FrontmatterValue> {
  let doc: unknown;
  try {
    // A file written on Windows keeps its carriage returns, and the parser
    // leaves them on the end of every scalar. Normalize the line breaks
    // first so a Windows author does not get "MIT\r" for a license. The
    // last line of the block ends at the closing `---`, so its carriage
    // return has no newline after it — match a lone one too.
    doc = parseYaml(text.replace(/\r\n?/g, "\n"));
  } catch {
    return {};
  }
  if (!isRecord(doc)) return {};

  const out: Record<string, FrontmatterValue> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (isScalar(value)) {
      out[key] = value;
      continue;
    }
    if (isRecord(value)) {
      const map: Record<string, string | boolean | number> = {};
      for (const [k, v] of Object.entries(value)) {
        if (isScalar(v)) map[k] = v;
      }
      out[key] = map;
    }
  }
  return out;
}

function isScalar(value: unknown): value is string | boolean | number {
  return typeof value === "string" || typeof value === "boolean" || typeof value === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
