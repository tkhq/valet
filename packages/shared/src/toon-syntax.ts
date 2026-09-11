const COLLECTION_MARKER = /^[\w.-]*\[\d+\](?:\{[^}]*\})?:\s*$/;
const OBJECT_KEY = /^[\w.-]+:\s*.*$/;

/** True when the first non-empty line is a TOON array or table marker. */
export function hasToonCollectionMarker(text: string): boolean {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0)?.trim();
  return firstLine !== undefined && COLLECTION_MARKER.test(firstLine);
}

/** True when text has at least two top-level TOON object fields. */
export function hasMultilineToonObject(text: string): boolean {
  let fields = 0;
  for (const line of text.split("\n")) {
    if (/^\s/.test(line) || !OBJECT_KEY.test(line)) continue;
    fields += 1;
    if (fields === 2) return true;
  }
  return false;
}
