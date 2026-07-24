import { describe, expect, it } from 'vitest';
import {
  computeBucketCounts,
  filterThreadsByBucket,
  getThreadOriginBucket,
  THREAD_ORIGIN_BUCKETS,
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
