import { describe, expect, it } from 'vitest';

import type { ToolNode } from '../dag/nodes.js';
import type { WorkflowDefinition } from '../dag/shape.js';
import type { WorkflowEngineDeps, WorkflowInvokeActionRequest, WorkflowInvokeActionResult } from '../engine-deps.js';
import { driveUntilPark } from '../interpreter.js';
import { InMemoryWorkflowStore } from '../memory-store.js';
import type { RunParams } from '../store.js';
import { executeTool } from './tool.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function runParams(overrides: Partial<RunParams> = {}): RunParams {
  return {
    workflowId: 'wf-1',
    definitionVersionId: 'v1',
    input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: {}, metadata: {} },
    ...overrides,
  };
}

async function claimAttempt(store: InMemoryWorkflowStore, runId: string, ownerId = 'owner'): Promise<number> {
  const claim = await store.claimRun(runId, ownerId, 30_000);
  if (!claim) throw new Error(`could not claim run ${runId}`);
  return claim.attempt;
}

function toolDefinition(node: Partial<ToolNode> = {}): WorkflowDefinition {
  const tool: ToolNode = {
    id: 'tl',
    type: 'tool',
    service: 'github',
    action: 'createIssue',
    params: { title: 'a {{trigger.data.thing}} issue' },
    ...node,
  };
  return {
    version: 'dag/v1',
    nodes: [
      { id: 't', type: 'trigger' },
      tool,
      { id: 'e', type: 'stop', outcome: 'success' },
    ],
    edges: [
      { from: 't', to: 'tl' },
      { from: 'tl', to: 'e' },
    ],
  };
}

interface RecordedCall {
  kind: 'invokeAction';
  req: WorkflowInvokeActionRequest;
}

/** A scriptable, call-recording fake `WorkflowEngineDeps` for the tool node. */
function makeEngine(
  responses: Array<WorkflowInvokeActionResult | Error> = [{ ok: true, result: { done: true } }],
): { engine: WorkflowEngineDeps; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = [...responses];

  function next(): WorkflowInvokeActionResult {
    const value = queue.length > 1 ? queue.shift() : queue[0];
    if (value === undefined) throw new Error('scripted queue exhausted');
    if (value instanceof Error) throw value;
    return value;
  }

  const engine: WorkflowEngineDeps = {
    createSession: async () => {
      throw new Error('createSession not exercised by this fixture');
    },
    prompt: async () => {
      throw new Error('prompt not exercised by this fixture');
    },
    awaitResult: async () => {
      throw new Error('awaitResult not exercised by this fixture');
    },
    abort: async () => {
      throw new Error('abort not exercised by this fixture');
    },
    isSettled: async () => {
      throw new Error('isSettled not exercised by this fixture');
    },
    llmComplete: async () => {
      throw new Error('llmComplete not exercised by this fixture');
    },
    promptOrchestrator: async () => {
      throw new Error('promptOrchestrator not exercised by this fixture');
    },
    invokeAction: async (req) => {
      const result = next();
      calls.push({ kind: 'invokeAction', req });
      return result;
    },
  };

  return { engine, calls };
}

// ─── 1. Params template rendering (structured, single-template preservation) ─

describe('executeTool: params rendered structurally', () => {
  it('renders string fields and preserves a non-string value from a single bare template', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine([{ ok: true, result: { ok: 'yes' } }]);

    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 's', type: 'set', values: { count: '{{trigger.data.n}}' } },
        {
          id: 'tl',
          type: 'tool',
          service: 'svc',
          action: 'act',
          params: {
            title: 'issue for {{trigger.data.thing}}',
            meta: { count: '{{nodes.s.output.count}}', tags: ['a', '{{trigger.data.thing}}'] },
          },
        },
        { id: 'e', type: 'stop', outcome: 'success' },
      ],
      edges: [
        { from: 't', to: 's' },
        { from: 's', to: 'tl' },
        { from: 'tl', to: 'e' },
      ],
    };

    await store.createRun(
      'run-1',
      runParams({ input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: { thing: 'widgets', n: 7 }, metadata: {} } }),
      definition,
      'v1',
    );
    const attempt = await claimAttempt(store, 'run-1');
    const park = await driveUntilPark('run-1', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.req.params).toEqual({
      title: 'issue for widgets',
      meta: { count: 7, tags: ['a', 'widgets'] },
    });
  });
});

// ─── 1b. Credential selection passes through to invokeAction ────────────────

describe('executeTool: credential selection', () => {
  it('forwards an explicit credential selection to invokeAction', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine([{ ok: true, result: { done: true } }]);

    await store.createRun('run-cred', runParams(), toolDefinition({ credential: 'app' }), 'v1');
    const attempt = await claimAttempt(store, 'run-cred');
    await driveUntilPark('run-cred', attempt, { store, engine, clock: clock.now });

    expect(calls[0]?.req.credential).toBe('app');
  });

  it('omits credential when the node does not select one (back-compat)', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine([{ ok: true, result: { done: true } }]);

    await store.createRun('run-nocred', runParams(), toolDefinition(), 'v1');
    const attempt = await claimAttempt(store, 'run-nocred');
    await driveUntilPark('run-nocred', attempt, { store, engine, clock: clock.now });

    expect(calls[0]?.req.credential).toBeUndefined();
  });
});

// ─── 2. Deterministic invocationId at iteration 0 (no suffix) ────────────────

describe('executeTool: invocationId at iteration 0', () => {
  it('uses workflow:{runId}:{nodeId} with no suffix', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine([{ ok: true, result: { done: true } }]);

    await store.createRun('run-2', runParams(), toolDefinition(), 'v1');
    const attempt = await claimAttempt(store, 'run-2');
    await driveUntilPark('run-2', attempt, { store, engine, clock: clock.now });

    expect(calls[0]?.req.invocationId).toBe('workflow:run-2:tl');
  });
});

// ─── 3. iteration > 0: invocationId gains the suffix, checkpoint keyed there ─

describe('executeTool: iteration > 0', () => {
  it('appends :{iteration} to invocationId and checkpoints at that iteration', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine([{ ok: true, result: { done: true } }]);

    const definition = toolDefinition();
    await store.createRun('run-3', runParams(), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-3');
    const run = await store.getRun('run-3');
    if (!run) throw new Error('run vanished');
    const node = definition.nodes.find((n): n is ToolNode => n.id === 'tl')!;

    const result = await executeTool({
      run,
      node,
      attempt,
      iteration: 1,
      templateContext: { trigger: undefined, nodes: {} },
      store,
      clock: clock.now,
      engine,
    });

    expect(result.status).toBe('completed');
    expect(calls[0]?.req.invocationId).toBe('workflow:run-3:tl:1');

    const checkpoints = await store.getCheckpoints('run-3');
    const cp = checkpoints.find((c) => c.nodeId === 'tl' && c.iteration === 1);
    expect(cp).toBeDefined();
    expect(cp?.status).toBe('completed');
    expect(checkpoints.some((c) => c.nodeId === 'tl' && c.iteration === 0)).toBe(false);
  });
});

// ─── 4. ok:true → completed, checkpoint result = receiver's result verbatim ──

describe('executeTool: ok result', () => {
  it('completes with the receiver result stored directly (no wrapper)', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine } = makeEngine([{ ok: true, result: { issueNumber: 42, url: 'https://example.com/42' } }]);

    await store.createRun('run-4', runParams(), toolDefinition(), 'v1');
    const attempt = await claimAttempt(store, 'run-4');
    const park = await driveUntilPark('run-4', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');

    const byNode = new Map((await store.getCheckpoints('run-4')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('tl')?.status).toBe('completed');
    expect(byNode.get('tl')?.result).toEqual({ issueNumber: 42, url: 'https://example.com/42' });
  });
});

// ─── 5. ok:false → node failed with the error, run failed ────────────────────

describe('executeTool: ok:false result', () => {
  it('fails the node (and the run) with the receiver error', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine } = makeEngine([{ ok: false, error: 'no integrations are connected' }]);

    await store.createRun('run-5', runParams(), toolDefinition(), 'v1');
    const attempt = await claimAttempt(store, 'run-5');
    const park = await driveUntilPark('run-5', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('failed');

    const byNode = new Map((await store.getCheckpoints('run-5')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('tl')?.status).toBe('failed');
    expect(byNode.get('tl')?.error).toBe('no integrations are connected');
  });
});

// ─── 6. invokeAction throws → node failed with the thrown message ────────────

describe('executeTool: invokeAction throws', () => {
  it('fails the node with the thrown error message (not a drive-level throw)', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine } = makeEngine([new Error('transport error')]);

    await store.createRun('run-6', runParams(), toolDefinition(), 'v1');
    const attempt = await claimAttempt(store, 'run-6');
    const park = await driveUntilPark('run-6', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('failed');

    const byNode = new Map((await store.getCheckpoints('run-6')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('tl')?.status).toBe('failed');
    expect(byNode.get('tl')?.error).toBe('transport error');
  });
});

// ─── 7. Crash-after-intent re-drive: re-invokes with the SAME invocationId ───

describe('executeTool: crash after the intent write, before the terminal checkpoint', () => {
  it('re-drives and re-invokes with the identical invocationId (dedup contract)', async () => {
    const clock = makeClock();
    const store = new InMemoryWorkflowStore(clock.now);
    const { engine, calls } = makeEngine([{ ok: true, result: { done: true } }]);

    let toolCompleteCheckpointCount = 0;
    const originalCompleteCheckpoint = store.completeCheckpoint.bind(store);
    store.completeCheckpoint = async (runId, nodeId, iter, attempt, terminal) => {
      if (nodeId === 'tl') {
        toolCompleteCheckpointCount += 1;
        if (toolCompleteCheckpointCount === 1) {
          throw new Error('simulated crash after invokeAction, before the terminal checkpoint');
        }
      }
      return originalCompleteCheckpoint(runId, nodeId, iter, attempt, terminal);
    };

    await store.createRun('run-7', runParams(), toolDefinition(), 'v1');
    const attempt1 = await claimAttempt(store, 'run-7');
    await expect(driveUntilPark('run-7', attempt1, { store, engine, clock: clock.now })).rejects.toThrow(
      'simulated crash after invokeAction, before the terminal checkpoint',
    );
    expect(calls).toHaveLength(1);

    store.completeCheckpoint = originalCompleteCheckpoint;

    clock.advance(30_001);
    const attempt2 = await claimAttempt(store, 'run-7', 'owner-2');
    const park2 = await driveUntilPark('run-7', attempt2, { store, engine, clock: clock.now });

    expect(park2.status).toBe('settled');
    expect(park2.outcome).toBe('completed');
    expect(calls).toHaveLength(2);

    const invocationIds = new Set(calls.map((c) => c.req.invocationId));
    expect(invocationIds.size).toBe(1);
    expect([...invocationIds][0]).toBe('workflow:run-7:tl');

    const byNode = new Map((await store.getCheckpoints('run-7')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('tl')?.status).toBe('completed');
  });
});
