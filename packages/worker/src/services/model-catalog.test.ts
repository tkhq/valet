import { describe, it, expect } from 'vitest';
import { computeCost, type ModelPricing } from './model-catalog.js';
import type { LlmTokenSums } from '../lib/db/analytics.js';

const SONNET: ModelPricing = {
  inputCostPerMillion: 3,
  outputCostPerMillion: 15,
  cacheReadCostPerMillion: 0.3,
  cacheWriteCostPerMillion: 3.75,
};

const pricing = (entries: Record<string, ModelPricing>) => new Map(Object.entries(entries));

const tokens = (t: Partial<LlmTokenSums>): LlmTokenSums => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  ...t,
});

describe('computeCost', () => {
  it('returns null for models without pricing', () => {
    expect(computeCost('anthropic/unknown', tokens({ inputTokens: 1_000_000 }), pricing({}))).toBeNull();
  });

  it('bills each cache tier at its own rate', () => {
    const map = pricing({ 'anthropic/claude-sonnet-4-5': SONNET });
    const cost = computeCost(
      'anthropic/claude-sonnet-4-5',
      tokens({ inputTokens: 1_000_000, cacheReadTokens: 10_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000 }),
      map,
    );
    // 1M * $3 + 10M * $0.30 + 1M * $3.75 + 1M * $15
    expect(cost).toBeCloseTo(3 + 3 + 3.75 + 15, 10);
  });

  it('bills reasoning tokens as output', () => {
    const map = pricing({ 'openai/gpt-5.1': { inputCostPerMillion: 1.25, outputCostPerMillion: 10, cacheReadCostPerMillion: 0.125, cacheWriteCostPerMillion: null } });
    const cost = computeCost(
      'openai/gpt-5.1',
      tokens({ outputTokens: 1_000_000, reasoningTokens: 2_000_000 }),
      map,
    );
    expect(cost).toBeCloseTo(30, 10);
  });

  it('falls back to the full input rate when cache rates are unpublished', () => {
    const map = pricing({ 'custom/model': { inputCostPerMillion: 2, outputCostPerMillion: 8, cacheReadCostPerMillion: null, cacheWriteCostPerMillion: null } });
    const cost = computeCost(
      'custom/model',
      tokens({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }),
      map,
    );
    // All three input-side tiers at $2/M — the pre-tiered behavior.
    expect(cost).toBeCloseTo(6, 10);
  });

  it('prices a cache-read-dominated agent workload at roughly a quarter of the flat-rate figure', () => {
    // Aggregates observed in a real month of orchestrator-heavy usage: cache
    // reads are >90% of input-side tokens, so flat-rate pricing inflates ~4.5x.
    const map = pricing({ 'anthropic/claude-sonnet-4-5': SONNET });
    const usage = tokens({
      inputTokens: 94_939,
      cacheReadTokens: 4_592_301_200,
      cacheWriteTokens: 445_100_864,
      outputTokens: 25_743_089,
    });
    const tiered = computeCost('anthropic/claude-sonnet-4-5', usage, map);
    const flat =
      ((usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens) * SONNET.inputCostPerMillion +
        usage.outputTokens * SONNET.outputCostPerMillion) / 1_000_000;
    expect(tiered).toBeCloseTo(3433.25, 0);
    expect(flat / (tiered ?? 1)).toBeGreaterThan(4);
  });
});
