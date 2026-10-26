/**
 * Recent request durations by route, kept in this API process so Valet's
 * diagnostics tool can name slow routes (`diagnostics.list_slow_requests`).
 * The OTel histogram (`valet.http.request.duration`) is the durable record;
 * this window is what an agent in a thread can read. It holds route
 * patterns, never parameter values, and is cleared on restart.
 */

/** How far back the window reaches. */
export const REQUEST_TIMING_WINDOW_MS = 60 * 60_000;
/** Newest samples kept per route, so one busy route cannot grow without bound. */
const MAX_SAMPLES_PER_ROUTE = 2_000;
/** Distinct routes kept; route patterns are bounded, raw unmatched paths are not. */
const MAX_ROUTES = 500;

interface Sample { at: number; ms: number; status: number; orgId?: string }

const byRoute = new Map<string, Sample[]>();
const startedAt = Date.now();

export function recordRequestTiming(route: string, sample: Sample): void {
  let samples = byRoute.get(route);
  if (!samples) {
    if (byRoute.size >= MAX_ROUTES) return;
    samples = [];
    byRoute.set(route, samples);
  }
  samples.push(sample);
  if (samples.length > MAX_SAMPLES_PER_ROUTE) samples.splice(0, samples.length - MAX_SAMPLES_PER_ROUTE);
}

export interface RouteTiming {
  route: string;
  count: number;
  totalMs: number;
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
  maxMs: number;
  serverErrors: number;
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

/**
 * Routes by total time spent in them since `sinceMs`, slowest first. A
 * request with no signed-in organization (a webhook, a probe) counts for
 * every organization: it shares the process with that organization's work.
 */
export function requestTimingSummary(opts: { orgId: string; sinceMs: number; limit: number; now?: number }): { windowStart: number; routes: RouteTiming[] } {
  const now = opts.now ?? Date.now();
  const cutoff = Math.max(opts.sinceMs, now - REQUEST_TIMING_WINDOW_MS);
  const routes: RouteTiming[] = [];
  for (const [route, samples] of byRoute) {
    while (samples.length > 0 && samples[0]!.at < now - REQUEST_TIMING_WINDOW_MS) samples.shift();
    const kept = samples.filter((sample) => sample.at >= cutoff && (sample.orgId === undefined || sample.orgId === opts.orgId));
    if (kept.length === 0) continue;
    const durations = kept.map((sample) => sample.ms).sort((a, b) => a - b);
    routes.push({
      route, count: kept.length, totalMs: durations.reduce((sum, ms) => sum + ms, 0),
      p50Ms: percentile(durations, 0.5), p90Ms: percentile(durations, 0.9), p99Ms: percentile(durations, 0.99),
      maxMs: durations[durations.length - 1] ?? 0, serverErrors: kept.filter((sample) => sample.status >= 500).length,
    });
  }
  routes.sort((a, b) => b.totalMs - a.totalMs);
  return { windowStart: Math.max(cutoff, startedAt), routes: routes.slice(0, opts.limit) };
}

/** Test seam: empty the window. */
export function resetRequestTimings(): void {
  byRoute.clear();
}
