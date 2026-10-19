/**
 * The run id a routine's scheduled fire gets, shared by the scheduler
 * (`packages/api/src/workflows/scheduler.ts`), which mints it, and the
 * routine page (`packages/web/src/components/presence/routine-page.tsx`),
 * which finds a routine's runs by its prefix.
 *
 * The id is `wfrun_sch_<hash>_<slot ms>`. `<hash>` is 14 hex digits of a
 * 53-bit hash (cyrb53) of the full schedule id. A hash of the whole id
 * keeps two routines apart when their ids share a start, such as
 * `proposal-<sha>` or `wfsched_<time>`. The id holds only letters, digits,
 * and `_`, so it is a safe path segment.
 */

/** cyrb53: a 53-bit string hash with good spread, from `Math.imul` only, so it runs alike in Node and the browser. */
function cyrb53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** The prefix every scheduled run of one routine shares: `wfrun_sch_<hash>_`. */
export function scheduleRunPrefix(scheduleId: string): string {
  return `wfrun_sch_${cyrb53(scheduleId).toString(16).padStart(14, "0")}_`;
}

/** The derived, idempotent run id for one (routine, slot) fire. */
export function scheduledRunId(scheduleId: string, slotMs: number): string {
  return `${scheduleRunPrefix(scheduleId)}${slotMs}`;
}
