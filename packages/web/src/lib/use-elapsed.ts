import { useEffect, useState } from "react";

/**
 * Seconds elapsed since `startedAt` (a wire/server timestamp, ms), ticking
 * once a second while `startedAt` is set. `undefined` when there's nothing
 * to time (mirrors the input) — callers hide their counter on `undefined`
 * rather than showing "0s" for an idle state.
 */
export function useElapsedSeconds(startedAt: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (startedAt === undefined) return undefined;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** "12s" under a minute, "1m 04s" at/beyond a minute. */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}
