import type { SessionThread } from '@/api/types';
import type { OriginBucketCounts, ThreadOriginBucketId } from '@valet/shared';

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
  /** Long-form label for a11y (used as tab title attribute). */
  description: string;
}

export const THREAD_ORIGIN_BUCKETS: readonly ThreadOriginBucket[] = [
  { id: 'ui', label: 'UI', description: 'Threads started from the web UI' },
  { id: 'slack', label: 'Slack', description: 'Threads started from Slack' },
  { id: 'automation', label: 'Automation', description: 'Threads started by scheduled triggers or workflows' },
  { id: 'other', label: 'Other', description: 'Telegram, GitHub, API, and other origins' },
] as const;

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
 * With server-side bucket filtering (see `useThreads` `bucket` option), this
 * is mostly a no-op for the sidebar. Kept for the history page's
 * within-page filtering fallback and for tests.
 */
export function filterThreadsByBucket(
  threads: readonly SessionThread[],
  bucket: ThreadOriginBucketId,
): SessionThread[] {
  return threads.filter((t) => getThreadOriginBucket(t) === bucket);
}
