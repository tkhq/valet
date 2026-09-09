export interface SearchQueryTerm {
  text: string;
  quoted: boolean;
}

/**
 * Splits a local search query into OR terms. A quote opens a phrase only at
 * a token boundary. An unmatched opening quote is ignored, so the remaining
 * words still search independently. Apostrophes inside words stay intact.
 */
export function tokenizeSearchQuery(query: string): SearchQueryTerm[] {
  const terms: SearchQueryTerm[] = [];
  let cursor = 0;

  while (cursor < query.length) {
    while (/\s/.test(query[cursor] ?? "")) cursor++;
    if (cursor >= query.length) break;

    const quote = query[cursor];
    if (quote === '"' || quote === "'") {
      const end = closingQuote(query, cursor + 1, quote);
      if (end !== -1) {
        const text = query.slice(cursor + 1, end).trim();
        if (text !== "") terms.push({ text, quoted: true });
        cursor = end + 1;
        continue;
      }
      cursor++;
      continue;
    }

    let end = cursor + 1;
    while (end < query.length && !/\s/.test(query[end] ?? "")) end++;
    terms.push({ text: query.slice(cursor, end), quoted: false });
    cursor = end;
  }

  return terms;
}

/** Finds a phrase-closing quote. An apostrophe inside a single-quoted phrase
 * closes it only at a token boundary, so `'Conner's notes'` stays intact. */
function closingQuote(query: string, start: number, quote: string): number {
  for (let cursor = start; cursor < query.length; cursor++) {
    if (query[cursor] !== quote) continue;
    if (quote === '"') return cursor;
    const next = query[cursor + 1];
    if (next === undefined || !/[\p{L}\p{N}_]/u.test(next)) return cursor;
  }
  return -1;
}

/** True when a query uses PostgreSQL web-search operators explicitly. */
export function hasExplicitSearchOperator(query: string): boolean {
  return tokenizeSearchQuery(query).some(
    (term) =>
      !term.quoted &&
      (term.text === "OR" || (term.text.startsWith("-") && term.text.length > 1)),
  );
}

/** Number of distinct query terms found in at least one field. */
export function searchMatchScore(
  query: string | readonly SearchQueryTerm[],
  fields: ReadonlyArray<string | null | undefined>,
): number {
  const terms = typeof query === "string" ? tokenizeSearchQuery(query) : query;
  const normalized = fields.flatMap((field) => (field == null ? [] : [field.toLowerCase()]));
  return terms.reduce(
    (score, term) =>
      score + (normalized.some((field) => field.includes(term.text.toLowerCase())) ? 1 : 0),
    0,
  );
}

/** Case-insensitive OR match. An empty query matches every item. */
export function matchesSearchQuery(
  query: string | readonly SearchQueryTerm[],
  fields: ReadonlyArray<string | null | undefined>,
): boolean {
  const terms = typeof query === "string" ? tokenizeSearchQuery(query) : query;
  return terms.length === 0 || searchMatchScore(terms, fields) > 0;
}

/** Stable sort by matched-term count. Items that match no term are removed. */
export function rankSearchResults<T>(
  query: string | readonly SearchQueryTerm[],
  items: readonly T[],
  fields: (item: T) => ReadonlyArray<string | null | undefined>,
): T[] {
  const terms = typeof query === "string" ? tokenizeSearchQuery(query) : query;
  if (terms.length === 0) return [...items];
  return items
    .map((item, index) => ({ item, index, score: searchMatchScore(terms, fields(item)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
