/**
 * Minimal markdown + YAML-frontmatter parser for role and skill artifacts.
 *
 * The frontmatter we care about is `key: value` pairs, plus ONE level of
 * nesting — that is the depth the Agent Skills spec needs for its
 * `metadata` map (https://agentskills.io/specification) — plus block
 * scalars (`|`, `|-`, `|+`, `>`, `>-`, `>+`), which is how real `SKILL.md`
 * files write a description that is longer than one line. We do NOT
 * support deeper nesting, lists, quoted multi-line flow scalars, explicit
 * indentation indicators (`|2`), or YAML anchors. If a future role or
 * skill needs them, swap in a real YAML parser and tighten this module's
 * API.
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

/** A block scalar header: the style character and its chomping indicator. */
const BLOCK_SCALAR = /^([|>])([+-]?)$/;

function parseFrontmatter(text: string): Record<string, FrontmatterValue> {
  const out: Record<string, FrontmatterValue> = {};
  // The most recent key that had no value on its own line. An indented
  // `key: value` line after it belongs to that key's nested map.
  let openKey: string | null = null;
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const valueRaw = line.slice(colon + 1).trim();
    const indented = /^[ \t]/.test(rawLine);

    // A block scalar takes the more-indented lines that follow it. The key
    // that comes back at the parent indentation ends the block and is read
    // as a key again.
    let value: string | boolean | number;
    const header = BLOCK_SCALAR.exec(valueRaw);
    if (header) {
      const block = readBlockScalar(lines, i + 1, {
        parentIndent: indentWidth(rawLine),
        folded: header[1] === ">",
        chomping: header[2] ?? "",
      });
      value = block.value;
      i = block.next - 1;
    } else {
      value = parseValue(valueRaw);
    }

    if (indented && openKey !== null) {
      const existing = out[openKey];
      const map = isScalarMap(existing) ? existing : {};
      map[key] = value;
      out[openKey] = map;
      continue;
    }

    out[key] = value;
    // A key with no value may open a nested map. It stays an empty string
    // when nothing is indented under it. A block scalar is a value, so it
    // opens nothing.
    openKey = valueRaw === "" ? key : null;
  }
  return out;
}

/**
 * Reads the block a scalar header opened. The block is every following line
 * that is empty or indented deeper than `parentIndent`. Its own indentation
 * is the indentation of its first line with text, and every line is dedented
 * by that much.
 *
 * `folded` joins the lines with spaces; a literal block keeps the line
 * breaks. The chomping indicator controls the TRAILING newline only: `-`
 * strips it, `+` keeps it and every trailing empty line, and no indicator
 * clips the block to exactly one.
 *
 * Returns the value and the index of the first line the block did not take.
 */
function readBlockScalar(
  lines: string[],
  start: number,
  style: { parentIndent: number; folded: boolean; chomping: string },
): { value: string; next: number } {
  const { parentIndent, folded, chomping } = style;
  const taken: string[] = [];
  let next = start;
  for (; next < lines.length; next++) {
    // A file written on Windows leaves the carriage return on every line.
    // The `key: value` path drops it with `trim`, so the block does too.
    const raw = (lines[next] ?? "").replace(/\r$/, "");
    if (raw.trim() === "") {
      taken.push("");
      continue;
    }
    if (indentWidth(raw) <= parentIndent) break;
    taken.push(raw);
  }

  const firstText = taken.findIndex((line) => line !== "");
  if (firstText < 0) return { value: "", next };
  const blockIndent = indentWidth(taken[firstText] ?? "");
  const dedented = taken.map((line) =>
    line === "" ? "" : line.slice(Math.min(blockIndent, indentWidth(line))),
  );

  // Trailing empty lines are not content. Chomping decides what they add.
  let lastText = dedented.length - 1;
  while (lastText >= 0 && dedented[lastText] === "") lastText--;
  const content = dedented.slice(0, lastText + 1);
  const trailingEmpty = dedented.length - 1 - lastText;

  const joined = folded ? foldLines(content) : content.join("\n");
  if (chomping === "-") return { value: joined, next };
  if (chomping === "+") return { value: joined + "\n".repeat(1 + trailingEmpty), next };
  return { value: `${joined}\n`, next };
}

/**
 * Joins the lines of a folded block. One line break between two lines of
 * text becomes a space. An empty line is a paragraph break and stays a line
 * break. A line indented deeper than the block keeps its own line breaks,
 * which is how YAML lets a folded block hold a code sample.
 */
function foldLines(lines: string[]): string {
  let out = "";
  let started = false;
  let breaks = 0;
  let previousDeeper = false;
  for (const line of lines) {
    if (line === "") {
      breaks++;
      continue;
    }
    const deeper = /^[ \t]/.test(line);
    if (!started) {
      out = "\n".repeat(breaks) + line;
      started = true;
    } else if (breaks > 0) {
      out += "\n".repeat(breaks) + line;
    } else {
      out += (deeper || previousDeeper ? "\n" : " ") + line;
    }
    previousDeeper = deeper;
    breaks = 0;
  }
  return out;
}

/** Number of leading whitespace characters. */
function indentWidth(line: string): number {
  return line.length - line.trimStart().length;
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
