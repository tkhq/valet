export const MAX_SEARCH_QUERY_LENGTH = 1024;
export const MAX_SEARCH_QUERY_TERMS = 16;
export const MAX_SEARCH_TERM_LENGTH = 128;

export interface SearchQueryTerm {
  text: string;
  quoted: boolean;
  negative: boolean;
}

export interface SearchQuery {
  positive: SearchQueryTerm[];
  negative: SearchQueryTerm[];
  /** True when the input contains non-whitespace text, including only `OR`. */
  hasInput: boolean;
  truncated: boolean;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Parses bounded local search syntax. The first 1,024 characters and first
 * 16 unique terms are used. Each term is at most 128 characters. Uppercase
 * `OR` is an optional separator because ordinary positive terms already use
 * OR semantics. A leading `-` excludes a term. A query with no positive
 * terms matches nothing unless the original query is empty.
 *
 * Quotes open only at a token boundary. Matched quotes preserve a phrase.
 * Unmatched opening quotes and mid-token quotes act as punctuation. An
 * apostrophe between word characters stays in the word. A one-letter token
 * in single quotes is ignored, so `rock 'n' roll` searches `rock` or `roll`.
 */
export function parseSearchQuery(query: string): SearchQuery {
  const bounded = query.slice(0, MAX_SEARCH_QUERY_LENGTH);
  const terms: SearchQueryTerm[] = [];
  const termIndex = new Map<string, number>();
  let cursor = 0;
  let truncated = query.length > MAX_SEARCH_QUERY_LENGTH;

  const add = (text: string, quoted: boolean, negative: boolean): void => {
    const trimmed = text.trim();
    const normalized = trimmed.slice(0, MAX_SEARCH_TERM_LENGTH);
    if (trimmed.length > MAX_SEARCH_TERM_LENGTH) truncated = true;
    if (normalized === "" || normalized === "-" || (!quoted && !negative && normalized === "OR")) return;
    const key = normalized.toLowerCase();
    const existing = termIndex.get(key);
    if (existing !== undefined) {
      // An exclusion wins over the same positive term, regardless of order.
      if (negative && !terms[existing]?.negative) {
        terms[existing] = { text: normalized, quoted, negative: true };
      }
      return;
    }
    if (terms.length >= MAX_SEARCH_QUERY_TERMS) {
      truncated = true;
      return;
    }
    termIndex.set(key, terms.length);
    terms.push({ text: normalized, quoted, negative });
  };

  while (cursor < bounded.length) {
    while (cursor < bounded.length && /\s/.test(bounded[cursor] ?? "")) cursor++;
    if (cursor >= bounded.length) break;

    let negative = false;
    if (bounded[cursor] === "-" && cursor + 1 < bounded.length && !/\s/.test(bounded[cursor + 1] ?? "")) {
      negative = true;
      cursor++;
    }

    const quote = bounded[cursor];
    if (quote === '"' || quote === "'") {
      const end = closingQuote(bounded, cursor + 1, quote);
      if (end !== -1) {
        const text = bounded.slice(cursor + 1, end).trim();
        if (!(quote === "'" && text.length === 1)) add(text, true, negative);
        cursor = end + 1;
        continue;
      }
      // Treat an unmatched opening quote as punctuation. Keep a leading
      // exclusion on the first recovered term.
      cursor++;
    }

    const start = cursor;
    while (cursor < bounded.length && !/\s/.test(bounded[cursor] ?? "") && !isSeparator(bounded, cursor)) cursor++;
    add(bounded.slice(start, cursor), false, negative);
    if (cursor < bounded.length && isSeparator(bounded, cursor)) cursor++;
  }

  return {
    positive: terms.filter((term) => !term.negative),
    negative: terms.filter((term) => term.negative),
    hasInput: query.trim() !== "",
    truncated,
  };
}

/** Backward-compatible name for callers that need the normalized terms. */
export function tokenizeSearchQuery(query: string): SearchQueryTerm[] {
  const parsed = parseSearchQuery(query);
  return [...parsed.positive, ...parsed.negative];
}

function isSeparator(query: string, cursor: number): boolean {
  const char = query[cursor];
  if (char === '"') return true;
  if (char !== "'") return false;
  const prev = query[cursor - 1];
  const next = query[cursor + 1];
  return !(prev !== undefined && next !== undefined && WORD_CHAR.test(prev) && WORD_CHAR.test(next));
}

function closingQuote(query: string, start: number, quote: string): number {
  for (let cursor = start; cursor < query.length; cursor++) {
    if (query[cursor] !== quote) continue;
    if (quote === '"') return cursor;
    const next = query[cursor + 1];
    if (next === undefined || !WORD_CHAR.test(next)) return cursor;
  }
  return -1;
}

function normalizedFields(fields: ReadonlyArray<string | null | undefined>): string[] {
  return fields.flatMap((field) => (field == null ? [] : [field.toLowerCase()]));
}

function termMatches(term: SearchQueryTerm, fields: readonly string[]): boolean {
  const needle = term.text.toLowerCase();
  return fields.some((field) => field.includes(needle));
}

/** Number of distinct positive terms found, or zero when an exclusion matches. */
export function searchMatchScore(
  query: string | SearchQuery,
  fields: ReadonlyArray<string | null | undefined>,
): number {
  const parsed = typeof query === "string" ? parseSearchQuery(query) : query;
  const normalized = normalizedFields(fields);
  if (parsed.negative.some((term) => termMatches(term, normalized))) return 0;
  return parsed.positive.reduce((score, term) => score + (termMatches(term, normalized) ? 1 : 0), 0);
}

/** Case-insensitive OR match with exclusions. Empty input matches every item. */
export function matchesSearchQuery(
  query: string | SearchQuery,
  fields: ReadonlyArray<string | null | undefined>,
): boolean {
  const parsed = typeof query === "string" ? parseSearchQuery(query) : query;
  if (parsed.positive.length === 0) return !parsed.hasInput && parsed.negative.length === 0;
  return searchMatchScore(parsed, fields) > 0;
}

/** Case-insensitive narrowing match. Every positive term must match. */
export function matchesAllSearchTerms(
  query: string | SearchQuery,
  fields: ReadonlyArray<string | null | undefined>,
): boolean {
  const parsed = typeof query === "string" ? parseSearchQuery(query) : query;
  if (parsed.positive.length === 0) return !parsed.hasInput && parsed.negative.length === 0;
  const normalized = normalizedFields(fields);
  return (
    parsed.positive.every((term) => termMatches(term, normalized)) &&
    parsed.negative.every((term) => !termMatches(term, normalized))
  );
}

/** Stable sort by distinct matched positive terms. Non-matches are removed. */
export function rankSearchResults<T>(
  query: string | SearchQuery,
  items: readonly T[],
  fields: (item: T) => ReadonlyArray<string | null | undefined>,
): T[] {
  const parsed = typeof query === "string" ? parseSearchQuery(query) : query;
  if (!parsed.hasInput && parsed.positive.length === 0 && parsed.negative.length === 0) return [...items];
  if (parsed.positive.length === 0) return [];
  return items
    .map((item, index) => ({ item, index, score: searchMatchScore(parsed, fields(item)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
