import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { UsageStatsResponse } from './types';

export type UsageScope = 'personal' | 'team' | 'org';
export type UsagePeriod =
  | { periodType: 'lookback'; period: 1 | 24 | 168 | 720 | 8760 }
  | { periodType: 'month'; month: string }
  | { periodType: 'range'; start: string; end: string };
export type UsageSelection = UsagePeriod & { scope: UsageScope };

export function usageSearchParams(selection: UsageSelection, asOf?: string): string {
  const params = new URLSearchParams({ scope: selection.scope, periodType: selection.periodType });
  if (selection.periodType === 'lookback' && asOf) params.set('asOf', asOf);
  if (selection.periodType === 'lookback') params.set('period', String(selection.period));
  if (selection.periodType === 'month') params.set('month', selection.month);
  if (selection.periodType === 'range') {
    params.set('start', selection.start);
    params.set('end', selection.end);
  }
  return params.toString();
}

function normalizeSelection(selection: UsageSelection | number): UsageSelection {
  if (typeof selection !== 'number') return selection;
  return { scope: 'org', periodType: 'lookback', period: selection as 1 | 24 | 168 | 720 | 8760 };
}

export const usageKeys = {
  all: ['usage'] as const,
  stats: (selection: UsageSelection) => [...usageKeys.all, 'stats', usageSearchParams(selection)] as const,
};

export function useUsageStats(selection: UsageSelection | number = 720) {
  const normalized = normalizeSelection(selection);
  return useQuery({
    queryKey: usageKeys.stats(normalized),
    queryFn: () => api.get<UsageStatsResponse>(`/usage/stats?${usageSearchParams(normalized)}`),
    refetchInterval: 300_000,
  });
}

export async function downloadUsageCsv(selection: UsageSelection, asOf?: string): Promise<void> {
  const response = await api.fetch(`/usage/export.csv?${usageSearchParams(selection, asOf)}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? 'Usage export failed');
  }
  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? 'valet-usage.csv';
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
