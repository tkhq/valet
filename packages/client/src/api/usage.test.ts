import { describe, expect, it, vi } from 'vitest';

vi.mock('./client', () => ({ api: { get: vi.fn(), fetch: vi.fn() } }));

import { usageSearchParams, type UsageSelection } from './usage';

describe('usageSearchParams', () => {
  it.each<UsageSelection>([
    { scope: 'personal', periodType: 'lookback', period: 24 },
    { scope: 'personal', periodType: 'lookback', period: 168 },
    { scope: 'org', periodType: 'lookback', period: 720 },
    { scope: 'org', periodType: 'month', month: '2024-02' },
    { scope: 'org', periodType: 'range', start: '2023-12-31', end: '2024-02-01' },
  ])('serializes scope and period without falling back: %o', (selection) => {
    const params = new URLSearchParams(usageSearchParams(selection));
    expect(params.get('scope')).toBe(selection.scope);
    expect(params.get('periodType')).toBe(selection.periodType);
    if (selection.periodType === 'month') expect(params.get('month')).toBe(selection.month);
    if (selection.periodType === 'range') expect([params.get('start'), params.get('end')]).toEqual([selection.start, selection.end]);
    if (selection.periodType === 'lookback') expect(params.get('period')).toBe(String(selection.period));
  });

  it('includes the report boundary when replaying a rolling export', () => {
    const query = usageSearchParams(
      { scope: 'org', periodType: 'lookback', period: 24 },
      '2024-03-15T12:30:00.000Z',
    );
    expect(new URLSearchParams(query).get('asOf')).toBe('2024-03-15T12:30:00.000Z');
  });
});
