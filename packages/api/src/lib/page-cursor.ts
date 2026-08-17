/**
 * Opaque page cursors for keyset-paginated listings.
 *
 * A cursor is base64url of a small JSON record holding the sort key of the
 * last row of the previous page. It is opaque on purpose: the client passes
 * back what it was given and never builds one, so the sort key can change
 * without a wire change.
 *
 * `decodePageCursor` returns `undefined` for anything malformed. A route
 * answers that with 400 rather than falling back to page one — a client
 * retrying with a corrupted cursor must see an error, not skip data without
 * knowing. This mirrors the rule the action log set in `policies/admin.ts`,
 * which predates this module and keeps its own typed pair.
 */

/** The fields a cursor may carry. Keep them small: the cursor rides in a
 * query string. */
export type CursorFields = Record<string, string | number>;

export function encodePageCursor(fields: CursorFields): string {
  return Buffer.from(JSON.stringify(fields), "utf8").toString("base64url");
}

/**
 * Reads a cursor back into a plain record, or `undefined` when the text is
 * not base64url, not JSON, or not a JSON object. The caller narrows the
 * fields it needs, because only the caller knows its own sort key.
 */
export function decodePageCursor(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    // A plain object from `JSON.parse` — the index signature is what the
    // caller narrows against, not a claim about which fields are present.
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Reads a `?limit=` query value. Returns the default when absent, the value
 * capped at `max` when valid, and `undefined` when the caller sent something
 * that is not a whole number of 1 or more — the route turns that into a 400.
 */
export function readLimit(
  raw: string | undefined,
  fallback: number,
  max: number,
): number | undefined {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== raw.trim()) return undefined;
  return Math.min(parsed, max);
}
