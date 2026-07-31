import type { SessionThread } from '@/api/types';
import type { ListThreadsResponse, OriginBucketCounts, ThreadOriginBucketId } from '@valet/shared';

// ─── Thread Origin Buckets ────────────────────────────────────────────────────
//
// Buckets an orchestrator thread into one of four tab categories based on how
// the thread was created. Grounded in the origin values written by:
//   - packages/worker/src/lib/db/threads.ts (default 'web')
//   - packages/worker/src/lib/db/channel-threads.ts (channel type, e.g. 'slack')
//   - packages/worker/src/services/triggers.ts + workflows/nodes/orchestrator.ts
//     + worker/src/index.ts (originType: 'automation')
//
// Legacy threads with no origin_* metadata fall back to the thread row's
// channelType/channelId (matches thread-sidebar.tsx:getThreadGroupTarget).
//
// The bucket id set (`ThreadOriginBucketId`) lives in `@valet/shared` so the
// worker's SQL filter (packages/worker/src/lib/db/threads.ts
// `originBucketCaseSql`) uses the exact same taxonomy. Update BOTH when
// changing the bucket rules.

export type { ThreadOriginBucketId };

export interface ThreadOriginBucket {
  id: ThreadOriginBucketId;
  label: string;
  /**
   * Compact, already-uppercased label for width-constrained tab bars (the chat
   * sidebar is ~248px, so four tabs get ~62px each). Capped at 5 characters so
   * label + count pill fits WITHOUT truncation at the design width — see the
   * width math in `ThreadOriginTabs` (thread-sidebar.tsx). Wider surfaces (the
   * thread-history page) use `label` instead.
   *
   * If you add a bucket, keep `shortLabel` <= 5 chars or re-do that math.
   */
  shortLabel: string;
  /** Long-form label for a11y (used as tab title attribute). */
  description: string;
}

export const THREAD_ORIGIN_BUCKETS: readonly ThreadOriginBucket[] = [
  { id: 'ui', label: 'UI', shortLabel: 'UI', description: 'Threads started from the web UI' },
  { id: 'slack', label: 'Slack', shortLabel: 'SLACK', description: 'Threads started from Slack' },
  { id: 'automation', label: 'Automation', shortLabel: 'AUTO', description: 'Threads started by scheduled triggers or workflows' },
  { id: 'other', label: 'Other', shortLabel: 'OTHER', description: 'Telegram, GitHub, API, and other origins' },
] as const;

/** Max characters any `shortLabel` may use — enforced by test. */
export const THREAD_ORIGIN_SHORT_LABEL_MAX_CHARS = 5;

export const DEFAULT_THREAD_ORIGIN_BUCKET: ThreadOriginBucketId = 'ui';

/**
 * Resolve a thread to exactly one bucket. Prefers `originType`; falls back to
 * `originChannelType`, then to the legacy top-level `channelType`.
 */
export function getThreadOriginBucket(thread: SessionThread): ThreadOriginBucketId {
  const originType = thread.originType;
  if (originType === 'automation') return 'automation';
  if (originType === 'web') return 'ui';
  if (originType === 'slack') return 'slack';

  const originChannelType = thread.originChannelType;
  if (originChannelType === 'slack') return 'slack';

  // Legacy fallback — no origin_* metadata on the row.
  if (!originType && !originChannelType) {
    const legacy = thread.channelType;
    if (legacy === 'slack') return 'slack';
    if (legacy === 'web' || !legacy) return 'ui';
    return 'other';
  }

  return 'other';
}

export interface BucketCounts {
  total: number;
  attentionNeeded: number;
}

/**
 * Compute per-bucket totals and attention-needed counts. `attentionNeeded` is
 * the number of threads in the bucket whose id is present in
 * `responseRequiredThreadIds` — the same set the ThreadItem bell icon uses.
 *
 * NOTE: this is a pure client-side computation over the passed `threads`. When
 * the sidebar fetches only a single bucket at a time (see `useThreads`
 * `bucket` option), the totals it produces reflect only what's loaded — for
 * TRUE per-bucket totals across all threads (independent of the current tab)
 * use `originCounts` returned by the server on `ListThreadsResponse`.
 */
export function computeBucketCounts(
  threads: readonly SessionThread[],
  responseRequiredThreadIds: ReadonlySet<string> | undefined,
): Record<ThreadOriginBucketId, BucketCounts> {
  const counts: Record<ThreadOriginBucketId, BucketCounts> = {
    ui: { total: 0, attentionNeeded: 0 },
    slack: { total: 0, attentionNeeded: 0 },
    automation: { total: 0, attentionNeeded: 0 },
    other: { total: 0, attentionNeeded: 0 },
  };

  for (const thread of threads) {
    const bucket = getThreadOriginBucket(thread);
    counts[bucket].total += 1;
    if (responseRequiredThreadIds?.has(thread.id)) {
      counts[bucket].attentionNeeded += 1;
    }
  }

  return counts;
}

/**
 * Merge SERVER-side per-bucket totals with the currently-loaded threads' worth
 * of attention-needed counts. Server-side totals take precedence for `total`;
 * `attentionNeeded` is still computed client-side against loaded threads
 * because "requires response" is a runtime client signal (interactivePrompts),
 * not a persisted server field.
 *
 * If the pending-prompt thread doesn't happen to be in `loadedThreads`
 * (because it lives in a different bucket than the currently-selected tab),
 * we fall back to `attentionBucketHint` per-id (see
 * `attentionBucketFromPrompt`) so the "needs response" badge still lights up
 * the right tab even when its threads aren't loaded.
 */
export function mergeBucketCounts(
  serverCounts: OriginBucketCounts | undefined,
  loadedThreads: readonly SessionThread[],
  responseRequiredThreadIds: ReadonlySet<string> | undefined,
  attentionBucketHint?: ReadonlyMap<string, ThreadOriginBucketId>,
): Record<ThreadOriginBucketId, BucketCounts> {
  const clientCounts = computeBucketCounts(loadedThreads, responseRequiredThreadIds);

  const totals: OriginBucketCounts = serverCounts ?? {
    ui: clientCounts.ui.total,
    slack: clientCounts.slack.total,
    automation: clientCounts.automation.total,
    other: clientCounts.other.total,
  };

  // Attention: start from loaded-thread attention. Then for any pending-
  // response thread whose id we DIDN'T see in loaded threads, count it via
  // the hint map (best-effort — usually derived from prompt.channelType).
  const attention: Record<ThreadOriginBucketId, number> = {
    ui: clientCounts.ui.attentionNeeded,
    slack: clientCounts.slack.attentionNeeded,
    automation: clientCounts.automation.attentionNeeded,
    other: clientCounts.other.attentionNeeded,
  };
  if (responseRequiredThreadIds && attentionBucketHint) {
    const loadedIds = new Set(loadedThreads.map((t) => t.id));
    for (const id of responseRequiredThreadIds) {
      if (loadedIds.has(id)) continue;
      const bucket = attentionBucketHint.get(id);
      if (bucket) attention[bucket] += 1;
    }
  }

  return {
    ui: { total: totals.ui, attentionNeeded: attention.ui },
    slack: { total: totals.slack, attentionNeeded: attention.slack },
    automation: { total: totals.automation, attentionNeeded: attention.automation },
    other: { total: totals.other, attentionNeeded: attention.other },
  };
}

/**
 * Best-effort mapping from an interactive prompt's channel metadata to an
 * origin bucket. Used to light up the "attention needed" badge on tabs whose
 * threads aren't currently loaded (see `mergeBucketCounts`). NOT authoritative
 * — the ONLY authoritative bucket comes from a loaded SessionThread row and
 * `getThreadOriginBucket`. Prefer that when available.
 */
export function attentionBucketFromPrompt(prompt: {
  channelType?: string;
}): ThreadOriginBucketId {
  const t = prompt.channelType;
  if (t === 'slack') return 'slack';
  if (t === 'automation') return 'automation';
  if (t === 'telegram' || t === 'github' || t === 'api') return 'other';
  // 'thread' / 'web' / undefined => UI (the default web-origin bucket).
  return 'ui';
}

/**
 * Filter threads to a single bucket. Preserves input order.
 *
 * DEFENSE-IN-DEPTH — this is NOT redundant with the server-side `originBucket`
 * filter (see `useThreads` `bucket` option). A worker build that predates
 * `originBucket` support silently IGNORES the param and returns every bucket;
 * a client that trusts the server then renders all origins under whichever tab
 * is selected (the round-2 regression Conner hit: the UI tab listed WEB +
 * AUTOMATIONS + SLACK DM groups at once).
 *
 * Callers rendering a bucket-scoped list MUST apply this to the fetched page,
 * so the UI is correct under frontend/worker version skew. The server-side
 * filter stays for efficiency (it keeps per-bucket pagination honest once the
 * worker is deployed); this keeps it CORRECT in the meantime.
 */
export function filterThreadsByBucket(
  threads: readonly SessionThread[],
  bucket: ThreadOriginBucketId,
): SessionThread[] {
  return threads.filter((t) => getThreadOriginBucket(t) === bucket);
}

// ─── Bucket-filter version skew ───────────────────────────────────────────────
//
// TEMPORARY (but self-retiring) compensation for frontend/worker deploy skew.
//
// A worker that supports `originBucket` filtering ALSO returns `originCounts`
// whenever counts are requested (see packages/worker/src/lib/db/threads.ts:386
// — `wantsCounts = !!originBucket || !!options.includeOriginCounts`). A worker
// that PREDATES the feature ignores both unknown query params and never
// returns the field. So the presence of `originCounts` on a response where we
// explicitly asked for it is a reliable runtime probe for "does this backend
// honor `originBucket`?".
//
// Why we need the probe at all: under skew the server returns a page of MIXED
// origins, the client re-filters it (`filterThreadsByBucket`), and each tab
// ends up rendering only its share of that page — e.g. 12 rows out of a
// 30-thread page. Tabs silently under-fill. To keep "up to 30 per tab" true in
// BOTH worlds we overfetch a bigger mixed page when skew is detected, then
// filter and cap client-side.
//
// This path costs nothing once the new worker is deployed: the probe flips to
// "not skewed" on the first response that carries `originCounts` and we go
// back to precise per-bucket fetches. It can keep detecting correctly forever.

/**
 * Maximum number of threads a single list-threads request can return.
 *
 * Mirrors the worker route's clamp (`Math.min(Math.max(parsedLimit, 1), 100)`
 * at packages/worker/src/routes/threads.ts:84). That clamp predates this
 * branch, so it applies to the OLD deployed worker too — overfetching past it
 * is silently truncated, which would make `hasMore` lie. Respect it here
 * instead of relying on server-side clamping.
 */
export const MAX_THREADS_PER_REQUEST = 100;

/**
 * How much bigger a mixed-origin page we request when the backend ignores
 * `originBucket`. 4x is a heuristic: it fills a 30-row tab as long as the
 * selected bucket is at least ~25% of recent thread traffic. Bounded by
 * `MAX_THREADS_PER_REQUEST` regardless.
 */
export const SKEW_OVERFETCH_FACTOR = 4;

/**
 * Did the backend ignore our `originBucket` filter?
 *
 * Call with a response that was fetched with `includeOriginCounts: true`.
 * Returns false for a missing response (nothing observed yet — assume the
 * happy path rather than overfetching on first paint).
 */
export function backendIgnoredBucketFilter(
  response: Pick<ListThreadsResponse, 'threads' | 'hasMore' | 'originCounts'> | undefined | null,
): boolean {
  if (!response) return false;
  return response.originCounts === undefined;
}

export interface BucketFetchPlan {
  /**
   * Bucket to send as the server-side `originBucket` filter, or undefined to
   * omit it. Omitted under skew — the backend ignores it anyway, and omitting
   * it keeps the request (and its react-query cache key) honest about the
   * mixed-origin page we're actually getting back.
   */
  bucket: ThreadOriginBucketId | undefined;
  /**
   * 1-based OFFSET page numbers to request, ascending and contiguous from 1.
   * One request per `Load more` page. This is what makes the sidebar's
   * pagination UNBOUNDED — see the note on `planBucketFetch` below.
   */
  requestPages: number[];
  /**
   * `pageSize` used for EVERY request in `requestPages`. Constant across pages
   * so `page` offsets line up. Already clamped to `MAX_THREADS_PER_REQUEST`.
   */
  requestPageSize: number;
  /** Max rows to RENDER for this bucket — `basePageSize` per Load-more page. */
  visibleLimit: number;
  /** True when we're deliberately overfetching to compensate for skew. */
  overfetching: boolean;
}

/**
 * Decide what to fetch for a bucket-scoped thread list.
 *
 * ROUND 5 — this used to plan ONE request whose `pageSize` grew with the
 * Load-more counter (`pageSize: basePageSize * pages`). That capped the sidebar
 * dead at `MAX_THREADS_PER_REQUEST`, because a "cumulative window" cannot grow
 * past the worker's per-request row clamp:
 *
 *   - happy path: pages 1..3 asked for 30/60/90 rows, page 4+ all asked for
 *     100 — so `Load more` stopped adding anything past 100 threads;
 *   - skewed path: `pageSize` was ALREADY 100 on the first page
 *     (`30 * SKEW_OVERFETCH_FACTOR`, clamped), so the very first render was
 *     also the last one. When the selected bucket happened to hold exactly
 *     `visibleLimit` rows within that window, `hasMore` evaluated false and the
 *     `Load more` button never even appeared — Conner's "exactly 30 threads and
 *     no more".
 *
 * The fix is to stop growing one request and instead ACCUMULATE offset pages:
 * request `page: 1..pages` at a CONSTANT `requestPageSize`, and merge the
 * responses (`mergeThreadPages`). Offsets have no ceiling, so `Load more` is
 * genuinely infinite in both worlds. `page`/`pageSize` are honored by the old
 * deployed worker too — they predate this branch — so this works under skew.
 *
 * Happy path (worker honors `originBucket`): each page is `basePageSize` rows
 * of the bucket, so page N adds exactly `basePageSize` renderable threads.
 * Skewed path: drop the (ignored) bucket param and request
 * `SKEW_OVERFETCH_FACTOR`x bigger MIXED pages so client-side filtering has
 * enough material to fill a tab, then filter + cap in
 * `selectVisibleBucketPage`. A Load-more click there may reveal FEWER than
 * `basePageSize` new rows (it buys the next mixed page, whose bucket share is
 * whatever it is) — but it always makes progress and never dead-ends while the
 * server still has rows.
 *
 * `visibleLimit` is identical in both cases — that's the point. "Up to
 * `basePageSize` per tab, +`basePageSize` per Load more" holds either way.
 */
export function planBucketFetch({
  bucket,
  pages,
  basePageSize,
  skewed,
}: {
  bucket: ThreadOriginBucketId;
  /** Load-more counter, in units of `basePageSize`. 1 = default first page. */
  pages: number;
  basePageSize: number;
  skewed: boolean;
}): BucketFetchPlan {
  const safePages = Number.isFinite(pages) ? Math.max(1, Math.floor(pages)) : 1;
  const requestPages = Array.from({ length: safePages }, (_, i) => i + 1);
  const visibleLimit = basePageSize * safePages;
  if (!skewed) {
    return {
      bucket,
      requestPages,
      requestPageSize: Math.min(basePageSize, MAX_THREADS_PER_REQUEST),
      visibleLimit,
      overfetching: false,
    };
  }
  return {
    bucket: undefined,
    requestPages,
    requestPageSize: Math.min(basePageSize * SKEW_OVERFETCH_FACTOR, MAX_THREADS_PER_REQUEST),
    visibleLimit,
    overfetching: true,
  };
}

/**
 * Flatten the accumulated Load-more pages into one newest-first list,
 * de-duplicating by thread id and keeping the FIRST occurrence.
 *
 * Dedupe is load-bearing, not paranoia:
 *  - offset pagination over a list ordered by `last_active_at DESC` shifts as
 *    threads receive messages, so a row can appear on two adjacent pages;
 *  - the worker clamps `page` to `totalPages`
 *    (packages/worker/src/lib/db/threads.ts:402), so requesting one page past
 *    the end re-serves the LAST page verbatim.
 *
 * Missing pages (still loading) are skipped, so already-loaded pages keep
 * rendering while a newly-requested one is in flight.
 */
export function mergeThreadPages(
  pages: readonly (readonly SessionThread[] | undefined)[],
): SessionThread[] {
  const seen = new Set<string>();
  const merged: SessionThread[] = [];
  for (const page of pages) {
    if (!page) continue;
    for (const thread of page) {
      if (seen.has(thread.id)) continue;
      seen.add(thread.id);
      merged.push(thread);
    }
  }
  return merged;
}

// NOTE: the sidebar's capping counterpart to `planBucketFetch` lives next to
// its filter primitive as `selectVisibleBucketPage` in thread-sidebar.tsx — it
// composes `selectVisibleBucketThreads` rather than re-implementing the
// active+bucket filter here.

// ─── Search ───────────────────────────────────────────────────────────────────
//
// The authoritative search is server-side (`search` query param -> title +
// message-contents LIKE, see packages/worker/src/lib/db/threads.ts). The client
// helpers below exist for exactly one reason: an old worker ignores unknown
// query params, so under the SAME deploy skew that `backendIgnoredBucketFilter`
// detects, `search` is silently dropped and every thread comes back.
//
// They are DEGRADED on purpose: only the fields the client actually holds
// (title + `firstMessagePreview`) can be matched, so message contents beyond
// the 120-char preview are not searchable while skewed. That's the accepted
// trade-off — the alternative (no client filter) shows an unfiltered list,
// which is strictly worse.
//
// CRITICAL: apply these ONLY when skew is detected. Against a NEW worker the
// server may legitimately match on message contents that appear in neither the
// title nor the preview; filtering those rows out client-side would silently
// drop real hits.

/** Trim + collapse a raw search input. Empty/whitespace-only => undefined. */
export function normalizeSearchTerm(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Case-insensitive substring match over the fields the client has loaded. */
export function threadMatchesSearch(thread: SessionThread, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  const title = thread.title?.toLowerCase();
  if (title && title.includes(needle)) return true;
  const preview = thread.firstMessagePreview?.toLowerCase();
  return !!preview && preview.includes(needle);
}

/** Filter threads by `term`. An empty/undefined term is a no-op. */
export function filterThreadsBySearch(
  threads: readonly SessionThread[],
  term: string | undefined,
): SessionThread[] {
  const needle = normalizeSearchTerm(term);
  if (!needle) return [...threads];
  return threads.filter((t) => threadMatchesSearch(t, needle));
}

export interface BucketHistoryPlan {
  /** `page` to request. Pinned to 1 under skew (see below). */
  requestPage: number;
  /** `pageSize` to request. Already clamped to `MAX_THREADS_PER_REQUEST`. */
  requestPageSize: number;
  /** Server-side `originBucket` filter, or undefined to omit it. */
  bucket: ThreadOriginBucketId | undefined;
  /** Client-side slice bounds applied to the bucket-filtered rows. */
  sliceStart: number;
  sliceEnd: number;
  /** True when paginating client-side over one overfetched window. */
  windowed: boolean;
}

/**
 * Same idea as `planBucketFetch`, for the OFFSET-paginated thread history page.
 *
 * The history page can't just overfetch-in-place the way the sidebar does:
 * under skew, `page` counts offsets in the MIXED stream, so filtering page N
 * client-side and capping it at 30 would silently skip bucket rows that fell
 * past the cap on page N-1.
 *
 * So under skew we switch to the sidebar's cumulative-window model: request a
 * single window from the newest thread (`page: 1`) big enough to cover every
 * page up to the requested one, then slice it client-side. That's lossless and
 * keeps page numbers meaningful; the cost is that history is limited to the
 * newest `MAX_THREADS_PER_REQUEST` threads while skew lasts. Callers should
 * derive `totalPages` from the filtered window when `windowed` is true so the
 * pager doesn't advertise pages that would render empty.
 */
export function planBucketHistoryFetch({
  page,
  pageSize,
  bucket,
  skewed,
}: {
  /** 1-based page number from the URL. */
  page: number;
  pageSize: number;
  bucket: ThreadOriginBucketId;
  skewed: boolean;
}): BucketHistoryPlan {
  const safePage = Math.max(1, page);
  if (!skewed) {
    return {
      requestPage: safePage,
      requestPageSize: Math.min(pageSize, MAX_THREADS_PER_REQUEST),
      bucket,
      sliceStart: 0,
      sliceEnd: pageSize,
      windowed: false,
    };
  }
  return {
    requestPage: 1,
    requestPageSize: Math.min(
      safePage * pageSize * SKEW_OVERFETCH_FACTOR,
      MAX_THREADS_PER_REQUEST,
    ),
    bucket: undefined,
    sliceStart: (safePage - 1) * pageSize,
    sliceEnd: safePage * pageSize,
    windowed: true,
  };
}
