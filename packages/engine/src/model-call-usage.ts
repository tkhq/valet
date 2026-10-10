import type { MessageCost, MessageUsage } from "./types.js";

/** One model call's counters as the provider reports them (pi-ai `Usage`). */
export interface ReportedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/**
 * What a model call persists, by the rule every usage writer shares: the
 * engine's turns and the API's workflow LLM steps.
 *
 * - `reported` always carries the counts; `total` falls back to the
 *   four-way sum when the provider reports no total.
 * - `usage` is present only when that total is above zero. All-zero usage
 *   (dev fakes, providers that do not report) means "no usage reported".
 * - `cost` is present only when the provider reported a price above zero.
 *   A missing cost reads "unpriced", never "$0".
 */
export function modelCallUsage(u: ReportedUsage): { reported: MessageUsage; usage?: MessageUsage; cost?: MessageCost } {
  const reported: MessageUsage = {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    total: u.totalTokens || u.input + u.output + u.cacheRead + u.cacheWrite,
  };
  const c = u.cost;
  return {
    reported,
    ...(reported.total > 0 ? { usage: { ...reported } } : {}),
    ...(c && c.total > 0
      ? { cost: { input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite, total: c.total } }
      : {}),
  };
}
