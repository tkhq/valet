/**
 * Per-row retry spacing for periodic sweeps. A row that fails waits
 * base * 2^(failures - 1), capped at `maxMs`, before the sweep tries it
 * again. Without it, a persistent failure retried every row on every pass
 * and rebuilt the 2026-10-29 retry storm.
 *
 * State lives in memory, so a restart retries every row once. The map is
 * bounded: past `maxEntries` the oldest failure is forgotten and that row
 * is retried on the next pass. The sweep still reports each failure.
 */
export class RetryBackoff {
  private readonly failures = new Map<string, { count: number; nextAt: number }>();

  constructor(private readonly opts: { baseMs: number; maxMs: number; maxEntries: number }) {}

  /** True when the row has no failure on record or its wait has passed. */
  ready(key: string, now: number): boolean {
    const entry = this.failures.get(key);
    return entry === undefined || entry.nextAt <= now;
  }

  /** Record a failure. Returns the wait before the next attempt. */
  failed(key: string, now: number): number {
    const count = (this.failures.get(key)?.count ?? 0) + 1;
    const waitMs = Math.min(this.opts.maxMs, this.opts.baseMs * 2 ** Math.min(count - 1, 30));
    // Delete first so the key moves to the newest end of insertion order.
    this.failures.delete(key);
    this.failures.set(key, { count, nextAt: now + waitMs });
    while (this.failures.size > this.opts.maxEntries) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
    return waitMs;
  }

  succeeded(key: string): void {
    this.failures.delete(key);
  }

  get size(): number {
    return this.failures.size;
  }
}

/** Shared spacing for sandbox reclaim sweeps: 5 minutes doubling to 6 hours. */
export function sandboxReclaimBackoff(): RetryBackoff {
  return new RetryBackoff({ baseMs: 5 * 60_000, maxMs: 6 * 60 * 60_000, maxEntries: 10_000 });
}
