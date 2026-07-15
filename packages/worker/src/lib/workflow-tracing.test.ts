import { describe, it, expect, beforeEach } from 'vitest';
import { InMemorySpanExporter, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode } from '@opentelemetry/api';
import type { WorkflowDefinition } from '@valet/shared';
import { emitWorkflowRunSpans } from './workflow-tracing.js';
import type { TracingEnv } from './tracing.js';
import type { WorkflowRunParams, WorkflowRunResult } from '../workflows/types.js';

const DISABLED_ENV: TracingEnv = {};

const DEF: WorkflowDefinition = {
  version: 'dag/v1',
  nodes: [
    { id: 'trigger', type: 'trigger' },
    { id: 'start', type: 'set', values: { ran: true } },
    { id: 'done', type: 'stop' },
    { id: 'orphan', type: 'set', values: {} },
  ],
  edges: [
    { from: 'trigger', to: 'start' },
    { from: 'start', to: 'done' },
  ],
};

function makeParams(overrides: Partial<WorkflowRunParams> = {}): WorkflowRunParams {
  return {
    executionId: 'exec-1',
    workflowId: 'wf-1',
    userId: 'user-1',
    trigger: {
      type: 'manual',
      timestamp: '2026-07-15T00:00:00.000Z',
      data: {},
      metadata: {},
    },
    definition: DEF,
    mode: 'test',
    ...overrides,
  };
}

function makeResult(overrides: Partial<WorkflowRunResult> = {}): WorkflowRunResult {
  return {
    status: 'completed',
    state: {
      trigger: { type: 'manual', timestamp: '2026-07-15T00:00:00.000Z', data: {}, metadata: {} },
      nodes: {
        trigger: { status: 'completed', startedAt: '2026-07-15T00:00:01.000Z', completedAt: '2026-07-15T00:00:01.500Z' },
        start: { status: 'completed', startedAt: '2026-07-15T00:00:02.000Z', completedAt: '2026-07-15T00:00:03.000Z', data: { ran: true } },
      },
      skipped: { orphan: { reason: 'no inbound edge satisfied' } },
    },
    ...overrides,
  };
}

function hrToMs(hr: [number, number]): number {
  return hr[0] * 1000 + hr[1] / 1e6;
}

describe('emitWorkflowRunSpans', () => {
  let memory: InMemorySpanExporter;
  let exporter: SpanExporter;

  beforeEach(() => {
    memory = new InMemorySpanExporter();
    // The emitter shuts its provider down after flushing, and
    // InMemorySpanExporter.shutdown() clears the captured spans — keep them
    // readable by absorbing the shutdown.
    exporter = {
      export: (spans, cb) => memory.export(spans, cb),
      shutdown: () => Promise.resolve(),
      forceFlush: () => Promise.resolve(),
    };
  });

  it('is a no-op returning 0 when tracing is disabled and no exporter is injected', async () => {
    const count = await emitWorkflowRunSpans(DISABLED_ENV, makeParams(), makeResult());
    expect(count).toBe(0);
  });

  it('emits a root workflow.run span with one child per executed and skipped node', async () => {
    const count = await emitWorkflowRunSpans(DISABLED_ENV, makeParams(), makeResult(), { exporter });
    expect(count).toBe(4); // root + trigger + start + skipped orphan

    const spans = memory.getFinishedSpans();
    expect(spans).toHaveLength(4);

    const root = spans.find((s) => s.name === 'workflow.run');
    expect(root).toBeDefined();
    expect(root?.attributes).toMatchObject({
      'valet.execution.id': 'exec-1',
      'valet.workflow.id': 'wf-1',
      'valet.user.id': 'user-1',
      'valet.workflow.mode': 'test',
      'valet.workflow.trigger_type': 'manual',
      'valet.workflow.status': 'completed',
      'valet.workflow.node_count': 2,
      'valet.workflow.skipped_count': 1,
      'valet.workflow.failed_count': 0,
    });

    const children = spans.filter((s) => s.name !== 'workflow.run');
    for (const child of children) {
      expect(child.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
      expect(child.spanContext().traceId).toBe(root?.spanContext().traceId);
    }
    expect(children.map((s) => s.name).sort()).toEqual([
      'workflow.node.set', 'workflow.node.set', 'workflow.node.trigger',
    ]);

    const skippedSpan = children.find((s) => s.attributes['valet.node.id'] === 'orphan');
    expect(skippedSpan?.attributes['valet.node.status']).toBe('skipped');
    expect(skippedSpan?.attributes['valet.node.skip_reason']).toBeUndefined();
  });

  it('reconstructs span timestamps from the replay-stable node timestamps', async () => {
    await emitWorkflowRunSpans(DISABLED_ENV, makeParams(), makeResult(), { exporter });
    const spans = memory.getFinishedSpans();

    const root = spans.find((s) => s.name === 'workflow.run');
    expect(hrToMs(root!.startTime)).toBe(Date.parse('2026-07-15T00:00:01.000Z'));
    expect(hrToMs(root!.endTime)).toBe(Date.parse('2026-07-15T00:00:03.000Z'));

    const startNode = spans.find((s) => s.attributes['valet.node.id'] === 'start');
    expect(hrToMs(startNode!.startTime)).toBe(Date.parse('2026-07-15T00:00:02.000Z'));
    expect(hrToMs(startNode!.endTime)).toBe(Date.parse('2026-07-15T00:00:03.000Z'));
  });

  it('parents the root span to a stamped traceparent', async () => {
    const traceId = 'a'.repeat(32);
    const spanId = 'b'.repeat(16);
    await emitWorkflowRunSpans(
      DISABLED_ENV,
      makeParams({ traceparent: `00-${traceId}-${spanId}-01` }),
      makeResult(),
      { exporter },
    );
    const root = memory.getFinishedSpans().find((s) => s.name === 'workflow.run');
    expect(root?.spanContext().traceId).toBe(traceId);
    expect(root?.parentSpanContext?.spanId).toBe(spanId);
  });

  it('starts a fresh trace on a malformed traceparent without throwing', async () => {
    await emitWorkflowRunSpans(
      DISABLED_ENV,
      makeParams({ traceparent: 'garbage-not-a-traceparent' }),
      makeResult(),
      { exporter },
    );
    const root = memory.getFinishedSpans().find((s) => s.name === 'workflow.run');
    expect(root?.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root?.parentSpanContext).toBeUndefined();
  });

  it('marks failed runs and failed nodes with ERROR status, without raw error text', async () => {
    const result = makeResult({
      status: 'failed',
      failures: [{ nodeId: 'start', message: 'secret backend body leaked 500' }],
    });
    result.state.nodes['start'] = {
      status: 'failed',
      error: 'secret backend body leaked 500',
      startedAt: '2026-07-15T00:00:02.000Z',
      completedAt: '2026-07-15T00:00:03.000Z',
    };
    await emitWorkflowRunSpans(DISABLED_ENV, makeParams(), result, { exporter });

    const spans = memory.getFinishedSpans();
    const root = spans.find((s) => s.name === 'workflow.run');
    expect(root?.status.code).toBe(SpanStatusCode.ERROR);
    expect(root?.status.message).toBe('node start failed');

    const failedNode = spans.find((s) => s.attributes['valet.node.id'] === 'start');
    expect(failedNode?.status.code).toBe(SpanStatusCode.ERROR);

    const serialized = JSON.stringify(spans.map((s) => ({ n: s.name, a: s.attributes, m: s.status.message, e: s.events })));
    expect(serialized).not.toContain('secret backend body');
  });

  it('emits a lone zero-length root for an early-cancelled run with no executed nodes', async () => {
    const result: WorkflowRunResult = {
      status: 'cancelled',
      state: { trigger: makeParams().trigger, nodes: {}, skipped: {} },
    };
    const count = await emitWorkflowRunSpans(DISABLED_ENV, makeParams(), result, { exporter });
    expect(count).toBe(1);
    const [root] = memory.getFinishedSpans();
    expect(root?.name).toBe('workflow.run');
    expect(root?.attributes['valet.workflow.status']).toBe('cancelled');
    expect(hrToMs(root!.endTime)).toBe(hrToMs(root!.startTime));
  });

  it('never throws when the exporter fails, and reports 0 spans', async () => {
    const exploding: SpanExporter = {
      export: () => { throw new Error('exporter down'); },
      shutdown: () => Promise.resolve(),
      forceFlush: () => Promise.resolve(),
    };
    const count = await emitWorkflowRunSpans(DISABLED_ENV, makeParams(), makeResult(), { exporter: exploding });
    expect(count).toBe(0);
  });

  it('never throws when the export flush rejects; reports 0 spans', async () => {
    const failing: SpanExporter = {
      export: (spans: ReadableSpan[], cb: Parameters<SpanExporter['export']>[1]) =>
        cb({ code: 1, error: new Error('rate limited') }),
      shutdown: () => Promise.resolve(),
      forceFlush: () => Promise.resolve(),
    };
    // The failed export is counted+logged by DropCountingSpanExporter and the
    // rejected flush is swallowed by the emitter's catch-all — the workflow
    // itself must never see it.
    const count = await emitWorkflowRunSpans(DISABLED_ENV, makeParams(), makeResult(), { exporter: failing });
    expect(count).toBe(0);
  });
});
