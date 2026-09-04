/**
 * A stable string for a value that may have made a round trip through
 * Postgres `jsonb`.
 *
 * `jsonb` does not preserve key order: it stores keys sorted by length and
 * then bytewise. So `JSON.stringify(rowFromDb) !== JSON.stringify(freshParse)`
 * for the same value, and any change test written that way is true on every
 * comparison. The content-sync collectors hit this three times: a mirrored
 * workflow minted a version on every file edit, a mirrored skill rewrote its
 * row on every poll, and a mirrored subscription rewrote its filters on every
 * poll. Sorting both sides first removes it.
 *
 * Arrays keep their order, which carries meaning in a node list, an edge list
 * and a filter list.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
}
