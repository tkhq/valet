/**
 * Unresolved template paths, end to end through a drive.
 *
 * The bug class this covers: `{{trigger.email}}` renders as empty, the
 * node completes, and the run reports success with a hole in its output.
 * The default policy keeps that rendering — existing definitions depend on
 * it — but no longer keeps it silent. `policy.onUnresolvedPath: "fail"`
 * turns the same finding into a node failure, taken BEFORE the node runs
 * so nothing is sent half-written.
 */
import { describe, expect, it, vi } from 'vitest';

import type { WorkflowDefinition } from './dag/shape.js';
import type { WorkflowEngineDeps } from './engine-deps.js';
import { driveUntilPark, type InterpreterDeps, type TemplateDiagnosticsReport } from './interpreter.js';
import { InMemoryWorkflowStore } from './memory-store.js';
import type { RunParams } from './store.js';

function makeEngine(): WorkflowEngineDeps {
  return {
    createSession: vi.fn(async (opts) => ({ id: opts.id })),
    prompt: vi.fn(async () => ({ threadId: 'thread', queueItemId: 'queue' })),
    awaitResult: vi.fn(async () => ({ queueItemId: 'queue', outcome: 'completed' as const })),
    abort: vi.fn(async () => {}),
    isSettled: vi.fn(async () => true),
    llmComplete: vi.fn(async () => {
      throw new Error('llmComplete not exercised by this fixture');
    }),
    promptOrchestrator: vi.fn(async () => {
      throw new Error('promptOrchestrator not exercised by this fixture');
    }),
    invokeAction: vi.fn(async () => ({ ok: true as const, result: { id: 1 } })),
  };
}

function runParams(data: Record<string, unknown>): RunParams {
  return {
    workflowId: 'wf-1',
    definitionVersionId: 'v1',
    input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data, metadata: {} },
  };
}

/** A `set` node reading one path, with the strictness policy under test. */
function definitionReading(path: string, onUnresolvedPath?: 'empty' | 'fail'): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'shape', type: 'set', values: { who: `{{${path}}}` } },
    ],
    edges: [{ from: 't', to: 'shape' }],
    ...(onUnresolvedPath !== undefined ? { policy: { onUnresolvedPath } } : {}),
  };
}

function collector(): { reports: TemplateDiagnosticsReport[]; onTemplateDiagnostics: NonNullable<InterpreterDeps['onTemplateDiagnostics']> } {
  const reports: TemplateDiagnosticsReport[] = [];
  return { reports, onTemplateDiagnostics: (report) => void reports.push(report) };
}

async function claim(store: InMemoryWorkflowStore, runId: string): Promise<number> {
  const claimed = await store.claimRun(runId, 'owner', 30_000);
  if (!claimed) throw new Error(`could not claim run ${runId}`);
  return claimed.attempt;
}

describe('driveUntilPark: template diagnostics', () => {
  it('reports an unresolved path and still completes the run', async () => {
    const store = new InMemoryWorkflowStore();
    const sink = collector();
    await store.createRun('run-d1', runParams({ email: 'a@b.com' }), definitionReading('trigger.email'), 'v1');

    const park = await driveUntilPark('run-d1', await claim(store, 'run-d1'), {
      store,
      engine: makeEngine(),
      clock: () => 1_000,
      onTemplateDiagnostics: sink.onTemplateDiagnostics,
    });

    expect(park.outcome).toBe('completed');
    expect(sink.reports).toHaveLength(1);
    const report = sink.reports[0]!;
    expect(report.runId).toBe('run-d1');
    expect(report.workflowId).toBe('wf-1');
    expect(report.enforced).toBe(false);
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0]).toMatchObject({
      nodeId: 'shape',
      field: 'values.who',
      path: 'trigger.email',
      failedSegment: 'email',
      suggestion: 'trigger.data.email',
      origin: 'field',
    });

    // The rendering itself is unchanged: the path is still empty, which is
    // exactly why the diagnostic has to exist.
    const checkpoints = await store.getCheckpoints('run-d1');
    const shape = checkpoints.find((cp) => cp.nodeId === 'shape');
    expect(shape?.status).toBe('completed');
    expect(shape?.result).toEqual({ who: null });
  });

  it('reports nothing when every path resolves', async () => {
    const store = new InMemoryWorkflowStore();
    const sink = collector();
    await store.createRun('run-d2', runParams({ email: 'a@b.com' }), definitionReading('trigger.data.email'), 'v1');

    await driveUntilPark('run-d2', await claim(store, 'run-d2'), {
      store,
      engine: makeEngine(),
      clock: () => 1_000,
      onTemplateDiagnostics: sink.onTemplateDiagnostics,
    });

    expect(sink.reports).toEqual([]);
  });

  it('fails the node before it runs when the policy says fail', async () => {
    const store = new InMemoryWorkflowStore();
    const engine = makeEngine();
    const sink = collector();
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        {
          id: 'file',
          type: 'tool',
          service: 'github',
          action: 'create_issue',
          params: { title: '{{trigger.email}}' },
        },
      ],
      edges: [{ from: 't', to: 'file' }],
      policy: { onUnresolvedPath: 'fail' },
    };
    await store.createRun('run-d3', runParams({ email: 'a@b.com' }), definition, 'v1');

    const park = await driveUntilPark('run-d3', await claim(store, 'run-d3'), {
      store,
      engine,
      clock: () => 1_000,
      onTemplateDiagnostics: sink.onTemplateDiagnostics,
    });

    expect(park.outcome).toBe('failed');
    // The point of failing before the wave: nothing was sent.
    expect(engine.invokeAction).not.toHaveBeenCalled();

    const failed = (await store.getCheckpoints('run-d3')).find((cp) => cp.nodeId === 'file');
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('policy.onUnresolvedPath');
    expect(failed?.error).toContain('trigger.email');
    expect(failed?.error).toContain('trigger.data.email');
    expect(sink.reports[0]?.enforced).toBe(true);
  });

  it('never fails an if condition, which may legitimately ask about absent data', async () => {
    const store = new InMemoryWorkflowStore();
    const sink = collector();
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        {
          id: 'gate',
          type: 'if',
          conditions: [{ left: 'trigger.data.optional', dataType: 'string', operation: 'isNotEmpty' }],
        },
        { id: 'end', type: 'stop', outcome: 'success' },
      ],
      edges: [
        { from: 't', to: 'gate' },
        { from: 'gate', to: 'end', fromOutput: 'false' },
      ],
      policy: { onUnresolvedPath: 'fail' },
    };
    await store.createRun('run-d4', runParams({}), definition, 'v1');

    const park = await driveUntilPark('run-d4', await claim(store, 'run-d4'), {
      store,
      engine: makeEngine(),
      clock: () => 1_000,
      onTemplateDiagnostics: sink.onTemplateDiagnostics,
    });

    expect(park.outcome).toBe('completed');
    const gate = (await store.getCheckpoints('run-d4')).find((cp) => cp.nodeId === 'gate');
    expect(gate?.status).toBe('completed');
    // Still reported — a condition on a path that never resolves is worth
    // seeing, even though it cannot fail the run.
    expect(sink.reports[0]?.diagnostics[0]).toMatchObject({
      nodeId: 'gate',
      field: 'conditions[0].left',
      enforceable: false,
    });
  });

  it('reports a foreach body path that only exists per iteration', async () => {
    const store = new InMemoryWorkflowStore();
    const sink = collector();
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        {
          id: 'loop',
          type: 'foreach',
          items: '{{trigger.data.rows}}',
          body: { id: 'row', type: 'set', values: { label: '{{item.nmae}}' } },
        },
      ],
      edges: [{ from: 't', to: 'loop' }],
    };
    await store.createRun('run-d5', runParams({ rows: [{ name: 'a' }, { name: 'b' }] }), definition, 'v1');

    await driveUntilPark('run-d5', await claim(store, 'run-d5'), {
      store,
      engine: makeEngine(),
      clock: () => 1_000,
      onTemplateDiagnostics: sink.onTemplateDiagnostics,
    });

    // Two items render the same bad path; one finding names it.
    const diagnostics = sink.reports.flatMap((r) => r.diagnostics);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      nodeId: 'loop',
      path: 'item.nmae',
      suggestion: 'item.name',
      origin: 'runtime',
    });
  });
});
