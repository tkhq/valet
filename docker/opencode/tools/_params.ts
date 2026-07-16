/**
 * Coercion for the `params` argument of call_tool.
 *
 * The argument is declared to the model as an object, so in the normal case the
 * value arrives already structured and is passed through untouched. Models that
 * still stringify it — and any caller written against the older string-only
 * schema — keep working through the JSON.parse branch.
 */

export type ParseParamsResult =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; error: string }

const INVALID = "Error: params must be a JSON object of the tool's parameters."

function asObject(value: unknown): ParseParamsResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: INVALID }
  }
  return { ok: true, params: value as Record<string, unknown> }
}

export function parseToolParams(raw: unknown): ParseParamsResult {
  if (raw === undefined || raw === null) {
    return { ok: true, params: {} }
  }

  if (typeof raw === "string") {
    // Legacy path: the schema used to be a string, so the model had to escape the
    // payload to embed it in JSON. Round-tripping newline-heavy content through
    // that extra layer is what produced literal "\n" in rendered output.
    if (raw.trim() === "") {
      return { ok: true, params: {} }
    }
    try {
      return asObject(JSON.parse(raw))
    } catch {
      return { ok: false, error: INVALID }
    }
  }

  return asObject(raw)
}
