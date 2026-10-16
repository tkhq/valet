import { describe, expect, it } from 'vitest';

import type { SubmissionResult } from '@valet/engine';
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider, extractStructuredOutput, ValidationError } from '@valet/engine';
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from '@valet/engine/test-helpers';
import { Type } from 'typebox';

import type { SessionNode } from '../dag/nodes.js';
import type { WorkflowDefinition } from '../dag/shape.js';
import type { WorkflowEngineDeps, WorkflowPromptReceipt } from '../engine-deps.js';
import { driveUntilPark } from '../interpreter.js';
import { InMemoryWorkflowStore } from '../memory-store.js';
import type { RunParams } from '../store.js';
import { executeSession } from './session.js';

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

function sessionDefinition(node: Partial<SessionNode> = {}): WorkflowDefinition {
  const session: SessionNode = {
    id: 's',
    type: 'session',
    mode: 'start',
    prompt: 'do the thing for {{trigger.data.thing}}',
    ...node,
  };
  return {
    version: 'dag/v1',
    nodes: [
      { id: 't', type: 'trigger' },
      session,
      { id: 'e', type: 'stop', outcome: 'success' },
    ],
    edges: [
      { from: 't', to: 's' },
      { from: 's', to: 'e' },
    ],
  };
}

interface RecordedCall {
  kind: 'createSession' | 'prompt' | 'awaitResult' | 'abort' | 'isSettled';
  [key: string]: unknown;
}

/** A scriptable, call-recording fake `WorkflowEngineDeps`. */
function makeEngine(
  config: {
    awaitResultQueue?: Array<Omit<SubmissionResult, 'queueItemId'>>;
    isSettledQueue?: boolean[];
  } = {},
): { engine: WorkflowEngineDeps; calls: RecordedCall[]; receiptsByDispatch: Map<string, WorkflowPromptReceipt> } {
  const calls: RecordedCall[] = [];
  const receiptsByDispatch = new Map<string, WorkflowPromptReceipt>();
  let receiptCounter = 0;
  const awaitResultQueue = [...(config.awaitResultQueue ?? [{ outcome: 'completed' as const, text: 'ok' }])];
  const isSettledQueue = [...(config.isSettledQueue ?? [true])];

  function nextFrom<T>(queue: T[]): T {
    const value = queue.length > 1 ? queue.shift() : queue[0];
    if (value === undefined) throw new Error('scripted queue exhausted');
    return value;
  }

  const engine: WorkflowEngineDeps = {
    createSession: async (opts) => {
      calls.push({ kind: 'createSession', id: opts.id, title: opts.title, purpose: opts.purpose });
      return { id: opts.id };
    },
    prompt: async (sessionId, text, opts) => {
      calls.push({ kind: 'prompt', sessionId, text, dispatchId: opts.dispatchId, model: opts.model, queueMode: opts.queueMode });
      let receipt = receiptsByDispatch.get(opts.dispatchId);
      if (!receipt) {
        receiptCounter += 1;
        receipt = { threadId: `thread-${receiptCounter}`, queueItemId: `queue-${receiptCounter}` };
        receiptsByDispatch.set(opts.dispatchId, receipt);
      }
      return receipt;
    },
    awaitResult: async (sessionId, threadId, queueItemId, opts) => {
      calls.push({ kind: 'awaitResult', sessionId, threadId, queueItemId, resultSchema: opts?.resultSchema });
      const scripted = nextFrom(awaitResultQueue);
      return { ...scripted, queueItemId };
    },
    abort: async (sessionId, threadId) => {
      calls.push({ kind: 'abort', sessionId, threadId });
    },
    isSettled: async (sessionId, queueItemId) => {
      calls.push({ kind: 'isSettled', sessionId, queueItemId });
      return nextFrom(isSettledQueue);
    },
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

  return { engine, calls, receiptsByDispatch };
}

// ─── 1. Intent-before-dispatch ordering ──────────────────────────────────────

describe('executeSession: intent-before-dispatch ordering', () => {
  it('writes the intent checkpoint before calling createSession/prompt, and again before parking', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine } = makeEngine();
    const order: string[] = [];

    const originalPutIntent = store.putIntent.bind(store);
    store.putIntent = async (cp) => {
      if (cp.nodeId === 's') {
        order.push(cp.effects?.receipt === undefined ? 'putIntent:session-only' : 'putIntent:receipt');
      }
      return originalPutIntent(cp);
    };
    const originalCreateSession = engine.createSession.bind(engine);
    engine.createSession = async (opts) => {
      order.push('createSession');
      return originalCreateSession(opts);
    };
    const originalPrompt = engine.prompt.bind(engine);
    engine.prompt = async (sessionId, text, opts) => {
      order.push('prompt');
      return originalPrompt(sessionId, text, opts);
    };

    await store.createRun('run-1', runParams(), sessionDefinition(), 'v1');
    const attempt = await claimAttempt(store, 'run-1');
    const park = await driveUntilPark('run-1', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('parked');
    expect(order).toEqual(['putIntent:session-only', 'createSession', 'prompt', 'putIntent:receipt']);
  });
});

// ─── 2. Deterministic ids ─────────────────────────────────────────────────────

describe('executeSession: deterministic ids', () => {
  it('uses wf:{runId}:{nodeId} for the session id and workflow:{runId}:{nodeId} for the dispatchId', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine();

    await store.createRun('run-2', runParams(), sessionDefinition(), 'v1');
    const attempt = await claimAttempt(store, 'run-2');
    await driveUntilPark('run-2', attempt, { store, engine, clock: clock.now });

    const createCall = calls.find((c) => c.kind === 'createSession');
    const promptCall = calls.find((c) => c.kind === 'prompt');
    expect(createCall?.id).toBe('wf:run-2:s');
    expect(promptCall?.sessionId).toBe('wf:run-2:s');
    expect(promptCall?.dispatchId).toBe('workflow:run-2:s');
  });
});

// ─── 3. Crash between dispatch and receipt persist ───────────────────────────

describe('executeSession: crash between dispatch and receipt persist', () => {
  it('re-dispatches with identical ids on reclaim; the engine dedupes to a single receipt', async () => {
    const clock = makeClock();
    // Lease expiry (below) is computed against the store's own clock, which
    // must be the fake clock here — the default `Date.now()` would never
    // observe `clock.advance(...)`.
    const store = new InMemoryWorkflowStore(clock.now);
    const { engine, calls, receiptsByDispatch } = makeEngine();

    let sessionPutIntentCount = 0;
    const originalPutIntent = store.putIntent.bind(store);
    store.putIntent = async (cp) => {
      if (cp.nodeId === 's') {
        sessionPutIntentCount += 1;
        if (sessionPutIntentCount === 2) {
          throw new Error('simulated crash before receipt persisted');
        }
      }
      return originalPutIntent(cp);
    };

    await store.createRun('run-3', runParams(), sessionDefinition(), 'v1');
    const attempt1 = await claimAttempt(store, 'run-3');
    await expect(driveUntilPark('run-3', attempt1, { store, engine, clock: clock.now })).rejects.toThrow(
      'simulated crash before receipt persisted',
    );

    store.putIntent = originalPutIntent;

    // The crashed attempt's lease is still live; simulate the lease expiring
    // before a new owner reclaims (the run never parked, so `parkRun`'s
    // ownership-clearing never ran).
    clock.advance(30_001);
    const attempt2 = await claimAttempt(store, 'run-3', 'owner-2');
    expect(attempt2).toBeGreaterThan(attempt1);
    const park2 = await driveUntilPark('run-3', attempt2, { store, engine, clock: clock.now });
    expect(park2.status).toBe('parked');

    const promptCalls = calls.filter((c) => c.kind === 'prompt');
    expect(promptCalls).toHaveLength(2); // dispatched once before the crash, once on retry
    expect(new Set(promptCalls.map((c) => c.dispatchId)).size).toBe(1); // identical dispatchId both times

    const createCalls = calls.filter((c) => c.kind === 'createSession');
    expect(createCalls).toHaveLength(2);
    expect(new Set(createCalls.map((c) => c.id)).size).toBe(1); // identical session id both times

    // Exactly one distinct receipt was ever issued (the fake engine dedupes by dispatchId).
    expect(receiptsByDispatch.size).toBe(1);

    const byNode = new Map((await store.getCheckpoints('run-3')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('s')?.effects?.receipt).toEqual(receiptsByDispatch.get('workflow:run-3:s'));
  });
});

// ─── 4. wait.mode 'none' completes without parking ───────────────────────────

describe('executeSession: wait.mode "none"', () => {
  it('completes immediately with { sessionId, receipt } without parking', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine();

    await store.createRun('run-4', runParams(), sessionDefinition({ wait: { mode: 'none' } }), 'v1');
    const attempt = await claimAttempt(store, 'run-4');
    const park = await driveUntilPark('run-4', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');
    expect(calls.some((c) => c.kind === 'awaitResult' || c.kind === 'isSettled')).toBe(false);

    const byNode = new Map((await store.getCheckpoints('run-4')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('s')?.status).toBe('completed');
    expect(byNode.get('s')?.result).toMatchObject({ sessionId: 'wf:run-4:s' });
  });
});

// ─── 5. Settled completed + valid output ─────────────────────────────────────

describe('executeSession: settled completed with valid output', () => {
  it('completes the node with { sessionId, response, output }', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    const { engine } = makeEngine({
      isSettledQueue: [true],
      awaitResultQueue: [{ outcome: 'completed', text: 'The answer is 42', output: { answer: '42' } }],
    });

    await store.createRun('run-5', runParams(), sessionDefinition({ outputSchema }), 'v1');
    const attempt1 = await claimAttempt(store, 'run-5');
    const park1 = await driveUntilPark('run-5', attempt1, { store, engine, clock: clock.now });
    expect(park1.status).toBe('parked');

    const attempt2 = await claimAttempt(store, 'run-5', 'owner-2');
    const park2 = await driveUntilPark('run-5', attempt2, { store, engine, clock: clock.now });
    expect(park2.status).toBe('settled');
    expect(park2.outcome).toBe('completed');

    const byNode = new Map((await store.getCheckpoints('run-5')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('s')?.status).toBe('completed');
    expect(byNode.get('s')?.result).toEqual({
      sessionId: 'wf:run-5:s',
      response: 'The answer is 42',
      output: { answer: '42' },
    });
  });
});

// ─── 5b. A schema step keeps its prose response ──────────────────────────────

describe('executeSession: schema step keeps its prose response', () => {
  const outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };

  it('asks for the normal response plus a trailing json block, not JSON only', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine();

    await store.createRun('run-5b', runParams(), sessionDefinition({ outputSchema }), 'v1');
    const attempt = await claimAttempt(store, 'run-5b');
    await driveUntilPark('run-5b', attempt, { store, engine, clock: clock.now });

    const primary = String(calls.find((c) => c.kind === 'prompt')?.text);
    expect(primary).toContain(JSON.stringify(outputSchema));
    expect(primary).not.toMatch(/ONLY JSON/i);
    expect(primary).toContain('End it with one fenced ```json block');
  });

  it('keeps the prose in response and the parsed block in output', async () => {
    const prose = '| PR | Status |\n| --- | --- |\n| #1 | merged |\n\nOne pull request merged today.';
    const reply = `${prose}\n\n\`\`\`json\n{"answer":"42"}\n\`\`\``;
    const extracted = extractStructuredOutput(reply, outputSchema);
    expect(extracted.output).toEqual({ answer: '42' });
    expect(extractStructuredOutput('{"answer":"42"}', outputSchema).output).toEqual({ answer: '42' });

    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine } = makeEngine({
      isSettledQueue: [true],
      awaitResultQueue: [{ outcome: 'completed', text: reply, output: extracted.output }],
    });

    await store.createRun('run-5c', runParams(), sessionDefinition({ outputSchema }), 'v1');
    await driveUntilPark('run-5c', await claimAttempt(store, 'run-5c'), { store, engine, clock: clock.now });
    await driveUntilPark('run-5c', await claimAttempt(store, 'run-5c', 'owner-2'), { store, engine, clock: clock.now });

    const result = (await store.getCheckpoints('run-5c')).find((cp) => cp.nodeId === 's')?.result;
    expect(result).toMatchObject({ output: { answer: '42' } });
    expect(String((result as { response?: string }).response)).toContain(prose);
  });
});

// ─── 6. isSettled false on re-entry: re-parks without calling awaitResult ────

describe('executeSession: isSettled false on re-entry', () => {
  it('re-parks on the same submission (spurious wake) without calling awaitResult', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine({ isSettledQueue: [false] });

    await store.createRun('run-6', runParams(), sessionDefinition(), 'v1');
    const attempt1 = await claimAttempt(store, 'run-6');
    const park1 = await driveUntilPark('run-6', attempt1, { store, engine, clock: clock.now });
    expect(park1.status).toBe('parked');

    const attempt2 = await claimAttempt(store, 'run-6', 'owner-2');
    const park2 = await driveUntilPark('run-6', attempt2, { store, engine, clock: clock.now });

    expect(park2.status).toBe('parked');
    expect(park2.waitingOn).toEqual(park1.waitingOn);
    expect(calls.some((c) => c.kind === 'isSettled')).toBe(true);
    expect(calls.some((c) => c.kind === 'awaitResult')).toBe(false);
  });
});

// ─── 7. Validation failure triggers exactly one repair ───────────────────────

describe('executeSession: schema validation failure triggers exactly one repair', () => {
  it('prompts dispatchId+":repair" with queueMode "followup", schema + error in the prompt, then parks', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    const { engine, calls } = makeEngine({
      isSettledQueue: [true],
      awaitResultQueue: [{ outcome: 'completed', text: 'not json', error: 'result did not match schema: /answer: missing value' }],
    });

    await store.createRun('run-7', runParams(), sessionDefinition({ outputSchema }), 'v1');
    const attempt1 = await claimAttempt(store, 'run-7');
    await driveUntilPark('run-7', attempt1, { store, engine, clock: clock.now });

    const attempt2 = await claimAttempt(store, 'run-7', 'owner-2');
    const park2 = await driveUntilPark('run-7', attempt2, { store, engine, clock: clock.now });
    expect(park2.status).toBe('parked');

    const repairCalls = calls.filter((c) => c.kind === 'prompt' && c.dispatchId === 'workflow:run-7:s:repair');
    expect(repairCalls).toHaveLength(1);
    expect(repairCalls[0]?.queueMode).toBe('followup');
    const repairText = String(repairCalls[0]?.text);
    expect(repairText).toContain(JSON.stringify(outputSchema));
    expect(repairText).toContain('missing value');
    expect(repairText).toContain('Reuse prior successful tool results');
    expect(repairText).toContain('Do not repeat actions with side effects');
    expect(repairText).toContain('Do not invent empty arrays');
    expect(repairText).toContain('If work remains incomplete but actionable');
    expect(repairText).toContain('using available read tools');
    expect(repairText).toContain('before returning the result');
    expect(repairText).toContain('remaining authorized work');
    expect(repairText).toContain('Reuse completed work and do not repeat side effects');
    expect(repairText).toContain('If a genuine blocker prevents completion');
    expect(repairText).toContain('report it truthfully');
    expect(repairText).toContain('JSON-only applies to your final reply, not to intervening tool use');
    const primary = calls.find((call) => call.kind === 'prompt' && call.dispatchId === 'workflow:run-7:s');
    expect(String(primary?.text)).toContain(JSON.stringify(outputSchema));
    expect(String(primary?.text)).toContain('End it with one fenced ```json block');

    const byNode = new Map((await store.getCheckpoints('run-7')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('s')?.status).toBe('intent'); // still parked on the repair submission, not terminal
    expect(byNode.get('s')?.effects?.repairAttempted).toBe(true);
    expect(byNode.get('s')?.effects?.firstError).toContain('missing value');
    // The repair replaces the receipt; the first submission stays findable.
    const effects = byNode.get('s')?.effects;
    const receipt = effects?.receipt;
    const repairQueueItemId = receipt && typeof receipt === 'object' && 'queueItemId' in receipt ? receipt.queueItemId : undefined;
    expect(typeof effects?.firstQueueItemId).toBe('string');
    expect(typeof repairQueueItemId).toBe('string');
    expect(effects?.firstQueueItemId).not.toBe(repairQueueItemId);
  });
});

// ─── 8. Second validation failure fails the node ─────────────────────────────

describe('executeSession: second validation failure fails the node', () => {
  it('fails the node (and the run) once repairAttempted is already true', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    const { engine, calls } = makeEngine({
      isSettledQueue: [true],
      awaitResultQueue: [
        { outcome: 'completed', text: 'nope', error: 'first validation error' },
        { outcome: 'completed', text: 'still nope', error: 'second validation error' },
      ],
    });

    await store.createRun('run-8', runParams(), sessionDefinition({ outputSchema }), 'v1');
    const attempt1 = await claimAttempt(store, 'run-8');
    await driveUntilPark('run-8', attempt1, { store, engine, clock: clock.now }); // dispatch, park

    const attempt2 = await claimAttempt(store, 'run-8', 'owner-2');
    const park2 = await driveUntilPark('run-8', attempt2, { store, engine, clock: clock.now }); // 1st failure -> repair, park
    expect(park2.status).toBe('parked');

    const attempt3 = await claimAttempt(store, 'run-8', 'owner-3');
    const park3 = await driveUntilPark('run-8', attempt3, { store, engine, clock: clock.now }); // 2nd failure -> node failed
    expect(park3.status).toBe('settled');
    expect(park3.outcome).toBe('failed');

    const byNode = new Map((await store.getCheckpoints('run-8')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('s')?.status).toBe('failed');
    expect(byNode.get('s')?.error).toMatch(/second validation error/);
    expect(byNode.get('s')?.effects?.firstError).toBe('first validation error');
    // The settled checkpoint keeps the first submission after the repair failed too.
    expect(typeof byNode.get('s')?.effects?.firstQueueItemId).toBe('string');
    expect(byNode.get('s')?.result).toBeUndefined();

    const repairCalls = calls.filter((c) => c.kind === 'prompt' && c.dispatchId === 'workflow:run-8:s:repair');
    expect(repairCalls).toHaveLength(1); // exactly one repair attempt, ever
  });
});

// ─── 9. aborted/failed outcome fails the node ────────────────────────────────

describe('executeSession: non-completed outcome fails the node', () => {
  it('fails the node with the submission error for an aborted outcome', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine } = makeEngine({
      isSettledQueue: [true],
      awaitResultQueue: [{ outcome: 'aborted', error: 'cancelled by user' }],
    });

    await store.createRun('run-9', runParams(), sessionDefinition(), 'v1');
    const attempt1 = await claimAttempt(store, 'run-9');
    await driveUntilPark('run-9', attempt1, { store, engine, clock: clock.now });

    const attempt2 = await claimAttempt(store, 'run-9', 'owner-2');
    const park2 = await driveUntilPark('run-9', attempt2, { store, engine, clock: clock.now });
    expect(park2.status).toBe('settled');
    expect(park2.outcome).toBe('failed');

    const byNode = new Map((await store.getCheckpoints('run-9')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('s')?.status).toBe('failed');
    expect(byNode.get('s')?.error).toBe('cancelled by user');
  });
});

// ─── 9b. a ValidationError at dispatch fails the NODE, not the drive ─────────
//
// The engine validates the per-item model pin at admission (thread-model-
// pinning design, decision 2), so `engine.prompt` can now reject with a
// deterministic ValidationError for an unknown `node.model`. Rethrowing
// would poison the drive (abandon lease → re-drive → same throw, until the
// poisoned-run cap fails the whole run with no per-node error).

describe('executeSession: ValidationError at dispatch fails the node', () => {
  it('settles the node failed with the admission error instead of throwing out of the drive', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine } = makeEngine();
    engine.prompt = async () => {
      throw new ValidationError('unknown model id: gone-model-9999. Run /model to list the available models.');
    };

    await store.createRun('run-9b', runParams(), sessionDefinition({ model: 'gone-model-9999' }), 'v1');
    const attempt = await claimAttempt(store, 'run-9b');
    const park = await driveUntilPark('run-9b', attempt, { store, engine, clock: clock.now });
    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('failed');

    const byNode = new Map((await store.getCheckpoints('run-9b')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('s')?.status).toBe('failed');
    expect(byNode.get('s')?.error).toMatch(/unknown model id: gone-model-9999/);
  });
});

// ─── 10. iteration > 0: id suffix + checkpoint keyed at the iteration ────────
//
// `driveUntilPark` always drives the definition's own nodes at iteration 0
// (no `foreach` executor exists yet to invoke a body at iteration > 0 — that
// lands in Task 6). This exercises the executor's contract directly, the way
// a future `foreach` executor will invoke it for one loop iteration.

describe('executeSession: iteration > 0', () => {
  it('appends :{iteration} to the session id and dispatchId, and checkpoints at that iteration', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine();

    const definition = sessionDefinition({ wait: { mode: 'none' } });
    await store.createRun('run-10', runParams(), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-10');
    const run = await store.getRun('run-10');
    if (!run) throw new Error('run vanished');
    const node = definition.nodes.find((n): n is SessionNode => n.id === 's')!;

    const result = await executeSession({
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
    const createCall = calls.find((c) => c.kind === 'createSession');
    const promptCall = calls.find((c) => c.kind === 'prompt');
    expect(createCall?.id).toBe('wf:run-10:s:1');
    expect(promptCall?.sessionId).toBe('wf:run-10:s:1');
    expect(promptCall?.dispatchId).toBe('workflow:run-10:s:1');

    const checkpoints = await store.getCheckpoints('run-10');
    const cp = checkpoints.find((c) => c.nodeId === 's' && c.iteration === 1);
    expect(cp).toBeDefined();
    expect(cp?.status).toBe('completed');
    // No stray iteration-0 checkpoint was written for this node.
    expect(checkpoints.some((c) => c.nodeId === 's' && c.iteration === 0)).toBe(false);
  });
});

// ─── 11. aliases merge into the template context ─────────────────────────────

describe('executeSession: aliases', () => {
  it('resolves {{item}} from aliases when rendering the prompt', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine();

    const definition = sessionDefinition({ prompt: 'process {{item}} at index {{index}}', wait: { mode: 'none' } });
    await store.createRun('run-11', runParams(), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-11');
    const run = await store.getRun('run-11');
    if (!run) throw new Error('run vanished');
    const node = definition.nodes.find((n): n is SessionNode => n.id === 's')!;

    await executeSession({
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

    const promptCall = calls.find((c) => c.kind === 'prompt');
    expect(promptCall?.text).toBe('process widget-7 at index 1');
  });
});

// Schema validity cannot prove whether an empty inventory reflects successful inspection.
describe('sessionDefinition: structured inventory results', () => {
  it.each(['completed', 'failed'] as const)('preserves the %s outcome when repair returns a schema-valid empty array', async (outcome) => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const outputSchema = { type: 'object', properties: { candidates: { type: 'array', items: { type: 'string' } } }, required: ['candidates'] };
    const { engine, calls } = makeEngine({
      isSettledQueue: [true],
      awaitResultQueue: [
        { outcome: 'completed', text: 'The inspection needs more time.', error: 'no JSON content found in result text' },
        { outcome, text: '{"candidates":[]}', output: { candidates: [] }, ...(outcome === 'failed' ? { error: 'inspection tool failed' } : {}) },
      ],
    });
    await store.createRun('inventory', runParams(), sessionDefinition({ outputSchema }), 'v1');
    for (let i = 0; i < 3; i++) {
      const attempt = await claimAttempt(store, 'inventory', `owner-${i}`);
      await driveUntilPark('inventory', attempt, { store, engine, clock: clock.now });
    }
    const checkpoint = (await store.getCheckpoints('inventory')).find((cp) => cp.nodeId === 's');
    expect(checkpoint?.status).toBe(outcome);
    expect(checkpoint?.effects).toMatchObject({ repairAttempted: true, firstError: 'no JSON content found in result text' });
    if (outcome === 'failed') {
      expect(checkpoint?.error).toBe('inspection tool failed');
      expect(checkpoint?.result).toBeUndefined();
    } else {
      expect(checkpoint?.result).toMatchObject({ output: { candidates: [] } });
    }
    expect(calls.filter((call) => call.kind === 'prompt')).toHaveLength(2);
  });
});

// Scripted compliance verifies runtime wiring, not live model task completion.
describe('executeSession: actionable repair through the real engine', () => {
  it.each([false, true])('finishes inspection or fails truthfully when blocked=%s', async (blocked) => {
    const faux = registerFauxProvider({ provider: `workflow-actionable-repair-${blocked}` });
    const sessionStore = new InMemorySessionStore();
    const runtime = new Engine({ providers: {
      store: sessionStore, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider(),
    } });
    const store = new InMemoryWorkflowStore();
    const reads: string[] = [];
    let completedActions = 0;
    const posts: Record<string, unknown>[] = [];
    const dispatches: WorkflowPromptReceipt[] = [];
    const { engine } = makeEngine();
    engine.createSession = async (opts) => runtime.createSession({
      ...opts, userId: 'u', orgId: 'o', workspace: '/', sandbox: {}, model: faux.getModel(),
      tools: [
        {
          name: 'inspect_repo', description: 'Read repository evidence.',
          parameters: Type.Object({ repo: Type.String() }),
          execute: async (args) => {
            if (!args || typeof args !== 'object' || !('repo' in args) || typeof args.repo !== 'string') {
              throw new Error('repo is required');
            }
            reads.push(args.repo);
            if (blocked && args.repo === 'beta') {
              throw new Error('Repository access denied. Request access from the repository owner.');
            }
            return { text: `${args.repo}: inspected` };
          },
        },
        {
          name: 'save_marker', description: 'Record the authorized inspection start once.', parameters: Type.Object({}),
          execute: async () => { completedActions++; return { text: 'marker saved' }; },
        },
      ],
    });
    engine.prompt = async (id, text, opts) => {
      const session = runtime.getSession(id);
      if (!session) throw new Error('session missing');
      const receipt = await session.prompt(text, opts);
      dispatches.push(receipt);
      return receipt;
    };
    engine.isSettled = async (id, queueItemId) => (await sessionStore.getQueueItem(id, queueItemId))?.status === 'settled';
    engine.awaitResult = async (id, threadId, queueItemId, opts) => {
      const thread = runtime.getSession(id)?.threadById(threadId);
      if (!thread) throw new Error('thread missing');
      return thread.awaitResult(queueItemId, opts);
    };
    engine.invokeAction = async (req) => { posts.push(req.params); return { ok: true, result: { posted: true } }; };
    const output = { repos: ['alpha: inspected', 'beta: inspected'] };
    const outputSchema = { type: 'object', properties: { repos: { type: 'array', items: { type: 'string' }, minItems: 2 } }, required: ['repos'] };
    const definition = sessionDefinition({
      prompt: 'Save the start marker once. Inspect alpha and beta. Return both repository findings.', outputSchema,
    });
    definition.nodes.splice(2, 0, {
      id: 'post', type: 'tool', service: 'test', action: 'post', params: { report: '{{nodes.s.output.output}}' },
    });
    definition.edges = [{ from: 't', to: 's' }, { from: 's', to: 'post' }, { from: 'post', to: 'e' }];
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('save_marker', {}, { id: 'marker' }),
        fauxToolCall('inspect_repo', { repo: 'alpha' }, { id: 'alpha' }),
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Alpha evidence recovered. Beta inspection is unfinished.'),
      (context) => {
        const last = context.messages.at(-1);
        const prompt = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
        expect(prompt).toContain('before returning the result');
        expect(prompt).toContain('JSON-only applies to your final reply, not to intervening tool use');
        expect(JSON.stringify(context.messages)).toContain('alpha: inspected');
        return fauxAssistantMessage([fauxToolCall('inspect_repo', { repo: 'beta' }, { id: 'beta' })], { stopReason: 'toolUse' });
      },
      (context) => {
        expect(JSON.stringify(context.messages)).toContain(blocked ? 'Repository access denied' : 'beta: inspected');
        return fauxAssistantMessage(blocked
          ? 'Blocked: beta repository access denied. Request access from the repository owner.'
          : JSON.stringify(output));
      },
    ]);
    const runId = `actionable-${blocked}`;
    try {
      await store.createRun(runId, runParams(), definition, 'v1');
      for (let i = 0; i < 3; i++) {
        const result = await driveUntilPark(runId, await claimAttempt(store, runId, `owner-${i}`), {
          store, engine, clock: Date.now,
        });
        if (i < 2) {
          expect(result.status).toBe('parked');
          const receipt = dispatches[i];
          const thread = runtime.getSession(`wf:${runId}:s`)?.threadById(receipt.threadId);
          if (!thread) throw new Error('thread missing');
          await thread.awaitResult(receipt.queueItemId, { timeoutMs: 2000 });
        } else {
          expect(result).toMatchObject({ status: 'settled', outcome: blocked ? 'failed' : 'completed' });
        }
      }
      const checkpoints = await store.getCheckpoints(runId);
      const research = checkpoints.find((cp) => cp.nodeId === 's');
      expect(research?.status).toBe(blocked ? 'failed' : 'completed');
      expect(research?.effects).toMatchObject({ repairAttempted: true, firstQueueItemId: dispatches[0].queueItemId });
      expect(dispatches).toHaveLength(2);
      const items = await Promise.all(dispatches.map((receipt) => sessionStore.getQueueItem(`wf:${runId}:s`, receipt.queueItemId)));
      expect(items.map((item) => item?.dispatchId)).toEqual([`workflow:${runId}:s`, `workflow:${runId}:s:repair`]);
      expect(items.every((item) => item?.attemptCount === 1 && item.status === 'settled')).toBe(true);
      const entries = await sessionStore.getEntries(`wf:${runId}:s`, dispatches[0].threadId);
      const betaCall = entries.find((entry) => entry.type === 'message' && entry.parts?.some((part) => part.type === 'tool_call' && part.callId === 'beta'));
      expect(betaCall?.queueItemId).toBe(dispatches[1].queueItemId);
      expect(new Set(dispatches.map((receipt) => receipt.threadId)).size).toBe(1);
      expect(new Set(dispatches.map((receipt) => receipt.queueItemId)).size).toBe(2);
      expect(reads).toEqual(['alpha', 'beta']);
      expect(completedActions).toBe(1);
      expect(faux.getPendingResponseCount()).toBe(0);
      if (blocked) {
        expect(research?.result).toBeUndefined();
        expect(research?.error).toContain('JSON');
        expect(entries.at(-1)).toMatchObject({ content: 'Blocked: beta repository access denied. Request access from the repository owner.' });
        expect(checkpoints.find((cp) => cp.nodeId === 'post')?.status).not.toBe('completed');
        expect(posts).toEqual([]);
      } else {
        expect(research?.result).toMatchObject({ output });
        expect(posts).toEqual([{ report: output }]);
      }
    } finally {
      await runtime.deleteSession(`wf:${runId}:s`);
      faux.unregister();
    }
  });
});
