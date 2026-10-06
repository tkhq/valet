/**
 * Rewrites stored workflow definitions to the shape every supported binary
 * reads.
 *
 * A top-level `assistantId` named one of several assistants; a workspace
 * now has exactly one, so the field is dropped.
 *
 * Input is untrusted JSON. Anything that is not a definition-shaped object is
 * returned unchanged, and so is a definition that needs no rewrite (same
 * reference), which lets callers skip a write.
 */
export function normalizeLegacyDefinition<T>(value: T): T {
  if (!isRecord(value) || !Array.isArray(value.nodes) || value.assistantId === undefined) return value;
  const { assistantId: _dropped, ...rest } = value;
  // `rest` is `value` without one key; the result keeps the caller's shape.
  return rest as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
