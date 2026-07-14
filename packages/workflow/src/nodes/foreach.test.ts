import { describe, expect, it } from 'vitest';

import type { SubmissionResult } from '@valet/engine';

import type { ForeachNode, LlmNode, SessionNode, SetNode } from '../dag/nodes.js';
import type { WorkflowDefinition } from '../dag/shape.js';
import { validateWorkflowDefinition } from '../dag/validate.js';
import type { WorkflowEngineDeps } from '../engine-deps.js';
import { driveUntilPark } from '../interpreter.js';
import { InMemoryWorkflowStore } from '../memory-store.js';
import type { RunParams } from '../store.js';
import { executeForeach } from './foreach.js';

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

function foreachDefinition(node: Partial<ForeachNode> & Pick<ForeachNode, 'items' | 'body'>): WorkflowDefinition {
  const loop: ForeachNode = { id: 'loop', type: 'foreach', ...node };
  return {
    version: 'dag/v1',
    nodes: [{ id: 't', type: 'trigger' }, loop, { id: 'e', type: 'stop', outcome: 'success' }],
    edges: [
      { from: 't', to: 'loop' },
      { from: 'loop', to: 'e' },
    ],
  };
}

const setBody: SetNode = { id: 'body', type: 'set', values: { seen: '{{item}}-{{index}}' } };

/** An engine stub where every method throws — call site failures are caught explicitly per test. */
function unusedEngine(): WorkflowEngineDeps {
  const fail = async (): Promise<never> => {
    throw new Error('this engine method must not be called by this fixture');
  };
  return {
    createSession: fail,
    prompt: fail,
    awaitResult: fail,
    abort: fail,
    isSettled: fail,
    llmComplete: fail,
    promptOrchestrator: fail,
    invokeAction: fail,
  };
}

interface LlmScript {
  responses: Array<{ text: string } | Error>;
}

/** A scriptable `llmComplete`-only engine, keyed by call order (used for llm-body onItemError tests). */
function makeLlmEngine(script: LlmScript): { engine: WorkflowEngineDeps; calls: number } {
  const queue = [...script.responses];
  let calls = 0;
  const engine: WorkflowEngineDeps = {
    ...unusedEngine(),
    llmComplete: async () => {
      calls++;
      const next = queue.shift();
      if (next === undefined) throw new Error('scripted llmComplete queue exhausted');
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { engine, calls };
}

interface Submission {
  queueItemId: string;
  threadId: string;
  settled: boolean;
  result?: Omit<SubmissionResult, 'queueItemId'>;
}

/** A scriptable session-submission engine: `prompt` parks by default; `settle` marks a queueItemId ready. */
function makeSessionEngine(): {
  engine: WorkflowEngineDeps;
  promptCalls: Array<{ dispatchId: string; sessionId: string }>;
  settle: (queueItemId: string, result: Omit<SubmissionResult, 'queueItemId'>) => void;
} {
  const subsByDispatch = new Map<string, Submission>();
  const promptCalls: Array<{ dispatchId: string; sessionId: string }> = [];
  let counter = 0;

  function findByQueueItem(queueItemId: string): Submission | undefined {
    for (const sub of subsByDispatch.values()) {
      if (sub.queueItemId === queueItemId) return sub;
    }
    return undefined;
  }

  const engine: WorkflowEngineDeps = {
    createSession: async (opts) => ({ id: opts.id }),
    prompt: async (sessionId, _text, opts) => {
      promptCalls.push({ dispatchId: opts.dispatchId, sessionId });
      let sub = subsByDispatch.get(opts.dispatchId);
      if (!sub) {
        counter++;
        sub = { queueItemId: `queue-${counter}`, threadId: `thread-${counter}`, settled: false };
        subsByDispatch.set(opts.dispatchId, sub);
      }
      return { threadId: sub.threadId, queueItemId: sub.queueItemId };
    },
    awaitResult: async (_sessionId, _threadId, queueItemId) => {
      const sub = findByQueueItem(queueItemId);
      if (!sub || !sub.settled || !sub.result) {
        throw new Error(`awaitResult called before ${queueItemId} was settled`);
      }
      return { ...sub.result, queueItemId };
    },
    isSettled: async (_sessionId, queueItemId) => findByQueueItem(queueItemId)?.settled ?? false,
    abort: async () => {},
    llmComplete: async () => {
      throw new Error('llmComplete not exercised by this fixture');
    },
    promptOrchestrator: async () => {
      throw new Error('promptOrchestrator not exercised by this fixture');
    },
    invokeAction: async () => {
      throw new Error('invokeAction not exercised by this fixture');
    },
  };

  return {
    engine,
    promptCalls,
    settle: (queueItemId, result) => {
      const sub = findByQueueItem(queueItemId);
      if (!sub) throw new Error(`unknown queueItemId ${queueItemId}`);
      sub.settled = true;
      sub.result = result;
    },
  };
}

// ─── 1. Non-array items → foreach failed, run failed ─────────────────────────

describe('executeForeach: non-array items', () => {
  it('fails the node (and the run) without attempting any iteration', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const definition = foreachDefinition({ items: '{{trigger.data.items}}', body: setBody });

    await store.createRun(
      'run-1',
      runParams({ input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: { items: 'not-an-array' }, metadata: {} } }),
      definition,
      'v1',
    );
    const attempt = await claimAttempt(store, 'run-1');
    const park = await driveUntilPark('run-1', attempt, { store, engine: unusedEngine(), clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('failed');

    const byNode = new Map((await store.getCheckpoints('run-1')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('loop')?.status).toBe('failed');
    expect(byNode.get('loop')?.error).toMatch(/did not resolve to an array/);
    // No body checkpoint was ever written.
    expect((await store.getCheckpoints('run-1')).some((cp) => cp.nodeId === 'body')).toBe(false);
  });
});

// ─── 2. Truncation ─────────────────────────────────────────────────────────

describe('executeForeach: truncation', () => {
  it('truncates to maxItems and records truncatedCount', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const items = Array.from({ length: 12 }, (_, i) => `item-${i}`);
    const definition = foreachDefinition({ items: '{{trigger.data.items}}', body: setBody, maxItems: 10 });

    await store.createRun('run-2', runParams({ input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: { items }, metadata: {} } }), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-2');
    const park = await driveUntilPark('run-2', attempt, { store, engine: unusedEngine(), clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');

    const byNode = new Map((await store.getCheckpoints('run-2')).map((cp) => [cp.nodeId, cp]));
    const result = byNode.get('loop')?.result as { count: number; inputCount: number; truncatedCount: number };
    expect(result.count).toBe(10);
    expect(result.inputCount).toBe(12);
    expect(result.truncatedCount).toBe(2);
  });
});

// ─── 3. Aliases reach the body template ──────────────────────────────────────

describe('executeForeach: aliases reach the body template', () => {
  it('resolves {{item}}/{{index}} (and custom alias names) in the set body', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const items = ['a', 'b'];
    const definition = foreachDefinition({
      items: '{{trigger.data.items}}',
      body: { id: 'body', type: 'set', values: { seen: '{{widget}}-{{idx}}' } },
      itemAlias: 'widget',
      indexAlias: 'idx',
    });

    await store.createRun('run-3', runParams({ input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: { items }, metadata: {} } }), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-3');
    const park = await driveUntilPark('run-3', attempt, { store, engine: unusedEngine(), clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');

    const byNode = new Map((await store.getCheckpoints('run-3')).map((cp) => [cp.nodeId, cp]));
    const result = byNode.get('loop')?.result as { items: Array<{ status: string; data?: unknown }> };
    expect(result.items).toEqual([
      { status: 'completed', data: { seen: 'a-0' } },
      { status: 'completed', data: { seen: 'b-1' } },
    ]);
  });
});

// ─── 4. Sequential completion (concurrency 1) + exact aggregate shape ────────

describe('executeForeach: sequential completion, concurrency 1', () => {
  it('completes the whole array in one pass with the exact ForeachResult shape', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const items = ['x', 'y', 'z'];
    const definition = foreachDefinition({ items: '{{trigger.data.items}}', body: setBody, concurrency: 1 });

    await store.createRun('run-4', runParams({ input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: { items }, metadata: {} } }), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-4');
    const park = await driveUntilPark('run-4', attempt, { store, engine: unusedEngine(), clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');

    const byNode = new Map((await store.getCheckpoints('run-4')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('loop')?.result).toEqual({
      items: [
        { status: 'completed', data: { seen: 'x-0' } },
        { status: 'completed', data: { seen: 'y-1' } },
        { status: 'completed', data: { seen: 'z-2' } },
      ],
      count: 3,
      inputCount: 3,
      truncatedCount: 0,
      completedCount: 3,
      skippedCount: 0,
      failedCount: 0,
    });

    // Body checkpoints were written at iterations 0..2 for the body id, not the foreach's own id.
    const bodyCps = (await store.getCheckpoints('run-4')).filter((cp) => cp.nodeId === 'body');
    expect(bodyCps.map((cp) => cp.iteration).sort()).toEqual([0, 1, 2]);
  });
});

// ─── 5. Concurrency 2 with parking session bodies ────────────────────────────

describe('executeForeach: concurrency 2 with session bodies', () => {
  it('dispatches exactly 2, parks with 2 waits, and completes all after out-of-order settlement', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const items = ['a', 'b', 'c'];
    const sessionBody: SessionNode = { id: 'body', type: 'session', mode: 'start', prompt: 'handle {{item}}' };
    const definition = foreachDefinition({ items: '{{trigger.data.items}}', body: sessionBody, concurrency: 2 });
    const { engine, promptCalls, settle } = makeSessionEngine();

    await store.createRun('run-5', runParams({ input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: { items }, metadata: {} } }), definition, 'v1');
    const attempt1 = await claimAttempt(store, 'run-5');
    const park1 = await driveUntilPark('run-5', attempt1, { store, engine, clock: clock.now });

    expect(park1.status).toBe('parked');
    expect(promptCalls).toHaveLength(2);
    expect(promptCalls.map((c) => c.dispatchId).sort()).toEqual(['workflow:run-5:body', 'workflow:run-5:body:1']);
    expect(park1.waitingOn).toHaveLength(2);

    // Settle item 1 (out of order) first — item 2 should now be dispatched.
    settle('queue-2', { outcome: 'completed', text: 'done-b' });
    const attempt2 = await claimAttempt(store, 'run-5', 'owner-2');
    const park2 = await driveUntilPark('run-5', attempt2, { store, engine, clock: clock.now });

    expect(park2.status).toBe('parked');
    expect(promptCalls).toHaveLength(3);
    expect(promptCalls.some((c) => c.dispatchId === 'workflow:run-5:body:2')).toBe(true);

    // Settle the remaining two.
    settle('queue-1', { outcome: 'completed', text: 'done-a' });
    settle('queue-3', { outcome: 'completed', text: 'done-c' });
    const attempt3 = await claimAttempt(store, 'run-5', 'owner-3');
    const park3 = await driveUntilPark('run-5', attempt3, { store, engine, clock: clock.now });

    expect(park3.status).toBe('settled');
    expect(park3.outcome).toBe('completed');

    const byNode = new Map((await store.getCheckpoints('run-5')).map((cp) => [cp.nodeId, cp]));
    const result = byNode.get('loop')?.result as { completedCount: number; count: number };
    expect(result.completedCount).toBe(3);
    expect(result.count).toBe(3);
  });
});

// ─── 6. onItemError 'fail': first failure fails the foreach; in-flight left as-is ─

describe('executeForeach: onItemError "fail"', () => {
  it('fails the foreach on the first failed iteration, leaving an in-flight sibling parked and un-aborted', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const items = ['a', 'b'];
    const sessionBody: SessionNode = { id: 'body', type: 'session', mode: 'start', prompt: 'handle {{item}}' };
    const definition = foreachDefinition({ items: '{{trigger.data.items}}', body: sessionBody, concurrency: 2, onItemError: 'fail' });
    const { engine, settle } = makeSessionEngine();

    await store.createRun('run-6', runParams({ input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: { items }, metadata: {} } }), definition, 'v1');
    const attempt1 = await claimAttempt(store, 'run-6');
    const park1 = await driveUntilPark('run-6', attempt1, { store, engine, clock: clock.now });
    expect(park1.status).toBe('parked'); // both items dispatched and parked

    // Item 1 (index 1, queue-2) settles as aborted; item 0 stays unsettled.
    settle('queue-2', { outcome: 'aborted', error: 'boom' });
    const attempt2 = await claimAttempt(store, 'run-6', 'owner-2');
    const park2 = await driveUntilPark('run-6', attempt2, { store, engine, clock: clock.now });

    expect(park2.status).toBe('settled');
    expect(park2.outcome).toBe('failed');

    const byNode = new Map((await store.getCheckpoints('run-6')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('loop')?.status).toBe('failed');
    const result = byNode.get('loop')?.result as { items: Array<{ status: string; error?: string }> };
    expect(result.items[1]?.status).toBe('failed');
    expect(result.items[1]?.error).toBe('boom');
    // Item 0 was never resolved — its body checkpoint is still 'intent' (left to ride/settle,
    // never actively aborted by this executor).
    const bodyCps = new Map((await store.getCheckpoints('run-6')).filter((cp) => cp.nodeId === 'body').map((cp) => [cp.iteration, cp]));
    expect(bodyCps.get(0)?.status).toBe('intent');
  });
});

// ─── 7. onItemError 'skip' ────────────────────────────────────────────────────

describe('executeForeach: onItemError "skip"', () => {
  it('records failed items as status "skipped" without data, and the foreach still completes', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const items = ['ok', 'bad'];
    const llmBody: LlmNode = { id: 'body', type: 'llm', model: 'haiku', prompt: 'process {{item}}' };
    const definition = foreachDefinition({ items: '{{trigger.data.items}}', body: llmBody, onItemError: 'skip' });
    const { engine } = makeLlmEngine({ responses: [{ text: 'fine' }, new Error('model exploded')] });

    await store.createRun('run-7', runParams({ input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: { items }, metadata: {} } }), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-7');
    const park = await driveUntilPark('run-7', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');

    const byNode = new Map((await store.getCheckpoints('run-7')).map((cp) => [cp.nodeId, cp]));
    const result = byNode.get('loop')?.result as {
      items: Array<{ status: string; data?: unknown; error?: string }>;
      completedCount: number;
      skippedCount: number;
      failedCount: number;
    };
    expect(result.items[0]).toEqual({ status: 'completed', data: { text: 'fine' } });
    expect(result.items[1]?.status).toBe('skipped');
    expect(result.items[1]?.data).toBeUndefined();
    expect(result.items[1]?.error).toBe('model exploded');
    expect(result.completedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.failedCount).toBe(0);
  });
});

// ─── 8. onItemError 'collect' ─────────────────────────────────────────────────

describe('executeForeach: onItemError "collect"', () => {
  it('records failed items as status "failed" with the error, and the foreach still completes', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const items = ['ok', 'bad'];
    const llmBody: LlmNode = { id: 'body', type: 'llm', model: 'haiku', prompt: 'process {{item}}' };
    const definition = foreachDefinition({ items: '{{trigger.data.items}}', body: llmBody, onItemError: 'collect' });
    const { engine } = makeLlmEngine({ responses: [{ text: 'fine' }, new Error('model exploded')] });

    await store.createRun('run-8', runParams({ input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: { items }, metadata: {} } }), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-8');
    const park = await driveUntilPark('run-8', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');

    const byNode = new Map((await store.getCheckpoints('run-8')).map((cp) => [cp.nodeId, cp]));
    const result = byNode.get('loop')?.result as {
      items: Array<{ status: string; error?: string }>;
      completedCount: number;
      skippedCount: number;
      failedCount: number;
    };
    expect(result.items[1]).toEqual({ status: 'failed', error: 'model exploded' });
    expect(result.completedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.failedCount).toBe(1);
  });
});

// ─── 9. Re-drive idempotency: terminal iterations are not re-executed ────────

describe('executeForeach: re-drive after a crash mid-loop', () => {
  it('does not re-invoke the body executor for an already-terminal iteration', async () => {
    const clock = makeClock();
    const store = new InMemoryWorkflowStore(clock.now);
    const items = ['a', 'b', 'c'];
    const definition = foreachDefinition({ items: '{{trigger.data.items}}', body: setBody, concurrency: 1 });

    let bodyCompleteCount = 0;
    const originalCompleteCheckpoint = store.completeCheckpoint.bind(store);
    store.completeCheckpoint = async (runId, nodeId, iter, attempt, terminal) => {
      if (nodeId === 'body') {
        bodyCompleteCount += 1;
        if (bodyCompleteCount === 2) {
          throw new Error('simulated crash after item 0 completed, before item 1 does');
        }
      }
      return originalCompleteCheckpoint(runId, nodeId, iter, attempt, terminal);
    };

    await store.createRun('run-9', runParams({ input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: { items }, metadata: {} } }), definition, 'v1');
    const attempt1 = await claimAttempt(store, 'run-9');
    await expect(driveUntilPark('run-9', attempt1, { store, engine: unusedEngine(), clock: clock.now })).rejects.toThrow(
      'simulated crash after item 0 completed',
    );

    store.completeCheckpoint = originalCompleteCheckpoint;
    clock.advance(30_001);
    const attempt2 = await claimAttempt(store, 'run-9', 'owner-2');
    const park2 = await driveUntilPark('run-9', attempt2, { store, engine: unusedEngine(), clock: clock.now });

    expect(park2.status).toBe('settled');
    expect(park2.outcome).toBe('completed');

    // Item 0's body checkpoint was written exactly once across both drives —
    // the re-drive skipped straight past its terminal row.
    const bodyCps = (await store.getCheckpoints('run-9')).filter((cp) => cp.nodeId === 'body');
    const iter0Cp = bodyCps.find((cp) => cp.iteration === 0);
    expect(iter0Cp?.status).toBe('completed');
    expect(iter0Cp?.attempt).toBe(attempt1); // written by the first attempt, never rewritten by the second

    const byNode = new Map((await store.getCheckpoints('run-9')).map((cp) => [cp.nodeId, cp]));
    const result = byNode.get('loop')?.result as { completedCount: number };
    expect(result.completedCount).toBe(3);
  });
});

// ─── 10. Downstream node reads the foreach aggregate ─────────────────────────

describe('executeForeach: downstream node consumes the aggregate', () => {
  it('exposes nodes.<foreachId>.output.completedCount and .items[i].data to a downstream set node', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const items = ['a', 'b'];
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'loop', type: 'foreach', items: '{{trigger.data.items}}', body: setBody },
        { id: 'summary', type: 'set', values: { total: '{{nodes.loop.output.completedCount}}', first: '{{nodes.loop.output.items[0].data.seen}}' } },
        { id: 'e', type: 'stop', outcome: 'success' },
      ],
      edges: [
        { from: 't', to: 'loop' },
        { from: 'loop', to: 'summary' },
        { from: 'summary', to: 'e' },
      ],
    };

    await store.createRun('run-10', runParams({ input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: { items }, metadata: {} } }), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-10');
    const park = await driveUntilPark('run-10', attempt, { store, engine: unusedEngine(), clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');

    const byNode = new Map((await store.getCheckpoints('run-10')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('summary')?.result).toEqual({ total: 2, first: 'a-0' });
  });
});

// ─── 11. Validator: itemAlias/indexAlias cannot shadow the template context ──

describe('executeForeach: alias-shadow validator rejection', () => {
  it('rejects itemAlias or indexAlias set to "trigger" or "nodes"', () => {
    const base: WorkflowDefinition = foreachDefinition({ items: '{{trigger.data.items}}', body: setBody });

    const withItemAlias: WorkflowDefinition = {
      ...base,
      nodes: base.nodes.map((n) => (n.id === 'loop' ? { ...(n as ForeachNode), itemAlias: 'trigger' } : n)),
    };
    const result1 = validateWorkflowDefinition(withItemAlias);
    expect(result1.ok).toBe(false);
    if (!result1.ok) {
      expect(result1.errors.some((e) => e.includes('itemAlias') && e.includes('shadows'))).toBe(true);
    }

    const withIndexAlias: WorkflowDefinition = {
      ...base,
      nodes: base.nodes.map((n) => (n.id === 'loop' ? { ...(n as ForeachNode), indexAlias: 'nodes' } : n)),
    };
    const result2 = validateWorkflowDefinition(withIndexAlias);
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(result2.errors.some((e) => e.includes('indexAlias') && e.includes('shadows'))).toBe(true);
    }
  });
});

// ─── 12. Direct-call contract (mirrors the other executors' iteration tests) ──
//
// `executeForeach` is invoked by `driveUntilPark` at iteration 0 in every
// other test above (a foreach can never itself be a foreach body, so
// iteration > 0 never actually occurs for this executor in practice) — this
// exercises the bare function the way `driveUntilPark` does, confirming it
// checkpoints itself at the iteration it was given.

describe('executeForeach: direct-call contract', () => {
  it('checkpoints the foreach itself at the given iteration and completes with the aggregate', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const definition = foreachDefinition({ items: '{{trigger.data.items}}', body: setBody });
    await store.createRun('run-11', runParams({ input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: { items: ['x'] }, metadata: {} } }), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-11');
    const run = await store.getRun('run-11');
    if (!run) throw new Error('run vanished');
    const node = definition.nodes.find((n): n is ForeachNode => n.id === 'loop')!;

    const result = await executeForeach({
      run,
      node,
      attempt,
      iteration: 0,
      templateContext: { trigger: run.params.input, nodes: {} },
      store,
      clock: clock.now,
      engine: unusedEngine(),
    });

    expect(result.status).toBe('completed');
    const cps = await store.getCheckpoints('run-11');
    const loopCp = cps.find((cp) => cp.nodeId === 'loop' && cp.iteration === 0);
    expect(loopCp?.status).toBe('completed');
  });
});
