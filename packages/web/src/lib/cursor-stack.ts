/**
 * Where a keyset pager keeps its place: a stack of the cursors walked so far,
 * carried in one search param.
 *
 * A keyset cursor only moves forward — it names the last row of a page, and
 * nothing in it says what came before. So "Previous" needs the cursor of the
 * page before, and the stack is what holds it.
 *
 * The stack lives in the URL and not in `useState`, so a page is a real
 * history entry: Back pages back instead of leaving the list, a reload stays
 * on the page being read, and a link to page three opens page three. That is
 * the same rule the rest of this client follows for filters and tabs.
 *
 * The stack is joined with `~`, which base64url never produces, so a cursor
 * cannot split into two.
 */

/**
 * The stack separator.
 *
 * This is safe ONLY because a cursor is base64url, whose alphabet is
 * `A-Z a-z 0-9 - _` — see `encodePageCursor` in the api's `lib/page-cursor.ts`,
 * which is where the invariant actually lives. `~` is outside that alphabet,
 * so a cursor can never split into two here.
 *
 * A change to the cursor encoding that admits `~` would break paging silently:
 * a split cursor produces two shorter strings, both of which the server would
 * reject as malformed. If the encoding changes, change this character too.
 */
const SEPARATOR = "~";

/** Reads the stack out of a raw search param. An empty or absent value is
 * page one, which holds no cursor at all. */
export function parseCursorStack(raw: string | undefined): string[] {
  if (raw === undefined || raw.length === 0) return [];
  return raw.split(SEPARATOR).filter((part) => part.length > 0);
}

/** Writes the stack back for the URL. `undefined` drops the param entirely,
 * so page one has a clean address. */
export function formatCursorStack(stack: string[]): string | undefined {
  return stack.length === 0 ? undefined : stack.join(SEPARATOR);
}

/** The cursor the current page was read with. Page one has none. */
export function currentCursor(stack: string[]): string | undefined {
  return stack[stack.length - 1];
}

/** The stack one page forward. `nextCursor` comes from the page in hand. */
export function pushCursor(stack: string[], nextCursor: string): string[] {
  return [...stack, nextCursor];
}

/** The stack one page back. Page one stays page one. */
export function popCursor(stack: string[]): string[] {
  return stack.slice(0, -1);
}

/** 1-based number of the page being read, for the pager's label. */
export function pageNumber(stack: string[]): number {
  return stack.length + 1;
}
