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
    // Definitions the validator sees at runtime come from storage/JSON, not
    // the type checker, so a definition containing a legacy/unsupported
    // node type is exactly what the runtime guard exists to catch. Round-trip
    // through JSON (as real callers would) and narrow with a single
    // assertion rather than fighting the literal union at the call site.
    const raw: WorkflowDefinition = JSON.parse(
      JSON.stringify({
        version: 'dag/v1',
        nodes: [
          { id: 'trigger', type: 'trigger' },
          { id: 'legacy', type: 'legacy-node-type' },
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

  it('accepts a valid fixture including a `ui` field', () => {
    const result = validateWorkflowDefinition(
      definition({
        ui: {
          nodes: {
            trigger: { position: { x: 0, y: 0 } },
            'set-a': { position: { x: 260, y: 0 }, collapsed: true },
            stop: { position: { x: 520, y: 0 } },
          },
          viewport: { x: 0, y: 0, zoom: 1 },
        },
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects session wait.timeout', () => {
    const result = validateWorkflowDefinition(
      definition({
        nodes: [
          { id: 'trigger', type: 'trigger' },
          {
            id: 'sess',
            type: 'session',
            mode: 'start',
            prompt: 'do it',
            wait: { mode: 'until_idle', timeout: '5m' },
          },
          { id: 'stop', type: 'stop' },
        ],
        edges: [
          { from: 'trigger', to: 'sess' },
          { from: 'sess', to: 'stop' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('session wait.timeout is not implemented — omit it'))).toBe(true);
    }
  });

  describe('llm node', () => {
    function llmDefinition(overrides: Partial<{ model: string; prompt: string }>): WorkflowDefinition {
      return definition({
        nodes: [
          { id: 'trigger', type: 'trigger' },
          { id: 'ask', type: 'llm', model: 'anthropic/claude-sonnet', prompt: 'summarize', ...overrides },
          { id: 'stop', type: 'stop' },
        ],
        edges: [
          { from: 'trigger', to: 'ask' },
          { from: 'ask', to: 'stop' },
        ],
      });
    }

    it('accepts a valid llm node', () => {
      expect(validateWorkflowDefinition(llmDefinition({}))).toEqual({ ok: true });
    });

    it('rejects an empty model', () => {
      const result = validateWorkflowDefinition(llmDefinition({ model: '' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('llm.model must be a non-empty string'))).toBe(true);
      }
    });

    it('rejects an empty prompt', () => {
      const result = validateWorkflowDefinition(llmDefinition({ prompt: '   ' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('llm.prompt must be a non-empty string'))).toBe(true);
      }
    });

    it('reports missing if.conditions / set.values / wait.duration as errors instead of throwing', () => {
      // Regression: an LLM-authored `if` node with a `condition` string
      // (not the `conditions` array) crashed the interpreter's drive loop
      // AND the web canvas with `undefined.length`. Same class of bug for
      // set.values and wait.duration (`.trim()` on undefined).
      const result = validateWorkflowDefinition({
        version: 'dag/v1',
        nodes: [
          { id: 'trigger', type: 'trigger' },
          { id: 'branch', type: 'if' } as unknown as WorkflowDefinition['nodes'][number],
          { id: 'vals', type: 'set' } as unknown as WorkflowDefinition['nodes'][number],
          { id: 'pause', type: 'wait', mode: 'duration' } as unknown as WorkflowDefinition['nodes'][number],
          { id: 'stop', type: 'stop' },
        ],
        edges: [
          { from: 'trigger', to: 'branch' },
          { from: 'branch', to: 'vals', fromOutput: 'true' },
          { from: 'branch', to: 'stop', fromOutput: 'false' },
          { from: 'vals', to: 'pause' },
          { from: 'pause', to: 'stop' },
        ],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('if.conditions must be an array'))).toBe(true);
        expect(result.errors.some((e) => e.includes('set.values must be an object'))).toBe(true);
        expect(result.errors.some((e) => e.includes('unparseable wait.duration'))).toBe(true);
      }
    });

    it('reports missing model/prompt as errors instead of throwing', () => {
      // Regression: `.trim()` used to be called unconditionally, so an LLM
      // node without `model`/`prompt` threw a TypeError before any error
      // could accumulate. Callers now see a validation error instead.
      const result = validateWorkflowDefinition(
        llmDefinition({}) && {
          version: 'dag/v1',
          nodes: [
            { id: 'trigger', type: 'trigger' },
            { id: 'ask', type: 'llm' } as unknown as WorkflowDefinition['nodes'][number],
            { id: 'stop', type: 'stop' },
          ],
          edges: [
            { from: 'trigger', to: 'ask' },
            { from: 'ask', to: 'stop' },
          ],
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('llm.model must be a non-empty string'))).toBe(true);
        expect(result.errors.some((e) => e.includes('llm.prompt must be a non-empty string'))).toBe(true);
      }
    });
  });

  describe('orchestrator node', () => {
    it('accepts a valid orchestrator node', () => {
      const result = validateWorkflowDefinition(
        definition({
          nodes: [
            { id: 'trigger', type: 'trigger' },
            { id: 'ask', type: 'orchestrator', prompt: 'do the thing' },
            { id: 'stop', type: 'stop' },
          ],
          edges: [
            { from: 'trigger', to: 'ask' },
            { from: 'ask', to: 'stop' },
          ],
        }),
      );
      expect(result).toEqual({ ok: true });
    });

    it('rejects an empty prompt', () => {
      const result = validateWorkflowDefinition(
        definition({
          nodes: [
            { id: 'trigger', type: 'trigger' },
            { id: 'ask', type: 'orchestrator', prompt: '' },
            { id: 'stop', type: 'stop' },
          ],
          edges: [
            { from: 'trigger', to: 'ask' },
            { from: 'ask', to: 'stop' },
          ],
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('orchestrator.prompt must be a non-empty string'))).toBe(true);
      }
    });
  });

  describe('tool node', () => {
    function toolDefinition(overrides: Partial<{ service: string; action: string }>): WorkflowDefinition {
      return definition({
        nodes: [
          { id: 'trigger', type: 'trigger' },
          { id: 'call', type: 'tool', service: 'slack', action: 'send_message', params: {}, ...overrides },
          { id: 'stop', type: 'stop' },
        ],
        edges: [
          { from: 'trigger', to: 'call' },
          { from: 'call', to: 'stop' },
        ],
      });
    }

    it('accepts a valid tool node', () => {
      expect(validateWorkflowDefinition(toolDefinition({}))).toEqual({ ok: true });
    });

    it('rejects an empty service', () => {
      const result = validateWorkflowDefinition(toolDefinition({ service: '' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('tool.service must be a non-empty string'))).toBe(true);
      }
    });

    it('rejects an empty action', () => {
      const result = validateWorkflowDefinition(toolDefinition({ action: '' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('tool.action must be a non-empty string'))).toBe(true);
      }
    });
  });

  describe('foreach node', () => {
    // Several of these cases construct deliberately invalid foreach shapes
    // (disallowed body types, malformed maxItems/concurrency) that don't fit
    // the `ForeachNode` interface — the whole point is exercising the
    // runtime guard on data the type checker would otherwise reject. Build
    // the raw JSON (as real callers' stored definitions would look) and
    // narrow with a single assertion, mirroring the "unsupported node type"
    // fixture above.
    function foreachDefinition(node: Record<string, unknown>): WorkflowDefinition {
      return JSON.parse(
        JSON.stringify({
          version: 'dag/v1',
          nodes: [
            { id: 'trigger', type: 'trigger' },
            {
              id: 'loop',
              type: 'foreach',
              items: '${trigger.data.items}',
              body: { id: 'loop-body', type: 'set', values: {} },
              ...node,
            },
            { id: 'stop', type: 'stop' },
          ],
          edges: [
            { from: 'trigger', to: 'loop' },
            { from: 'loop', to: 'stop' },
          ],
        }),
      ) as WorkflowDefinition;
    }

    it('accepts a valid foreach node', () => {
      expect(validateWorkflowDefinition(foreachDefinition({}))).toEqual({ ok: true });
    });

    it('rejects session wait.timeout inside a foreach body', () => {
      const result = validateWorkflowDefinition(
        foreachDefinition({
          body: {
            id: 'loop-body',
            type: 'session',
            mode: 'start',
            prompt: 'do the thing for ${item}',
            wait: { mode: 'until_idle', timeout: '5m' },
          },
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some(
            (e) => e.includes('loop.body (loop-body)') && e.includes('session wait.timeout is not implemented'),
          ),
        ).toBe(true);
      }
    });

    it('rejects an empty items expression', () => {
      const result = validateWorkflowDefinition(foreachDefinition({ items: '' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('foreach.items must be a non-empty string'))).toBe(true);
      }
    });

    it.each(['foreach', 'if', 'approval', 'stop'])('rejects a %s body type', (bodyType) => {
      const result = validateWorkflowDefinition(
        foreachDefinition({ body: { id: 'loop-body', type: bodyType } }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('is not allowed'))).toBe(true);
      }
    });

    it('rejects a body id that collides with a definition node id', () => {
      const result = validateWorkflowDefinition(foreachDefinition({ body: { id: 'stop', type: 'set', values: {} } }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('collides with a definition node id'))).toBe(true);
      }
    });

    it('rejects two foreach nodes sharing the same body id, naming both foreach nodes', () => {
      const definition: WorkflowDefinition = JSON.parse(
        JSON.stringify({
          version: 'dag/v1',
          nodes: [
            { id: 'trigger', type: 'trigger' },
            { id: 'loop-a', type: 'foreach', items: '${trigger.data.items}', body: { id: 'body', type: 'set', values: {} } },
            { id: 'loop-b', type: 'foreach', items: '${trigger.data.items}', body: { id: 'body', type: 'set', values: {} } },
            { id: 'stop', type: 'stop' },
          ],
          edges: [
            { from: 'trigger', to: 'loop-a' },
            { from: 'loop-a', to: 'loop-b' },
            { from: 'loop-b', to: 'stop' },
          ],
        }),
      );
      const result = validateWorkflowDefinition(definition);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some(
            (e) => e.includes(JSON.stringify('body')) && e.includes('loop-a') && e.includes('loop-b'),
          ),
        ).toBe(true);
      }
    });

    it('validates the body node\'s own type-specific rules, naming the foreach and body', () => {
      const result = validateWorkflowDefinition(
        foreachDefinition({ body: { id: 'loop-body', type: 'llm', model: '', prompt: 'x' } }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((e) => e.includes('loop.body (loop-body)') && e.includes('llm.model must be a non-empty string')),
        ).toBe(true);
      }
    });

    it.each([0, -1, 1.5])('rejects a non-positive-integer maxItems (%s)', (maxItems) => {
      const result = validateWorkflowDefinition(foreachDefinition({ maxItems }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('foreach.maxItems must be a positive integer'))).toBe(true);
      }
    });

    it.each([0, -1, 1.5])('rejects a non-positive-integer concurrency (%s)', (concurrency) => {
      const result = validateWorkflowDefinition(foreachDefinition({ concurrency }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('foreach.concurrency must be a positive integer'))).toBe(true);
      }
    });

    it('rejects concurrency above 10', () => {
      const result = validateWorkflowDefinition(foreachDefinition({ concurrency: 11 }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('foreach.concurrency must be <= 10'))).toBe(true);
      }
    });

    it('accepts concurrency of exactly 10', () => {
      expect(validateWorkflowDefinition(foreachDefinition({ concurrency: 10 }))).toEqual({ ok: true });
    });
  });
});
