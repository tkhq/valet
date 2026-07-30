import { describe, it, expect } from 'vitest';
import { runDag } from '../runtime.js';
import type { WorkflowDefinition, LoopNode, ForeachBodyNode } from '@valet/shared';
import type { WorkflowRunParams, TraceWriter, TraceTransition } from '../types.js';
import type { Env } from '../../env.js';
import type { WorkflowStep, WorkflowStepConfig, WorkflowSleepDuration, WorkflowTimeoutDuration } from 'cloudflare:workers';
import type { LoopResult } from './loop.js';

const stubEnv: Env = {} as Env;

function makeStep(): WorkflowStep {
  return {
    async do<T>(_name: string, configOrFn: WorkflowStepConfig | (() => Promise<T>), maybeFn?: () => Promise<T>): Promise<T> {
      const fn = typeof configOrFn === 'function' ? configOrFn : maybeFn!;
      return fn();
    },
    async sleep(_name: string, _duration: WorkflowSleepDuration): Promise<void> {},
    async sleepUntil(_name: string, _timestamp: Date | number): Promise<void> {},
    async waitForEvent<T>(_name: string, _options: { type: string; timeout?: WorkflowTimeoutDuration | number }): Promise<{ payload: T; timestamp: Date; type: string }> {
      throw new Error('not used');
    },
  } as unknown as WorkflowStep;
}

function makeTraceWriter(): { writer: TraceWriter; rows: TraceTransition[] } {
  const rows: TraceTransition[] = [];
  return { writer: { async recordTransition(row) { rows.push(row); } }, rows };
}

function makeParams(definition: WorkflowDefinition, overrides: Partial<WorkflowRunParams> = {}): WorkflowRunParams {
  return {
    executionId: 'exec-1',
    workflowId: 'wf-1',
    userId: 'user-1',
    trigger: { type: 'manual', timestamp: '2026-06-12T00:00:00.000Z', data: {}, metadata: {} },
    definition,
    mode: 'production',
    ...overrides,
  };
}

function loopDef(loop: Omit<LoopNode, 'type' | 'id'> & Partial<Pick<LoopNode, 'id'>>): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [
      { id: loop.id ?? 'refine', type: 'loop', ...loop } as LoopNode,
    ],
    edges: [],
  };
}

function loopData(result: Awaited<ReturnType<typeof runDag>>, id = 'refine'): LoopResult {
  return result.state.nodes[id]!.data as LoopResult;
}

describe('loop — until condition', () => {
  it('exits when until fires, exposing the final iteration steps', async () => {
    // Two body steps per iteration; the second reads the first within the
    // same iteration (steps.* visibility). until fires on iteration 1.
    const def = loopDef({
      body: [
        { id: 'a', type: 'set', values: { n: '{{iteration}}' } },
        { id: 'b', type: 'set', values: { seen: '{{steps.a.n}}' } },
      ],
      maxIterations: 5,
      until: { conditions: [{ left: 'steps.b.seen', dataType: 'number', operation: 'equals', right: 1 }] },
    });

    const { writer } = makeTraceWriter();
    const result = await runDag(stubEnv, makeParams(def), makeStep(), writer);
    expect(result.status).toBe('completed');
    const data = loopData(result);
    expect(data.satisfied).toBe(true);
    expect(data.iterations).toBe(2);
    expect(data.steps).toEqual({ a: { n: 1 }, b: { seen: 1 } });
  });

  it('reports satisfied=false when the cap is hit before until fires', async () => {
    const def = loopDef({
      body: [{ id: 'a', type: 'set', values: { n: '{{iteration}}' } }],
      maxIterations: 3,
      until: { conditions: [{ left: 'steps.a.n', dataType: 'number', operation: 'equals', right: 99 }] },
    });

    const { writer } = makeTraceWriter();
    const result = await runDag(stubEnv, makeParams(def), makeStep(), writer);
    expect(result.status).toBe('completed');
    const data = loopData(result);
    expect(data.satisfied).toBe(false);
    expect(data.iterations).toBe(3);
    expect(data.steps).toEqual({ a: { n: 2 } });
  });

  it('exposes the previous iteration under prev.*', async () => {
    const def = loopDef({
      body: [{ id: 'a', type: 'set', values: { n: '{{iteration}}', sawPrev: '{{prev.a.n}}' } }],
      maxIterations: 2,
    });

    const { writer } = makeTraceWriter();
    const result = await runDag(stubEnv, makeParams(def), makeStep(), writer);
    const data = loopData(result);
    // Single-expression templates render undefined → null, so the first
    // iteration's sawPrev is null and the second sees iteration 0's n.
    expect(data.steps).toEqual({ a: { n: 1, sawPrev: 0 } });
  });
});

describe('loop — no until (repeat N times)', () => {
  it('runs exactly maxIterations and reports satisfied=true', async () => {
    const def = loopDef({
      body: [{ id: 'a', type: 'set', values: { n: '{{iteration}}' } }],
      maxIterations: 4,
    });

    const { writer } = makeTraceWriter();
    const result = await runDag(stubEnv, makeParams(def), makeStep(), writer);
    const data = loopData(result);
    expect(data.iterations).toBe(4);
    expect(data.satisfied).toBe(true);
    expect(data.steps).toEqual({ a: { n: 3 } });
  });
});

describe('loop — error handling', () => {
  // A project node whose source doesn't resolve to an array throws
  // deterministically — the standard way to make a body step fail.
  const failingStep: ForeachBodyNode = { id: 'boom', type: 'project', source: '{{trigger.data.missing}}', columns: [{ header: 'X', path: 'x' }] };

  it("onIterationError='fail' (default) fails the loop node with step context", async () => {
    const def = loopDef({
      body: [failingStep],
      maxIterations: 3,
    });

    const { writer } = makeTraceWriter();
    const result = await runDag(stubEnv, makeParams(def), makeStep(), writer);
    expect(result.status).toBe('failed');
    expect(result.failures?.[0]?.message).toContain('loop "refine": iteration 0 step "boom" failed');
  });

  it("onIterationError='break' completes the node instead of failing it", async () => {
    const def = loopDef({
      body: [
        { id: 'a', type: 'set', values: { n: '{{iteration}}' } },
        failingStep,
      ],
      maxIterations: 3,
      onIterationError: 'break',
    });

    const { writer } = makeTraceWriter();
    const result = await runDag(stubEnv, makeParams(def), makeStep(), writer);
    expect(result.status).toBe('completed');
    const data = loopData(result);
    expect(data.satisfied).toBe(false);
    expect(data.iterations).toBe(1);
    expect(data.stoppedEarly).toContain('iteration 0 step "boom" failed');
    // `steps` is the final iteration, including a partial one: 'a' ran before
    // 'boom' threw, so its output survives the break for downstream nodes.
    expect(Object.keys(data.steps as Record<string, unknown>)).toEqual(['a']);
    expect(data.iterations).toBe(1);
  });

  it("onIterationError='break' exposes every step that ran before the failure", async () => {
    // The partial iteration is cut exactly at the failing step: steps before
    // it are present, the failing step and everything after it are absent.
    const def = loopDef({
      body: [
        { id: 'a', type: 'set', values: { n: '{{iteration}}' } },
        { id: 'b', type: 'set', values: { seen: '{{steps.a.n}}' } },
        failingStep,
        { id: 'never', type: 'set', values: { x: '1' } },
      ],
      maxIterations: 3,
      onIterationError: 'break',
    });

    const { writer } = makeTraceWriter();
    const result = await runDag(stubEnv, makeParams(def), makeStep(), writer);
    expect(result.status).toBe('completed');
    const data = loopData(result);
    expect(data.satisfied).toBe(false);
    expect(Object.keys(data.steps as Record<string, unknown>).sort()).toEqual(['a', 'b']);
    expect(data.stoppedEarly).toContain('step "boom" failed');
  });
});

describe('loop — step.do contract', () => {
  it('wraps non-step-driven body steps in NO_RETRY step.do keyed per iteration and step', async () => {
    const def = loopDef({
      body: [
        { id: 'a', type: 'set', values: { n: '{{iteration}}' } },
        { id: 'b', type: 'set', values: {} },
      ],
      maxIterations: 2,
    });

    const bodySteps: Array<{ name: string; config: WorkflowStepConfig }> = [];
    const step: WorkflowStep = {
      async do<T>(name: string, configOrFn: WorkflowStepConfig | (() => Promise<T>), maybeFn?: () => Promise<T>): Promise<T> {
        if (/^node:refine:i:\d+:/.test(name) && typeof configOrFn === 'object') {
          bodySteps.push({ name, config: configOrFn });
        }
        const fn = typeof configOrFn === 'function' ? configOrFn : maybeFn!;
        return fn();
      },
      async sleep() {},
      async sleepUntil() {},
      async waitForEvent() { throw new Error('not used'); },
    } as unknown as WorkflowStep;

    const { writer } = makeTraceWriter();
    await runDag(stubEnv, makeParams(def), step, writer);

    expect(bodySteps.map((s) => s.name)).toEqual([
      'node:refine:i:0:a',
      'node:refine:i:0:b',
      'node:refine:i:1:a',
      'node:refine:i:1:b',
    ]);
    for (const s of bodySteps) {
      // NO_RETRY: limit 1 = the initial attempt only, no retries.
      expect(s.config.retries).toEqual({ limit: 1, delay: '1 second' });
    }
  });
});

describe('loop — cumulative iteration budget', () => {
  it('charges every body-step execution against the shared foreach budget', async () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'refine',
          type: 'loop',
          body: [
            { id: 'a', type: 'set', values: {} },
            { id: 'b', type: 'set', values: {} },
          ],
          maxIterations: 3,
        },
      ],
      edges: [],
    };

    const { writer } = makeTraceWriter();
    const result = await runDag(stubEnv, makeParams(def), makeStep(), writer);
    expect(result.status).toBe('completed');
    // 3 iterations × 2 body steps.
    expect(result.state.foreachIterationCount).toBe(6);
  });
});

describe('loop — downstream consumption', () => {
  it('lets downstream nodes read the final steps via nodes.<id>.data.steps', async () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        {
          id: 'refine',
          type: 'loop',
          body: [{ id: 'draft', type: 'set', values: { text: 'v{{iteration}}' } }],
          maxIterations: 2,
        },
        { id: 'report', type: 'set', values: { final: '{{nodes.refine.data.steps.draft.text}}', ok: '{{nodes.refine.data.satisfied}}' } },
      ],
      edges: [{ from: 'refine', to: 'report' }],
    };

    const { writer } = makeTraceWriter();
    const result = await runDag(stubEnv, makeParams(def), makeStep(), writer);
    expect(result.status).toBe('completed');
    expect(result.state.nodes.report!.data).toEqual({ final: 'v1', ok: true });
  });
});
