/**
 * A short-lived, single-flight cache for Slack DIRECTORY reads (`users.list`,
 * `users.conversations`).
 *
 * The typeahead pickers need the whole directory to rank a query properly:
 * ranking a truncated scan hides an exact match behind whatever Slack paged
 * first. Reading the whole directory per keystroke is what made the channel
 * picker unusable, because `users.list` and `conversations.list` are Tier 2
 * (20 req/min) and `slackGet` sleeps through three `Retry-After` windows
 * before giving up. Reading it once per TTL and filtering in memory gives the
 * ranking without the request volume: a whole typing session costs one scan.
 *
 * Two properties beyond a plain memo:
 *
 * - **Single flight.** The promise is stored, not the value, so several
 *   keystrokes racing a cold entry share one scan instead of starting one
 *   each. Without it the first characters typed would each launch a full
 *   directory read, which is the volume the cache exists to remove.
 * - **Failures are not cached.** A rejected load removes its own entry, so a
 *   rate-limited scan does not answer the next minute of retries from a
 *   failure. Caching one made the picker say "no matches" for a minute after
 *   a single 429, with no way for the reader to retry out of it.
 */

/** How long a scanned directory stays usable. */
const DEFAULT_TTL_MS = 60_000;

/** Distinct workspaces held at once. One entry per credential per kind; the
 * bound is a backstop against unbounded growth, not an expected limit. */
const DEFAULT_MAX_ENTRIES = 32;

export class DirectoryCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<T> }>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
  ) {}

  async get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit !== undefined && hit.expiresAt > Date.now()) return hit.value;

    const value = load();
    // Evict the oldest single entry (Map preserves insertion order) rather
    // than clearing, so one workspace's miss cannot flush every other's.
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const entry = { expiresAt: Date.now() + this.ttlMs, value };
    this.entries.set(key, entry);
    // Drop a failed scan immediately. The `===` guard means a later successful
    // load that already replaced this entry is left alone.
    value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return value;
  }

  /** Drop everything. Tests call this between cases; nothing in production
   * needs it, because every entry expires on its own. */
  clear(): void {
    this.entries.clear();
  }
}
