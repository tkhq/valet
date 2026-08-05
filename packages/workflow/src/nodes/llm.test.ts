import { describe, expect, it } from 'vitest';

import type { LlmNode } from '../dag/nodes.js';
import type { WorkflowDefinition } from '../dag/shape.js';
import type {
  WorkflowEngineDeps,
  WorkflowLlmCompleteRequest,
  WorkflowLlmCompleteResult,
  WorkflowLlmUsage,
} from '../engine-deps.js';
import { driveUntilPark } from '../interpreter.js';
import { InMemoryWorkflowStore } from '../memory-store.js';
import type { RunParams } from '../store.js';
import { executeLlm } from './llm.js';

/** Fixture default — most tests don't care about usage values, only that
 * SOME usage is captured and threaded through. Tests that specifically
 * cover usage capture (below) use distinct non-zero values per call so a
 * repair round's SUM is distinguishable from either call alone. */
const ZERO_USAGE: WorkflowLlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

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

/** A scriptable, call-recording fake `WorkflowEngineDeps` for the llm node.
 * Response literals may omit `usage` — it defaults to `ZERO_USAGE` — so
 * the majority of fixtures below that don't care about usage values stay
 * untouched; tests that DO care supply it explicitly. */
function makeEngine(
  responses: Array<({ text: string; usage?: WorkflowLlmUsage }) | Error> = [{ text: 'ok' }],
): { engine: WorkflowEngineDeps; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = [...responses];

  function next(): WorkflowLlmCompleteResult {
    const value = queue.length > 1 ? queue.shift() : queue[0];
    if (value === undefined) throw new Error('scripted queue exhausted');
    if (value instanceof Error) throw value;
    return { text: value.text, usage: value.usage ?? ZERO_USAGE };
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
    expect(byNode.get('l')?.result).toEqual({ text: 'the summary', usage: ZERO_USAGE });
  });

  it('captures the completion usage into the checkpoint result, not just text', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const usage: WorkflowLlmUsage = {
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      costUsd: 0.0042,
    };
    const { engine } = makeEngine([{ text: 'the summary', usage }]);

    await store.createRun('run-1b', runParams(), llmDefinition(), 'v1');
    const attempt = await claimAttempt(store, 'run-1b');
    await driveUntilPark('run-1b', attempt, { store, engine, clock: clock.now });

    const byNode = new Map((await store.getCheckpoints('run-1b')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('l')?.result).toEqual({ text: 'the summary', usage });
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
    expect(byNode.get('l')?.result).toEqual({
      text: '```json\n{"answer":"42"}\n```',
      output: { answer: '42' },
      usage: ZERO_USAGE,
    });
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
    expect(byNode.get('l')?.result).toEqual({ text: '{"answer":"42"}', output: { answer: '42' }, usage: ZERO_USAGE });
    expect(byNode.get('l')?.effects?.repairAttempted).toBe(true);
  });

  it('sums usage across BOTH calls — the first (failed-validation) call was still a real billed completion', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    const firstUsage: WorkflowLlmUsage = {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 120,
      costUsd: 0.001,
    };
    const repairUsage: WorkflowLlmUsage = {
      inputTokens: 150,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 160,
      costUsd: 0.002,
    };
    const { engine } = makeEngine([
      { text: 'not json at all', usage: firstUsage },
      { text: '{"answer":"42"}', usage: repairUsage },
    ]);

    await store.createRun('run-3b', runParams(), llmDefinition({ outputSchema }), 'v1');
    const attempt = await claimAttempt(store, 'run-3b');
    await driveUntilPark('run-3b', attempt, { store, engine, clock: clock.now });

    const byNode = new Map((await store.getCheckpoints('run-3b')).map((cp) => [cp.nodeId, cp]));
    const result = byNode.get('l')?.result as { usage: WorkflowLlmUsage } | undefined;
    expect(result?.usage).toEqual({
      inputTokens: 250,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 280,
      costUsd: 0.003,
    });
  });

  it('rounds summed costUsd to avoid floating-point drift — 0.1 + 0.2 must report exactly 0.3, not 0.30000000000000004', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    const firstUsage: WorkflowLlmUsage = {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 120,
      costUsd: 0.1,
    };
    const repairUsage: WorkflowLlmUsage = {
      inputTokens: 150,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 160,
      costUsd: 0.2,
    };
    const { engine } = makeEngine([
      { text: 'not json at all', usage: firstUsage },
      { text: '{"answer":"42"}', usage: repairUsage },
    ]);

    await store.createRun('run-3e', runParams(), llmDefinition({ outputSchema }), 'v1');
    const attempt = await claimAttempt(store, 'run-3e');
    await driveUntilPark('run-3e', attempt, { store, engine, clock: clock.now });

    const byNode = new Map((await store.getCheckpoints('run-3e')).map((cp) => [cp.nodeId, cp]));
    const result = byNode.get('l')?.result as { usage: WorkflowLlmUsage } | undefined;
    expect(result?.usage.costUsd).toBe(0.3);
  });

  it('on resume after a crash AFTER the repair decision was persisted (only the repair call\'s TERMINAL checkpoint was lost), only the repair call\'s usage is reported', async () => {
    const clock = makeClock();
    const store = new InMemoryWorkflowStore(clock.now);
    const outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    const repairUsage: WorkflowLlmUsage = {
      inputTokens: 150,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 160,
      costUsd: 0.002,
    };

    // Seeds the state a resume sees when `effects.repairAttempted` was
    // ALREADY checkpointed before the crash (llm.ts's own docstring,
    // "resumed after a crash before the repair call's result was
    // checkpointed"). `executeLlm` reads `repairAttempted: true` and skips
    // the `!effects.repairAttempted` block (llm.ts:111) entirely, so
    // `firstCallUsage` stays undefined by construction — the first call's
    // usage was already spent and never re-derivable from this state,
    // which is what makes it genuinely unrecoverable (not a crash-mechanics
    // gap this test needs to replay — see test 8 for that).
    const definition = llmDefinition({ outputSchema });
    await store.createRun('run-3c', runParams(), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-3c');
    await store.putIntent({
      runId: 'run-3c',
      nodeId: 'l',
      iteration: 0,
      status: 'intent',
      attempt,
      createdAt: clock.now(),
      effects: { repairAttempted: true, firstError: 'result did not match the schema' },
    });

    const { engine } = makeEngine([{ text: '{"answer":"42"}', usage: repairUsage }]);
    await driveUntilPark('run-3c', attempt, { store, engine, clock: clock.now });

    const byNode = new Map((await store.getCheckpoints('run-3c')).map((cp) => [cp.nodeId, cp]));
    const result = byNode.get('l')?.result as { usage: WorkflowLlmUsage } | undefined;
    expect(result?.usage).toEqual(repairUsage);
  });

  it('on resume BEFORE the repair decision was ever persisted, the crash just duplicates the first call — its (new) usage is captured normally, nothing is lost', async () => {
    const clock = makeClock();
    const store = new InMemoryWorkflowStore(clock.now);
    const outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };

    // Distinct from the test above: here the crash happens BEFORE
    // `effects.repairAttempted` was ever checkpointed. `executeLlm`'s only
    // persisted state on resume is the pre-call intent (written at
    // llm.ts:88-98, `repairAttempted: false`) — so it reads
    // `!effects.repairAttempted` as true and calls `engine.llmComplete`
    // AGAIN, exactly like test 8's documented at-least-once duplicate.
    // The resulting completion becomes THIS invocation's `firstCallUsage`
    // and is captured normally — this crash point produces a duplicate
    // billed call (the accepted cost test 8 already covers), not a usage
    // GAP, which is the distinction the fix's docstring draws.
    const definition = llmDefinition({ outputSchema });
    await store.createRun('run-3d', runParams(), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-3d');
    await store.putIntent({
      runId: 'run-3d',
      nodeId: 'l',
      iteration: 0,
      status: 'intent',
      attempt,
      createdAt: clock.now(),
      effects: { repairAttempted: false },
    });

    const duplicateFirstUsage: WorkflowLlmUsage = {
      inputTokens: 70,
      outputTokens: 8,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 78,
      costUsd: 0.0009,
    };
    const repairUsage: WorkflowLlmUsage = {
      inputTokens: 150,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 160,
      costUsd: 0.002,
    };
    const { engine, calls } = makeEngine([
      { text: 'nope', usage: duplicateFirstUsage },
      { text: '{"answer":"42"}', usage: repairUsage },
    ]);
    await driveUntilPark('run-3d', attempt, { store, engine, clock: clock.now });

    expect(calls).toHaveLength(2);
    const byNode = new Map((await store.getCheckpoints('run-3d')).map((cp) => [cp.nodeId, cp]));
    const result = byNode.get('l')?.result as { usage: WorkflowLlmUsage } | undefined;
    expect(result?.usage).toEqual({
      inputTokens: 220,
      outputTokens: 18,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 238,
      costUsd: 0.0029,
    });
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

  it('still reports the summed usage of BOTH real billed calls, even though the node ultimately fails', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    const firstUsage: WorkflowLlmUsage = {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 120,
      costUsd: 0.01,
    };
    const repairUsage: WorkflowLlmUsage = {
      inputTokens: 90,
      outputTokens: 15,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 105,
      costUsd: 0.02,
    };
    const { engine } = makeEngine([
      { text: 'nope', usage: firstUsage },
      { text: 'still nope', usage: repairUsage },
    ]);

    await store.createRun('run-4b', runParams(), llmDefinition({ outputSchema }), 'v1');
    const attempt = await claimAttempt(store, 'run-4b');
    await driveUntilPark('run-4b', attempt, { store, engine, clock: clock.now });

    const byNode = new Map((await store.getCheckpoints('run-4b')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('l')?.status).toBe('failed');
    // Both calls were real, billed completions — a failed node must not
    // report $0 for work that actually happened.
    expect(byNode.get('l')?.effects?.usage).toEqual({
      inputTokens: 190,
      outputTokens: 35,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 225,
      costUsd: 0.03,
    });
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

  it('reports the first call\'s usage when the FIRST call succeeded but the REPAIR call throws', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    const firstUsage: WorkflowLlmUsage = {
      inputTokens: 80,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 90,
      costUsd: 0.005,
    };
    const { engine } = makeEngine([
      { text: 'nope', usage: firstUsage },
      new Error('model unavailable during repair'),
    ]);

    await store.createRun('run-5b', runParams(), llmDefinition({ outputSchema }), 'v1');
    const attempt = await claimAttempt(store, 'run-5b');
    await driveUntilPark('run-5b', attempt, { store, engine, clock: clock.now });

    const byNode = new Map((await store.getCheckpoints('run-5b')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('l')?.status).toBe('failed');
    expect(byNode.get('l')?.error).toBe('model unavailable during repair');
    // The first call was real and billed even though the repair call
    // itself never returned a completion to sum against.
    expect(byNode.get('l')?.effects?.usage).toEqual(firstUsage);
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
