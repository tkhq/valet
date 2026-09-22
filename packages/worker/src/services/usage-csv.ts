import type { UsageStatsResponse } from '@valet/shared';

export const USAGE_CSV_HEADERS = [
  'period_label', 'period_start', 'period_end', 'timezone', 'boundary', 'scope',
  'sandbox_usage_semantics', 'breakdown', 'dimension', 'secondary_dimension', 'input_tokens', 'output_tokens',
  'total_cost_usd', 'call_count', 'session_count', 'sandbox_cost_usd',
  'sandbox_active_seconds', 'percentage', 'total_users',
] as const;

type CsvRow = Partial<Record<(typeof USAGE_CSV_HEADERS)[number], string | number | null | undefined>>;

function csvCell(value: CsvRow[keyof CsvRow]): string {
  let text = value == null ? '' : String(value);
  if (typeof value === 'string' && /^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * Serialize the exact aggregates returned to the usage screen. No data is
 * re-queried or recomputed, so CSV and on-screen totals cannot use different windows.
 */
export function usageReportToCsv(report: UsageStatsResponse): string {
  const common = {
    period_label: report.report.label,
    period_start: report.report.start,
    period_end: report.report.end,
    timezone: report.report.timezone,
    boundary: report.report.boundary,
    scope: report.report.scope,
    sandbox_usage_semantics: report.report.sandboxUsage,
  };
  const rows: CsvRow[] = [{
    ...common,
    breakdown: 'total',
    dimension: 'all',
    input_tokens: report.hero.totalInputTokens,
    output_tokens: report.hero.totalOutputTokens,
    total_cost_usd: report.hero.totalCost,
    session_count: report.hero.totalSessions,
    sandbox_cost_usd: report.hero.sandboxCost,
    sandbox_active_seconds: report.hero.sandboxActiveSeconds,
    total_users: report.hero.totalUsers,
  }];

  for (const row of report.costByDay) rows.push({
    ...common, breakdown: 'day', dimension: row.date,
    input_tokens: row.inputTokens, output_tokens: row.outputTokens,
    total_cost_usd: row.cost == null ? (row.sandboxCost > 0 ? row.sandboxCost : null) : row.cost + row.sandboxCost,
    sandbox_cost_usd: row.sandboxCost, sandbox_active_seconds: row.sandboxActiveSeconds,
  });
  for (const row of report.byPurpose) rows.push({
    ...common, breakdown: 'origin', dimension: row.purpose,
    input_tokens: row.inputTokens, output_tokens: row.outputTokens,
    total_cost_usd: row.cost, call_count: row.callCount, percentage: row.percentage,
  });
  for (const row of report.byWorkflow) rows.push({
    ...common, breakdown: 'workflow', dimension: row.workflowName,
    secondary_dimension: row.triggerType, input_tokens: row.inputTokens,
    output_tokens: row.outputTokens, total_cost_usd: row.cost, call_count: row.callCount,
  });
  for (const row of report.byModel) rows.push({
    ...common, breakdown: 'model', dimension: row.model,
    input_tokens: row.inputTokens, output_tokens: row.outputTokens,
    total_cost_usd: row.cost, call_count: row.callCount, percentage: row.percentage,
  });
  for (const row of report.byUser) rows.push({
    ...common, breakdown: 'user', dimension: row.email,
    secondary_dimension: row.name, input_tokens: row.inputTokens,
    output_tokens: row.outputTokens, total_cost_usd: row.cost,
    session_count: row.sessionCount, sandbox_cost_usd: row.sandboxCost,
    sandbox_active_seconds: row.sandboxActiveSeconds,
  });
  for (const row of report.byUserModel) rows.push({
    ...common, breakdown: 'user_model', dimension: row.userId,
    secondary_dimension: row.model, input_tokens: row.inputTokens,
    output_tokens: row.outputTokens, total_cost_usd: row.cost, call_count: row.callCount,
  });

  return `${USAGE_CSV_HEADERS.join(',')}\n${rows.map((row) => USAGE_CSV_HEADERS.map((header) => csvCell(row[header])).join(',')).join('\n')}\n`;
}
