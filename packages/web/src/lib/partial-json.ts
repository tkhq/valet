/**
 * Best-effort parser for a truncated JSON object, used to render tool-call
 * args while their JSON is still streaming (`tool_call_update` frames).
 *
 * Strategy: repair the fragment (close open strings/objects/arrays, strip a
 * trailing comma) and JSON.parse it. If the repaired string does not parse —
 * the fragment ends inside a key, a literal, or an escape — chop one
 * character off the tail and retry. The chop loop converges on the longest
 * parseable prefix; a cap bounds pathological inputs.
 *
 * Returns undefined when no object can be recovered. Callers keep the last
 * good parse in that case, so the preview never regresses mid-stream.
 */
export function parsePartialJson(text: string): Record<string, unknown> | undefined {
  let candidate = text.trim();
  const MAX_CHOPS = 500;
  for (let i = 0; i < MAX_CHOPS && candidate; i++) {
    const repaired = repair(candidate);
    if (repaired !== undefined) {
      try {
        const parsed: unknown = JSON.parse(repaired);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
        // Parseable but not an object — tool args are always objects.
        return undefined;
      } catch {
        // Fall through to chop.
      }
    }
    candidate = candidate.slice(0, -1).trimEnd();
  }
  return undefined;
}

/**
 * Close whatever the fragment left open. Returns undefined when the fragment
 * cannot be repaired by appending (dangling escape, mismatched close) —
 * the caller chops and retries.
 */
function repair(t: string): string | undefined {
  const closers: string[] = [];
  let inString = false;
  let escape = false;
  for (const ch of t) {
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") closers.push("}");
    else if (ch === "[") closers.push("]");
    else if (ch === "}" || ch === "]") {
      if (closers.pop() !== ch) return undefined;
    }
  }
  if (escape) return undefined;
  let out = t;
  if (inString) out += '"';
  else out = out.replace(/,\s*$/, "");
  while (closers.length) out += closers.pop();
  return out;
}
