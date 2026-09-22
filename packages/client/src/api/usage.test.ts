import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { downloadUsageCsv, usageSearchParams, type UsageSelection } from './usage';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAuthStore.setState({ token: null });
});

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

  it('downloads through the authenticated client path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('period_label\nreport\n', {
      headers: { 'Content-Disposition': 'attachment; filename="usage.csv"' },
    }));
    const click = vi.fn();
    const anchor = { href: '', download: '', click };
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', { createElement: vi.fn(() => anchor) });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:usage');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    useAuthStore.setState({ token: 'test-token' });

    await downloadUsageCsv(
      { scope: 'org', periodType: 'lookback', period: 24 },
      '2024-03-15T12:30:00.000Z',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/usage/export.csv?scope=org&periodType=lookback&asOf=2024-03-15T12%3A30%3A00.000Z&period=24',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
    );
    expect(anchor).toMatchObject({ href: 'blob:usage', download: 'usage.csv' });
    expect(click).toHaveBeenCalledOnce();
  });
});
