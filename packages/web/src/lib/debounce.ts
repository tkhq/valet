/**
 * Trailing-edge debouncer. `trigger()` (re)arms a timer; only the last
 * call within `delayMs` actually runs `fn`. Used to coalesce bursts of
 * live wire events (e.g. `queue.state`) into a single follow-up action
 * (a query invalidation, a refetch) instead of firing once per frame.
 */
export interface Debouncer {
  trigger(): void;
  cancel(): void;
}

export function createDebouncer(fn: () => void, delayMs: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    trigger() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        fn();
      }, delayMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
