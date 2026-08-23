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
  stop(): void;
}

export function startSweepTimer(name: string, intervalMs: number, pass: () => Promise<unknown>): SweepTimer {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void pass()
      .catch((err) => console.error(`${name}: sweep failed:`, err))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
