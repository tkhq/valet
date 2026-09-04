/**
 * Reasoning/thinking-level vocabulary for the org and per-user reasoning
 * settings (`GET`/`PATCH /api/org/reasoning`, `MeResponse.defaultReasoning`).
 * Levels are ordered low to high; a `max` cap restricts which levels a UI
 * offers.
 */
export const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export const REASONING_LABELS: Record<ReasoningLevel, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

/**
 * Reasoning levels up to and including `max` (inclusive). An unset or
 * unrecognized cap returns the full ordered list — the cap is
 * unrestricted in that case, not zero.
 */
export function levelsUpTo(max: string | undefined): ReasoningLevel[] {
  const idx = max ? (REASONING_LEVELS as readonly string[]).indexOf(max) : -1;
  if (idx < 0) return [...REASONING_LEVELS];
  return REASONING_LEVELS.slice(0, idx + 1);
}
