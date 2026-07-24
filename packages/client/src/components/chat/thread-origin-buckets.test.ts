import { describe, expect, it } from 'vitest';
import {
  attentionBucketFromPrompt,
  backendIgnoredBucketFilter,
  computeBucketCounts,
  filterThreadsByBucket,
  getThreadOriginBucket,
  MAX_THREADS_PER_REQUEST,
  mergeBucketCounts,
  planBucketFetch,
  planBucketHistoryFetch,
  THREAD_ORIGIN_BUCKETS,
  THREAD_ORIGIN_SHORT_LABEL_MAX_CHARS,
  type ThreadOriginBucketId,
} from './thread-origin-buckets';
import type { SessionThread } from '@/api/types';

const baseThread = (overrides: Partial<SessionThread>): SessionThread => ({
  id: overrides.id ?? 'thread',
  sessionId: 'orchestrator:user-1',
  summaryAdditions: 0,
  summaryDeletions: 0,
  summaryFiles: 0,
  status: 'active',
  messageCount: 1,
  createdAt: new Date('2026-07-24T00:00:00Z'),
  lastActiveAt: new Date('2026-07-24T00:00:00Z'),
  ...overrides,
});

describe('getThreadOriginBucket', () => {
  it('returns "ui" for web-origin threads', () => {
    expect(getThreadOriginBucket(baseThread({ originType: 'web' }))).toBe('ui');
  });

  it('returns "slack" for slack-origin threads by originType', () => {
    expect(getThreadOriginBucket(baseThread({ originType: 'slack' }))).toBe('slack');
  });

  it('returns "slack" for slack-origin threads by originChannelType', () => {
    expect(
      getThreadOriginBucket(baseThread({ originChannelType: 'slack', originChannelId: 'C1' })),
    ).toBe('slack');
  });

  it('returns "automation" for automation-origin threads regardless of channel metadata', () => {
    expect(
      getThreadOriginBucket(
        baseThread({
          originType: 'automation',
          channelType: 'slack',
          channelId: 'D1',
        }),
      ),
    ).toBe('automation');
  });

  it('returns "other" for telegram / github / api / unknown origin types', () => {
    expect(getThreadOriginBucket(baseThread({ originType: 'telegram' }))).toBe('other');
    expect(getThreadOriginBucket(baseThread({ originType: 'github' }))).toBe('other');
    expect(getThreadOriginBucket(baseThread({ originType: 'api' }))).toBe('other');
    expect(getThreadOriginBucket(baseThread({ originType: 'someFutureThing' }))).toBe('other');
  });

  it('falls back to legacy channelType when origin_* fields are missing', () => {
    expect(getThreadOriginBucket(baseThread({ channelType: 'slack', channelId: 'D1' }))).toBe('slack');
    expect(getThreadOriginBucket(baseThread({ channelType: 'web' }))).toBe('ui');
    expect(getThreadOriginBucket(baseThread({}))).toBe('ui');
    expect(getThreadOriginBucket(baseThread({ channelType: 'telegram' }))).toBe('other');
  });
});

describe('computeBucketCounts', () => {
  it('sums totals across buckets and starts every bucket at zero', () => {
    const counts = computeBucketCounts([], undefined);
    for (const b of THREAD_ORIGIN_BUCKETS) {
      expect(counts[b.id]).toEqual({ total: 0, attentionNeeded: 0 });
    }
  });

  it('counts attention-needed threads per bucket from the response-required set', () => {
    const threads = [
      baseThread({ id: 'ui-1', originType: 'web' }),
      baseThread({ id: 'ui-2', originType: 'web' }),
      baseThread({ id: 'auto-1', originType: 'automation' }),
      baseThread({ id: 'auto-2', originType: 'automation' }),
      baseThread({ id: 'slack-1', originType: 'slack' }),
      baseThread({ id: 'telegram-1', originType: 'telegram' }),
    ];
    const attention = new Set(['auto-1', 'slack-1', 'telegram-1']);

    const counts = computeBucketCounts(threads, attention);

    expect(counts.ui).toEqual({ total: 2, attentionNeeded: 0 });
    expect(counts.slack).toEqual({ total: 1, attentionNeeded: 1 });
    expect(counts.automation).toEqual({ total: 2, attentionNeeded: 1 });
    expect(counts.other).toEqual({ total: 1, attentionNeeded: 1 });
  });

  it('ignores response-required ids that do not match any thread', () => {
    const threads = [baseThread({ id: 'ui-1', originType: 'web' })];
    const counts = computeBucketCounts(threads, new Set(['ghost']));
    expect(counts.ui).toEqual({ total: 1, attentionNeeded: 0 });
  });
});

describe('filterThreadsByBucket', () => {
  it('preserves input order within a bucket', () => {
    const threads = [
      baseThread({ id: 'a', originType: 'web' }),
      baseThread({ id: 'b', originType: 'automation' }),
      baseThread({ id: 'c', originType: 'web' }),
      baseThread({ id: 'd', originType: 'slack' }),
      baseThread({ id: 'e', originType: 'web' }),
    ];
    expect(filterThreadsByBucket(threads, 'ui').map((t) => t.id)).toEqual(['a', 'c', 'e']);
    expect(filterThreadsByBucket(threads, 'automation').map((t) => t.id)).toEqual(['b']);
    expect(filterThreadsByBucket(threads, 'slack').map((t) => t.id)).toEqual(['d']);
    expect(filterThreadsByBucket(threads, 'other').map((t) => t.id)).toEqual([]);
  });
});

describe('mergeBucketCounts', () => {
  it('prefers server-side totals over loaded-thread counts', () => {
    // Only 2 automation threads are loaded, but the server says there are 23.
    // Tab label must show the true total (23), not "loaded so far" (2).
    const loaded = [
      baseThread({ id: 'auto-a', originType: 'automation' }),
      baseThread({ id: 'auto-b', originType: 'automation' }),
    ];
    const counts = mergeBucketCounts(
      { ui: 5, slack: 12, automation: 23, other: 1 },
      loaded,
      undefined,
      undefined,
    );
    expect(counts.ui.total).toBe(5);
    expect(counts.slack.total).toBe(12);
    expect(counts.automation.total).toBe(23);
    expect(counts.other.total).toBe(1);
    for (const b of THREAD_ORIGIN_BUCKETS) {
      expect(counts[b.id].attentionNeeded).toBe(0);
    }
  });

  it('falls back to loaded-thread totals when server did not send counts', () => {
    const loaded = [
      baseThread({ id: 'a', originType: 'web' }),
      baseThread({ id: 'b', originType: 'slack' }),
      baseThread({ id: 'c', originType: 'slack' }),
    ];
    const counts = mergeBucketCounts(undefined, loaded, undefined, undefined);
    expect(counts.ui.total).toBe(1);
    expect(counts.slack.total).toBe(2);
    expect(counts.automation.total).toBe(0);
    expect(counts.other.total).toBe(0);
  });

  it('counts attention from loaded threads using their authoritative bucket', () => {
    const loaded = [
      baseThread({ id: 'ui-1', originType: 'web' }),
      baseThread({ id: 'slack-1', originType: 'slack' }),
      baseThread({ id: 'auto-1', originType: 'automation' }),
    ];
    const attention = new Set(['ui-1', 'slack-1', 'auto-1']);
    const counts = mergeBucketCounts(
      { ui: 10, slack: 10, automation: 10, other: 10 },
      loaded,
      attention,
      undefined,
    );
    expect(counts.ui.attentionNeeded).toBe(1);
    expect(counts.slack.attentionNeeded).toBe(1);
    expect(counts.automation.attentionNeeded).toBe(1);
    expect(counts.other.attentionNeeded).toBe(0);
  });

  it('uses the hint map to attribute attention to buckets whose threads are NOT loaded', () => {
    // The user is on the UI tab so only UI threads are loaded, but two other
    // threads (one automation, one slack) require response — their bell must
    // still light up their respective tabs.
    const loaded = [baseThread({ id: 'ui-1', originType: 'web' })];
    const attention = new Set(['ui-1', 'auto-not-loaded', 'slack-not-loaded']);
    const hint = new Map<string, ThreadOriginBucketId>([
      ['auto-not-loaded', 'automation'],
      ['slack-not-loaded', 'slack'],
    ]);
    const counts = mergeBucketCounts(
      { ui: 3, slack: 8, automation: 12, other: 0 },
      loaded,
      attention,
      hint,
    );
    expect(counts.ui.attentionNeeded).toBe(1);
    expect(counts.slack.attentionNeeded).toBe(1);
    expect(counts.automation.attentionNeeded).toBe(1);
    expect(counts.other.attentionNeeded).toBe(0);
  });

  it('does not double-count when the loaded thread is also in the hint map', () => {
    // Attention for a loaded thread is attributed via `getThreadOriginBucket`
    // — the hint is only consulted for threads NOT present in the loaded set.
    const loaded = [baseThread({ id: 'slack-1', originType: 'slack' })];
    const attention = new Set(['slack-1']);
    const hint = new Map<string, ThreadOriginBucketId>([['slack-1', 'other']]);
    const counts = mergeBucketCounts(undefined, loaded, attention, hint);
    expect(counts.slack.attentionNeeded).toBe(1);
    expect(counts.other.attentionNeeded).toBe(0);
  });
});

describe('attentionBucketFromPrompt', () => {
  it('maps slack channelType to slack', () => {
    expect(attentionBucketFromPrompt({ channelType: 'slack' })).toBe('slack');
  });

  it('maps automation channelType to automation', () => {
    expect(attentionBucketFromPrompt({ channelType: 'automation' })).toBe('automation');
  });

  it('maps external non-slack, non-automation channels to other', () => {
    expect(attentionBucketFromPrompt({ channelType: 'telegram' })).toBe('other');
    expect(attentionBucketFromPrompt({ channelType: 'github' })).toBe('other');
    expect(attentionBucketFromPrompt({ channelType: 'api' })).toBe('other');
  });

  it('maps thread/web/missing channels to ui (web-origin default)', () => {
    expect(attentionBucketFromPrompt({ channelType: 'thread' })).toBe('ui');
    expect(attentionBucketFromPrompt({ channelType: 'web' })).toBe('ui');
    expect(attentionBucketFromPrompt({})).toBe('ui');
  });
});

describe('THREAD_ORIGIN_BUCKETS labels', () => {
  // Round-3 guard: the sidebar tab bar renders `shortLabel` at a fixed 248px
  // width with no `truncate` class, so an over-long label would OVERFLOW rather
  // than ellipsize. The width math in `ThreadOriginTabs` assumes <=5 chars.
  it('keeps every shortLabel within the sidebar width budget', () => {
    for (const bucket of THREAD_ORIGIN_BUCKETS) {
      expect(bucket.shortLabel.length).toBeLessThanOrEqual(
        THREAD_ORIGIN_SHORT_LABEL_MAX_CHARS,
      );
      expect(bucket.shortLabel.length).toBeGreaterThan(0);
    }
  });

  it('uses already-uppercased shortLabels (the tab bar no longer applies uppercase)', () => {
    for (const bucket of THREAD_ORIGIN_BUCKETS) {
      expect(bucket.shortLabel).toBe(bucket.shortLabel.toUpperCase());
    }
  });

  it('has no leading/trailing whitespace that would skew the width math', () => {
    for (const bucket of THREAD_ORIGIN_BUCKETS) {
      expect(bucket.shortLabel).toBe(bucket.shortLabel.trim());
    }
  });

  it('keeps shortLabels distinct so tabs stay distinguishable', () => {
    const shortLabels = THREAD_ORIGIN_BUCKETS.map((b) => b.shortLabel);
    expect(new Set(shortLabels).size).toBe(shortLabels.length);
  });

  it('keeps a full-length label for wider surfaces (thread-history page)', () => {
    const automation = THREAD_ORIGIN_BUCKETS.find((b) => b.id === 'automation');
    expect(automation?.label).toBe('Automation');
    expect(automation?.shortLabel).toBe('AUTO');
  });
});

describe('backendIgnoredBucketFilter', () => {
  it('reports skew when a counts-requesting response comes back WITHOUT originCounts', () => {
    // An old worker ignores both `originBucket` and `includeOriginCounts`.
    expect(backendIgnoredBucketFilter({ threads: [], hasMore: false })).toBe(true);
  });

  it('reports no skew when the response carries originCounts', () => {
    expect(
      backendIgnoredBucketFilter({
        threads: [],
        hasMore: false,
        originCounts: { ui: 1, slack: 2, automation: 3, other: 0 },
      }),
    ).toBe(false);
  });

  it('assumes the happy path before any response is observed', () => {
    // First paint must not overfetch on speculation.
    expect(backendIgnoredBucketFilter(undefined)).toBe(false);
    expect(backendIgnoredBucketFilter(null)).toBe(false);
  });

  it('treats zeroed counts as support, not absence', () => {
    // A brand-new session legitimately has all-zero counts; that still proves
    // the worker understands the param.
    expect(
      backendIgnoredBucketFilter({
        threads: [],
        hasMore: false,
        originCounts: { ui: 0, slack: 0, automation: 0, other: 0 },
      }),
    ).toBe(false);
  });
});

describe('planBucketFetch', () => {
  it('asks the server for exactly the rows it will render when the backend filters', () => {
    const plan = planBucketFetch({
      bucket: 'slack',
      pages: 1,
      basePageSize: 30,
      skewed: false,
    });

    expect(plan).toEqual({
      bucket: 'slack',
      pageSize: 30,
      visibleLimit: 30,
      overfetching: false,
    });
  });

  it('overfetches a MIXED page and drops the ignored bucket param under skew', () => {
    const plan = planBucketFetch({
      bucket: 'slack',
      pages: 1,
      basePageSize: 30,
      skewed: true,
    });

    // 30 * 4 = 120, clamped to the worker's 100-row request cap.
    expect(plan.pageSize).toBe(MAX_THREADS_PER_REQUEST);
    expect(plan.bucket).toBeUndefined();
    expect(plan.overfetching).toBe(true);
    // The render cap is IDENTICAL to the happy path — that's the whole point.
    expect(plan.visibleLimit).toBe(30);
  });

  it('keeps visibleLimit at 30 per Load-more page in BOTH worlds', () => {
    for (const pages of [1, 2, 3]) {
      const healthy = planBucketFetch({ bucket: 'ui', pages, basePageSize: 30, skewed: false });
      const skewed = planBucketFetch({ bucket: 'ui', pages, basePageSize: 30, skewed: true });

      expect(healthy.visibleLimit).toBe(30 * pages);
      expect(skewed.visibleLimit).toBe(30 * pages);
    }
  });

  it('never requests more than the worker will return', () => {
    for (const pages of [1, 2, 4, 10]) {
      for (const skewed of [true, false]) {
        const plan = planBucketFetch({ bucket: 'automation', pages, basePageSize: 30, skewed });
        expect(plan.pageSize).toBeLessThanOrEqual(MAX_THREADS_PER_REQUEST);
        expect(plan.pageSize).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('treats a zero/negative Load-more counter as the first page', () => {
    expect(planBucketFetch({ bucket: 'ui', pages: 0, basePageSize: 30, skewed: false }).visibleLimit)
      .toBe(30);
  });
});

describe('planBucketHistoryFetch', () => {
  it('passes offset pagination straight through when the backend filters', () => {
    const plan = planBucketHistoryFetch({ page: 2, pageSize: 30, bucket: 'ui', skewed: false });

    expect(plan).toEqual({
      requestPage: 2,
      requestPageSize: 30,
      bucket: 'ui',
      sliceStart: 0,
      sliceEnd: 30,
      windowed: false,
    });
  });

  it('switches to ONE cumulative window sliced client-side under skew', () => {
    const plan = planBucketHistoryFetch({ page: 2, pageSize: 30, bucket: 'ui', skewed: true });

    // Page 1 of a big window — NOT page 2 of a small one. Offset-paging a
    // client-filtered stream would skip bucket rows that fell past page 1's cap.
    expect(plan.requestPage).toBe(1);
    expect(plan.bucket).toBeUndefined();
    expect(plan.windowed).toBe(true);
    // The slice is what paginates.
    expect(plan.sliceStart).toBe(30);
    expect(plan.sliceEnd).toBe(60);
  });

  it('grows the window with the page number, bounded by the request cap', () => {
    const p1 = planBucketHistoryFetch({ page: 1, pageSize: 10, bucket: 'ui', skewed: true });
    const p2 = planBucketHistoryFetch({ page: 2, pageSize: 10, bucket: 'ui', skewed: true });

    expect(p1.requestPageSize).toBe(40);
    expect(p2.requestPageSize).toBe(80);
    expect(
      planBucketHistoryFetch({ page: 9, pageSize: 30, bucket: 'ui', skewed: true }).requestPageSize,
    ).toBe(MAX_THREADS_PER_REQUEST);
  });

  it('slices contiguously so no bucket row can be skipped between pages', () => {
    const pageSize = 30;
    const plans = [1, 2, 3].map((page) =>
      planBucketHistoryFetch({ page, pageSize, bucket: 'ui', skewed: true }),
    );

    for (let i = 1; i < plans.length; i++) {
      expect(plans[i].sliceStart).toBe(plans[i - 1].sliceEnd);
    }
  });

  it('clamps a bogus page number to 1', () => {
    expect(planBucketHistoryFetch({ page: 0, pageSize: 30, bucket: 'ui', skewed: true }).sliceStart)
      .toBe(0);
    expect(planBucketHistoryFetch({ page: -3, pageSize: 30, bucket: 'ui', skewed: false }).requestPage)
      .toBe(1);
  });
});
