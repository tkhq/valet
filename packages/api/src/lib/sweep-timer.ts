/**
 * Shared interval shell for the periodic sweeps (hibernation reaper,
 * reconcile sweep, workflow reclaimer, idle-hibernation sweep). One place
 * for the semantics every sweep hand-copied before this existed:
 *
 *   - unref'd — a sweep never holds the process open;
 *   - errors logged, never thrown into the timer;
 *   - OVERLAP-GUARDED: a pass that outlives the interval skips the next
 *     tick instead of stacking a concurrent pass over the same rows
 *     (post-incident backlogs make slow passes the norm, not the edge).
 */
export interface SweepTimer {
  /**
   * Stops the interval. The returned promise settles when the pass in
   * flight, if any, ends. A caller that closes the store after `stop` must
   * await it, or the pass loses its database mid-write (fix wave 2, M3).
   */
  stop(): Promise<void>;
}

export function startSweepTimer(name: string, intervalMs: number, pass: () => Promise<unknown>): SweepTimer {
  let inFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = pass()
      .then(() => undefined)
      .catch((err) => console.error(`${name}: sweep failed:`, err))
      .finally(() => {
        inFlight = null;
      });
  }, intervalMs);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await inFlight;
    },
  };
}
