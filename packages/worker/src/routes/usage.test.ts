import { describe, it, expect } from 'vitest';
import { safe } from './usage.js';

// The Analytics page (`/api/usage/stats`) fans out ~11 breakdown queries in one
// Promise.all. safe() guarantees a single query failing (e.g. a schema/migration
// gap on one table) degrades to an empty fallback instead of 500-ing the whole
// endpoint and blanking the page.
describe('usage/stats safe()', () => {
  it('returns the resolved value when the query succeeds', async () => {
    await expect(safe('byModel', Promise.resolve([{ model: 'x' }]), [])).resolves.toEqual([{ model: 'x' }]);
  });

  it('degrades to the fallback (never rejects) when the query throws', async () => {
    await expect(
      safe('byWorkflow', Promise.reject(new Error('no such column: we.session_id')), []),
    ).resolves.toEqual([]);
  });

  it('preserves the fallback shape for non-array queries', async () => {
    const heroFallback = { totalInputTokens: 0, totalOutputTokens: 0, totalSessions: 0, totalUsers: 0 };
    await expect(safe('hero', Promise.reject(new Error('boom')), heroFallback)).resolves.toEqual(heroFallback);
  });
});
