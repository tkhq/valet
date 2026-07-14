import { useEffect, useState } from "react";

/**
 * Trailing-edge value debounce (memory search, decision 17 — 250ms). Unlike
 * `~/lib/debounce`'s `createDebouncer` (which coalesces side-effect
 * triggers with no payload, used for WS-event-driven refetches), this
 * tracks a changing value and re-renders once `delayMs` after the last
 * change settles — the shape a controlled search input needs.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
