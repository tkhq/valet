/**
 * Bounded edit distance and the `did you mean` hint built on it.
 *
 * The validator (save time) and the template path diagnostics (run time)
 * both need the same "you almost wrote a real name" hint, so the
 * implementation lives here instead of in one of them.
 */

/** ` — did you mean "x"?` when a close match exists, else "". */
export function didYouMean(input: string, candidates: readonly string[]): string {
  const best = nearestMatch(input, candidates);
  return best ? ` — did you mean ${JSON.stringify(best)}?` : '';
}

/** The closest candidate within edit distance 2, or null. */
export function nearestMatch(input: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDist = 3; // only suggest within edit distance 2
  for (const candidate of candidates) {
    const dist = editDistance(input.toLowerCase(), candidate.toLowerCase(), bestDist);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

/** Bounded Levenshtein — bails once the distance exceeds `limit`. */
export function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      rowMin = Math.min(rowMin, cur[j]!);
    }
    if (rowMin > limit) return limit + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}
