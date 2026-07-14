import { describe, expect, it } from 'vitest';

import type { LlmNode } from '../dag/nodes.js';
import type { WorkflowDefinition } from '../dag/shape.js';
import type { WorkflowEngineDeps, WorkflowLlmCompleteRequest, WorkflowLlmCompleteResult } from '../engine-deps.js';
import { driveUntilPark } from '../interpreter.js';
import { InMemoryWorkflowStore } from '../memory-store.js';
import type { RunParams } from '../store.js';
import { executeLlm } from './llm.js';

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

function llmDefinition(node: Partial<LlmNode> = {}): WorkflowDefinition {
  const llm: LlmNode = {
    id: 'l',
    type: 'llm',
    model: 'claude-haiku',
    prompt: 'summarize {{trigger.data.thing}}',
    ...node,
  };
  return {
    version: 'dag/v1',
    nodes: [
      { id: 't', type: 'trigger' },
      llm,
      { id: 'e', type: 'stop', outcome: 'success' },
    ],
    edges: [
      { from: 't', to: 'l' },
      { from: 'l', to: 'e' },
    ],
  };
}

interface RecordedCall {
  kind: 'llmComplete';
  req: WorkflowLlmCompleteRequest;
}

/** A scriptable, call-recording fake `WorkflowEngineDeps` for the llm node. */
function makeEngine(
  responses: Array<Omit<WorkflowLlmCompleteResult, never> | Error> = [{ text: 'ok' }],
): { engine: WorkflowEngineDeps; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = [...responses];

  function next(): WorkflowLlmCompleteResult {
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
    llmComplete: async (req) => {
      const result = next();
      calls.push({ kind: 'llmComplete', req });
      return result;
    },
    promptOrchestrator: async () => {
      throw new Error('promptOrchestrator not exercised by this fixture');
    },
    invokeAction: async () => {
      throw new Error('invokeAction not exercised by this fixture');
    },
  };

  return { engine, calls };
}

// ─── 1. Happy path, text only ────────────────────────────────────────────────

describe('executeLlm: happy path, no outputSchema', () => {
  it('completes with { text } in a single call, never parking', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine([{ text: 'the summary' }]);

    await store.createRun('run-1', runParams(), llmDefinition(), 'v1');
    const attempt = await claimAttempt(store, 'run-1');
    const park = await driveUntilPark('run-1', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');
    expect(calls).toHaveLength(1);

    const byNode = new Map((await store.getCheckpoints('run-1')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('l')?.status).toBe('completed');
    expect(byNode.get('l')?.result).toEqual({ text: 'the summary' });
  });
});

// ─── 2. Schema valid → output ────────────────────────────────────────────────

describe('executeLlm: outputSchema set and valid on first try', () => {
  it('completes with { text, output }', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    const { engine, calls } = makeEngine([{ text: '```json\n{"answer":"42"}\n```' }]);

    await store.createRun('run-2', runParams(), llmDefinition({ outputSchema }), 'v1');
    const attempt = await claimAttempt(store, 'run-2');
    const park = await driveUntilPark('run-2', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');
    expect(calls).toHaveLength(1);

    const byNode = new Map((await store.getCheckpoints('run-2')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('l')?.status).toBe('completed');
    expect(byNode.get('l')?.result).toEqual({ text: '```json\n{"answer":"42"}\n```', output: { answer: '42' } });
  });
});

// ─── 3. Schema invalid then valid after ONE repair ───────────────────────────

describe('executeLlm: schema invalid, then valid after one repair', () => {
  it('calls llmComplete exactly twice; the repair prompt contains the schema and the first validation error', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    const { engine, calls } = makeEngine([{ text: 'not json at all' }, { text: '{"answer":"42"}' }]);

    await store.createRun('run-3', runParams(), llmDefinition({ outputSchema }), 'v1');
    const attempt = await claimAttempt(store, 'run-3');
    const park = await driveUntilPark('run-3', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');
    expect(calls).toHaveLength(2);

    const repairReq = calls[1]?.req;
    expect(repairReq?.prompt).toContain(JSON.stringify(outputSchema));
    // First failure is a JSON-parse error (not a schema-mismatch error) —
    // still asserted verbatim in the repair prompt.
    expect(repairReq?.prompt).toContain('failed to parse JSON from result text');

    const byNode = new Map((await store.getCheckpoints('run-3')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('l')?.status).toBe('completed');
    expect(byNode.get('l')?.result).toEqual({ text: '{"answer":"42"}', output: { answer: '42' } });
    expect(byNode.get('l')?.effects?.repairAttempted).toBe(true);
  });
});

// ─── 4. Invalid twice → node failed ──────────────────────────────────────────

describe('executeLlm: schema invalid twice', () => {
  it('fails the node (and the run) without a third call', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    const { engine, calls } = makeEngine([{ text: 'nope' }, { text: 'still nope' }]);

    await store.createRun('run-4', runParams(), llmDefinition({ outputSchema }), 'v1');
    const attempt = await claimAttempt(store, 'run-4');
    const park = await driveUntilPark('run-4', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('failed');
    expect(calls).toHaveLength(2); // repairAttempted prevented a third call

    const byNode = new Map((await store.getCheckpoints('run-4')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('l')?.status).toBe('failed');
    expect(byNode.get('l')?.effects?.repairAttempted).toBe(true);
    expect(byNode.get('l')?.error).toBeDefined();
  });
});

// ─── 5. llmComplete throws → node failed with the message ───────────────────

describe('executeLlm: llmComplete throws', () => {
  it('fails the node with the thrown error message', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine } = makeEngine([new Error('model unavailable')]);

    await store.createRun('run-5', runParams(), llmDefinition(), 'v1');
    const attempt = await claimAttempt(store, 'run-5');
    const park = await driveUntilPark('run-5', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('failed');

    const byNode = new Map((await store.getCheckpoints('run-5')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('l')?.status).toBe('failed');
    expect(byNode.get('l')?.error).toBe('model unavailable');
  });
});

// ─── 6. maxOutputTokens clamp ─────────────────────────────────────────────────

describe('executeLlm: maxOutputTokens clamp', () => {
  it('clamps a requested 999_999 down to the 16_384 ceiling before calling', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine([{ text: 'ok' }]);

    await store.createRun('run-6', runParams(), llmDefinition({ maxOutputTokens: 999_999 }), 'v1');
    const attempt = await claimAttempt(store, 'run-6');
    await driveUntilPark('run-6', attempt, { store, engine, clock: clock.now });

    expect(calls[0]?.req.maxOutputTokens).toBe(16_384);
  });
});

// ─── 7. Oversized result → failed ────────────────────────────────────────────

describe('executeLlm: oversized result', () => {
  it('fails the node when the result JSON exceeds 512KB', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const huge = 'x'.repeat(512 * 1024 + 1);
    const { engine } = makeEngine([{ text: huge }]);

    await store.createRun('run-7', runParams(), llmDefinition(), 'v1');
    const attempt = await claimAttempt(store, 'run-7');
    const park = await driveUntilPark('run-7', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('failed');

    const byNode = new Map((await store.getCheckpoints('run-7')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('l')?.status).toBe('failed');
    expect(byNode.get('l')?.error).toMatch(/exceeds/);
  });
});

// ─── 8. Crash-after-intent, re-drive re-calls llmComplete (at-least-once) ───
//
// Call count 2 across the two drives is tolerated ONLY in this test — it's
// the documented at-least-once duplicate-call window (no receiver-side
// dedup handle exists for `llmComplete`, unlike `session`'s `dispatchId`).

describe('executeLlm: crash after the intent write and the llmComplete call, before the terminal checkpoint', () => {
  it('re-drives and calls llmComplete again (2 calls total across both drives)', async () => {
    const clock = makeClock();
    const store = new InMemoryWorkflowStore(clock.now);
    const { engine, calls } = makeEngine([{ text: 'ok' }]);

    let llmCompleteCheckpointCount = 0;
    const originalCompleteCheckpoint = store.completeCheckpoint.bind(store);
    store.completeCheckpoint = async (runId, nodeId, iter, attempt, terminal) => {
      if (nodeId === 'l') {
        llmCompleteCheckpointCount += 1;
        if (llmCompleteCheckpointCount === 1) {
          throw new Error('simulated crash after llmComplete, before the terminal checkpoint');
        }
      }
      return originalCompleteCheckpoint(runId, nodeId, iter, attempt, terminal);
    };

    await store.createRun('run-8', runParams(), llmDefinition(), 'v1');
    const attempt1 = await claimAttempt(store, 'run-8');
    await expect(driveUntilPark('run-8', attempt1, { store, engine, clock: clock.now })).rejects.toThrow(
      'simulated crash after llmComplete, before the terminal checkpoint',
    );
    expect(calls).toHaveLength(1); // llmComplete was called once before the simulated crash

    store.completeCheckpoint = originalCompleteCheckpoint;

    // The crashed attempt's lease is still live; simulate it expiring before
    // a new owner reclaims (the run never parked, so `parkRun`'s
    // ownership-clearing never ran).
    clock.advance(30_001);
    const attempt2 = await claimAttempt(store, 'run-8', 'owner-2');
    const park2 = await driveUntilPark('run-8', attempt2, { store, engine, clock: clock.now });

    expect(park2.status).toBe('settled');
    expect(park2.outcome).toBe('completed');
    expect(calls).toHaveLength(2); // tolerated in this test only — the documented at-least-once duplicate

    const byNode = new Map((await store.getCheckpoints('run-8')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('l')?.status).toBe('completed');
  });
});

// ─── 9. Template rendering of prompt AND system over upstream node output ───

describe('executeLlm: template rendering', () => {
  it('renders both prompt and system against { trigger, nodes }', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine([{ text: 'ok' }]);

    await store.createRun(
      'run-9',
      runParams({ input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: { thing: 'widgets' }, metadata: {} } }),
      llmDefinition({ prompt: 'summarize {{trigger.data.thing}}', system: 'you are a {{trigger.data.thing}} expert' }),
      'v1',
    );
    const attempt = await claimAttempt(store, 'run-9');
    await driveUntilPark('run-9', attempt, { store, engine, clock: clock.now });

    expect(calls[0]?.req.prompt).toBe('summarize widgets');
    expect(calls[0]?.req.system).toBe('you are a widgets expert');
  });
});

// ─── 10. iteration > 0: checkpoint keyed at that iteration ───────────────────
//
// `driveUntilPark` always drives top-level nodes at iteration 0 (no
// `foreach` executor exists yet to invoke a body at iteration > 0 — Task 6).
// This exercises the executor's contract directly, as a future `foreach`
// executor will.

describe('executeLlm: iteration > 0', () => {
  it('checkpoints at the given iteration and resolves aliases in the prompt', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine([{ text: 'ok' }]);

    const definition = llmDefinition({ prompt: 'process {{item}} at index {{index}}' });
    await store.createRun('run-10', runParams(), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-10');
    const run = await store.getRun('run-10');
    if (!run) throw new Error('run vanished');
    const node = definition.nodes.find((n): n is LlmNode => n.id === 'l')!;

    const result = await executeLlm({
      run,
      node,
      attempt,
      iteration: 1,
      aliases: { item: 'widget-7', index: 1 },
      templateContext: { trigger: undefined, nodes: {} },
      store,
      clock: clock.now,
      engine,
    });

    expect(result.status).toBe('completed');
    expect(calls[0]?.req.prompt).toBe('process widget-7 at index 1');

    const checkpoints = await store.getCheckpoints('run-10');
    const cp = checkpoints.find((c) => c.nodeId === 'l' && c.iteration === 1);
    expect(cp).toBeDefined();
    expect(cp?.status).toBe('completed');
    expect(checkpoints.some((c) => c.nodeId === 'l' && c.iteration === 0)).toBe(false);
  });
});
