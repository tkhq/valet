import { describe, expect, it } from 'vitest';
import { parseUsageScope, resolveUsagePeriod, UsagePeriodError } from './usage-period.js';

const NOW = new Date('2024-03-15T12:30:00.000Z');
const params = (value: string) => new URLSearchParams(value);

describe('resolveUsagePeriod', () => {
  it.each([[1, 1 / 24], [24, 1], [168, 7], [720, 30], [8760, 365]])('preserves the %ih rolling lookback', (hours, days) => {
    const result = resolveUsagePeriod(params(`periodType=lookback&period=${hours}`), NOW);
    expect(Date.parse(result.end) - Date.parse(result.start)).toBe(days * 86_400_000);
    expect(result.timezone).toBe('UTC');
  });

  it('replays a rolling report with an exact as-of boundary', () => {
    const result = resolveUsagePeriod(params('period=24&asOf=2024-03-14T08%3A00%3A00.000Z'), NOW);
    expect(result).toMatchObject({
      start: '2024-03-13T08:00:00.000Z', end: '2024-03-14T08:00:00.000Z',
    });
  });

  it('resolves leap February and variable months to exact boundaries', () => {
    expect(resolveUsagePeriod(params('periodType=month&month=2024-02'), NOW)).toMatchObject({
      start: '2024-02-01T00:00:00.000Z', end: '2024-03-01T00:00:00.000Z',
    });
    expect(resolveUsagePeriod(params('periodType=month&month=2023-04'), NOW)).toMatchObject({
      start: '2023-04-01T00:00:00.000Z', end: '2023-05-01T00:00:00.000Z',
    });
  });

  it('keeps custom cross-month/year and DST-date boundaries start-inclusive/end-exclusive in UTC', () => {
    expect(resolveUsagePeriod(params('periodType=range&start=2023-12-31&end=2024-03-11'), NOW)).toMatchObject({
      start: '2023-12-31T00:00:00.000Z', end: '2024-03-11T00:00:00.000Z',
      label: 'date-range_2023-12-31_2024-03-11_UTC',
    });
  });

  it.each([
    'periodType=range&start=2024-03-10&end=2024-03-10',
    'periodType=range&start=2024-02-30&end=2024-03-01',
    'periodType=range&start=2024-03-01&end=2024-03-18',
    'periodType=month&month=2024-03',
    'periodType=lookback&period=2',
    'period=24&asOf=2024-03-16T12%3A30%3A00.000Z',
    'period=24&asOf=2024-03-14T08%3A00%3A00Z',
  ])('rejects invalid or future selection: %s', (query) => {
    expect(() => resolveUsagePeriod(params(query), NOW)).toThrow(UsagePeriodError);
  });

  it('validates all supported scopes', () => {
    expect(['personal', 'team', 'org'].map((scope) => parseUsageScope(scope))).toEqual(['personal', 'team', 'org']);
    expect(() => parseUsageScope('other')).toThrow('scope must be personal, team, or org');
  });
});
