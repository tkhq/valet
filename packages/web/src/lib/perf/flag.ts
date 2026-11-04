import { safeLocalStorage } from "../safe-storage";

/**
 * Whether latency measurement runs in this browser. Off by default. The rest
 * of `lib/perf` loads as a separate chunk only when this is on, so the app
 * pays nothing for it otherwise.
 *
 * - `?perf=1` turns on measurement and the overlay, and keeps them on.
 * - `?perf=record` turns on measurement only (the CI check uses this).
 * - `?perf=0` turns both off again.
 */
export type PerfMode = "off" | "record" | "overlay";

export const PERF_STORAGE_KEY = "valet:perf";

export function perfMode(search: string = window.location.search): PerfMode {
  const storage = safeLocalStorage();
  const param = new URLSearchParams(search).get("perf");
  if (param === "0") storage.removeItem(PERF_STORAGE_KEY);
  else if (param === "1") storage.setItem(PERF_STORAGE_KEY, "overlay");
  else if (param === "record") storage.setItem(PERF_STORAGE_KEY, "record");
  const stored = storage.getItem(PERF_STORAGE_KEY);
  return stored === "overlay" || stored === "record" ? stored : "off";
}
