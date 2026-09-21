import { describe, expect, it } from 'vitest';
import type { UsageStatsResponse } from '@valet/shared';
import { USAGE_CSV_HEADERS, usageReportToCsv } from './usage-csv.js';

const report: UsageStatsResponse = {
  hero: { totalCost: 1.25, totalInputTokens: 100, totalOutputTokens: 20, totalSessions: 2, totalUsers: 1, sandboxCost: 0.25, sandboxActiveSeconds: 30 },
  costByDay: [{ date: '2024-02-01', cost: 1, inputTokens: 100, outputTokens: 20, sandboxCost: 0.25, sandboxActiveSeconds: 30 }],
  byUser: [{ userId: 'u1', email: 'accounting@example.com', name: 'Accounting, "Ops"', inputTokens: 100, outputTokens: 20, cost: 1.25, sessionCount: 2, sandboxCost: 0.25, sandboxActiveSeconds: 30 }],
  byModel: [{ model: 'model-a', inputTokens: 100, outputTokens: 20, cost: 1, callCount: 2, percentage: 100 }],
  byUserModel: [{ userId: 'u1', model: 'model-a', inputTokens: 100, outputTokens: 20, cost: 1, callCount: 2 }],
  byPurpose: [{ purpose: 'interactive', inputTokens: 100, outputTokens: 20, cost: 1, callCount: 2, percentage: 100 }],
  byWorkflow: [],
  period: 0,
  report: { scope: 'org', periodType: 'month', start: '2024-02-01T00:00:00.000Z', end: '2024-03-01T00:00:00.000Z', label: 'calendar-month_2024-02_UTC', timezone: 'UTC', boundary: 'start-inclusive/end-exclusive' },
};

describe('usageReportToCsv', () => {
  it('uses stable headers, an unambiguous label, and exact screen aggregates', () => {
    const csv = usageReportToCsv(report);
    expect(csv.split('\n')[0]).toBe(USAGE_CSV_HEADERS.join(','));
    expect(csv).toContain('"calendar-month_2024-02_UTC"');
    expect(csv).toContain('"start-inclusive/end-exclusive"');
    expect(csv).toContain('"total","all","","100","20","1.25"');
    expect(csv).toContain('"Accounting, ""Ops"""');
    expect(csv.trim().split('\n')).toHaveLength(7);
  });

  it('neutralizes spreadsheet formulas in text dimensions', () => {
    const csv = usageReportToCsv({
      ...report,
      byWorkflow: [{ workflowId: 'w1', workflowName: '=IMPORTXML("x")', triggerType: '@manual', inputTokens: 1, outputTokens: 1, cost: 0, callCount: 1 }],
    });
    expect(csv).toContain('"\'=IMPORTXML(""x"")"');
    expect(csv).toContain('"\'@manual"');
  });
});
