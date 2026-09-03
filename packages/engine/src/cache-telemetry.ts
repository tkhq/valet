/**
 * Prompt-cache break detection (TKAI-320). Pure classification over
 * per-turn snapshots; the thread records the metric and log line. This is
 * the alert side of alert-don't-auto-repair: a sustained break rate means
 * something rewrites the request prefix every turn (a per-turn system
 * prompt overlay, a mutating tool list) and the cause label says what to
 * investigate. Nothing here repairs anything.
 */

export interface CacheTurnSnapshot {
  /** Total prompt tokens of the turn's last request: input + cacheRead + cacheWrite. */
  promptTokens: number;
  /** Cache-read tokens the provider reported for that request. */
  cacheRead: number;
  modelId: string;
  systemPromptLength: number;
  toolCount: number;
}

export type CacheBreakCause =
  | "model_changed"
  | "system_prompt_changed"
  | "tools_changed"
  | "ttl_or_content";

/**
 * A break means the newest request re-paid for a prefix the previous turn
 * already cached. Detection: the previous turn's whole prompt should be a
 * cached prefix of this one, so this turn's cacheRead should be at least
 * ~that size. Thresholds are deliberately loose (50% and an absolute 2k
 * floor) — mid-turn tool rounds and elision make exact accounting noisy,
 * and a false alert erodes trust in the counter.
 */
export function classifyCacheBreak(
  prev: CacheTurnSnapshot,
  current: CacheTurnSnapshot,
): CacheBreakCause | undefined {
  if (prev.promptTokens < 4_000) return undefined; // too small to matter
  const expectedRead = prev.promptTokens;
  const shortfall = expectedRead - current.cacheRead;
  if (current.cacheRead >= expectedRead * 0.5 || shortfall < 2_000) return undefined;
  if (current.modelId !== prev.modelId) return "model_changed";
  if (current.systemPromptLength !== prev.systemPromptLength) return "system_prompt_changed";
  if (current.toolCount !== prev.toolCount) return "tools_changed";
  return "ttl_or_content";
}
