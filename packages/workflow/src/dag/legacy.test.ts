import { describe, expect, it } from 'vitest';
import { normalizeLegacyDefinition } from './legacy.js';

describe('normalizeLegacyDefinition', () => {
  it('drops the assistantId an earlier build stored on the definition', () => {
    const nodes = [{ id: 't', type: 'trigger' }, { id: 'o', type: 'orchestrator', prompt: 'hi' }];
    expect(normalizeLegacyDefinition({ version: 'dag/v1', assistantId: 'asst_old', nodes, edges: [] }))
      .toEqual({ version: 'dag/v1', nodes, edges: [] });
  });

  it('returns the same reference when nothing needs a rewrite', () => {
    const current = { version: 'dag/v1', nodes: [{ id: 'a', type: 'orchestrator', prompt: 'x' }], edges: [] };
    expect(normalizeLegacyDefinition(current)).toBe(current);
    for (const value of [null, 'text', [], { nodes: 'no' }]) expect(normalizeLegacyDefinition(value)).toBe(value);
  });
});
