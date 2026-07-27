import { describe, expect, it } from 'vitest';
import {
  formatTabCount,
  groupThreadsByChannel,
  selectActiveThreads,
  selectVisibleBucketPage,
  selectVisibleBucketThreads,
  threadListEmptyMessage,
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

  /** `n` UI-bucket threads, as a bucket-filtered worker would return them. */
  const uiPage = (n: number, offset = 0): SessionThread[] =>
    Array.from({ length: n }, (_, i) => baseThread({ id: `web-${offset + i}`, originType: 'web' }));

  it('fills the tab to 30 from an overfetched mixed page (the under-fill bug)', () => {
    // 100 mixed rows -> 25 per bucket. Before overfetching, a pageSize=30
    // request yielded only ~7 UI rows.
    const page = skewedPage(25);
    const visible = selectVisibleBucketPage(page, 'ui', { visibleLimit: 30 }, true);

    expect(visible.threads).toHaveLength(25);
    expect(visible.threads.every((t) => t.originType === 'web')).toBe(true);
  });

  it('CAPS the rendered list at visibleLimit even when more are already fetched', () => {
    // 40 UI rows present in the overfetched page; only 30 may render.
    const page = skewedPage(40);
    const visible = selectVisibleBucketPage(page, 'ui', { visibleLimit: 30 }, false);

    expect(visible.threads).toHaveLength(30);
    // Newest-first order preserved — we cap the tail, not a random subset.
    expect(visible.threads[0].id).toBe('web-0');
    expect(visible.threads[29].id).toBe('web-29');
  });

  it('offers Load more when it holds more bucket rows than it renders', () => {
    // No server hasMore, but 40 fetched vs 30 rendered -> reveal locally.
    const visible = selectVisibleBucketPage(skewedPage(40), 'ui', { visibleLimit: 30 }, false);

    expect(visible.hasMore).toBe(true);
  });

  it('reveals the held-back rows on the next Load more page with no refetch', () => {
    const page = skewedPage(40);
    const second = selectVisibleBucketPage(page, 'ui', { visibleLimit: 60 }, false);

    expect(second.threads).toHaveLength(40);
    expect(second.hasMore).toBe(false);
  });

  it('still excludes foreign buckets and archived threads', () => {
    const visible = selectVisibleBucketPage(
      [
        baseThread({ id: 'web-1', originType: 'web' }),
        baseThread({ id: 'slack-1', originType: 'slack' }),
        baseThread({ id: 'web-archived', originType: 'web', status: 'archived' }),
      ],
      'ui',
      { visibleLimit: 30 },
      false,
    );

    expect(visible.threads.map((t) => t.id)).toEqual(['web-1']);
  });

  it('caps every bucket independently at 30', () => {
    const page = skewedPage(40);
    for (const bucket of ['ui', 'slack', 'automation', 'other'] as const) {
      const visible = selectVisibleBucketPage(page, bucket, { visibleLimit: 30 }, false);
      expect(visible.threads).toHaveLength(30);
    }
  });

  // ── Round-5 regression: "exactly 30 threads load and no more" ─────────────
  //
  // The old derivation was
  //   all.length > threads.length || (serverHasMore && plan.pageSize < MAX_THREADS_PER_REQUEST)
  // which goes false as soon as a saturated request (pageSize === 100, i.e. the
  // FIRST page under skew) has everything it holds rendered. A bucket holding
  // exactly `visibleLimit` rows in that window rendered 30 threads and hid the
  // `Load more` button outright — with hundreds of threads still server-side.

  it('offers Load more when it fetched EXACTLY visibleLimit rows and the server has more', () => {
    // The reported bug, minimal form: a full page of 30 bucket rows and the
    // server saying there are more. Nothing is held back, so the ONLY signal is
    // the server flag — it must be honored on its own.
    const visible = selectVisibleBucketPage(uiPage(30), 'ui', { visibleLimit: 30 }, true);

    expect(visible.threads).toHaveLength(30);
    expect(visible.hasMore).toBe(true);
  });

  it('offers Load more from a SATURATED overfetch when the server has more', () => {
    // Under skew page 1 already requests MAX_THREADS_PER_REQUEST rows, of which
    // exactly 30 are UI. Round 4 hid the button here; the next OFFSET page is
    // reachable, so it must not.
    const visible = selectVisibleBucketPage(skewedPage(30), 'ui', { visibleLimit: 30 }, true);

    expect(visible.threads).toHaveLength(30);
    expect(visible.hasMore).toBe(true);
  });

  it('keeps offering Load more page after page while the server has more', () => {
    // Simulate accumulating offset pages: 30 rows per Load more, server still
    // reporting more each time. Load more must survive well past 100 threads.
    for (const pages of [1, 2, 3, 4, 5, 10]) {
      const merged = uiPage(30 * pages);
      const visible = selectVisibleBucketPage(merged, 'ui', { visibleLimit: 30 * pages }, true);

      expect(visible.threads).toHaveLength(30 * pages);
      expect(visible.hasMore).toBe(true);
    }
  });

  it('hides Load more only when the bucket is genuinely exhausted', () => {
    // Last loaded page reported hasMore=false and nothing is held back.
    const visible = selectVisibleBucketPage(uiPage(42), 'ui', { visibleLimit: 60 }, false);

    expect(visible.threads).toHaveLength(42);
    expect(visible.hasMore).toBe(false);
  });

  it('hides Load more for an empty exhausted bucket', () => {
    const visible = selectVisibleBucketPage([], 'slack', { visibleLimit: 30 }, false);

    expect(visible.threads).toEqual([]);
    expect(visible.hasMore).toBe(false);
  });

  it('increases the rendered count on each Load more click', () => {
    // What the user experiences: click -> page 2 arrives -> 60 rows rendered.
    const afterFirstPage = selectVisibleBucketPage(uiPage(30), 'ui', { visibleLimit: 30 }, true);
    const afterSecondPage = selectVisibleBucketPage(uiPage(60), 'ui', { visibleLimit: 60 }, true);
    const afterThirdPage = selectVisibleBucketPage(uiPage(90), 'ui', { visibleLimit: 90 }, true);

    expect(afterFirstPage.threads).toHaveLength(30);
    expect(afterSecondPage.threads).toHaveLength(60);
    expect(afterThirdPage.threads).toHaveLength(90);
    // And every one of them still offers another click.
    expect([afterFirstPage, afterSecondPage, afterThirdPage].map((p) => p.hasMore))
      .toEqual([true, true, true]);
  });

  it('renders newly-arrived rows even before the render cap is reached', () => {
    // Under skew a Load-more click buys the next MIXED page, whose bucket share
    // may be well under 30. Progress must still be visible.
    const page1 = skewedPage(8);
    const page2 = skewedPage(6).map((t) => baseThread({ ...t, id: `${t.id}-p2` }));
    const merged = selectVisibleBucketPage(
      [...page1, ...page2], 'ui', { visibleLimit: 60 }, true,
    );

    expect(merged.threads).toHaveLength(14);
    expect(merged.hasMore).toBe(true);
  });
});

// ─── Client-side search fallback (skew only) ──────────────────────────────────

describe('selectVisibleBucketPage — clientSearch', () => {
  const page = (): SessionThread[] => [
    baseThread({ id: 'web-orb', originType: 'web', title: 'Orb billing cutover' }),
    baseThread({ id: 'web-other', originType: 'web', title: 'Unrelated thread' }),
    baseThread({ id: 'web-preview', originType: 'web', firstMessagePreview: 'check the orb webhook' }),
    baseThread({ id: 'slack-orb', originType: 'slack', title: 'Orb in Slack' }),
  ];

  it('filters the tab by title or preview when a client search is supplied', () => {
    const visible = selectVisibleBucketPage(page(), 'ui', { visibleLimit: 30 }, false, 'orb');

    expect(visible.threads.map((t) => t.id)).toEqual(['web-orb', 'web-preview']);
  });

  it('does not leak foreign buckets that match the term', () => {
    const visible = selectVisibleBucketPage(page(), 'ui', { visibleLimit: 30 }, false, 'orb');

    expect(visible.threads.some((t) => t.id === 'slack-orb')).toBe(false);
  });

  it('is a no-op when no client search is supplied (new worker already filtered)', () => {
    // Against a NEW worker the server may match message CONTENTS that appear in
    // neither the title nor the 120-char preview. Filtering client-side there
    // would drop real hits, so the sidebar passes undefined.
    const visible = selectVisibleBucketPage(page(), 'ui', { visibleLimit: 30 }, false);

    expect(visible.threads).toHaveLength(3);
  });

  it('applies the search BEFORE the cap so a filtered tab still fills to 30', () => {
    const matches = Array.from({ length: 40 }, (_, i) =>
      baseThread({ id: `hit-${i}`, originType: 'web', title: `deploy ${i}` }),
    );
    const noise = Array.from({ length: 40 }, (_, i) =>
      baseThread({ id: `miss-${i}`, originType: 'web', title: `unrelated ${i}` }),
    );
    // Interleave so a cap-then-filter implementation would render ~15 rows.
    const interleaved = matches.flatMap((hit, i) => [noise[i], hit]);

    const visible = selectVisibleBucketPage(interleaved, 'ui', { visibleLimit: 30 }, false, 'deploy');

    expect(visible.threads).toHaveLength(30);
    expect(visible.threads.every((t) => t.id.startsWith('hit-'))).toBe(true);
    expect(visible.hasMore).toBe(true);
  });
});

describe('threadListEmptyMessage', () => {
  const base = {
    isLoading: false,
    hasMore: false,
    searching: false,
    bucket: 'ui' as const,
    bucketTotal: 0,
  };

  it('says Loading while any page is in flight', () => {
    expect(threadListEmptyMessage({ ...base, isLoading: true, bucketTotal: 12 }))
      .toBe('Loading…');
  });

  it('reports no search matches once there is nothing left to fetch', () => {
    expect(threadListEmptyMessage({ ...base, searching: true, bucketTotal: 0 }))
      .toBe('No threads match');
  });

  it('does NOT claim "no match" while more pages are still reachable', () => {
    // Under skew a MIXED page can hold zero rows of the active bucket while
    // later pages hold plenty — claiming "no match" there would be a lie, and
    // `Load more` stays on screen next to this message.
    expect(threadListEmptyMessage({ ...base, hasMore: true, searching: true }))
      .toBe('No matches on these threads yet');
    expect(threadListEmptyMessage({ ...base, hasMore: true, searching: false }))
      .toBe('None on these threads yet');
  });

  it('names the bucket when it is genuinely empty', () => {
    expect(threadListEmptyMessage({ ...base, bucket: 'ui' })).toBe('No UI threads');
    expect(threadListEmptyMessage({ ...base, bucket: 'other' })).toBe('No other threads');
    expect(threadListEmptyMessage({ ...base, bucket: 'slack' })).toBe('No slack threads');
    expect(threadListEmptyMessage({ ...base, bucket: 'automation' })).toBe('No automation threads');
  });

  it('falls back to Loading when counts disagree with an empty render', () => {
    expect(threadListEmptyMessage({ ...base, bucketTotal: 7 })).toBe('Loading…');
  });
});
