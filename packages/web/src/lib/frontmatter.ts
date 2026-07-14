/**
 * Tolerant, display-only OKF frontmatter splitter (Task 6 brief). The
 * memory doc pane's `rendered` field is `renderConcept` output
 * (`packages/api/src/lib/okf.ts`) — a YAML frontmatter block wrapped in
 * `---` fences followed by a blank line and the markdown body. The spec
 * says frontmatter must never render raw; this pulls out the handful of
 * keys the doc pane needs as badges (`type`, `tags`, `valet.sensitivity`,
 * `valet.origin`) and returns the body separately.
 *
 * Deliberately NOT a real YAML parser — `renderConcept`'s output is a
 * narrow, known shape (see `buildFrontmatterObject`), so a small
 * line-oriented scan covers it without pulling in a YAML dependency for a
 * display-only concern. Anything this can't confidently parse is simply
 * omitted from the badges; it never throws and never leaks raw YAML into
 * the body.
 */

export interface ParsedFrontmatter {
  type?: string;
  tags?: string[];
  sensitivity?: string;
  origin?: string;
}

export interface SplitDoc {
  meta: ParsedFrontmatter;
  body: string;
}

const OPEN_DELIM = "---\n";
const CLOSE_DELIM = "\n---\n";

/**
 * Splits a rendered OKF doc into parsed metadata + body. Only treats the
 * document as having frontmatter when it starts with a `---` fence AND a
 * matching closing `---` fence is found later in the string — a bare
 * `---` used as a markdown `<hr>` inside the body (with no opening fence
 * at position 0) never triggers this path.
 */
export function splitFrontmatter(raw: string): SplitDoc {
  if (!raw.startsWith(OPEN_DELIM)) {
    return { meta: {}, body: raw };
  }

  const rest = raw.slice(OPEN_DELIM.length);
  const closeIdx = rest.indexOf(CLOSE_DELIM);
  if (closeIdx === -1) {
    return { meta: {}, body: raw };
  }

  const block = rest.slice(0, closeIdx);
  const body = rest.slice(closeIdx + CLOSE_DELIM.length).replace(/^\n+/, "");
  return { meta: parseBlock(block), body };
}

function stripQuotes(value: string): string {
  const t = value.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  return t;
}

/** `["a", "b"]` (flow style, what `renderConcept` emits) → `["a", "b"]`. */
function parseInlineArray(value: string): string[] {
  const t = value.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return [];
  const inner = t.slice(1, -1).trim();
  if (inner === "") return [];
  return inner
    .split(",")
    .map((s) => stripQuotes(s))
    .filter((s) => s.length > 0);
}

const TOP_LEVEL_KEY = /^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/;
const VALET_SUB_KEY = /^\s{2,}([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/;

function parseBlock(block: string): ParsedFrontmatter {
  const meta: ParsedFrontmatter = {};
  let inValet = false;

  for (const line of block.split("\n")) {
    if (/^valet:\s*$/.test(line)) {
      inValet = true;
      continue;
    }

    if (inValet) {
      const sub = VALET_SUB_KEY.exec(line);
      if (sub) {
        const [, key, value] = sub;
        if (key === "sensitivity") meta.sensitivity = stripQuotes(value);
        if (key === "origin") meta.origin = stripQuotes(value);
        continue;
      }
      // Any non-indented (or non-matching) line ends the valet block.
      inValet = false;
    }

    const top = TOP_LEVEL_KEY.exec(line);
    if (!top) continue;
    const [, key, value] = top;
    if (key === "valet") continue; // handled above via lookahead
    if (key === "type") meta.type = stripQuotes(value);
    if (key === "tags") meta.tags = parseInlineArray(value);
  }

  return meta;
}
