/**
 * Batch fan-out phase 3 behaviours of `executeForeach`:
 *   - over-length input is never dropped in silence;
 *   - `concurrency` bounds real parallelism, not just parked submissions;
 *   - a fail-mode pass reports one deterministic failure and keeps every
 *     terminal item's real status.
 *
 * `foreach.test.ts` covers the phase-1/2 contract (aliases, aggregate
 * shape, onItemError policies, re-drive idempotency). These are separate so
 * the two can be read on their own.
 */

import { describe, expect, it, vi } from 'vitest';

import type { SubmissionResult } from '@valet/engine';

import type { ForeachNode, LlmNode, SessionNode, SetNode } from '../dag/nodes.js';
import type { WorkflowDefinition } from '../dag/shape.js';
import type { WorkflowEngineDeps, WorkflowLlmUsage } from '../engine-deps.js';
import { driveUntilPark } from '../interpreter.js';
import { InMemoryWorkflowStore } from '../memory-store.js';
import type { NodeCheckpoint, RunParams } from '../store.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ZERO_USAGE: WorkflowLlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

const setBody: SetNode = { id: 'body', type: 'set', values: { seen: '{{item}}' } };

function runParams(items: unknown[]): RunParams {
  return {
    workflowId: 'wf-1',
    definitionVersionId: 'v1',
    input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: { items }, metadata: {} },
  };
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

async function claimAttempt(store: InMemoryWorkflowStore, runId: string, ownerId = 'owner'): Promise<number> {
  const claim = await store.claimRun(runId, ownerId, 30_000);
  if (!claim) throw new Error(`could not claim run ${runId}`);
  return claim.attempt;
}

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

/** Yields the microtask queue `n` times, so a suspended body lets its siblings start. */
async function yieldTicks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/**
 * An `llmComplete` that records how many calls are in flight at once, and
 * that holds each call open across several microtask turns so genuinely
 * concurrent bodies overlap. Responses are keyed by the item text in the
 * prompt, so a per-item outcome does not depend on dispatch order.
 */
function makeOverlapEngine(outcomes: Map<string, string | Error>): {
  engine: WorkflowEngineDeps;
  maxActive: () => number;
  order: () => string[];
} {
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const engine: WorkflowEngineDeps = {
    ...unusedEngine(),
    llmComplete: async (req) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(req.prompt);
      await yieldTicks(5);
      active -= 1;
      const outcome = outcomes.get(req.prompt);
      if (outcome === undefined) throw new Error(`no scripted outcome for prompt ${req.prompt}`);
      if (outcome instanceof Error) throw outcome;
      return { text: outcome, usage: ZERO_USAGE };
    },
  };
  return { engine, maxActive: () => maxActive, order: () => order };
}

interface Submission {
  queueItemId: string;
  threadId: string;
  settled: boolean;
  result?: Omit<SubmissionResult, 'queueItemId'>;
}

/** A session engine whose submissions park until `settle` marks them ready. */
function makeSessionEngine(): {
  engine: WorkflowEngineDeps;
  promptCalls: string[];
  settle: (queueItemId: string, result: Omit<SubmissionResult, 'queueItemId'>) => void;
} {
  const subsByDispatch = new Map<string, Submission>();
  const promptCalls: string[] = [];
  let counter = 0;

  function findByQueueItem(queueItemId: string): Submission | undefined {
    for (const sub of subsByDispatch.values()) {
      if (sub.queueItemId === queueItemId) return sub;
    }
    return undefined;
  }

  const engine: WorkflowEngineDeps = {
    ...unusedEngine(),
    createSession: async (opts) => ({ id: opts.id }),
    prompt: async (_sessionId, _text, opts) => {
      promptCalls.push(opts.dispatchId);
      let sub = subsByDispatch.get(opts.dispatchId);
      if (!sub) {
        counter += 1;
        sub = { queueItemId: `queue-${counter}`, threadId: `thread-${counter}`, settled: false };
        subsByDispatch.set(opts.dispatchId, sub);
      }
      return { threadId: sub.threadId, queueItemId: sub.queueItemId };
    },
    awaitResult: async (_sessionId, _threadId, queueItemId) => {
      const sub = findByQueueItem(queueItemId);
      if (!sub || !sub.settled || !sub.result) throw new Error(`awaitResult called before ${queueItemId} settled`);
      return { ...sub.result, queueItemId };
    },
    isSettled: async (_sessionId, queueItemId) => findByQueueItem(queueItemId)?.settled ?? false,
    abort: async () => {},
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

function loopCheckpoint(checkpoints: NodeCheckpoint[]): NodeCheckpoint | undefined {
  return checkpoints.find((cp) => cp.nodeId === 'loop');
}

// ─── Over-length input ───────────────────────────────────────────────────────

describe('executeForeach: over-length input without maxItems', () => {
  it('fails the node and names both corrections, rather than dropping rows', async () => {
    const store = new InMemoryWorkflowStore();
    const items = Array.from({ length: 101 }, (_, i) => `item-${i}`);
    const definition = foreachDefinition({ items: '{{trigger.data.items}}', body: setBody });

    await store.createRun('run-over', runParams(items), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-over');
    const park = await driveUntilPark('run-over', attempt, { store, engine: unusedEngine(), clock: () => 1_000 });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('failed');

    const checkpoints = await store.getCheckpoints('run-over');
    const loop = loopCheckpoint(checkpoints);
    expect(loop?.status).toBe('failed');
    expect(loop?.error).toContain('101 entries');
    expect(loop?.error).toContain('built-in limit of 100');
    expect(loop?.error).toContain('Set maxItems');
    expect(loop?.error).toContain('narrow the items expression');

    // Nothing was executed: a partial batch is exactly what this refuses to do.
    expect(checkpoints.filter((cp) => cp.nodeId === 'body')).toHaveLength(0);
  });

  it('runs the whole array when it sits on the built-in limit', async () => {
    const store = new InMemoryWorkflowStore();
    const items = Array.from({ length: 100 }, (_, i) => `item-${i}`);
    const definition = foreachDefinition({ items: '{{trigger.data.items}}', body: setBody });

    await store.createRun('run-at-limit', runParams(items), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-at-limit');
    const park = await driveUntilPark('run-at-limit', attempt, { store, engine: unusedEngine(), clock: () => 1_000 });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');
    const result = loopCheckpoint(await store.getCheckpoints('run-at-limit'))?.result as {
      completedCount: number;
      truncated?: true;
    };
    expect(result.completedCount).toBe(100);
    expect(result.truncated).toBeUndefined();
  });
});

describe('executeForeach: truncation under an explicit maxItems', () => {
  it('carries truncated + truncationWarning on the aggregate and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new InMemoryWorkflowStore();
      const items = Array.from({ length: 7 }, (_, i) => `item-${i}`);
      const definition = foreachDefinition({ items: '{{trigger.data.items}}', body: setBody, maxItems: 3 });

      await store.createRun('run-trunc', runParams(items), definition, 'v1');
      const attempt = await claimAttempt(store, 'run-trunc');
      const park = await driveUntilPark('run-trunc', attempt, { store, engine: unusedEngine(), clock: () => 1_000 });

      expect(park.status).toBe('settled');
      expect(park.outcome).toBe('completed');

      const result = loopCheckpoint(await store.getCheckpoints('run-trunc'))?.result as {
        count: number;
        truncatedCount: number;
        truncated?: true;
        truncationWarning?: string;
      };
      expect(result.count).toBe(3);
      expect(result.truncatedCount).toBe(4);
      expect(result.truncated).toBe(true);
      expect(result.truncationWarning).toContain('4 of 7 entries were dropped');
      expect(result.truncationWarning).toContain('Raise maxItems');

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('4 of 7 entries were dropped');
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves the aggregate shape untouched when nothing is dropped', async () => {
    const store = new InMemoryWorkflowStore();
    const definition = foreachDefinition({ items: '{{trigger.data.items}}', body: setBody, maxItems: 10 });

    await store.createRun('run-no-trunc', runParams(['a', 'b']), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-no-trunc');
    await driveUntilPark('run-no-trunc', attempt, { store, engine: unusedEngine(), clock: () => 1_000 });

    expect(loopCheckpoint(await store.getCheckpoints('run-no-trunc'))?.result).toEqual({
      items: [
        { status: 'completed', data: { seen: 'a' } },
        { status: 'completed', data: { seen: 'b' } },
      ],
      count: 2,
      inputCount: 2,
      truncatedCount: 0,
      completedCount: 2,
      skippedCount: 0,
      failedCount: 0,
    });
  });
});

// ─── Real per-item parallelism ───────────────────────────────────────────────

describe('executeForeach: concurrency bounds real parallelism', () => {
  it('runs non-parking bodies concurrently up to the declared width', async () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'];
    const outcomes = new Map<string, string | Error>(items.map((item) => [`handle ${item}`, `done ${item}`]));
    const { engine, maxActive } = makeOverlapEngine(outcomes);

    const llmBody: LlmNode = { id: 'body', type: 'llm', model: 'test-model', prompt: 'handle {{item}}' };
    const definition = foreachDefinition({ items: '{{trigger.data.items}}', body: llmBody, concurrency: 3 });

    const store = new InMemoryWorkflowStore();
    await store.createRun('run-par', runParams(items), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-par');
    const park = await driveUntilPark('run-par', attempt, { store, engine, clock: () => 1_000 });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');

    const result = loopCheckpoint(await store.getCheckpoints('run-par'))?.result as { completedCount: number };
    expect(result.completedCount).toBe(6);

    // Before phase 3 this was always 1: an `llm` body never parks, so the
    // old parked-only accounting made `concurrency` a no-op for it.
    expect(maxActive()).toBeGreaterThanOrEqual(2);
    expect(maxActive()).toBeLessThanOrEqual(3);
  });

  it('keeps a concurrency of 1 strictly serial', async () => {
    const items = ['a', 'b', 'c'];
    const outcomes = new Map<string, string | Error>(items.map((item) => [`handle ${item}`, `done ${item}`]));
    const { engine, maxActive, order } = makeOverlapEngine(outcomes);

    const llmBody: LlmNode = { id: 'body', type: 'llm', model: 'test-model', prompt: 'handle {{item}}' };
    const definition = foreachDefinition({ items: '{{trigger.data.items}}', body: llmBody, concurrency: 1 });

    const store = new InMemoryWorkflowStore();
    await store.createRun('run-serial', runParams(items), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-serial');
    await driveUntilPark('run-serial', attempt, { store, engine, clock: () => 1_000 });

    expect(maxActive()).toBe(1);
    expect(order()).toEqual(['handle a', 'handle b', 'handle c']);
  });

  it('never exceeds the width when there are more items than workers', async () => {
    const items = Array.from({ length: 9 }, (_, i) => `i${i}`);
    const outcomes = new Map<string, string | Error>(items.map((item) => [`handle ${item}`, 'ok']));
    const { engine, maxActive } = makeOverlapEngine(outcomes);

    const llmBody: LlmNode = { id: 'body', type: 'llm', model: 'test-model', prompt: 'handle {{item}}' };
    const definition = foreachDefinition({
      items: '{{trigger.data.items}}',
      body: llmBody,
      concurrency: 2,
      maxItems: 9,
    });

    const store = new InMemoryWorkflowStore();
    await store.createRun('run-width', runParams(items), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-width');
    await driveUntilPark('run-width', attempt, { store, engine, clock: () => 1_000 });

    expect(maxActive()).toBeLessThanOrEqual(2);
    expect(maxActive()).toBeGreaterThanOrEqual(2);
    const result = loopCheckpoint(await store.getCheckpoints('run-width'))?.result as { completedCount: number };
    expect(result.completedCount).toBe(9);
  });
});

// ─── Fail-mode determinism and honest reporting ──────────────────────────────

describe('executeForeach: fail mode with concurrent bodies', () => {
  it('reports the lowest-index failure when two bodies fail in the same wave', async () => {
    const outcomes = new Map<string, string | Error>([
      ['handle a', new Error('first item exploded')],
      ['handle b', new Error('second item exploded')],
    ]);
    const { engine } = makeOverlapEngine(outcomes);

    const llmBody: LlmNode = { id: 'body', type: 'llm', model: 'test-model', prompt: 'handle {{item}}' };
    const definition = foreachDefinition({
      items: '{{trigger.data.items}}',
      body: llmBody,
      concurrency: 2,
      onItemError: 'fail',
    });

    const store = new InMemoryWorkflowStore();
    await store.createRun('run-two-fail', runParams(['a', 'b']), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-two-fail');
    const park = await driveUntilPark('run-two-fail', attempt, { store, engine, clock: () => 1_000 });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('failed');

    const loop = loopCheckpoint(await store.getCheckpoints('run-two-fail'));
    expect(loop?.status).toBe('failed');
    expect(loop?.error).toContain('first item exploded');
    expect(loop?.error).not.toContain('second item exploded');
  });

  it('keeps the real status of an item that completed above the failing index', async () => {
    const sessionBody: SessionNode = { id: 'body', type: 'session', mode: 'start', prompt: 'handle {{item}}' };
    const definition = foreachDefinition({
      items: '{{trigger.data.items}}',
      body: sessionBody,
      concurrency: 3,
      onItemError: 'fail',
    });
    const { engine, settle } = makeSessionEngine();

    const store = new InMemoryWorkflowStore();
    await store.createRun('run-mixed', runParams(['a', 'b', 'c']), definition, 'v1');
    const attempt1 = await claimAttempt(store, 'run-mixed');
    const park1 = await driveUntilPark('run-mixed', attempt1, { store, engine, clock: () => 1_000 });
    expect(park1.status).toBe('parked');

    // Item 1 fails; item 2 succeeds; item 0 is still running.
    settle('queue-2', { outcome: 'aborted', error: 'boom' });
    settle('queue-3', { outcome: 'completed', text: 'done-c' });

    const attempt2 = await claimAttempt(store, 'run-mixed', 'owner-2');
    const park2 = await driveUntilPark('run-mixed', attempt2, { store, engine, clock: () => 1_000 });
    expect(park2.status).toBe('settled');
    expect(park2.outcome).toBe('failed');

    const result = loopCheckpoint(await store.getCheckpoints('run-mixed'))?.result as {
      items: Array<{ status: string; error?: string }>;
    };
    expect(result.items[0]?.status).toBe('skipped'); // never resolved, aborted best-effort
    expect(result.items[1]?.status).toBe('failed');
    // Phase 1 reads every terminal row before the halt, so a real success at
    // a higher index than the failure is no longer reported as skipped.
    expect(result.items[2]?.status).toBe('completed');
  });
});
