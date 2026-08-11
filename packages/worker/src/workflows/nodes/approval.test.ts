import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApprovalNode, WorkflowDagState } from '@valet/shared';
import type { WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../../env.js';
import type { WorkflowRunParams } from '../types.js';

const isActionDisabledMock = vi.fn();
const invokeWorkflowActionMock = vi.fn();
const markExecutedMock = vi.fn();
const markFailedMock = vi.fn();
const waitForApprovalEventMock = vi.fn();
const setExecutionStatusMock = vi.fn();

vi.mock('../../lib/db/disabled-actions.js', () => ({
  isActionDisabled: (...a: unknown[]) => isActionDisabledMock(...a),
}));
vi.mock('../../lib/drizzle.js', () => ({ getDb: () => ({}) }));
vi.mock('../../services/actions.js', () => ({
  invokeWorkflowAction: (...a: unknown[]) => invokeWorkflowActionMock(...a),
  markExecuted: (...a: unknown[]) => markExecutedMock(...a),
  markFailed: (...a: unknown[]) => markFailedMock(...a),
}));
vi.mock('../approvals.js', () => ({
  waitForApprovalEvent: (...a: unknown[]) => waitForApprovalEventMock(...a),
}));
vi.mock('../execution-status.js', () => ({
  setExecutionStatus: (...a: unknown[]) => setExecutionStatusMock(...a),
}));

const { executeApproval } = await import('./approval.js');

function makeStep(): WorkflowStep {
  return {
    async do<T>(_name: string, configOrFn: unknown, maybeFn?: () => Promise<T>): Promise<T> {
      const fn = typeof configOrFn === 'function' ? (configOrFn as () => Promise<T>) : maybeFn;
      if (!fn) throw new Error('missing step callback');
      return fn();
    },
  } as unknown as WorkflowStep;
}

function args(node: ApprovalNode, aliases?: Record<string, unknown>) {
  const state: WorkflowDagState = {
    trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: {}, metadata: {} },
    nodes: {},
    skipped: {},
  };
  return {
    node,
    state,
    params: { executionId: 'exec-1', workflowId: 'wf-1', userId: 'user-1' } as WorkflowRunParams,
    env: { DB: {} } as Env,
    step: makeStep(),
    ...(aliases ? { aliases } : {}),
  };
}

/** Every stepKey the node handed to setExecutionStatus, in call order. */
function stepKeys(): string[] {
  return setExecutionStatusMock.mock.calls.map((c) => (c[0] as { stepKey: string }).stepKey);
}

beforeEach(() => {
  isActionDisabledMock.mockReset().mockResolvedValue(false);
  invokeWorkflowActionMock.mockReset().mockResolvedValue({
    outcome: 'pending_approval', invocationId: 'inv-1', mode: 'require_approval', policyId: null,
  });
  markExecutedMock.mockReset();
  markFailedMock.mockReset();
  waitForApprovalEventMock.mockReset().mockResolvedValue({ result: 'approved', approvedBy: 'u', respondedAt: 'now' });
  setExecutionStatusMock.mockReset().mockResolvedValue(true);
});

describe('executeApproval — execution status step keys', () => {
  const node: ApprovalNode = { id: 'approve', type: 'approval', prompt: 'ok?' };

  // step.do memoises by name. Without the iteration suffix, every iteration
  // of a foreach reuses iteration 0's cached status transitions, so the
  // execution row stops tracking waiting_approval after the first item —
  // and an iteration that never records its exit leaves the row parked.
  it('scopes the status step keys to the foreach iteration', async () => {
    await executeApproval(args(node, { item: { x: 1 }, index: 0, __iterationIndex: 0 }));
    const first = stepKeys();
    setExecutionStatusMock.mockClear();

    await executeApproval(args(node, { item: { x: 2 }, index: 1, __iterationIndex: 1 }));
    const second = stepKeys();

    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBe(first.length);
    for (const key of second) expect(first).not.toContain(key);
  });

  it('matches the iteration suffix already used for the invocation id', async () => {
    await executeApproval(args(node, { item: { x: 1 }, index: 3, __iterationIndex: 3 }));
    const invocationId = (invokeWorkflowActionMock.mock.calls[0]?.[1] as { invocationId: string }).invocationId;
    expect(invocationId).toContain(':i:3');
    for (const key of stepKeys()) expect(key).toContain(':i:3');
  });

  it('leaves the step keys unsuffixed outside a foreach', async () => {
    await executeApproval(args(node));
    for (const key of stepKeys()) expect(key).not.toContain(':i:');
  });

  it('still records enter and exit transitions', async () => {
    await executeApproval(args(node));
    const keys = stepKeys();
    expect(keys.some((k) => k.includes('enter:waiting_approval'))).toBe(true);
    expect(keys.some((k) => k.includes('exit:running'))).toBe(true);
  });
});
