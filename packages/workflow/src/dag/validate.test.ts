import { describe, it, expect } from 'vitest';

import { validateWorkflowDefinition } from './validate.js';
import type { WorkflowDefinition } from './shape.js';

function definition(overrides: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [
      { id: 'trigger', type: 'trigger' },
      { id: 'set-a', type: 'set', values: { hello: 'world' } },
      { id: 'stop', type: 'stop' },
    ],
    edges: [
      { from: 'trigger', to: 'set-a' },
      { from: 'set-a', to: 'stop' },
    ],
    ...overrides,
  };
}

describe('validateWorkflowDefinition', () => {
  it('accepts a valid fixture', () => {
    const result = validateWorkflowDefinition(definition({}));
    expect(result).toEqual({ ok: true });
  });

  it('rejects duplicate node ids', () => {
    const result = validateWorkflowDefinition(
      definition({
        nodes: [
          { id: 'trigger', type: 'trigger' },
          { id: 'set-a', type: 'set', values: {} },
          { id: 'set-a', type: 'set', values: {} },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('duplicate node id'))).toBe(true);
    }
  });

  it('rejects two trigger nodes', () => {
    const result = validateWorkflowDefinition(
      definition({
        nodes: [
          { id: 'trigger', type: 'trigger' },
          { id: 'trigger-2', type: 'trigger' },
          { id: 'stop', type: 'stop' },
        ],
        edges: [],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('exactly one trigger node'))).toBe(true);
    }
  });

  it('rejects an edge targeting an unknown node', () => {
    const result = validateWorkflowDefinition(
      definition({
        edges: [
          { from: 'trigger', to: 'set-a' },
          { from: 'set-a', to: 'does-not-exist' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('unknown target node'))).toBe(true);
    }
  });

  it('rejects a cycle', () => {
    const result = validateWorkflowDefinition(
      definition({
        nodes: [
          { id: 'trigger', type: 'trigger' },
          { id: 'set-a', type: 'set', values: {} },
          { id: 'set-b', type: 'set', values: {} },
        ],
        edges: [
          { from: 'trigger', to: 'set-a' },
          { from: 'set-a', to: 'set-b' },
          { from: 'set-b', to: 'set-a' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('cycle detected'))).toBe(true);
    }
  });

  it('rejects fromOutput on an edge leaving a non-if/approval node', () => {
    const result = validateWorkflowDefinition(
      definition({
        edges: [
          { from: 'trigger', to: 'set-a' },
          { from: 'set-a', to: 'stop', fromOutput: 'true' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('fromOutput is only valid'))).toBe(true);
    }
  });

  it('allows fromOutput on an edge leaving an if node', () => {
    const result = validateWorkflowDefinition(
      definition({
        nodes: [
          { id: 'trigger', type: 'trigger' },
          { id: 'check', type: 'if', conditions: [] },
          { id: 'stop', type: 'stop' },
        ],
        edges: [
          { from: 'trigger', to: 'check' },
          { from: 'check', to: 'stop', fromOutput: 'true' },
        ],
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects an unparseable wait.duration', () => {
    const result = validateWorkflowDefinition(
      definition({
        nodes: [
          { id: 'trigger', type: 'trigger' },
          { id: 'pause', type: 'wait', mode: 'duration', duration: 'not-a-duration' },
          { id: 'stop', type: 'stop' },
        ],
        edges: [
          { from: 'trigger', to: 'pause' },
          { from: 'pause', to: 'stop' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('unparseable wait.duration'))).toBe(true);
    }
  });

  it('rejects an unsupported node type', () => {
    // `llm` is a real dag/v1 node type in main but is out of scope for
    // Phase 5 (see plan Global Constraints), so it's absent from the
    // `WorkflowNode` union. Definitions the validator sees at runtime come
    // from storage/JSON, not the type checker, so a definition containing
    // a legacy/unsupported node type is exactly what the runtime guard
    // exists to catch. Round-trip through JSON (as real callers would) and
    // narrow with a single assertion rather than fighting the literal
    // union at the call site.
    const raw: WorkflowDefinition = JSON.parse(
      JSON.stringify({
        version: 'dag/v1',
        nodes: [
          { id: 'trigger', type: 'trigger' },
          { id: 'legacy', type: 'llm' },
          { id: 'stop', type: 'stop' },
        ],
        edges: [
          { from: 'trigger', to: 'legacy' },
          { from: 'legacy', to: 'stop' },
        ],
      }),
    ) as WorkflowDefinition;

    const result = validateWorkflowDefinition(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('unsupported node type'))).toBe(true);
    }
  });
});
