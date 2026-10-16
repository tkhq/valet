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
  /**
   * Starts a pass now. With a pass in flight, it schedules exactly one more
   * pass after that pass ends, however many calls arrive meanwhile, so two
   * passes never overlap. After `stop`, it does nothing.
   */
  runNow(): void;
}

export function startSweepTimer(name: string, intervalMs: number, pass: () => Promise<unknown>): SweepTimer {
  let inFlight: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  const begin = () => {
    inFlight = (async () => {
      do {
        again = false;
        try {
          await pass();
        } catch (err) {
          console.error(`${name}: sweep failed:`, err);
        }
      } while (again && !stopped);
    })().finally(() => {
      inFlight = null;
    });
  };
  const timer = setInterval(() => {
    if (inFlight || stopped) return;
    begin();
  }, intervalMs);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      again = false;
      clearInterval(timer);
      await inFlight;
    },
    runNow() {
      if (stopped) return;
      if (inFlight) {
        again = true;
        return;
      }
      begin();
    },
  };
}
