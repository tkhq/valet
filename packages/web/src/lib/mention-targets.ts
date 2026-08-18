/**
 * `@`-mention completion for the composer (V1 port #9).
 *
 * V1 completed against the whole sandbox workspace. V2 cannot read the
 * workspace without a sandbox round trip, and a picker that wakes a sandbox
 * on a keystroke is worse than no picker. So this completes over the two
 * path sets the client already holds, both of which come from the database:
 *
 * - Memory documents (`GET /api/memory/tree`), which every session has.
 * - The files this session changed (`GET /api/sessions/:id/files-changed`),
 *   which a session on a repository has.
 *
 * The composer sends the text unchanged either way — a path could always be
 * typed by hand, so this is discoverability, not new capability. What it
 * must not do is pretend to know paths it does not: a workspace tree needs
 * that sandbox round trip and is not offered here.
 */

/** Where a mention token sits in the composer text. */
export interface MentionQuery {
  /** Index of the `@`. */
  start: number;
  /** Index one past the last character of the token. */
  end: number;
  /** The text between the `@` and the caret. */
  query: string;
}

/**
 * Finds the mention token the caret sits in, or null when it does not sit
 * in one.
 *
 * A mention opens at an `@` that starts the text or follows whitespace, so
 * an email address and a decorator do not open the popup. It closes at the
 * first whitespace, so the token is one path.
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  const position = Math.max(0, Math.min(caret, text.length));
  for (let i = position - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === undefined) return null;
    if (/\s/.test(ch)) return null;
    if (ch !== "@") continue;
    const before = i > 0 ? text[i - 1] : undefined;
    if (before !== undefined && !/\s/.test(before)) return null;
    return { start: i, end: position, query: text.slice(i + 1, position) };
  }
  return null;
}

/** Replaces the mention token with `path`, and leaves the caret after it. */
export function applyMention(
  text: string,
  mention: MentionQuery,
  path: string,
): { text: string; caret: number } {
  const inserted = `@${path} `;
  return {
    text: text.slice(0, mention.start) + inserted + text.slice(mention.end),
    caret: mention.start + inserted.length,
  };
}

/** One completable path, and where it came from. */
export interface MentionTarget {
  path: string;
  /** The popup's group heading. */
  group: string;
  /** Second line: a title, or the file's line counts. */
  detail?: string;
}

/** The file name — what a person types when reaching for a path. */
function baseName(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * How well `path` answers `query`, or null when it does not.
 *
 * Lower is better. The order is the order a person expects: a file whose
 * NAME starts with what they typed, then a path that starts with it, then
 * anything containing it. An empty query matches everything at one rank, so
 * a bare `@` lists the paths in their given order.
 */
export function matchRank(path: string, query: string): number | null {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const name = baseName(p);
  if (name.startsWith(q)) return 0;
  if (p.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if (p.includes(q)) return 3;
  return null;
}

/** How many rows the popup shows. Past this the list stops being scannable. */
export const MAX_MENTION_RESULTS = 12;

/**
 * Ranks and truncates the completions for one query. Ties keep the input
 * order, so the caller decides which source leads — the changed files of the
 * session being discussed are more likely wanted than a memory document, so
 * they are passed first.
 */
export function rankMentionTargets(
  targets: readonly MentionTarget[],
  query: string,
  limit: number = MAX_MENTION_RESULTS,
): MentionTarget[] {
  const scored: { target: MentionTarget; rank: number; index: number }[] = [];
  targets.forEach((target, index) => {
    const rank = matchRank(target.path, query);
    if (rank !== null) scored.push({ target, rank, index });
  });
  scored.sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank));
  return groupContiguously(scored.slice(0, limit).map((s) => s.target));
}

/**
 * Reorders a ranked list so every group's rows sit together, keeping the
 * groups in the order their best match appeared.
 *
 * `CommandPopup` renders group by group while the arrow keys walk the flat
 * item order. A group split across the list therefore breaks keyboard
 * navigation — the highlight jumps. Ranking mixes the sources by definition,
 * so the mixing is undone here rather than in the popup.
 */
export function groupContiguously(targets: readonly MentionTarget[]): MentionTarget[] {
  const byGroup = new Map<string, MentionTarget[]>();
  for (const target of targets) {
    const bucket = byGroup.get(target.group);
    if (bucket) bucket.push(target);
    else byGroup.set(target.group, [target]);
  }
  return [...byGroup.values()].flat();
}
