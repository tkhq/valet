/**
 * Output cap for MCP tool results (`docs/specs/2026-10-07-mcp-agent-tools-design.md`, "Results").
 *
 * A tool result goes into the calling agent's context. A large result (a
 * tool's raw response, a long schema, many search hits) can fill that
 * context, so every tool result passes through `capOutput` before it is
 * sent. A small result passes through unchanged.
 */

/**
 * Maximum serialized size of one tool result, in characters of compact JSON.
 * It is above the 20,000-character text clip in `mcp-workspace-tools.ts`, so
 * a clipped skill or memory file still fits with its other fields.
 */
export const MAX_OUTPUT_CHARS = 24_000;

/** Note for a result with no narrower way to read it. */
export const GENERIC_CAP_NOTE = "The result was too long to return in full, so Valet shortened it.";

function size(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

/** Shorten `text` until its JSON string form is at most `budget` characters. */
function previewText(text: string, budget: number): string {
  let preview = text.slice(0, Math.max(0, budget - 2));
  // JSON escapes (quotes, newlines) make the serialized form longer than the
  // string. Each pass cuts the string in proportion to the excess, and by at
  // least one character, so the loop ends.
  for (let serialized = size(preview); preview.length > 0 && serialized > budget; serialized = size(preview)) {
    preview = preview.slice(0, Math.min(preview.length - 1, Math.floor((preview.length * budget) / serialized)));
  }
  return preview;
}

/** The leading items of `items` whose JSON array form fits in `budget` characters. */
function leadingItems(items: unknown[], budget: number): unknown[] {
  const kept: unknown[] = [];
  let used = 2; // "[]"
  for (const item of items) {
    const cost = size(item) + (kept.length > 0 ? 1 : 0);
    if (used + cost > budget) break;
    kept.push(item);
    used += cost;
  }
  return kept;
}

const CAP_FIELDS = new Set(["truncated", "original_chars", "note", "omitted_items"]);

/**
 * Cap a tool result at `max` characters of compact JSON. A result under the
 * cap returns unchanged. Otherwise the largest top-level fields shrink, one
 * at a time, until the result fits:
 *
 * - An array keeps as many leading items as fit, and `omitted_items` counts the rest.
 * - Any other value becomes a string preview of its JSON (or of the string itself).
 *
 * A shortened result carries `truncated: true`, `original_chars`, and `note`,
 * which says how to get the rest when a way exists. The return value is
 * always a JSON object, so it is valid MCP `structuredContent`. A value that
 * is not an object is wrapped as `{ result: value }`.
 */
export function capOutput(value: unknown, note: string = GENERIC_CAP_NOTE, max: number = MAX_OUTPUT_CHARS): Record<string, unknown> {
  const object: Record<string, unknown> =
    typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : { result: value };
  const total = size(object);
  if (total <= max) return object;

  const capped: Record<string, unknown> = { ...object, truncated: true, original_chars: total, note };
  // The largest fields hold most of the output. Shrink them first, so ids
  // and statuses stay readable.
  const fields = Object.keys(object)
    .filter((key) => !CAP_FIELDS.has(key))
    .sort((a, b) => size(object[b]) - size(object[a]));
  for (const field of fields) {
    if (size(capped) <= max) break;
    const inner = object[field];
    capped[field] = null;
    const budget = max - size(capped) + size(null);
    if (Array.isArray(inner)) {
      const kept = leadingItems(inner, budget - size({ omitted_items: inner.length }));
      if (kept.length > 0 || inner.length === 0) {
        capped[field] = kept;
        capped.omitted_items = inner.length - kept.length;
        continue;
      }
    }
    // Not an array, or not even its first item fits: use a text preview.
    capped[field] = previewText(typeof inner === "string" ? inner : (JSON.stringify(inner) ?? ""), budget);
  }
  return capped;
}
