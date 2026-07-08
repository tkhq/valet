// Pure helpers for the admin "Value metrics" panel. Kept free of D1 so the
// classification and window math are unit-testable without a database.

export type ModelTier = 'efficient' | 'standard' | 'frontier' | 'unknown';

// Name-pattern classification. Order matters: size/speed suffixes win over
// family names so "gpt-5-mini" and "gemini-2.5-flash" land in 'efficient'
// even though their families are frontier/standard. Word boundaries are
// required — "gemini" must not match "mini".
const EFFICIENT_PATTERN = /\b(haiku|mini|nano|flash|lite|small)\b/;
const FRONTIER_PATTERN = /\b(opus|fable|mythos|gpt-5|o1|o3|grok-4|ultra)\b/;
const STANDARD_PATTERN = /\b(sonnet|gpt-4|gemini|grok|deepseek|qwen|llama|mistral)\b/;

export function classifyModelTier(model: string): ModelTier {
  const m = model.toLowerCase();
  if (EFFICIENT_PATTERN.test(m)) return 'efficient';
  if (FRONTIER_PATTERN.test(m)) return 'frontier';
  if (STANDARD_PATTERN.test(m)) return 'standard';
  return 'unknown';
}

/** numerator/denominator, or null when the denominator is zero. */
export function safeRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

export interface ValueMetricWindows {
  currentStart: string;
  currentEnd: string;
  previousStart: string;
  previousEnd: string;
}

/**
 * Current window is the trailing `periodHours` from `now`; previous window is
 * the equal-length window immediately before it (used for delta badges).
 */
export function computeWindowBounds(now: Date, periodHours: number): ValueMetricWindows {
  const periodMs = periodHours * 60 * 60 * 1000;
  const currentEnd = now.toISOString();
  const currentStart = new Date(now.getTime() - periodMs).toISOString();
  const previousStart = new Date(now.getTime() - 2 * periodMs).toISOString();
  return { currentStart, currentEnd, previousStart, previousEnd: currentStart };
}
