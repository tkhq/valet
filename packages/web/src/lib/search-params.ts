/**
 * Readers for a route's raw search object (`validateSearch` input). The
 * routes keep their filters in the URL, so every reader faces the same
 * input: an object a person may have hand-edited.
 */

/** Reads one string search param. A value of any other type reads as
 * absent, the same as a missing key — a hand-edited URL must degrade to
 * the default view, never to a crash. */
export function textParam(raw: unknown, key: string): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  // The guard above establishes the object; the cast only names what an
  // `object` type cannot express: that it is indexable.
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
