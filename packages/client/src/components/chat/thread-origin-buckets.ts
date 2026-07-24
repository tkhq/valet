import type { SessionThread } from '@/api/types';

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

export type ThreadOriginBucketId = 'ui' | 'slack' | 'automation' | 'other';

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
 * Filter threads to a single bucket. Preserves input order.
 */
export function filterThreadsByBucket(
  threads: readonly SessionThread[],
  bucket: ThreadOriginBucketId,
): SessionThread[] {
  return threads.filter((t) => getThreadOriginBucket(t) === bucket);
}
