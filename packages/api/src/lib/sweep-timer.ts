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
  /**
   * Starts the light pass now, under the same overlap guard as `runNow`.
   * With a pass of either kind in flight, it schedules one light pass
   * after it, unless a full pass is already scheduled. With no light pass
   * configured, it is `runNow`.
   */
  runLight(): void;
}

export interface SweepTimerOptions {
  /**
   * A cheaper pass that `runLight` starts, such as the WakeWatcher's
   * event-row pass after ingest (event wakeups spec, Part E step 6). It
   * never overlaps the full pass or itself.
   */
  light?: () => Promise<unknown>;
}

export function startSweepTimer(
  name: string,
  intervalMs: number,
  pass: () => Promise<unknown>,
  opts: SweepTimerOptions = {},
): SweepTimer {
  let inFlight: Promise<void> | null = null;
  let again = false;
  let lightAgain = false;
  let stopped = false;
  // One pass per `begin`. The follow-up check runs in `finally`, after
  // `inFlight` clears, so a call that lands while a pass settles is never
  // lost between the check and the clear. A scheduled full pass covers a
  // scheduled light pass, so it runs instead of both.
  const begin = (run: () => Promise<unknown>, full: boolean): void => {
    if (full) again = false;
    lightAgain = false;
    inFlight = run()
      .then(() => undefined)
      .catch((err) => console.error(`${name}: ${full ? "sweep" : "light pass"} failed:`, err))
      .finally(() => {
        inFlight = null;
        if (stopped) return;
        if (again) begin(pass, true);
        else if (lightAgain && opts.light) begin(opts.light, false);
      });
  };
  const timer = setInterval(() => {
    if (inFlight || stopped) return;
    begin(pass, true);
  }, intervalMs);
  timer.unref();
  const runNow = (): void => {
    if (stopped) return;
    if (inFlight) {
      again = true;
      return;
    }
    begin(pass, true);
  };
  return {
    async stop() {
      stopped = true;
      again = false;
      lightAgain = false;
      clearInterval(timer);
      await inFlight;
    },
    runNow,
    runLight() {
      if (stopped) return;
      const light = opts.light;
      if (!light) {
        runNow();
        return;
      }
      if (inFlight) {
        lightAgain = true;
        return;
      }
      begin(light, false);
    },
  };
}
