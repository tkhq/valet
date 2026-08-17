/**
 * `workflow` node (sub-workflow call) — drive-level lifecycle against the
 * in-memory store, executor-level guards, foreach fan-out, and the
 * bounded-concurrency wave the batch-fanout design adds alongside it.
 */
import { describe, expect, it } from 'vitest';

import type { ForeachNode, WorkflowCallNode } from '../dag/nodes.js';
import type { WorkflowDefinition } from '../dag/shape.js';
import { validateWorkflowDefinition } from '../dag/validate.js';
import type { WorkflowEngineDeps } from '../engine-deps.js';
import { driveUntilPark, type InterpreterDeps } from '../interpreter.js';
import { InMemoryWorkflowStore } from '../memory-store.js';
import type { NodeExecutorRegistry } from './index.js';
import type { RunParams, WorkflowRun } from '../store.js';
import { deriveChildRunId, executeWorkflowCall, type WorkflowCallResult } from './workflow-call.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeClock(start = 1_000): () => number {
  let t = start;
  return () => ++t;
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

/** Child: trigger → set(echo) → stop with a declared output template. */
function childDefinition(): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [
      { id: 'ct', type: 'trigger' },
      { id: 'echo', type: 'set', values: { seen: '{{trigger.data.name}}' } },
      { id: 'cs', type: 'stop', outcome: 'success', output: { greeting: '{{nodes.echo.output.seen}}' } },
    ],
    edges: [
      { from: 'ct', to: 'echo' },
      { from: 'echo', to: 'cs' },
    ],
  };
}

function parentDefinition(call: Partial<WorkflowCallNode> = {}): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'call', type: 'workflow', workflowId: 'wf-child', input: { name: '{{trigger.data.customer}}' }, ...call },
      { id: 's', type: 'stop', outcome: 'success' },
    ],
    edges: [
      { from: 't', to: 'call' },
      { from: 'call', to: 's' },
    ],
  };
}

function parentParams(): RunParams {
  return {
    workflowId: 'wf-parent',
    definitionVersionId: 'v1',
    input: { type: 'manual', timestamp: 1, data: { customer: 'acme' } },
  };
}

function resolvingEngine(definition: WorkflowDefinition = childDefinition()): WorkflowEngineDeps {
  return {
    ...unusedEngine(),
    resolveWorkflow: async (workflowId) =>
      workflowId === 'wf-child' ? { definition, definitionVersionId: 'child-v1' } : null,
  };
}

function deps(store: InMemoryWorkflowStore, engine: WorkflowEngineDeps): InterpreterDeps {
  return { store, engine, clock: makeClock() };
}

async function claimAttempt(store: InMemoryWorkflowStore, runId: string): Promise<number> {
  const claim = await store.claimRun(runId, 'test-owner', 30_000);
  if (!claim) throw new Error(`could not claim run ${runId}`);
  return claim.attempt;
}

/** Drives one run to its next park/settle under a fresh claim. */
async function drive(store: InMemoryWorkflowStore, engine: WorkflowEngineDeps, runId: string) {
  const attempt = await claimAttempt(store, runId);
  return driveUntilPark(runId, attempt, deps(store, engine));
}

// ─── Drive-level lifecycle ───────────────────────────────────────────────────

describe('workflow node (sub-workflow call)', () => {
  it('starts a child run with parent linkage and rendered input, and parks on it', async () => {
    const store = new InMemoryWorkflowStore();
    const engine = resolvingEngine();
    await store.createRun('wfrun_p1', parentParams(), parentDefinition(), 'v1', {
      ownerType: 'user',
      ownerId: 'u1',
    });

    const park = await drive(store, engine, 'wfrun_p1');
    expect(park.status).toBe('parked');
    expect(park.waitingOn).toHaveLength(1);
    const wait = park.waitingOn[0];
    if (wait.kind !== 'run') throw new Error(`expected a run wait, got ${wait.kind}`);

    const child = await store.getRun(wait.runId);
    expect(child).not.toBeNull();
    expect(child?.params.parentRunId).toBe('wfrun_p1');
    expect(child?.params.parentNodeId).toBe('call');
    expect(child?.params.workflowId).toBe('wf-child');
    expect(child?.owner).toEqual({ ownerType: 'user', ownerId: 'u1' });
    expect(child?.wakeRequested).toBe(true);
    const input = child?.params.input as { type: string; data: Record<string, unknown> };
    expect(input.type).toBe('workflow');
    expect(input.data).toEqual({ name: 'acme' });
  });

  it('resumes with the child stop output and wakes the parent on child settle', async () => {
    const store = new InMemoryWorkflowStore();
    const engine = resolvingEngine();
    await store.createRun('wfrun_p2', parentParams(), parentDefinition(), 'v1');

    const park = await drive(store, engine, 'wfrun_p2');
    const wait = park.waitingOn[0];
    if (wait.kind !== 'run') throw new Error('expected a run wait');

    // The child completes synchronously (trigger → set → stop).
    const childPark = await drive(store, engine, wait.runId);
    expect(childPark.status).toBe('settled');
    expect(childPark.outcome).toBe('completed');

    // Settling the child requested a wake on the parent.
    const parent = await store.getRun('wfrun_p2');
    expect(parent?.wakeRequested).toBe(true);

    const finalPark = await drive(store, engine, 'wfrun_p2');
    expect(finalPark.status).toBe('settled');
    expect(finalPark.outcome).toBe('completed');

    const checkpoints = await store.getCheckpoints('wfrun_p2');
    const callCp = checkpoints.find((cp) => cp.nodeId === 'call');
    expect(callCp?.status).toBe('completed');
    const result = callCp?.result as WorkflowCallResult;
    expect(result.runId).toBe(wait.runId);
    expect(result.output).toEqual({ greeting: 'acme' });
  });

  it('fails the call node when the child settles failed, naming the child errors', async () => {
    const failing: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'ct', type: 'trigger' },
        { id: 'cs', type: 'stop', outcome: 'failure', message: 'child exploded' },
      ],
      edges: [{ from: 'ct', to: 'cs' }],
    };
    const store = new InMemoryWorkflowStore();
    const engine = resolvingEngine(failing);
    await store.createRun('wfrun_p3', parentParams(), parentDefinition(), 'v1');

    const park = await drive(store, engine, 'wfrun_p3');
    const wait = park.waitingOn[0];
    if (wait.kind !== 'run') throw new Error('expected a run wait');
    await drive(store, engine, wait.runId);

    const finalPark = await drive(store, engine, 'wfrun_p3');
    expect(finalPark.status).toBe('settled');
    expect(finalPark.outcome).toBe('failed');
    const callCp = (await store.getCheckpoints('wfrun_p3')).find((cp) => cp.nodeId === 'call');
    expect(callCp?.status).toBe('failed');
    expect(callCp?.error).toContain(wait.runId);
    expect(callCp?.error).toContain('child exploded');
  });

  it('keeps the parent running when the call node carries onError "continue"', async () => {
    // The batch shape: one child run per item, a tail node that reports what
    // broke, and a parent that still settles `completed`.
    const failing: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'ct', type: 'trigger' },
        { id: 'cs', type: 'stop', outcome: 'failure', message: 'child exploded' },
      ],
      edges: [{ from: 'ct', to: 'cs' }],
    };
    const parent: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'call', type: 'workflow', workflowId: 'wf-child', onError: 'continue' },
        { id: 'notify', type: 'set', values: { text: 'child failed: {{nodes.call.error}}' } },
        { id: 's', type: 'stop', outcome: 'success' },
      ],
      edges: [
        { from: 't', to: 'call' },
        { from: 'call', to: 'notify' },
        { from: 'notify', to: 's' },
      ],
    };
    const store = new InMemoryWorkflowStore();
    const engine = resolvingEngine(failing);
    await store.createRun('wfrun_p3b', parentParams(), parent, 'v1');

    const park = await drive(store, engine, 'wfrun_p3b');
    const wait = park.waitingOn[0];
    if (wait.kind !== 'run') throw new Error('expected a run wait');
    await drive(store, engine, wait.runId);

    const finalPark = await drive(store, engine, 'wfrun_p3b');
    expect(finalPark.status).toBe('settled');
    expect(finalPark.outcome).toBe('completed'); // the tolerated child failure does not dominate

    const byNode = new Map((await store.getCheckpoints('wfrun_p3b')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('call')?.status).toBe('failed'); // the failure is still recorded
    expect(byNode.get('notify')?.status).toBe('completed');
    const notified = byNode.get('notify')?.result;
    if (!notified || typeof notified !== 'object' || !('text' in notified)) {
      throw new Error(`notify wrote no text: ${JSON.stringify(notified)}`);
    }
    expect(String(notified.text)).toContain('child failed: ');
    expect(String(notified.text)).toContain('child exploded'); // `nodes.call.error` reached the template
  });

  it('fails loudly when the reference does not resolve', async () => {
    const store = new InMemoryWorkflowStore();
    const engine = resolvingEngine();
    await store.createRun('wfrun_p4', parentParams(), parentDefinition({ workflowId: 'wf-nope' }), 'v1');

    const park = await drive(store, engine, 'wfrun_p4');
    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('failed');
    const callCp = (await store.getCheckpoints('wfrun_p4')).find((cp) => cp.nodeId === 'call');
    expect(callCp?.error).toContain('wf-nope');
  });

  it('rejects a child definition that contains its own workflow node (depth 1)', async () => {
    const store = new InMemoryWorkflowStore();
    const engine = resolvingEngine(parentDefinition());
    await store.createRun('wfrun_p5', parentParams(), parentDefinition(), 'v1');

    const park = await drive(store, engine, 'wfrun_p5');
    expect(park.outcome).toBe('failed');
    const callCp = (await store.getCheckpoints('wfrun_p5')).find((cp) => cp.nodeId === 'call');
    expect(callCp?.error).toContain('nesting depth is 1');
  });

  it('propagates a parent cancel to the parked child run', async () => {
    const store = new InMemoryWorkflowStore();
    const engine = resolvingEngine();
    await store.createRun('wfrun_p6', parentParams(), parentDefinition(), 'v1');

    const park = await drive(store, engine, 'wfrun_p6');
    const wait = park.waitingOn[0];
    if (wait.kind !== 'run') throw new Error('expected a run wait');

    await store.insertSignal({ runId: 'wfrun_p6', signalId: 'cancel', signalType: 'cancel', createdAt: 2_000 });
    const cancelled = await drive(store, engine, 'wfrun_p6');
    expect(cancelled.outcome).toBe('cancelled');

    const childSignals = await store.listSignals(wait.runId, { unconsumed: true });
    expect(childSignals.some((s) => s.signalType === 'cancel')).toBe(true);
    expect((await store.getRun(wait.runId))?.wakeRequested).toBe(true);
  });
});

// ─── Executor-level guards ───────────────────────────────────────────────────

describe('executeWorkflowCall guards', () => {
  function runRow(params: RunParams): WorkflowRun {
    return {
      runId: 'wfrun_guard',
      status: 'running',
      waitingOn: [],
      updatedAt: 0,
      params,
      definition: parentDefinition(),
      definitionVersionId: 'v1',
      attempt: 1,
      wakeRequested: false,
      createdAt: 0,
    };
  }

  it('a sub-workflow run may not start another (depth guard)', async () => {
    const store = new InMemoryWorkflowStore();
    const params: RunParams = { ...parentParams(), parentRunId: 'wfrun_outer' };
    await store.createRun('wfrun_guard', params, parentDefinition(), 'v1');
    const attempt = await claimAttempt(store, 'wfrun_guard');
    const node: WorkflowCallNode = { id: 'call', type: 'workflow', workflowId: 'wf-child' };

    const outcome = await executeWorkflowCall({
      run: runRow(params),
      node,
      attempt,
      iteration: 0,
      templateContext: { trigger: undefined, nodes: {} },
      store,
      clock: makeClock(),
      engine: resolvingEngine(),
    });
    if (outcome.status !== 'failed') throw new Error(`expected failed, got ${outcome.status}`);
    expect(outcome.error).toContain('nesting depth is 1');
  });

  it('fails loudly when the host wires no resolveWorkflow', async () => {
    const store = new InMemoryWorkflowStore();
    await store.createRun('wfrun_guard', parentParams(), parentDefinition(), 'v1');
    const attempt = await claimAttempt(store, 'wfrun_guard');
    const node: WorkflowCallNode = { id: 'call', type: 'workflow', workflowId: 'wf-child' };

    const outcome = await executeWorkflowCall({
      run: runRow(parentParams()),
      node,
      attempt,
      iteration: 0,
      templateContext: { trigger: undefined, nodes: {} },
      store,
      clock: makeClock(),
      engine: unusedEngine(),
    });
    if (outcome.status !== 'failed') throw new Error(`expected failed, got ${outcome.status}`);
    expect(outcome.error).toContain('resolveWorkflow');
  });

  it('re-entry after a crash before createRun converges on the same derived child id', async () => {
    const store = new InMemoryWorkflowStore();
    await store.createRun('wfrun_guard', parentParams(), parentDefinition(), 'v1');
    const attempt = await claimAttempt(store, 'wfrun_guard');
    const node: WorkflowCallNode = { id: 'call', type: 'workflow', workflowId: 'wf-child' };
    const derived = await deriveChildRunId('wfrun_guard', 'call', 0);

    const outcome = await executeWorkflowCall({
      run: runRow(parentParams()),
      node,
      attempt,
      iteration: 0,
      templateContext: { trigger: undefined, nodes: {} },
      store,
      clock: makeClock(),
      engine: resolvingEngine(),
      // Simulates the crash window: intent persisted the derived id, but the
      // child run row was never created.
      existingCheckpoint: {
        runId: 'wfrun_guard',
        nodeId: 'call',
        iteration: 0,
        status: 'intent',
        attempt,
        createdAt: 0,
        effects: { childRunId: derived },
      },
    });
    if (outcome.status !== 'parked') throw new Error(`expected parked, got ${outcome.status}`);
    expect(await store.getRun(derived)).not.toBeNull();
  });
});

// ─── foreach fan-out ─────────────────────────────────────────────────────────

describe('foreach with a workflow body', () => {
  it('starts one child run per item and aggregates their outputs', async () => {
    const body: WorkflowCallNode = { id: 'per', type: 'workflow', workflowId: 'wf-child', input: { name: '{{item}}' } };
    const loop: ForeachNode = {
      id: 'loop',
      type: 'foreach',
      items: '{{trigger.data.customers}}',
      body,
      concurrency: 5,
    };
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [{ id: 't', type: 'trigger' }, loop, { id: 's', type: 'stop', outcome: 'success' }],
      edges: [
        { from: 't', to: 'loop' },
        { from: 'loop', to: 's' },
      ],
    };
    const store = new InMemoryWorkflowStore();
    const engine = resolvingEngine();
    const params: RunParams = {
      workflowId: 'wf-batch',
      definitionVersionId: 'v1',
      input: { type: 'manual', timestamp: 1, data: { customers: ['acme', 'globex'] } },
    };
    await store.createRun('wfrun_batch', params, definition, 'v1');

    const park = await drive(store, engine, 'wfrun_batch');
    expect(park.status).toBe('parked');
    const runWaits = park.waitingOn.filter((w) => w.kind === 'run');
    expect(runWaits).toHaveLength(2);

    for (const wait of runWaits) {
      if (wait.kind !== 'run') continue;
      const settled = await drive(store, engine, wait.runId);
      expect(settled.outcome).toBe('completed');
    }

    const finalPark = await drive(store, engine, 'wfrun_batch');
    expect(finalPark.status).toBe('settled');
    expect(finalPark.outcome).toBe('completed');
    const loopCp = (await store.getCheckpoints('wfrun_batch')).find((cp) => cp.nodeId === 'loop');
    const aggregate = loopCp?.result as { items: Array<{ status: string; data: WorkflowCallResult }> };
    expect(aggregate.items.map((i) => i.status)).toEqual(['completed', 'completed']);
    expect(aggregate.items.map((i) => (i.data.output as { greeting: string }).greeting)).toEqual(['acme', 'globex']);
  });
});

// ─── Parallel waves ──────────────────────────────────────────────────────────

describe('parallel wave execution', () => {
  it('runs independent same-wave nodes concurrently (bounded)', async () => {
    // Two root `set` nodes with a custom executor that records overlap: the
    // sequential loop this replaces would never have two in flight at once.
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'a', type: 'set', values: { v: 'a' } },
        { id: 'b', type: 'set', values: { v: 'b' } },
      ],
      edges: [],
    };
    let active = 0;
    let maxActive = 0;
    const overlapExecutors: NodeExecutorRegistry = {
      set: {
        execute: async ({ run, node, attempt, iteration, store, clock }) => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 25));
          active--;
          await store.putIntent({ runId: run.runId, nodeId: node.id, iteration, status: 'intent', attempt, createdAt: clock() });
          const cp = {
            runId: run.runId,
            nodeId: node.id,
            iteration,
            status: 'completed' as const,
            result: {},
            attempt,
            createdAt: clock(),
          };
          await store.completeCheckpoint(run.runId, node.id, iteration, attempt, cp);
          return { status: 'completed' as const, result: {} };
        },
      },
    };

    const store = new InMemoryWorkflowStore();
    await store.createRun('wfrun_wave', { workflowId: 'wf-w', definitionVersionId: 'v1' }, definition, 'v1');
    const attempt = await claimAttempt(store, 'wfrun_wave');
    const park = await driveUntilPark('wfrun_wave', attempt, {
      store,
      engine: unusedEngine(),
      clock: makeClock(),
      executors: overlapExecutors,
    });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');
    expect(maxActive).toBe(2);
  });
});

// ─── Validator coverage ──────────────────────────────────────────────────────

describe('workflow node validation', () => {
  it('accepts a workflow node at top level and as a foreach body', () => {
    const body: WorkflowCallNode = { id: 'per', type: 'workflow', workflowId: 'wf-child' };
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'call', type: 'workflow', workflowId: 'wf-child' },
        { id: 'loop', type: 'foreach', items: '{{trigger.data.items}}', body },
      ],
      edges: [
        { from: 't', to: 'call' },
        { from: 'call', to: 'loop' },
      ],
    };
    expect(validateWorkflowDefinition(definition)).toEqual({ ok: true });
  });

  it('rejects a workflow node without a workflowId', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'call', type: 'workflow', workflowId: '' },
      ],
      edges: [{ from: 't', to: 'call' }],
    };
    const result = validateWorkflowDefinition(definition);
    if (result.ok) throw new Error('expected validation errors');
    expect(result.errors.some((e) => e.includes('workflowId'))).toBe(true);
  });
});
