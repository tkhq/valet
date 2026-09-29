import { describe, expect, it } from 'vitest';
import { normalizeLegacyDefinition } from './legacy.js';

describe('normalizeLegacyDefinition', () => {
  it('renames orchestrator steps, including foreach bodies, and drops assistantId', () => {
    const legacy = {
      version: 'dag/v1',
      assistantId: 'asst_old',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'o', type: 'orchestrator', prompt: 'hi', wait: { mode: 'until_idle' } },
        { id: 'f', type: 'foreach', items: '{{x}}', body: { id: 'b', type: 'orchestrator', prompt: 'each' } },
      ],
      edges: [{ from: 't', to: 'o' }],
    };
    expect(normalizeLegacyDefinition(legacy)).toEqual({
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'o', type: 'thread', prompt: 'hi', wait: { mode: 'until_idle' } },
        { id: 'f', type: 'foreach', items: '{{x}}', body: { id: 'b', type: 'thread', prompt: 'each' } },
      ],
      edges: [{ from: 't', to: 'o' }],
    });
  });

  it('returns the same reference when nothing needs a rewrite', () => {
    const current = { version: 'dag/v1', nodes: [{ id: 'a', type: 'thread', prompt: 'x' }], edges: [] };
    expect(normalizeLegacyDefinition(current)).toBe(current);
    for (const value of [null, 'text', [], { nodes: 'no' }]) expect(normalizeLegacyDefinition(value)).toBe(value);
  });
});
