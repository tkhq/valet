import { describe, it, expect } from 'vitest';
import { validateDefinition, validateDefinitionWithContext, validateTriggerData, validateAgainstEnvironment, validateAgainstAvailableModels, isValidationWarning } from './validator.js';
import type { WorkflowDefinition } from '@valet/shared';
import type { Env } from '../../env.js';

function definition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [
      { id: 'start', type: 'set', values: { hello: 'world' } },
      { id: 'finish', type: 'stop' },
    ],
    edges: [{ from: 'start', to: 'finish' }],
    ...overrides,
  };
}

// Filter out the non-blocking warnings (advisories, not publish blockers).
// Delegates to the real classifier so this test helper stays in sync as
// new warning codes are added (e.g. unknown_tool_service).
function blockingErrors(errs: ReturnType<typeof validateDefinition>) {
  return errs.filter((e) => !isValidationWarning(e));
}

describe('validateDefinition', () => {
  it('accepts a simple valid definition', () => {
    expect(blockingErrors(validateDefinition(definition()))).toEqual([]);
  });

  it('is total — returns malformed_definition for non-object input', () => {
    const errs = validateDefinition(null);
    expect(errs.some((e) => e.code === 'malformed_definition')).toBe(true);
    expect(validateDefinition('not-an-object').some((e) => e.code === 'malformed_definition')).toBe(true);
  });

  it('returns malformed_definition when nodes is not an array', () => {
    const errs = validateDefinition({ version: 'dag/v1', edges: [] });
    expect(errs.some((e) => e.code === 'malformed_definition')).toBe(true);
  });

  it('returns malformed_definition when edges is not an array', () => {
    const errs = validateDefinition({ version: 'dag/v1', nodes: [] });
    expect(errs.some((e) => e.code === 'malformed_definition')).toBe(true);
  });

  it('returns malformed_definition for the wrong version', () => {
    const errs = validateDefinition({ version: 'steps/v1', nodes: [], edges: [] });
    expect(errs.some((e) => e.code === 'malformed_definition')).toBe(true);
  });

  it('rejects top-level workflow inputs', () => {
    const errs = validateDefinition({
      version: 'dag/v1',
      inputs: { owner: { type: 'string' } },
      nodes: [{ id: 'trigger', type: 'trigger' }],
      edges: [],
    });

    expect(errs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'malformed_definition',
        message: expect.stringContaining('inputs'),
      }),
    ]));
  });

  it('accepts output schemas on session and orchestrator nodes', () => {
    const outputSchema = {
      type: 'object',
      properties: { totalCount: { type: 'number' } },
      required: ['totalCount'],
    };
    const errs = validateDefinition({
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        {
          id: 'scrape',
          type: 'session',
          mode: 'start',
          prompt: 'scrape',
          workspace: 'scrape-test',
          wait: { mode: 'until_idle' },
          outputSchema,
          repairModel: 'anthropic:claude-sonnet-4-5',
        },
        {
          id: 'summarize',
          type: 'orchestrator',
          prompt: 'summarize',
          wait: { mode: 'until_idle' },
          outputSchema,
          repairModel: 'anthropic:claude-sonnet-4-5',
        },
      ],
      edges: [
        { from: 'trigger', to: 'scrape' },
        { from: 'scrape', to: 'summarize' },
      ],
    });

    expect(blockingErrors(errs)).toEqual([]);
  });

  it('adds node id and type context to malformed node field messages', () => {
    const errs = validateDefinition({
      version: 'dag/v1',
      nodes: [
        { id: 'start', type: 'trigger' },
        {
          id: 'route',
          type: 'if',
          conditions: [{ left: 'trigger.data.ok', dataType: 'boolean', op: 'equals', right: true }],
        },
      ],
      edges: [],
    });

    expect(errs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'malformed_definition',
        message: expect.stringContaining('nodes.1 (id: "route", type: "if")'),
      }),
    ]));
    expect(errs.map((e) => e.message).join('\n')).toContain('conditions.0.operation');
  });

  it('returns a helpful unknown node type error before node-specific discriminator errors', () => {
    const errs = validateDefinition({
      version: 'dag/v1',
      nodes: [
        { id: 'start', type: 'trigger' },
        { id: 'run_script', type: 'bash', command: 'echo hello', mode: 'start' },
      ],
      edges: [],
    });

    expect(errs).toEqual([
      expect.objectContaining({
        code: 'unknown_node_type',
        path: 'nodes.1.type',
        nodeId: 'run_script',
        message: expect.stringContaining('Unknown node type "bash"'),
      }),
    ]);
    expect(errs[0]!.message).toContain('trigger, llm, tool, set, if, wait, approval, foreach, loop, orchestrator, session, stop');
    expect(errs[0]!.message).not.toContain('mode');
  });

  it('suggests current node type names for legacy aliases', () => {
    const errs = validateDefinition({
      version: 'dag/v1',
      nodes: [{ id: 'ask_agent', type: 'agent_prompt', prompt: 'hello' }],
      edges: [],
    });

    expect(errs).toEqual([
      expect.objectContaining({
        code: 'unknown_node_type',
        message: expect.stringContaining('Did you mean "llm"?'),
      }),
    ]);
  });

  it('returns a helpful unknown foreach body type error', () => {
    const errs = validateDefinition({
      version: 'dag/v1',
      nodes: [
        {
          id: 'each_item',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          body: { id: 'route_item', type: 'if', conditions: [] },
        },
      ],
      edges: [],
    });

    expect(errs).toEqual([
      expect.objectContaining({
        code: 'unknown_foreach_body_type',
        path: 'nodes.0.body.type',
        nodeId: 'route_item',
        message: expect.stringContaining('foreach body type "if" is not allowed'),
      }),
    ]);
    expect(errs[0]!.message).toContain('llm, tool, set, stop, orchestrator, session');
  });

  it('returns a helpful unknown loop body type error', () => {
    const errs = validateDefinition({
      version: 'dag/v1',
      nodes: [
        {
          id: 'refine',
          type: 'loop',
          maxIterations: 3,
          body: [{ id: 'route_item', type: 'if', conditions: [] }],
        },
      ],
      edges: [],
    });

    expect(errs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'unknown_loop_body_type',
        path: 'nodes.0.body.0.type',
        nodeId: 'route_item',
        message: expect.stringContaining('loop body step type "if" is not allowed'),
      }),
    ]));
    expect(errs.find((e) => e.code === 'unknown_loop_body_type')!.message).toContain('llm, tool, set, stop, orchestrator, session');
  });

  it('accepts a valid loop node with an until condition', () => {
    const def = definition({
      nodes: [
        {
          id: 'refine',
          type: 'loop',
          maxIterations: 5,
          body: [
            { id: 'draft', type: 'llm', prompt: 'draft it', maxOutputTokens: 500 },
            { id: 'review', type: 'llm', prompt: 'review it', maxOutputTokens: 500, outputSchema: { approved: { type: 'boolean' } } },
          ],
          until: { conditions: [{ left: 'steps.review.approved', dataType: 'boolean', operation: 'isTrue' }] },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'refine', to: 'finish' }],
    });

    expect(blockingErrors(validateDefinition(def))).toEqual([]);
  });

  it('rejects duplicate node IDs within a single loop body', () => {
    const def = definition({
      nodes: [
        {
          id: 'refine',
          type: 'loop',
          maxIterations: 3,
          body: [
            { id: 'dup', type: 'set', values: {} },
            { id: 'dup', type: 'set', values: {} },
          ],
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'refine', to: 'finish' }],
    });

    const errs = blockingErrors(validateDefinition(def));
    expect(errs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'duplicate_id',
        nodeId: 'refine',
        message: expect.stringContaining('two steps of loop "refine" share an id'),
      }),
    ]));
  });

  it('rejects an invalid regex in a loop until condition, same as an if node', () => {
    const def = definition({
      nodes: [
        {
          id: 'refine',
          type: 'loop',
          maxIterations: 3,
          body: [{ id: 'draft', type: 'set', values: {} }],
          until: {
            conditions: [{ left: 'steps.draft.status', dataType: 'string', operation: 'matchesRegex', right: '(unterminated' }],
          },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'refine', to: 'finish' }],
    });

    const errs = blockingErrors(validateDefinition(def));
    expect(errs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'invalid_regex',
        nodeId: 'refine',
        path: 'until.conditions.right',
      }),
    ]));
  });

  it('rejects an unsupported operation for the dataType in a loop until condition', () => {
    const def = definition({
      nodes: [
        {
          id: 'refine',
          type: 'loop',
          maxIterations: 3,
          body: [{ id: 'draft', type: 'set', values: {} }],
          until: {
            conditions: [{ left: 'steps.draft.count', dataType: 'number', operation: 'matchesRegex', right: 'x' }],
          },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'refine', to: 'finish' }],
    });

    const errs = blockingErrors(validateDefinition(def));
    expect(errs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'if_operation_unsupported',
        nodeId: 'refine',
        path: 'until.conditions.operation',
      }),
    ]));
  });

  it('enforces maxIterations bounds via the node schema', () => {
    const tooMany = definition({
      nodes: [
        {
          id: 'refine',
          type: 'loop',
          maxIterations: 26,
          body: [{ id: 'draft', type: 'set', values: {} }],
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'refine', to: 'finish' }],
    });
    const errs = blockingErrors(validateDefinition(tooMany));
    expect(errs.length).toBeGreaterThan(0);

    const withinBounds = definition({
      nodes: [
        {
          id: 'refine',
          type: 'loop',
          maxIterations: 25,
          body: [{ id: 'draft', type: 'set', values: {} }],
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'refine', to: 'finish' }],
    });
    expect(blockingErrors(validateDefinition(withinBounds))).toEqual([]);
  });

  it('rejects duplicate node IDs', () => {
    const def = definition({
      nodes: [
        { id: 'dup', type: 'set', values: {} },
        { id: 'dup', type: 'stop' },
      ],
      edges: [],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'duplicate_id')).toBe(true);
  });

  it('rejects edges referencing unknown nodes', () => {
    const def = definition({ edges: [{ from: 'start', to: 'missing' }] });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'edge_to_unknown')).toBe(true);
  });

  it('rejects self-loop edges', () => {
    const def = definition({ edges: [{ from: 'start', to: 'start' }] });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'edge_self_loop')).toBe(true);
  });

  it('rejects edges leaving a stop node', () => {
    const def = definition({
      nodes: [
        { id: 'a', type: 'stop' },
        { id: 'b', type: 'set', values: {} },
      ],
      edges: [{ from: 'a', to: 'b' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'edge_from_stop')).toBe(true);
  });

  it('detects cycles', () => {
    const def = definition({
      nodes: [
        { id: 'a', type: 'set', values: {} },
        { id: 'b', type: 'set', values: {} },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'cycle')).toBe(true);
  });

  it('requires fromOutput on edges leaving an if node', () => {
    const def = definition({
      nodes: [
        { id: 'route', type: 'if', conditions: [{ left: 'trigger.data.x', dataType: 'string', operation: 'equals', right: 'a' }] },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'route', to: 'finish' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'if_edge_missing_fromOutput')).toBe(true);
  });

  it('rejects fromOutput on edges from non-if nodes', () => {
    const def = definition({
      edges: [{ from: 'start', to: 'finish', fromOutput: 'true' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'fromOutput_on_non_if')).toBe(true);
  });

  it('rejects an unparseable edge when predicate', () => {
    const def = definition({
      edges: [{ from: 'start', to: 'finish', when: 'trigger.data ==' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'edge_when_unparseable')).toBe(true);
  });

  it('flags llm nodes without maxOutputTokens as a non-blocking warning', () => {
    const def = definition({
      nodes: [
        { id: 'extract', type: 'llm', prompt: 'do it' },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'extract', to: 'finish' }],
    });
    const errs = validateDefinition(def);
    expect(errs.some((e) => e.code === 'llm_maxoutput_warning')).toBe(true);
    expect(blockingErrors(errs)).toEqual([]);
  });

  it('rejects wait nodes with unparseable duration', () => {
    const def = definition({
      nodes: [
        { id: 'pause', type: 'wait', mode: 'duration', duration: 'banana' },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'pause', to: 'finish' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'wait_duration_unparseable')).toBe(true);
  });

  it('rejects wait durations exceeding the policy ceiling', () => {
    const def = definition({
      nodes: [
        { id: 'pause', type: 'wait', mode: 'duration', duration: '30d' },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'pause', to: 'finish' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'wait_duration_exceeds_policy')).toBe(true);
  });

  it('allows explicit foreach maxItems up to the execution iteration cap', () => {
    const def = definition({
      nodes: [
        // Declared so trigger.data.items is a typed array — otherwise
        // the foreach items rule would error first and mask the
        // maxItems policy check this test cares about.
        { id: 'trigger', type: 'trigger', dataSchema: { items: { type: 'array' } } },
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          maxItems: 5000,
          body: { id: 'inner', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'loop', to: 'finish' }],
    });

    expect(blockingErrors(validateDefinition(def))).toEqual([]);
  });

  it('rejects foreach maxItems above the execution iteration cap', () => {
    const def = definition({
      nodes: [
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          maxItems: 5001,
          body: { id: 'inner', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'loop', to: 'finish' }],
    });

    const errs = blockingErrors(validateDefinition(def));
    expect(errs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'foreach_max_items_exceeds_policy',
        message: expect.stringContaining('5000'),
      }),
    ]));
  });

  it('rejects foreach items that reference a trigger field with no declared dataSchema', () => {
    // Programmatic authors call workflows.validate / workflows.save_draft
    // and only honor errors — a "warning" on this case is invisible to
    // them. So this is a hard error: the author must declare the
    // trigger's shape and the named field must be an array.
    const def = definition({
      nodes: [
        { id: 'trigger', type: 'trigger' },
        {
          id: 'sweep',
          type: 'foreach',
          items: '{{trigger.data.names}}',
          body: { id: 'inner', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'trigger', to: 'sweep' },
        { from: 'sweep', to: 'finish' },
      ],
    });

    // Trigger source keeps a DISTINCT hard-error code
    // (foreach_items_trigger_untyped) — the author owns trigger.dataSchema
    // entirely, so we can and should hard-block. Only node-source untyped
    // paths are downgraded to warnings (see foreach_items_untyped_array_output).
    expect(blockingErrors(validateDefinition(def))).toEqual([
      expect.objectContaining({
        code: 'foreach_items_trigger_untyped',
        nodeId: 'sweep',
        path: 'items',
        message: expect.stringContaining('foreach "sweep" uses {{trigger.data.names}}, but it is not a typed array output'),
      }),
    ]);
  });

  it('rejects foreach items that reference a trigger field declared as a non-array type', () => {
    const def = definition({
      nodes: [
        { id: 'trigger', type: 'trigger', dataSchema: { names: { type: 'string' } } },
        {
          id: 'sweep',
          type: 'foreach',
          items: '{{trigger.data.names}}',
          body: { id: 'inner', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'trigger', to: 'sweep' },
        { from: 'sweep', to: 'finish' },
      ],
    });

    // Trigger source stays a hard error under the distinct code.
    expect(blockingErrors(validateDefinition(def))).toEqual([
      expect.objectContaining({
        code: 'foreach_items_trigger_untyped',
        nodeId: 'sweep',
      }),
    ]);
  });

  it('accepts foreach items that reference a trigger field declared as an array', () => {
    const def = definition({
      nodes: [
        { id: 'trigger', type: 'trigger', dataSchema: { names: { type: 'array' } } },
        {
          id: 'sweep',
          type: 'foreach',
          items: '{{trigger.data.names}}',
          body: { id: 'inner', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'trigger', to: 'sweep' },
        { from: 'sweep', to: 'finish' },
      ],
    });

    expect(blockingErrors(validateDefinition(def))).toEqual([]);
  });

  it('rejects foreach items that reference an untyped session output field', () => {
    const def = definition({
      nodes: [
        {
          id: 'scrape_yc',
          type: 'session',
          mode: 'start',
          prompt: 'scrape',
          workspace: 'yc-scraper',
          wait: { mode: 'until_idle' },
        },
        {
          id: 'write_companies',
          type: 'foreach',
          items: '{{nodes.scrape_yc.data.companies}}',
          body: { id: 'write_company', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'scrape_yc', to: 'write_companies' },
        { from: 'write_companies', to: 'finish' },
      ],
    });

    // Warning-level surface, not a hard block.
    expect(validateDefinition(def)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'write_companies',
        path: 'items',
        code: 'foreach_items_untyped_array_output',
        message: expect.stringContaining('foreach "write_companies" uses {{nodes.scrape_yc.data.companies}}, but it is not a typed array output'),
      }),
    ]));
    expect(
      blockingErrors(validateDefinition(def)).some((e) => e.code === 'foreach_items_untyped_array_output'),
    ).toBe(false);
  });

  it('accepts foreach items that reference an array declared by a session output schema', () => {
    const def = definition({
      nodes: [
        {
          id: 'scrape_yc',
          type: 'session',
          mode: 'start',
          prompt: 'scrape',
          workspace: 'yc-scraper',
          wait: { mode: 'until_idle' },
          outputSchema: {
            type: 'object',
            properties: {
              companies: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        {
          id: 'write_companies',
          type: 'foreach',
          items: '{{nodes.scrape_yc.data.output.companies}}',
          body: { id: 'write_company', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'scrape_yc', to: 'write_companies' },
        { from: 'write_companies', to: 'finish' },
      ],
    });

    expect(blockingErrors(validateDefinition(def))).toEqual([]);
  });

  it('rejects direct session data paths even when the structured output schema exists under data.output', () => {
    const def = definition({
      nodes: [
        {
          id: 'scrape_yc',
          type: 'session',
          mode: 'start',
          prompt: 'scrape',
          workspace: 'yc-scraper',
          wait: { mode: 'until_idle' },
          outputSchema: {
            type: 'object',
            properties: {
              companies: { type: 'array', items: { type: 'object' } },
            },
          },
        },
        {
          id: 'write_companies',
          type: 'foreach',
          items: '{{nodes.scrape_yc.data.companies}}',
          body: { id: 'write_company', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'scrape_yc', to: 'write_companies' },
        { from: 'write_companies', to: 'finish' },
      ],
    });

    expect(validateDefinition(def)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'foreach_items_untyped_array_output' }),
    ]));
    expect(
      blockingErrors(validateDefinition(def)).some((e) => e.code === 'foreach_items_untyped_array_output'),
    ).toBe(false);
  });

  it('accepts foreach items that reference an array declared by an llm outputSchema', () => {
    const def = definition({
      nodes: [
        {
          id: 'classify',
          type: 'llm',
          prompt: 'Classify these into categories.',
          outputSchema: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        {
          id: 'process_items',
          type: 'foreach',
          items: '{{nodes.classify.data.items}}',
          body: { id: 'process_item', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'classify', to: 'process_items' },
        { from: 'process_items', to: 'finish' },
      ],
    });

    expect(blockingErrors(validateDefinition(def))).toEqual([]);
  });

  it('accepts foreach items that reference an array declared by an orchestrator outputSchema', () => {
    const def = definition({
      nodes: [
        {
          id: 'ask_orch',
          type: 'orchestrator',
          prompt: 'Return a list of tasks as JSON.',
          wait: { mode: 'until_idle' },
          outputSchema: {
            type: 'object',
            properties: {
              tasks: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        {
          id: 'process_tasks',
          type: 'foreach',
          items: '{{nodes.ask_orch.data.output.tasks}}',
          body: { id: 'process_task', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'ask_orch', to: 'process_tasks' },
        { from: 'process_tasks', to: 'finish' },
      ],
    });

    expect(blockingErrors(validateDefinition(def))).toEqual([]);
  });

  it('rejects foreach items that reference an llm output field with no outputSchema', () => {
    const def = definition({
      nodes: [
        {
          id: 'classify',
          type: 'llm',
          prompt: 'Classify these.',
        },
        {
          id: 'process_items',
          type: 'foreach',
          items: '{{nodes.classify.data.items}}',
          body: { id: 'process_item', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'classify', to: 'process_items' },
        { from: 'process_items', to: 'finish' },
      ],
    });

    const errs = validateDefinition(def);
    expect(errs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'foreach_items_untyped_array_output',
        nodeId: 'process_items',
        path: 'items',
        // Message should name the source node concretely and point to the outputSchema fix.
        message: expect.stringContaining('llm node "classify"'),
      }),
    ]));
    // Actionable fix hint still mentions outputSchema.
    const untyped = errs.find((e) => e.code === 'foreach_items_untyped_array_output');
    expect(untyped?.message).toMatch(/outputSchema/);
    // Warning-level, not blocker.
    expect(
      blockingErrors(errs).some((e) => e.code === 'foreach_items_untyped_array_output'),
    ).toBe(false);
  });

  it('rejects foreach itemAlias shadowing reserved context names', () => {
    const def = definition({
      nodes: [
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          itemAlias: 'trigger',
          body: { id: 'inner', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'loop', to: 'finish' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'foreach_alias_shadows_reserved')).toBe(true);
  });

  it('rejects foreach aliases that collide', () => {
    const def = definition({
      nodes: [
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          itemAlias: 'x',
          indexAlias: 'x',
          body: { id: 'inner', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'loop', to: 'finish' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'foreach_aliases_collide')).toBe(true);
  });

  it('rejects two foreach nodes that share a body id (step.do cache key collision)', () => {
    const def = definition({
      nodes: [
        {
          id: 'loop_a',
          type: 'foreach',
          items: '{{trigger.data.a}}',
          body: { id: 'send', type: 'tool', service: 'slack', action: 'slack.send_message', params: {} },
        },
        {
          id: 'loop_b',
          type: 'foreach',
          items: '{{trigger.data.b}}',
          body: { id: 'send', type: 'tool', service: 'slack', action: 'slack.send_message', params: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'loop_a', to: 'loop_b' },
        { from: 'loop_b', to: 'finish' },
      ],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'duplicate_id')).toBe(true);
  });

  it('rejects an edge that targets a foreach body id (runtime cannot execute body nodes as graph nodes)', () => {
    const def = definition({
      nodes: [
        { id: 'start', type: 'set', values: { x: 1 } },
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          body: { id: 'inner_send', type: 'tool', service: 'slack', action: 'slack.send_message', params: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'start', to: 'loop' },
        // illegal: edge points into a foreach body — runtime's compile()
        // only registers def.nodes, so this would silently orphan finish.
        { from: 'inner_send', to: 'finish' },
      ],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'edge_from_unknown')).toBe(true);
  });

  it('rejects an edge that starts from a foreach body id', () => {
    const def = definition({
      nodes: [
        { id: 'start', type: 'set', values: { x: 1 } },
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          body: { id: 'inner_send', type: 'tool', service: 'slack', action: 'slack.send_message', params: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'start', to: 'loop' },
        { from: 'loop', to: 'inner_send' },
        { from: 'inner_send', to: 'finish' },
      ],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'edge_to_unknown')).toBe(true);
    expect(errs.some((e) => e.code === 'edge_from_unknown')).toBe(true);
  });

  it('rejects a foreach body id that collides with a top-level node id', () => {
    const def = definition({
      nodes: [
        { id: 'send', type: 'set', values: { x: 1 } },
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          body: { id: 'send', type: 'tool', service: 'slack', action: 'slack.send_message', params: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'send', to: 'loop' },
        { from: 'loop', to: 'finish' },
      ],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'duplicate_id')).toBe(true);
  });

  it('rejects session.prompt with both threadId and forceNewThread', () => {
    const def = definition({
      nodes: [
        {
          id: 's',
          type: 'session',
          mode: 'prompt',
          sessionId: '{{nodes.a.data.sessionId}}',
          prompt: 'hello',
          threadId: 't1',
          forceNewThread: true,
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 's', to: 'finish' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'session_thread_targeting_xor')).toBe(true);
  });

  it('rejects malformed template at validation time', () => {
    const def = definition({
      nodes: [
        { id: 'notify', type: 'orchestrator', prompt: 'hello {{broken' },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'notify', to: 'finish' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'template_parse_error')).toBe(true);
  });

  it('suggests bracket notation when dot notation references a hyphenated node id', () => {
    const def = definition({
      nodes: [
        { id: 'normalize-input', type: 'set', values: { email: 'a@example.com' } },
        { id: 'finish', type: 'stop', output: '{{nodes.normalize-input.data.email}}' },
      ],
      edges: [{ from: 'normalize-input', to: 'finish' }],
    });

    const errs = blockingErrors(validateDefinition(def));
    expect(errs).toEqual([
      expect.objectContaining({
        code: 'template_parse_error',
        nodeId: 'finish',
        message: expect.stringContaining('nodes["normalize-input"]'),
      }),
    ]);
  });

  it('accepts bracket notation references to hyphenated node ids', () => {
    const def = definition({
      nodes: [
        { id: 'normalize-input', type: 'set', values: { email: 'a@example.com' } },
        { id: 'finish', type: 'stop', output: '{{nodes["normalize-input"].data.email}}' },
      ],
      edges: [{ from: 'normalize-input', to: 'finish' }],
    });

    expect(blockingErrors(validateDefinition(def))).toEqual([]);
  });
});

describe('validateTriggerData', () => {
  it('accepts when all required trigger parameters are present with correct types', () => {
    const def = definition({
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          dataSchema: {
            target: { type: 'string', required: true },
            priority: { type: 'number' },
          },
        },
      ],
    });
    const result = validateTriggerData(def, { target: 'urgent', priority: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.triggerData).toEqual({ target: 'urgent', priority: 5 });
  });

  it('applies defaults for missing optional trigger parameters', () => {
    const def = definition({
      nodes: [{ id: 'trigger', type: 'trigger', dataSchema: { tag: { type: 'string', default: 'free' } } }],
    });
    const result = validateTriggerData(def, {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.triggerData.tag).toBe('free');
  });

  it('rejects missing required trigger parameter', () => {
    const def = definition({
      nodes: [{ id: 'trigger', type: 'trigger', dataSchema: { target: { type: 'string', required: true } } }],
    });
    const result = validateTriggerData(def, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.code).toBe('input_required_missing');
    }
  });

  it('rejects type mismatch', () => {
    const def = definition({
      nodes: [{ id: 'trigger', type: 'trigger', dataSchema: { count: { type: 'number' } } }],
    });
    const result = validateTriggerData(def, { count: 'not-a-number' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.code).toBe('input_type_mismatch');
    }
  });

  it('rejects values not in declared enum', () => {
    const def = definition({
      nodes: [{ id: 'trigger', type: 'trigger', dataSchema: { priority: { type: 'string', enum: ['low', 'high'] } } }],
    });
    const result = validateTriggerData(def, { priority: 'medium' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.code).toBe('input_not_in_enum');
    }
  });

  it('rejects trigger parameters not declared in the schema', () => {
    const def = definition({ nodes: [{ id: 'trigger', type: 'trigger', dataSchema: { target: { type: 'string' } } }] });
    const result = validateTriggerData(def, { target: 'x', prioirty: 'high' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'input_unknown' && e.inputName === 'prioirty')).toBe(true);
    }
  });

  it('rejects enum members with deep object equality (not reference equality)', () => {
    const def = definition({
      nodes: [{ id: 'trigger', type: 'trigger', dataSchema: { config: { type: 'object', enum: [{ a: 1, nested: { b: 2 } }] } } }],
    });
    const okResult = validateTriggerData(def, { config: { a: 1, nested: { b: 2 } } });
    expect(okResult.ok).toBe(true);
    const failResult = validateTriggerData(def, { config: { a: 1, nested: { b: 3 } } });
    expect(failResult.ok).toBe(false);
  });
});

describe('validateDefinition — if matchesRegex compiles', () => {
  it('accepts supported snake_case condition operation aliases', () => {
    const def = definition({
      nodes: [
        {
          id: 'check_required',
          type: 'if',
          combinator: 'and',
          conditions: [
            { left: 'trigger.data.email', dataType: 'string', operation: 'is_not_empty' },
            { left: 'trigger.data.name', dataType: 'string', operation: 'is_not_empty' },
          ],
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'check_required', to: 'finish', fromOutput: 'true' }],
    });

    expect(blockingErrors(validateDefinition(def))).toEqual([]);
  });

  it('rejects unsupported if condition operations before execution', () => {
    const def = definition({
      nodes: [
        { id: 'route', type: 'if', conditions: [{ left: 'trigger.x', dataType: 'string', operation: 'isTotallyFilled' }] },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'route', to: 'finish', fromOutput: 'true' }],
    });

    const errs = blockingErrors(validateDefinition(def));
    expect(errs).toEqual([
      expect.objectContaining({
        code: 'if_operation_unsupported',
        nodeId: 'route',
        message: expect.stringContaining('Unsupported string operation "isTotallyFilled"'),
      }),
    ]);
  });

  it('rejects an if node whose matchesRegex pattern is not a valid regex', () => {
    const def = definition({
      nodes: [
        { id: 'route', type: 'if', conditions: [{ left: 'trigger.x', dataType: 'string', operation: 'matchesRegex', right: '(unclosed' }] },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'route', to: 'finish', fromOutput: 'true' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'invalid_regex')).toBe(true);
  });
});

describe('validateAgainstEnvironment', () => {
  it('is total — returns empty array for malformed shapes', () => {
    expect(validateAgainstEnvironment(null, {} as Env)).toEqual([]);
    expect(validateAgainstEnvironment({ version: 'dag/v1' }, {} as Env)).toEqual([]);
  });

  it('rejects llm nodes whose provider has no configured API key', () => {
    const def = definition({
      nodes: [
        { id: 'extract', type: 'llm', model: 'anthropic:claude-sonnet-4-5', prompt: 'do it', maxOutputTokens: 100 },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'extract', to: 'finish' }],
    });
    const errs = validateAgainstEnvironment(def, {} as Env);
    expect(errs.some((e) => e.code === 'llm_provider_key_missing')).toBe(true);
  });

  it('passes when the right env key is set', () => {
    const def = definition({
      nodes: [
        { id: 'extract', type: 'llm', model: 'openai:gpt-4o', prompt: 'do it', maxOutputTokens: 100 },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'extract', to: 'finish' }],
    });
    const errs = validateAgainstEnvironment(def, { OPENAI_API_KEY: 'sk-...' } as Env);
    expect(errs).toEqual([]);
  });

  it('rejects llm nodes whose model id is malformed', () => {
    const def = definition({
      nodes: [
        { id: 'extract', type: 'llm', model: 'no-prefix', prompt: 'do it', maxOutputTokens: 100 },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'extract', to: 'finish' }],
    });
    const errs = validateAgainstEnvironment(def, {} as Env);
    expect(errs.some((e) => e.code === 'llm_model_id_invalid')).toBe(true);
  });

  it('descends into foreach bodies for env checks', () => {
    const def = definition({
      nodes: [
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.items}}',
          body: { id: 'inner', type: 'llm', model: 'anthropic:claude-sonnet-4-5', prompt: 'x', maxOutputTokens: 50 },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'loop', to: 'finish' }],
    });
    const errs = validateAgainstEnvironment(def, {} as Env);
    expect(errs.some((e) => e.code === 'llm_provider_key_missing' && e.nodeId === 'inner')).toBe(true);
  });
});

describe('validateAgainstAvailableModels', () => {
  it('rejects llm nodes whose model is not in the resolved model catalog', () => {
    const def = definition({
      nodes: [
        { id: 'extract', type: 'llm', model: 'anthropic:claude-fake-model-9999', prompt: 'do it', maxOutputTokens: 100 },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'extract', to: 'finish' }],
    });

    const errs = validateAgainstAvailableModels(def, [
      { provider: 'Anthropic', models: [{ id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }] },
    ]);

    expect(errs).toEqual([
      expect.objectContaining({
        scope: 'node',
        nodeId: 'extract',
        code: 'llm_model_unavailable',
        message: expect.stringContaining('anthropic:claude-fake-model-9999'),
      }),
    ]);
    expect(errs[0]?.message).toContain('anthropic:claude-sonnet-4-5');
  });

  it('accepts workflow colon model IDs when the picker catalog uses slash model IDs', () => {
    const def = definition({
      nodes: [
        { id: 'extract', type: 'llm', model: 'anthropic:claude-sonnet-4-5', prompt: 'do it', maxOutputTokens: 100 },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'extract', to: 'finish' }],
    });

    const errs = validateAgainstAvailableModels(def, [
      { provider: 'Anthropic', models: [{ id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }] },
    ]);

    expect(errs).toEqual([]);
  });

  it('prioritizes related and newer model suggestions over raw catalog order', () => {
    const def = definition({
      nodes: [
        { id: 'generate_welcome', type: 'llm', model: 'anthropic:claude-sonnet-old', prompt: 'do it', maxOutputTokens: 100 },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'generate_welcome', to: 'finish' }],
    });

    const errs = validateAgainstAvailableModels(def, [
      {
        provider: 'Anthropic',
        models: [
          { id: 'anthropic/claude-opus-4-5', name: 'Claude Opus 4.5' },
          { id: 'anthropic/claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
          { id: 'anthropic/claude-opus-4-8', name: 'Claude Opus 4.8' },
          { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
        ],
      },
    ]);

    const message = errs[0]?.message ?? '';
    const sonnetIndex = message.indexOf('anthropic:claude-sonnet-4-5');
    const opusIndex = message.indexOf('anthropic:claude-opus-4-8');

    expect(sonnetIndex).toBeGreaterThan(-1);
    expect(opusIndex).toBeGreaterThan(-1);
    expect(sonnetIndex).toBeLessThan(opusIndex);
  });
});

describe('validateDefinition — body-level templates and per-node baseline', () => {
  it('surfaces a foreach body llm template parse error', () => {
    const def = definition({
      nodes: [
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          body: { id: 'inner', type: 'llm', prompt: 'tell me about {{broken', maxOutputTokens: 100 },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'loop', to: 'finish' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'template_parse_error' && e.nodeId === 'inner')).toBe(true);
  });

  it('rejects expressions with empty bracket subscript like nodes.x[]', () => {
    const def = definition({
      nodes: [
        { id: 'route', type: 'if', conditions: [{ left: 'nodes.x[]', dataType: 'string', operation: 'equals', right: 'a' }] },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'route', to: 'finish', fromOutput: 'true' }],
    });
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'expression_parse_error')).toBe(true);
  });
});

describe('validateDefinition — set node outputSchema (deterministic-reshape source for foreach)', () => {
  it('accepts a foreach whose items reference a set node with an array-typed outputSchema field, even when values is a template reference', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger', dataSchema: { raw: { type: 'object' } } },
        {
          id: 'reshape',
          type: 'set',
          values: { records: '{{trigger.data.raw.records}}' },
          outputSchema: {
            type: 'object',
            properties: { records: { type: 'array', items: { type: 'object' } } },
            required: ['records'],
          },
        },
        {
          id: 'loop',
          type: 'foreach',
          items: '{{nodes.reshape.data.records}}',
          body: { id: 'inner', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'trigger', to: 'reshape' },
        { from: 'reshape', to: 'loop' },
        { from: 'loop', to: 'finish' },
      ],
    };
    // Under the old behavior this failed with foreach_items_untyped_array_output because a template
    // reference under `values` doesn't count as a literal array. outputSchema now bridges that gap.
    expect(blockingErrors(validateDefinition(def)).filter((e) => e.code === 'foreach_items_untyped_array_output')).toEqual([]);
  });

  it('still rejects a set-sourced foreach when outputSchema does not declare the field as an array', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger', dataSchema: { raw: { type: 'object' } } },
        {
          id: 'reshape',
          type: 'set',
          values: { records: '{{trigger.data.raw.records}}' },
          outputSchema: {
            type: 'object',
            properties: { records: { type: 'string' } },
          },
        },
        {
          id: 'loop',
          type: 'foreach',
          items: '{{nodes.reshape.data.records}}',
          body: { id: 'inner', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'trigger', to: 'reshape' },
        { from: 'reshape', to: 'loop' },
        { from: 'loop', to: 'finish' },
      ],
    };
    // Warning-level: the validator surfaces the mismatch but doesn't hard-block.
    expect(validateDefinition(def)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'foreach_items_untyped_array_output', nodeId: 'loop' }),
    ]));
    expect(
      blockingErrors(validateDefinition(def)).some((e) => e.code === 'foreach_items_untyped_array_output'),
    ).toBe(false);
  });
});

describe('validateDefinitionWithContext — tool service:action existence', () => {
  const knownToolActions = new Map<string, Set<string>>([
    ['salesforce-read-only', new Set(['salesforce-read-only.soqlQuery', 'salesforce-read-only.getUserInfo'])],
    ['google_workspace', new Set(['sheets.create_spreadsheet', 'sheets.write_spreadsheet', 'sheets.append_rows'])],
  ]);

  it('emits unknown_tool_action with a nearest-match suggestion for the classic missing-prefix typo', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'query',
          type: 'tool',
          service: 'salesforce-read-only',
          action: 'soqlQuery',
          params: { q: 'SELECT Id FROM Account LIMIT 1' },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'query', to: 'finish' }],
    };
    const errs = blockingErrors(validateDefinitionWithContext(def, { knownToolActions }));
    const err = errs.find((e) => e.code === 'unknown_tool_action');
    expect(err).toBeDefined();
    expect(err?.message).toContain('salesforce-read-only.soqlQuery');
    expect(err?.nodeId).toBe('query');
    expect(err?.path).toBe('action');
  });

  it('emits unknown_tool_service as a WARNING (not blocker) when the service is unknown — the catalog may not see per-user custom MCP connectors, so this must not hard-fail publish', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'query',
          type: 'tool',
          service: 'salesforce-typo',
          action: 'soqlQuery',
          params: {},
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'query', to: 'finish' }],
    };
    const all = validateDefinitionWithContext(def, { knownToolActions });
    // The unknown_tool_service entry exists on the full result set…
    expect(all).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'unknown_tool_service', nodeId: 'query', path: 'service' })]),
    );
    // …but is filtered out of blocking errors (it's a warning).
    expect(blockingErrors(all).some((e) => e.code === 'unknown_tool_service')).toBe(false);
  });

  it('accepts a foreach whose items reference a tool node with a per-node outputSchema declaring the field as array (the arbitrary-SOQL/SQL case)', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'query',
          type: 'tool',
          service: 'salesforce-read-only',
          action: 'salesforce-read-only.soqlQuery',
          params: { q: 'SELECT Id FROM Account LIMIT 1' },
          outputSchema: {
            type: 'object',
            properties: { records: { type: 'array', items: { type: 'object' } } },
            required: ['records'],
          },
        },
        {
          id: 'loop',
          type: 'foreach',
          items: '{{nodes.query.data.records}}',
          body: { id: 'inner', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'query', to: 'loop' },
        { from: 'loop', to: 'finish' },
      ],
    };
    expect(blockingErrors(validateDefinition(def)).filter((e) => e.code === 'foreach_items_untyped_array_output')).toEqual([]);
  });

  it('accepts a foreach over a tool source when only a service-level toolOutputSchemas entry is registered (no per-node outputSchema)', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'query',
          type: 'tool',
          service: 'salesforce-read-only',
          action: 'salesforce-read-only.soqlQuery',
          params: { q: 'SELECT Id FROM Account LIMIT 1' },
        },
        {
          id: 'loop',
          type: 'foreach',
          items: '{{nodes.query.data.records}}',
          body: { id: 'inner', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'query', to: 'loop' },
        { from: 'loop', to: 'finish' },
      ],
    };
    const context = {
      toolOutputSchemas: {
        'salesforce-read-only:salesforce-read-only.soqlQuery': {
          type: 'object',
          properties: { records: { type: 'array', items: { type: 'object' } } },
        },
      },
    };
    expect(
      blockingErrors(validateDefinitionWithContext(def, context)).filter((e) => e.code === 'foreach_items_untyped_array_output'),
    ).toEqual([]);
  });

  it('rejects project column paths with empty/whitespace segments (\".\", \"x.\", \"x..y\") that pass zod min(1) but resolve weirdly at runtime', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger', dataSchema: { records: { type: 'array' } } },
        {
          id: 'rows',
          type: 'project',
          source: '{{trigger.data.records}}',
          columns: [
            { header: 'A', path: '.' },
            { header: 'B', path: 'x.' },
            { header: 'C', path: 'x..y' },
            { header: 'OK', path: 'Account.Name' }, // valid
          ],
        },
      ],
      edges: [{ from: 'trigger', to: 'rows' }],
    };
    const errs = blockingErrors(validateDefinition(def));
    const bad = errs.filter((e) => e.code === 'project_column_path_malformed');
    expect(bad.map((e) => e.path)).toEqual(['columns.0.path', 'columns.1.path', 'columns.2.path']);
  });

  it('accepts a foreach whose items reference a project node (its output IS the array)', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger', dataSchema: { records: { type: 'array' } } },
        {
          id: 'rows',
          type: 'project',
          source: '{{trigger.data.records}}',
          columns: [{ header: 'Name', path: 'name' }],
        },
        {
          id: 'loop',
          type: 'foreach',
          items: '{{nodes.rows.data}}',
          body: { id: 'inner', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'trigger', to: 'rows' },
        { from: 'rows', to: 'loop' },
        { from: 'loop', to: 'finish' },
      ],
    };
    expect(blockingErrors(validateDefinition(def)).filter((e) => e.code === 'foreach_items_untyped_array_output')).toEqual([]);
  });

  it('foreach_items_untyped_array_output is now a WARNING (not blocker) so the obvious {{nodes.query.data.records}} template does not hard-fail when no schema is available', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'query',
          type: 'tool',
          service: 'salesforce-read-only',
          action: 'salesforce-read-only.soqlQuery',
          params: {},
        },
        {
          id: 'loop',
          type: 'foreach',
          items: '{{nodes.query.data.records}}',
          body: { id: 'inner', type: 'set', values: {} },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'query', to: 'loop' },
        { from: 'loop', to: 'finish' },
      ],
    };
    // No context.toolOutputSchemas, no per-node outputSchema → currently the
    // check is skipped for tool sources (see validateForeachItemSources), but
    // if it fires, it must be a warning, not a blocking error.
    const all = validateDefinition(def);
    expect(blockingErrors(all).some((e) => e.code === 'foreach_items_untyped_array_output')).toBe(false);
  });

  it('empty knownToolActions map: every service is unknown (warning-only) — a catalog-build failure or empty tenant must not silently hard-block every workflow', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'query',
          type: 'tool',
          service: 'salesforce-read-only',
          action: 'salesforce-read-only.soqlQuery',
          params: {},
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'query', to: 'finish' }],
    };
    const all = validateDefinitionWithContext(def, { knownToolActions: new Map() });
    expect(blockingErrors(all).filter((e) => e.code === 'unknown_tool_service' || e.code === 'unknown_tool_action')).toEqual([]);
  });

  it('accepts a tool node whose service:action resolves', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'query',
          type: 'tool',
          service: 'salesforce-read-only',
          action: 'salesforce-read-only.soqlQuery',
          params: { q: 'SELECT Id FROM Account LIMIT 1' },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'query', to: 'finish' }],
    };
    const errs = blockingErrors(validateDefinitionWithContext(def, { knownToolActions }));
    expect(errs.filter((e) => e.code === 'unknown_tool_action' || e.code === 'unknown_tool_service')).toEqual([]);
  });

  it('descends into foreach body tool nodes', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger', dataSchema: { items: { type: 'array' } } },
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.items}}',
          body: {
            id: 'write',
            type: 'tool',
            service: 'google_workspace',
            action: 'sheets.write_spreadhseet', // typo
            params: { spreadsheetId: 'x', range: 'A1', data: [[]] },
          },
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [
        { from: 'trigger', to: 'loop' },
        { from: 'loop', to: 'finish' },
      ],
    };
    const errs = blockingErrors(validateDefinitionWithContext(def, { knownToolActions }));
    const err = errs.find((e) => e.code === 'unknown_tool_action');
    expect(err?.nodeId).toBe('write');
    expect(err?.message).toContain('sheets.write_spreadsheet');
  });

  it('skips the check entirely when knownToolActions is not provided (back-compat)', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'query',
          type: 'tool',
          service: 'salesforce-read-only',
          action: 'soqlQuery',
          params: {},
        },
        { id: 'finish', type: 'stop' },
      ],
      edges: [{ from: 'query', to: 'finish' }],
    };
    // No context.knownToolActions -> no unknown_tool_action error.
    const errs = blockingErrors(validateDefinition(def));
    expect(errs.some((e) => e.code === 'unknown_tool_action' || e.code === 'unknown_tool_service')).toBe(false);
  });
});
