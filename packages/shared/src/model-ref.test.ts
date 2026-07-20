import { describe, expect, it } from 'vitest';
import { splitModelRef, isBareModelRef } from './model-ref.js';

describe('splitModelRef', () => {
  it('splits both dialects at the first separator', () => {
    expect(splitModelRef('anthropic/claude-sonnet-4-5')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
    expect(splitModelRef('anthropic:claude-sonnet-4-5')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
    expect(splitModelRef('ollama/llama3:70b')).toEqual({ provider: 'ollama', model: 'llama3:70b' });
    expect(splitModelRef('openrouter:anthropic/claude-x')).toEqual({ provider: 'openrouter', model: 'anthropic/claude-x' });
  });

  it('returns null for bare refs and edge separators', () => {
    for (const ref of ['claude-sonnet-4-5', ':claude', '/claude', 'anthropic:', 'anthropic/', '', '  ']) {
      expect(splitModelRef(ref)).toBeNull();
    }
  });
});

describe('isBareModelRef', () => {
  it('is true only when neither separator appears', () => {
    expect(isBareModelRef('claude-sonnet-4-5')).toBe(true);
    expect(isBareModelRef('anthropic/claude')).toBe(false);
    expect(isBareModelRef('llama3:70b')).toBe(false);
  });
});
