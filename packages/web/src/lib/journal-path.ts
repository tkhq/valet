/** Pure — UTC date, matches the server's `journal/YYYY-MM-DD.md` convention
 * (`packages/api/src/orchestrator/bootstrap.ts` `todayJournalPath`). */
export function todayJournalPath(now: Date = new Date()): string {
  return `journal/${now.toISOString().slice(0, 10)}.md`;
}
