import { matchesAllSearchTerms } from "@valet/shared";

/**
 * The shared narrowing matcher behind client-side filter boxes. Every term
 * must match across the fields. An empty query matches everything.
 */
export function matchesNeedle(
  query: string,
  haystack: ReadonlyArray<string | null | undefined>,
): boolean {
  return matchesAllSearchTerms(query, haystack);
}
