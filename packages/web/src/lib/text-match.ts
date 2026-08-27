/**
 * The one substring matcher behind the client-side filter boxes: the
 * integrations search, the model pickers and comboboxes, the thread list.
 * Case-insensitive, and an empty query matches everything — a filter box
 * with nothing in it narrows nothing.
 */
export function matchesNeedle(
  query: string,
  haystack: ReadonlyArray<string | null | undefined>,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return haystack.some((text) => text != null && text.toLowerCase().includes(needle));
}
