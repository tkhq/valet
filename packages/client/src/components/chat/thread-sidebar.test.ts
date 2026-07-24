import { describe, expect, it } from 'vitest';
import {
  formatTabCount,
  groupThreadsByChannel,
  selectActiveThreads,
  selectVisibleBucketPage,
  selectVisibleBucketThreads,
} from './thread-sidebar';
import type { SessionThread } from '@/api/types';

const baseThread = (overrides: Partial<SessionThread>): SessionThread => ({
  id: overrides.id ?? 'thread',
  sessionId: 'orchestrator:user-1',
  summaryAdditions: 0,
  summaryDeletions: 0,
  summaryFiles: 0,
  status: 'active',
  messageCount: 1,
  createdAt: new Date('2026-06-11T00:00:00Z'),
  lastActiveAt: new Date('2026-06-11T00:00:00Z'),
  ...overrides,
});

describe('groupThreadsByChannel', () => {
  it('uses automation origin before Slack routing metadata', () => {
    const groups = groupThreadsByChannel([
      baseThread({
        id: 'automation-thread',
        originType: 'automation',
        channelType: 'slack',
        channelId: 'D123',
      }),
    ], new Map());

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      channelKey: 'automation:default',
      channelType: 'automation',
      channelId: 'default',
      label: 'Automations',
    });
  });

  it('keeps web-origin threads under Web even after Slack mappings exist', () => {
    const groups = groupThreadsByChannel([
      baseThread({
        id: 'web-thread',
        originType: 'web',
        channelType: 'slack',
        channelId: 'D123',
      }),
    ], new Map());

    expect(groups[0]).toMatchObject({
      channelKey: 'web:default',
      channelType: 'web',
      channelId: 'default',
      label: 'Web',
    });
  });

  it('uses Slack origin channel labels for Slack-origin threads', () => {
    const groups = groupThreadsByChannel([
      baseThread({
        id: 'slack-thread',
        originType: 'slack',
        originChannelType: 'slack',
        originChannelId: 'C123',
      }),
    ], new Map([['slack:C123', 'Slack #alerts']]));

    expect(groups[0]).toMatchObject({
      channelKey: 'slack:C123',
      channelType: 'slack',
      channelId: 'C123',
      label: 'Slack #alerts',
    });
  });

  it('falls back to legacy channel metadata when origin is missing', () => {
    const groups = groupThreadsByChannel([
      baseThread({
        id: 'legacy-thread',
        channelType: 'slack',
        channelId: 'D123',
      }),
    ], new Map([['slack:D123', 'Slack DM']]));

    expect(groups[0]).toMatchObject({
      channelKey: 'slack:D123',
      label: 'Slack DM',
    });
  });

  it('sorts Web first, Automations second, then other channel labels', () => {
    const groups = groupThreadsByChannel([
      baseThread({
        id: 'slack-thread',
        originType: 'slack',
        originChannelType: 'slack',
        originChannelId: 'C123',
      }),
      baseThread({
        id: 'automation-thread',
        originType: 'automation',
      }),
      baseThread({
        id: 'web-thread',
        originType: 'web',
      }),
      baseThread({
        id: 'telegram-thread',
        originType: 'telegram',
        originChannelType: 'telegram',
        originChannelId: 'T123',
      }),
    ], new Map([
      ['slack:C123', 'Slack #alerts'],
      ['telegram:T123', 'Telegram'],
    ]));

    expect(groups.map((group) => group.channelKey)).toEqual([
      'web:default',
      'automation:default',
      'slack:C123',
      'telegram:T123',
    ]);
  });
});

// ─── Bucket filtering (round-3 regression guard) ─────────────────────────────
//
// Round 2 moved bucket filtering server-side and DROPPED the client-side
// filter, trusting the `originBucket` query param. Against a worker build that
// predates `originBucket` support, the param is silently ignored, every bucket
// comes back, and the sidebar rendered all of them under whichever tab was
// selected — Conner saw WEB + AUTOMATIONS + SLACK DM group headers while the
// "UI" tab was active.
//
// These tests pin the defense-in-depth contract: the render list is filtered
// client-side REGARDLESS of what the fetch returned.

/** A fetch response from a worker that ignores `originBucket` — all buckets. */
const mixedOriginPage = (): SessionThread[] => [
  baseThread({ id: 'web-1', originType: 'web' }),
  baseThread({ id: 'slack-1', originType: 'slack', originChannelType: 'slack', originChannelId: 'C123' }),
  baseThread({ id: 'automation-1', originType: 'automation' }),
  baseThread({ id: 'telegram-1', originType: 'telegram', originChannelType: 'telegram', originChannelId: 'T1' }),
  baseThread({ id: 'legacy-slack-1', channelType: 'slack', channelId: 'D123' }),
  baseThread({ id: 'web-2', originType: 'web' }),
];

describe('selectVisibleBucketThreads', () => {
  it('excludes Slack-origin threads from the "ui" bucket even when the fetch returns mixed origins', () => {
    const visible = selectVisibleBucketThreads(mixedOriginPage(), 'ui');

    expect(visible.map((t) => t.id)).toEqual(['web-1', 'web-2']);
    expect(visible.some((t) => t.id === 'slack-1')).toBe(false);
    expect(visible.some((t) => t.id === 'legacy-slack-1')).toBe(false);
    expect(visible.some((t) => t.id === 'automation-1')).toBe(false);
  });

  it('never renders a foreign-bucket thread for ANY selected bucket', () => {
    const page = mixedOriginPage();

    expect(selectVisibleBucketThreads(page, 'slack').map((t) => t.id))
      .toEqual(['slack-1', 'legacy-slack-1']);
    expect(selectVisibleBucketThreads(page, 'automation').map((t) => t.id))
      .toEqual(['automation-1']);
    expect(selectVisibleBucketThreads(page, 'other').map((t) => t.id))
      .toEqual(['telegram-1']);
  });

  it('partitions the page exactly — every thread lands in exactly one bucket', () => {
    const page = mixedOriginPage();
    const ids = (['ui', 'slack', 'automation', 'other'] as const)
      .flatMap((b) => selectVisibleBucketThreads(page, b).map((t) => t.id));

    expect(ids).toHaveLength(page.length);
    expect(new Set(ids).size).toBe(page.length);
  });

  it('drops archived threads — the dismissed section renders those separately', () => {
    const visible = selectVisibleBucketThreads([
      baseThread({ id: 'active-web', originType: 'web' }),
      baseThread({ id: 'archived-web', originType: 'web', status: 'archived' }),
    ], 'ui');

    expect(visible.map((t) => t.id)).toEqual(['active-web']);
  });

  it('preserves the server-provided ordering within a bucket', () => {
    const visible = selectVisibleBucketThreads([
      baseThread({ id: 'newer', originType: 'web', lastActiveAt: new Date('2026-07-24T10:00:00Z') }),
      baseThread({ id: 'slack-noise', originType: 'slack' }),
      baseThread({ id: 'older', originType: 'web', lastActiveAt: new Date('2026-07-20T10:00:00Z') }),
    ], 'ui');

    expect(visible.map((t) => t.id)).toEqual(['newer', 'older']);
  });

  it('renders no foreign group headers — the actual symptom Conner reported', () => {
    // The screenshot bug was group HEADERS ("WEB", "AUTOMATIONS", "SLACK DM")
    // for other buckets showing under the UI tab. Assert the full render
    // pipeline (filter -> group) yields only web grouping.
    const groups = groupThreadsByChannel(
      selectVisibleBucketThreads(mixedOriginPage(), 'ui'),
      new Map([['slack:D123', 'Slack DM']]),
    );

    expect(groups.map((g) => g.channelKey)).toEqual(['web:default']);
    expect(groups.map((g) => g.channelType)).not.toContain('slack');
    expect(groups.map((g) => g.channelType)).not.toContain('automation');
  });
});

describe('selectActiveThreads', () => {
  it('keeps every bucket present in the payload (counts must not be bucket-scoped)', () => {
    // Tab counts fall back to this list when the worker returns no
    // `originCounts`, so it deliberately spans all buckets.
    expect(selectActiveThreads(mixedOriginPage())).toHaveLength(6);
  });

  it('excludes archived threads', () => {
    expect(selectActiveThreads([
      baseThread({ id: 'a', originType: 'web' }),
      baseThread({ id: 'b', originType: 'web', status: 'archived' }),
    ]).map((t) => t.id)).toEqual(['a']);
  });
});

describe('formatTabCount', () => {
  it('renders counts up to 99 verbatim', () => {
    expect(formatTabCount(0)).toBe('0');
    expect(formatTabCount(9)).toBe('9');
    expect(formatTabCount(99)).toBe('99');
  });

  it('caps above 99 so the pill width stays bounded', () => {
    expect(formatTabCount(100)).toBe('99+');
    expect(formatTabCount(4212)).toBe('99+');
  });

  it('never exceeds 3 glyphs — the tab-bar width math depends on it', () => {
    for (const n of [0, 5, 42, 99, 100, 1000, 999999]) {
      expect(formatTabCount(n).length).toBeLessThanOrEqual(3);
    }
  });
});

describe('selectVisibleBucketPage', () => {
  // A mixed-origin page as an OLD worker returns it: bucket param ignored, so
  // roughly-alternating origins. `n` threads per bucket.
  const skewedPage = (perBucket: number): SessionThread[] => {
    const page: SessionThread[] = [];
    for (let i = 0; i < perBucket; i++) {
      page.push(baseThread({ id: `web-${i}`, originType: 'web' }));
      page.push(baseThread({ id: `slack-${i}`, originType: 'slack' }));
      page.push(baseThread({ id: `automation-${i}`, originType: 'automation' }));
      page.push(baseThread({ id: `telegram-${i}`, originType: 'telegram' }));
    }
    return page;
  };

  it('fills the tab to 30 from an overfetched mixed page (the under-fill bug)', () => {
    // 100 mixed rows -> 25 per bucket. Before overfetching, a pageSize=30
    // request yielded only ~7 UI rows.
    const page = skewedPage(25);
    const visible = selectVisibleBucketPage(page, 'ui', { pageSize: 100, visibleLimit: 30 }, true);

    expect(visible.threads).toHaveLength(25);
    expect(visible.threads.every((t) => t.originType === 'web')).toBe(true);
  });

  it('CAPS the rendered list at visibleLimit even when more are already fetched', () => {
    // 40 UI rows present in the overfetched page; only 30 may render.
    const page = skewedPage(40);
    const visible = selectVisibleBucketPage(page, 'ui', { pageSize: 100, visibleLimit: 30 }, false);

    expect(visible.threads).toHaveLength(30);
    // Newest-first order preserved — we cap the tail, not a random subset.
    expect(visible.threads[0].id).toBe('web-0');
    expect(visible.threads[29].id).toBe('web-29');
  });

  it('offers Load more when it holds more bucket rows than it renders', () => {
    // No server hasMore, but 40 fetched vs 30 rendered -> reveal locally.
    const visible = selectVisibleBucketPage(
      skewedPage(40), 'ui', { pageSize: 100, visibleLimit: 30 }, false,
    );

    expect(visible.hasMore).toBe(true);
  });

  it('reveals the held-back rows on the next Load more page with no refetch', () => {
    const page = skewedPage(40);
    const second = selectVisibleBucketPage(page, 'ui', { pageSize: 100, visibleLimit: 60 }, false);

    expect(second.threads).toHaveLength(40);
    expect(second.hasMore).toBe(false);
  });

  it('offers Load more when the server has more and we can still ask for a bigger page', () => {
    const visible = selectVisibleBucketPage(
      [baseThread({ id: 'web-1', originType: 'web' })],
      'ui',
      { pageSize: 30, visibleLimit: 30 },
      true,
    );

    expect(visible.hasMore).toBe(true);
  });

  it('hides Load more once the request cap is reached and everything held is shown', () => {
    // pageSize is already at the worker's 100-row cap, so a bigger request is
    // impossible — a Load more button here would be a no-op.
    const visible = selectVisibleBucketPage(
      skewedPage(5), 'ui', { pageSize: 100, visibleLimit: 30 }, true,
    );

    expect(visible.threads).toHaveLength(5);
    expect(visible.hasMore).toBe(false);
  });

  it('still excludes foreign buckets and archived threads', () => {
    const visible = selectVisibleBucketPage(
      [
        baseThread({ id: 'web-1', originType: 'web' }),
        baseThread({ id: 'slack-1', originType: 'slack' }),
        baseThread({ id: 'web-archived', originType: 'web', status: 'archived' }),
      ],
      'ui',
      { pageSize: 100, visibleLimit: 30 },
      false,
    );

    expect(visible.threads.map((t) => t.id)).toEqual(['web-1']);
  });

  it('caps every bucket independently at 30', () => {
    const page = skewedPage(40);
    for (const bucket of ['ui', 'slack', 'automation', 'other'] as const) {
      const visible = selectVisibleBucketPage(page, bucket, { pageSize: 100, visibleLimit: 30 }, false);
      expect(visible.threads).toHaveLength(30);
    }
  });
});
