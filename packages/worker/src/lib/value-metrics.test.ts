import { describe, expect, it } from 'vitest';
import { classifyModelTier, safeRate, computeWindowBounds } from './value-metrics.js';

describe('classifyModelTier', () => {
  it('classifies size/speed suffixes as efficient even in frontier families', () => {
    expect(classifyModelTier('anthropic/claude-haiku-4-5')).toBe('efficient');
    expect(classifyModelTier('openai/gpt-5-mini')).toBe('efficient');
    expect(classifyModelTier('google/gemini-2.5-flash')).toBe('efficient');
    expect(classifyModelTier('openai/gpt-4.1-nano')).toBe('efficient');
  });

  it('classifies frontier models', () => {
    expect(classifyModelTier('anthropic/claude-opus-4')).toBe('frontier');
    expect(classifyModelTier('anthropic/claude-fable-5')).toBe('frontier');
    expect(classifyModelTier('openai/gpt-5')).toBe('frontier');
    expect(classifyModelTier('openai/o3')).toBe('frontier');
  });

  it('classifies mid-tier families as standard', () => {
    expect(classifyModelTier('anthropic/claude-sonnet-5')).toBe('standard');
    expect(classifyModelTier('google/gemini-2.5-pro')).toBe('standard');
  });

  it('returns unknown for unrecognized models', () => {
    expect(classifyModelTier('acme/secret-model-v2')).toBe('unknown');
  });
});

describe('safeRate', () => {
  it('returns the fraction', () => {
    expect(safeRate(1, 4)).toBe(0.25);
  });

  it('returns null on an empty denominator', () => {
    expect(safeRate(0, 0)).toBeNull();
    expect(safeRate(5, 0)).toBeNull();
  });
});

describe('computeWindowBounds', () => {
  it('produces adjacent equal-length windows', () => {
    const now = new Date('2026-07-08T00:00:00.000Z');
    const w = computeWindowBounds(now, 168); // 7 days
    expect(w.currentEnd).toBe('2026-07-08T00:00:00.000Z');
    expect(w.currentStart).toBe('2026-07-01T00:00:00.000Z');
    expect(w.previousEnd).toBe(w.currentStart);
    expect(w.previousStart).toBe('2026-06-24T00:00:00.000Z');
  });
});
