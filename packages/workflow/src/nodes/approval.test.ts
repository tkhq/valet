import { describe, expect, it, vi } from 'vitest';

import type { ApprovalNode } from '../dag/nodes.js';
import type { WorkflowDefinition } from '../dag/shape.js';
import type { WorkflowEngineDeps } from '../engine-deps.js';
import { driveUntilPark, type InterpreterDeps } from '../interpreter.js';
import { InMemoryWorkflowStore } from '../memory-store.js';
import type { NodeExecutorRegistry, OnApprovalPending } from './index.js';
import { createDefaultNodeExecutors } from './index.js';
import type { RunParams } from '../store.js';
import { executeApproval } from './approval.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function makeFakeEngineDeps(): WorkflowEngineDeps {
  return {
    createSession: async (opts) => ({ id: opts.id }),
    prompt: async () => ({ threadId: 'thread', queueItemId: 'queue' }),
    awaitResult: async () => ({ queueItemId: 'queue', outcome: 'completed' as const }),
    abort: async () => {},
    isSettled: async () => true,
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

function approvalDefinition(node: Partial<ApprovalNode> = {}): WorkflowDefinition {
  const approval: ApprovalNode = {
    id: 'ap',
    type: 'approval',
    prompt: 'approve {{trigger.data.thing}}?',
    ...node,
  };
  return {
    version: 'dag/v1',
    nodes: [
      { id: 't', type: 'trigger' },
      approval,
      { id: 'approved', type: 'set', values: { branch: 'approved' } },
      { id: 'denied', type: 'set', values: { branch: 'denied' } },
    ],
    edges: [
      { from: 't', to: 'ap' },
      { from: 'ap', to: 'approved', fromOutput: 'true' },
      { from: 'ap', to: 'denied', fromOutput: 'false' },
    ],
  };
}

// ─── 1. Parks + onApprovalPending fired exactly once ────────────────────────

describe('executeApproval: parks and notifies exactly once', () => {
  it('parks on a signal wait and calls onApprovalPending exactly once across spurious re-drives', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock(1_000);
    const engine = makeFakeEngineDeps();
    const onApprovalPending: OnApprovalPending = vi.fn();
    await store.createRun('run-1', runParams({ input: { type: 'manual', timestamp: 't', data: { thing: 'x' }, metadata: {} } }), approvalDefinition(), 'v1');

    const attempt1 = await claimAttempt(store, 'run-1');
    const park1 = await driveUntilPark('run-1', attempt1, { store, engine, clock: clock.now, onApprovalPending });
    expect(park1.status).toBe('parked');
    expect(park1.waitingOn).toEqual([{ kind: 'signal', nodeId: 'ap', signalType: 'approval:ap', timeoutAt: undefined }]);
    expect(onApprovalPending).toHaveBeenCalledTimes(1);
    expect(onApprovalPending).toHaveBeenCalledWith({
      runId: 'run-1',
      nodeId: 'ap',
      prompt: 'approve x?',
      summary: undefined,
      details: undefined,
    });

    // Spurious re-drive: nothing resolved, must not re-notify.
    const attempt2 = await claimAttempt(store, 'run-1', 'owner-2');
    const park2 = await driveUntilPark('run-1', attempt2, { store, engine, clock: clock.now, onApprovalPending });
    expect(park2.status).toBe('parked');
    expect(onApprovalPending).toHaveBeenCalledTimes(1);
  });
});

// ─── 2. Approve resolves via atomic consume+checkpoint ───────────────────────

describe('executeApproval: approve', () => {
  it('consumes the signal atomically with the terminal checkpoint and the run proceeds', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock(1_000);
    const engine = makeFakeEngineDeps();
    await store.createRun('run-2', runParams(), approvalDefinition(), 'v1');
    const attempt1 = await claimAttempt(store, 'run-2');
    const park1 = await driveUntilPark('run-2', attempt1, { store, engine, clock: clock.now });
    expect(park1.status).toBe('parked');

    await store.insertSignal({
      runId: 'run-2',
      signalId: 'approval:ap:resolution',
      signalType: 'approval:ap',
      payload: { approved: true, resolvedBy: 'alice' },
      createdAt: clock.now(),
    });

    const attempt2 = await claimAttempt(store, 'run-2', 'owner-2');
    const park2 = await driveUntilPark('run-2', attempt2, { store, engine, clock: clock.now });

    expect(park2.status).toBe('settled');
    const byNode = new Map((await store.getCheckpoints('run-2')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('ap')?.status).toBe('completed');
    expect(byNode.get('ap')?.result).toEqual({ approved: true, resolvedBy: 'alice' });
    expect(byNode.get('approved')?.status).toBe('completed');
    expect(byNode.get('denied')?.status).toBe('skipped');

    const signals = await store.listSignals('run-2');
    expect(signals[0]?.consumedAt).toBeDefined();
    expect(signals[0]?.consumedBy).toMatchObject({ nodeId: 'ap' });
  });
});

// ─── 3. Deny onDeny: 'fail' → run failed ─────────────────────────────────────

describe('executeApproval: deny with onDeny "fail" (default)', () => {
  it('fails the node and the run settles failed', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock(1_000);
    const engine = makeFakeEngineDeps();
    await store.createRun('run-3', runParams(), approvalDefinition(), 'v1');
    const attempt1 = await claimAttempt(store, 'run-3');
    await driveUntilPark('run-3', attempt1, { store, engine, clock: clock.now });

    await store.insertSignal({
      runId: 'run-3',
      signalId: 'approval:ap:resolution',
      signalType: 'approval:ap',
      payload: { approved: false, resolvedBy: 'bob' },
      createdAt: clock.now(),
    });

    const attempt2 = await claimAttempt(store, 'run-3', 'owner-2');
    const park2 = await driveUntilPark('run-3', attempt2, { store, engine, clock: clock.now });

    expect(park2.status).toBe('settled');
    expect(park2.outcome).toBe('failed');
    const byNode = new Map((await store.getCheckpoints('run-3')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('ap')?.status).toBe('failed');
    expect(byNode.get('ap')?.error).toMatch(/denied by bob/);
  });
});

// ─── 4. Deny onDeny: 'skip' → false-branch edges activate ───────────────────

describe('executeApproval: deny with onDeny "skip"', () => {
  it('completes the node with { approved: false } so fromOutput:"false" edges activate', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock(1_000);
    const engine = makeFakeEngineDeps();
    await store.createRun('run-4', runParams(), approvalDefinition({ onDeny: 'skip' }), 'v1');
    const attempt1 = await claimAttempt(store, 'run-4');
    await driveUntilPark('run-4', attempt1, { store, engine, clock: clock.now });

    await store.insertSignal({
      runId: 'run-4',
      signalId: 'approval:ap:resolution',
      signalType: 'approval:ap',
      payload: { approved: false, resolvedBy: 'carol' },
      createdAt: clock.now(),
    });

    const attempt2 = await claimAttempt(store, 'run-4', 'owner-2');
    const park2 = await driveUntilPark('run-4', attempt2, { store, engine, clock: clock.now });

    expect(park2.status).toBe('settled');
    expect(park2.outcome).toBe('completed'); // node completed (skip path), run isn't failed
    const byNode = new Map((await store.getCheckpoints('run-4')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('ap')?.status).toBe('completed');
    expect(byNode.get('ap')?.result).toEqual({ approved: false, resolvedBy: 'carol' });
    // deny-path edge (fromOutput: 'false') activates; true-branch node skips.
    expect(byNode.get('denied')?.status).toBe('completed');
    expect(byNode.get('approved')?.status).toBe('skipped');
  });
});

// ─── 5. Timeout expiry behaves as deny ───────────────────────────────────────

describe('executeApproval: timeout expiry', () => {
  it('behaves as a deny (resolvedBy "timeout") when no signal arrives before timeoutAt', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock(1_000);
    const engine = makeFakeEngineDeps();
    await store.createRun('run-5', runParams(), approvalDefinition({ timeout: '5s' }), 'v1');
    const attempt1 = await claimAttempt(store, 'run-5');
    const park1 = await driveUntilPark('run-5', attempt1, { store, engine, clock: clock.now });
    expect(park1.status).toBe('parked');
    expect(park1.waitingOn).toEqual([{ kind: 'signal', nodeId: 'ap', signalType: 'approval:ap', timeoutAt: 1_000 + 5_000 }]);

    clock.advance(5_000);
    const attempt2 = await claimAttempt(store, 'run-5', 'owner-2');
    const park2 = await driveUntilPark('run-5', attempt2, { store, engine, clock: clock.now });

    expect(park2.status).toBe('settled');
    expect(park2.outcome).toBe('failed'); // default onDeny 'fail'
    const byNode = new Map((await store.getCheckpoints('run-5')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('ap')?.status).toBe('failed');
    expect(byNode.get('ap')?.error).toMatch(/timed out/);
  });

  it('re-parks (does not time out) before timeoutAt is reached, honoring effects.timeoutAt read-back', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock(1_000);
    const engine = makeFakeEngineDeps();
    await store.createRun('run-6', runParams(), approvalDefinition({ timeout: '10s' }), 'v1');
    const attempt1 = await claimAttempt(store, 'run-6');
    const park1 = await driveUntilPark('run-6', attempt1, { store, engine, clock: clock.now });
    expect(park1.status).toBe('parked');
    const originalTimeoutAt = 1_000 + 10_000;

    clock.advance(1); // not yet due, and a different delta than the duration would suggest
    const attempt2 = await claimAttempt(store, 'run-6', 'owner-2');
    const park2 = await driveUntilPark('run-6', attempt2, { store, engine, clock: clock.now });
    expect(park2.status).toBe('parked');
    expect(park2.waitingOn).toEqual([{ kind: 'signal', nodeId: 'ap', signalType: 'approval:ap', timeoutAt: originalTimeoutAt }]);
  });
});

// ─── 6. Signal arriving before the park is absorbed on the same drive ───────

describe('executeApproval: signal inserted before the node first runs', () => {
  it('is absorbed on the same drive as the first entry, without ever parking', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock(1_000);
    const engine = makeFakeEngineDeps();
    const onApprovalPending: OnApprovalPending = vi.fn();
    await store.createRun('run-7', runParams(), approvalDefinition(), 'v1');

    // Insert the signal before the run has been driven at all — mirrors the
    // interpreter's "signal-before-wait" store contract (task 3 conformance)
    // extended to this node.
    await store.insertSignal({
      runId: 'run-7',
      signalId: 'approval:ap:resolution',
      signalType: 'approval:ap',
      payload: { approved: true, resolvedBy: 'dave' },
      createdAt: clock.now(),
    });

    const attempt = await claimAttempt(store, 'run-7');
    const park = await driveUntilPark('run-7', attempt, { store, engine, clock: clock.now, onApprovalPending });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');
    expect(onApprovalPending).toHaveBeenCalledTimes(1); // still fired once, on first entry
    const byNode = new Map((await store.getCheckpoints('run-7')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('ap')?.status).toBe('completed');
    expect(byNode.get('ap')?.result).toEqual({ approved: true, resolvedBy: 'dave' });
  });
});

// ─── 7. iteration > 0 ─────────────────────────────────────────────────────────
//
// `driveUntilPark` always drives at iteration 0 (no `foreach` executor
// exists yet — Task 6). This exercises the executor's checkpoint-keying
// contract directly, and confirms the signal type stays iteration-less
// (approvals can't be foreach bodies — the validator enforces this).

describe('executeApproval: iteration > 0', () => {
  it('checkpoints the intent at the given iteration; signalType is unaffected', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock(1_000);
    const engine = makeFakeEngineDeps();
    const definition = approvalDefinition();
    await store.createRun('run-8', runParams(), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-8');
    const run = await store.getRun('run-8');
    if (!run) throw new Error('run vanished');
    const node = definition.nodes.find((n): n is ApprovalNode => n.id === 'ap')!;

    const result = await executeApproval({
      run,
      node,
      attempt,
      iteration: 1,
      templateContext: { trigger: undefined, nodes: {} },
      store,
      clock: clock.now,
      engine,
    });

    expect(result.status).toBe('parked');
    if (result.status === 'parked') {
      expect(result.waitingOn).toEqual([{ kind: 'signal', nodeId: 'ap', signalType: 'approval:ap', timeoutAt: undefined }]);
    }

    const checkpoints = await store.getCheckpoints('run-8');
    const cp = checkpoints.find((c) => c.nodeId === 'ap' && c.iteration === 1);
    expect(cp).toBeDefined();
    expect(cp?.status).toBe('intent');
    expect(checkpoints.some((c) => c.nodeId === 'ap' && c.iteration === 0)).toBe(false);
  });
});

// ─── Sanity: registry wiring ─────────────────────────────────────────────────

describe('createDefaultNodeExecutors', () => {
  it('registers approval and wait executors', () => {
    const registry: NodeExecutorRegistry = createDefaultNodeExecutors();
    expect(registry.approval).toBeDefined();
    expect(registry.wait).toBeDefined();
  });
});

// ─── grant-the-rest-of-this-run (action-policies T3) ─────────────────────────

describe('executeApproval: onApprovalGrant', () => {
  it('calls onApprovalGrant with the authorized actions when approved with grantActions', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock(1_000);
    const engine = makeFakeEngineDeps();
    const onApprovalGrant = vi.fn();
    await store.createRun('run-g1', runParams(), approvalDefinition(), 'v1');
    const a1 = await claimAttempt(store, 'run-g1');
    await driveUntilPark('run-g1', a1, { store, engine, clock: clock.now, onApprovalGrant });

    await store.insertSignal({
      runId: 'run-g1',
      signalId: 'approval:ap:resolution',
      signalType: 'approval:ap',
      payload: {
        approved: true,
        resolvedBy: 'alice',
        grantActions: [{ service: 'github', actionId: 'create_issue' }],
      },
      createdAt: clock.now(),
    });

    const a2 = await claimAttempt(store, 'run-g1', 'owner-2');
    const park = await driveUntilPark('run-g1', a2, { store, engine, clock: clock.now, onApprovalGrant });
    expect(park.status).toBe('settled');
    expect(onApprovalGrant).toHaveBeenCalledTimes(1);
    expect(onApprovalGrant).toHaveBeenCalledWith({
      runId: 'run-g1',
      resolvedBy: 'alice',
      grants: [{ service: 'github', actionId: 'create_issue' }],
    });
  });

  it('does NOT call onApprovalGrant on a denial, even if grantActions are present', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock(1_000);
    const engine = makeFakeEngineDeps();
    const onApprovalGrant = vi.fn();
    await store.createRun('run-g2', runParams(), approvalDefinition({ onDeny: 'skip' }), 'v1');
    const a1 = await claimAttempt(store, 'run-g2');
    await driveUntilPark('run-g2', a1, { store, engine, clock: clock.now, onApprovalGrant });

    await store.insertSignal({
      runId: 'run-g2',
      signalId: 'approval:ap:resolution',
      signalType: 'approval:ap',
      payload: {
        approved: false,
        resolvedBy: 'bob',
        grantActions: [{ service: 'github', actionId: 'create_issue' }],
      },
      createdAt: clock.now(),
    });

    const a2 = await claimAttempt(store, 'run-g2', 'owner-2');
    await driveUntilPark('run-g2', a2, { store, engine, clock: clock.now, onApprovalGrant });
    expect(onApprovalGrant).not.toHaveBeenCalled();
  });
});
