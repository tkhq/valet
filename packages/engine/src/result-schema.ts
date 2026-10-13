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

function extractCandidate(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;

  const lastMatch = lastFencedBlock(trimmed, LINE_FENCED_JSON_RE) ?? lastFencedBlock(trimmed, FENCED_JSON_RE);
  if (lastMatch !== undefined) {
    return lastMatch.trim();
  }

  return trimmed;
}
