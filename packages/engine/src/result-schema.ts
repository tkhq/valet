import { Value } from "typebox/value";
import type { TSchema } from "typebox";

/**
 * Extracts and validates a structured result from the final assistant text
 * of a completed submission (spec §1481.5, plan decision 14).
 *
 * Candidate JSON is taken from the last fenced ```json code block in `text`
 * if one exists, else the whole trimmed text. The candidate is parsed and
 * checked against `schema`; on success `output` is the typed value, on
 * failure `output` is left undefined and `error` carries a compact message
 * (schema-mismatch errors name the first few failing paths). Schema repair
 * is a caller concern, not this function's — it never throws.
 */
export function extractStructuredOutput(text: string, schema: TSchema): { output?: unknown; error?: string } {
  const candidate = extractCandidate(text);
  if (candidate === undefined) {
    return { error: "no JSON content found in result text" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `failed to parse JSON from result text: ${message}` };
  }

  if (Value.Check(schema, parsed)) {
    return { output: parsed };
  }

  const errors = Value.Errors(schema, parsed).slice(0, 3);
  const paths = errors.map((e) => `${e.instancePath || "/"}: ${e.message}`).join("; ");
  return { error: `result did not match schema: ${paths || "unknown validation error"}` };
}

const FENCED_JSON_RE = /```json\s*\n?([\s\S]*?)```/g;
// A closing fence on its own line. Valid JSON cannot hold a raw line break
// inside a string, so a ``` inside a string value cannot end this block.
const LINE_FENCED_JSON_RE = /```json[ \t]*\n([\s\S]*?)\n[ \t]*```/g;

function lastFencedBlock(text: string, re: RegExp): string | undefined {
  let lastMatch: string | undefined;
  for (const match of text.matchAll(re)) {
    lastMatch = match[1];
  }
  return lastMatch;
}

function parses(candidate: string): boolean {
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}

function extractCandidate(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;

  // The original match wins whenever it parses, so every reply that parsed
  // before reads the same. The line match is only a fallback, for a code
  // fence inside a JSON string that cut the original match short.
  const lastMatch = lastFencedBlock(trimmed, FENCED_JSON_RE)?.trim();
  if (lastMatch !== undefined && parses(lastMatch)) return lastMatch;
  const lineMatch = lastFencedBlock(trimmed, LINE_FENCED_JSON_RE)?.trim();
  if (lineMatch !== undefined && parses(lineMatch)) return lineMatch;
  if (lastMatch !== undefined) return lastMatch;

  return trimmed;
}
