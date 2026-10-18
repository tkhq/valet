import { describe, expect, it } from 'vitest';

import type { WorkflowDefinition } from './dag/shape.js';
import { LocalRunHost } from './local-host.js';
import { InMemoryWorkflowStore } from './memory-store.js';
import { makeRunHostFixtureEngine } from './conformance/run-host.js';
import { retrySeedCheckpoints } from './retry-seed.js';
import type { NodeCheckpoint } from './store.js';

function cp(nodeId: string, status: NodeCheckpoint['status'], iteration = 0, result?: unknown): NodeCheckpoint {
  return { runId: 'old', nodeId, iteration, status, attempt: 1, createdAt: 1, ...(result !== undefined ? { result } : {}) };
}

/** trigger → list → loop(body) → report → stop */
function chain(prompt = 'qualify {{item}}'): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [
      { id: 'trigger', type: 'trigger' },
      { id: 'list', type: 'set', values: { items: [1, 2, 3] } },
      { id: 'loop', type: 'foreach', items: '{{nodes.list.output.items}}', body: { id: 'qualify', type: 'session', mode: 'start', prompt } },
      { id: 'report', type: 'set', values: { done: true } },
      { id: 'stop', type: 'stop' },
    ],
    edges: [
      { from: 'trigger', to: 'list' },
      { from: 'list', to: 'loop' },
      { from: 'loop', to: 'report' },
      { from: 'report', to: 'stop' },
    ],
  };
}

const ids = (cps: NodeCheckpoint[]) => cps.map((c) => `${c.nodeId}#${c.iteration}`);

describe('retrySeedCheckpoints', () => {
  it('reuses the steps before the failed step and nothing after it', () => {
    const run = [cp('trigger', 'completed'), cp('list', 'completed'), cp('loop', 'completed'), cp('report', 'failed')];
    expect(ids(retrySeedCheckpoints(chain(), chain(), run))).toEqual(['trigger#0', 'list#0', 'loop#0']);
  });

  it('keeps the finished items of a failed foreach and runs the failed item again', () => {
    const run = [
      cp('trigger', 'completed'), cp('list', 'completed'),
      cp('qualify', 'completed', 0), cp('qualify', 'failed', 1), cp('qualify', 'intent', 2),
      cp('loop', 'failed'),
    ];
    expect(ids(retrySeedCheckpoints(chain(), chain(), run))).toEqual(['trigger#0', 'list#0', 'qualify#0']);
  });

  it('runs an edited step and everything after it again, even when the step completed', () => {
    const run = [cp('trigger', 'completed'), cp('list', 'completed'), cp('qualify', 'completed', 0), cp('loop', 'completed'), cp('report', 'failed')];
    expect(ids(retrySeedCheckpoints(chain(), chain('qualify {{item}} strictly'), run))).toEqual(['trigger#0', 'list#0']);
  });

  it('never copies a stop step, so a stop that ended the old run ends the retry too', () => {
    const run = [cp('trigger', 'completed'), cp('list', 'completed'), cp('loop', 'failed'), cp('stop', 'completed')];
    expect(ids(retrySeedCheckpoints(chain(), chain(), run))).toEqual(['trigger#0', 'list#0']);
  });

  it('asks for an approval again when a step after it changed, and keeps it when nothing after it did', () => {
    const guarded = (to: string, extra = false): WorkflowDefinition => ({
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'ok', type: 'approval', prompt: 'Send the digest?' },
        { id: 'send', type: 'tool', service: 'gmail', action: 'send', params: { to } },
        ...(extra ? [{ id: 'send2', type: 'tool' as const, service: 'gmail', action: 'send', params: { to } }] : []),
        { id: 'stop', type: 'stop' },
      ],
      edges: [{ from: 'trigger', to: 'ok' }, { from: 'ok', to: 'send' }, ...(extra ? [{ from: 'ok', to: 'send2' }] : []), { from: 'send', to: 'stop' }],
    });
    const run = [cp('trigger', 'completed'), cp('ok', 'completed'), cp('send', 'failed')];
    expect(ids(retrySeedCheckpoints(guarded('me@corp.test'), guarded('me@corp.test'), run))).toEqual(['trigger#0', 'ok#0']);
    expect(ids(retrySeedCheckpoints(guarded('me@corp.test'), guarded('attacker@evil.test'), run))).toEqual(['trigger#0']);
    expect(ids(retrySeedCheckpoints(guarded('me@corp.test'), guarded('me@corp.test', true), run))).toEqual(['trigger#0']);
  });

  it('treats a key-order difference from a database read as the same step', () => {
    const previous = chain();
    const reordered: WorkflowDefinition = {
      ...previous,
      nodes: previous.nodes.map((node) => Object.fromEntries(Object.entries(node).reverse()) as typeof node),
    };
    const run = [cp('trigger', 'completed'), cp('list', 'completed'), cp('loop', 'completed'), cp('report', 'failed')];
    expect(ids(retrySeedCheckpoints(previous, reordered, run))).toEqual(['trigger#0', 'list#0', 'loop#0']);
  });
});

describe('LocalRunHost seeded start', () => {
  it('does not run a seeded step again and runs the step after it', async () => {
    const store = new InMemoryWorkflowStore();
    const host = new LocalRunHost({ store, engine: makeRunHostFixtureEngine(), pollMs: 5, sweepMs: 10 });
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'first', type: 'set', values: { from: 'new run' } },
        { id: 'second', type: 'set', values: { saw: '{{nodes.first.output.from}}' } },
        { id: 'stop', type: 'stop' },
      ],
      edges: [{ from: 'trigger', to: 'first' }, { from: 'first', to: 'second' }, { from: 'second', to: 'stop' }],
    };
    const seed = [
      cp('trigger', 'completed', 0, { data: {} }),
      cp('first', 'completed', 0, { from: 'old run' }),
    ];
    host.startHost();
    try {
      await host.start('retry', { workflowId: 'wf', definitionVersionId: 'v' }, definition, undefined, { seed });
      for (let i = 0; i < 300 && (await store.getRun('retry'))?.status !== 'settled'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      await host.stopHost();
    }
    const run = await store.getRun('retry');
    expect(run?.outcome).toBe('completed');
    const byNode = new Map((await store.getCheckpoints('retry')).map((c) => [c.nodeId, c]));
    expect(byNode.get('first')).toMatchObject({ runId: 'retry', attempt: 0, result: { from: 'old run' } });
    expect(byNode.get('second')).toMatchObject({ status: 'completed', result: { saw: 'old run' } });
  });
});
