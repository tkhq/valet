import { describe, it, expect, beforeEach, vi } from 'vitest';

// WorkflowEntrypoint from 'cloudflare:workers' isn't importable under Node —
// stub it with a base that just stores env, matching the runtime contract.
vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    ctx: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const runWorkflowDagMock = vi.fn();
vi.mock('./runtime.js', () => ({
  runWorkflowDag: (...args: unknown[]) => runWorkflowDagMock(...args),
}));
vi.mock('./trace-writer.js', () => ({
  createD1TraceWriter: () => ({ recordTransition: vi.fn() }),
}));
const emitWorkflowRunSpansMock = vi.fn();
vi.mock('../lib/workflow-tracing.js', () => ({
  emitWorkflowRunSpans: (...args: unknown[]) => emitWorkflowRunSpansMock(...args),
}));

import { ValetWorkflowInterpreter } from './interpreter.js';
import type { Env } from '../env.js';
import type { WorkflowRunParams, WorkflowRunResult } from './types.js';

type StepDoCall = { name: string; config?: unknown; fn: () => unknown };

function makeStep() {
  const calls: StepDoCall[] = [];
  const step = {
    do: vi.fn(async (name: string, ...rest: unknown[]) => {
      // step.do(name, fn) or step.do(name, config, fn)
      const fn = rest[rest.length - 1] as () => unknown;
      const config = rest.length > 1 ? rest[0] : undefined;
      calls.push({ name, config, fn });
      return fn();
    }),
  };
  return { step, calls };
}

function makeEvent(): { payload: WorkflowRunParams } {
  return {
    payload: {
      executionId: 'exec-42',
      workflowId: 'wf-1',
      userId: 'user-1',
      trigger: { type: 'manual', timestamp: 't', data: {}, metadata: {} },
      definition: { version: 'dag/v1', nodes: [], edges: [] },
      mode: 'test',
    },
  };
}

const RESULT: WorkflowRunResult = {
  status: 'completed',
  state: { trigger: { type: 'manual', timestamp: 't', data: {}, metadata: {} }, nodes: {}, skipped: {} },
};

describe('ValetWorkflowInterpreter.run', () => {
  beforeEach(() => {
    runWorkflowDagMock.mockReset().mockResolvedValue(RESULT);
    emitWorkflowRunSpansMock.mockReset().mockResolvedValue(1);
  });

  function make(env: Partial<Env>): ValetWorkflowInterpreter {
    return new ValetWorkflowInterpreter({} as never, env as Env);
  }

  it('does not schedule the otel-emit step when tracing is disabled', async () => {
    const { step, calls } = makeStep();
    const result = await make({}).run(makeEvent() as never, step as never);
    expect(result).toBe(RESULT);
    expect(calls.find((c) => c.name.startsWith('otel-emit:'))).toBeUndefined();
    expect(emitWorkflowRunSpansMock).not.toHaveBeenCalled();
  });

  it('schedules otel-emit with the NO_RETRY policy when tracing is enabled', async () => {
    const { step, calls } = makeStep();
    await make({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector' }).run(makeEvent() as never, step as never);
    const emit = calls.find((c) => c.name === 'otel-emit:exec-42');
    expect(emit).toBeDefined();
    // The non-idempotent OTLP export must carry NO_RETRY so CF's default 5x
    // policy can't re-fire it and duplicate the span tree.
    expect(emit!.config).toEqual({ retries: { limit: 1, delay: '1 second' } });
    expect(emitWorkflowRunSpansMock).toHaveBeenCalledOnce();
  });

  it('never fails the run when span emission throws', async () => {
    emitWorkflowRunSpansMock.mockRejectedValue(new Error('otlp down'));
    const { step } = makeStep();
    const result = await make({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector' }).run(makeEvent() as never, step as never);
    expect(result).toBe(RESULT);
  });
});
