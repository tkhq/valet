import { matchesSearchQuery } from "@valet/shared";

/**
 * The shared OR matcher behind client-side filter boxes. An empty query
 * matches everything, and quoted text stays one phrase.
 */
export function matchesNeedle(
  query: string,
  haystack: ReadonlyArray<string | null | undefined>,
): boolean {
  return matchesSearchQuery(query, haystack);
}
