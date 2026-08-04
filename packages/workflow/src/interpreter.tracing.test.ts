/**
 * Interpreter tracing coverage: with a real (in-memory) OTel SDK
 * registered, one drive must produce a `workflow.drive` root span with the
 * run's identity and settlement, and one `workflow.node.{type}` child span
 * per executed node. With no SDK registered (every other workflow test),
 * the tracing seam is a no-op — those suites prove the untraced path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { context as otelContext, trace as otelTrace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { activeTraceparent } from '@valet/engine';

import type { WorkflowDefinition } from './dag/shape.js';
import type { WorkflowEngineDeps } from './engine-deps.js';
import { driveUntilPark, type InterpreterDeps } from './interpreter.js';
import { InMemoryWorkflowStore } from './memory-store.js';
import type { RunParams } from './store.js';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let contextManager: AsyncLocalStorageContextManager;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  otelContext.setGlobalContextManager(contextManager);
  otelTrace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  otelTrace.disable();
  otelContext.disable();
});

function makeFakeEngineDeps(): WorkflowEngineDeps {
  return {
    createSession: vi.fn(async (opts) => ({ id: opts.id })),
    prompt: vi.fn(async () => ({ threadId: 'thread', queueItemId: 'queue' })),
    awaitResult: vi.fn(async () => ({ queueItemId: 'queue', outcome: 'completed' as const })),
    abort: vi.fn(async () => {}),
    isSettled: vi.fn(async () => true),
    llmComplete: vi.fn(async () => {
      throw new Error('llm exploded');
    }),
    promptOrchestrator: vi.fn(async () => {
      throw new Error('promptOrchestrator not exercised by this fixture');
    }),
    invokeAction: vi.fn(async () => {
      throw new Error('invokeAction not exercised by this fixture');
    }),
  };
}

function runParams(): RunParams {
  return {
    workflowId: 'wf-traced',
    definitionVersionId: 'v1',
    input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: {}, metadata: {} },
  };
}

function linearDefinition(): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 's', type: 'set', values: { greeting: 'hello' } },
      { id: 'e', type: 'stop', outcome: 'success' },
    ],
    edges: [
      { from: 't', to: 's' },
      { from: 's', to: 'e' },
    ],
  };
}

async function drive(
  store: InMemoryWorkflowStore,
  definition: WorkflowDefinition,
  engine: WorkflowEngineDeps = makeFakeEngineDeps(),
) {
  await store.createRun('run-1', runParams(), definition, 'v1');
  const claim = await store.claimRun('run-1', 'owner', 30_000);
  if (!claim) throw new Error('could not claim run-1');
  const deps: InterpreterDeps = { store, engine, clock: () => 1_000 };
  return await driveUntilPark('run-1', claim.attempt, deps);
}

function spansByName(name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter((s) => s.name === name);
}

describe('driveUntilPark tracing', () => {
  it('emits a workflow.drive span with run identity and settlement attributes', async () => {
    const park = await drive(new InMemoryWorkflowStore(), linearDefinition());
    expect(park.status).toBe('settled');

    const drives = spansByName('workflow.drive');
    expect(drives).toHaveLength(1);
    const span = drives[0];
    expect(span.attributes['valet.workflow.id']).toBe('wf-traced');
    expect(span.attributes['valet.workflow.run.id']).toBe('run-1');
    expect(span.attributes['valet.workflow.run.attempt']).toBe(1);
    expect(span.attributes['valet.workflow.run.status']).toBe('settled');
    expect(span.attributes['valet.workflow.run.outcome']).toBe('completed');
  });

  it('emits one workflow.node.{type} child span per executed node, parented under the drive', async () => {
    await drive(new InMemoryWorkflowStore(), linearDefinition());

    const drives = spansByName('workflow.drive');
    expect(drives).toHaveLength(1);
    const driveSpanId = drives[0].spanContext().spanId;

    for (const [name, nodeId] of [
      ['workflow.node.trigger', 't'],
      ['workflow.node.set', 's'],
      ['workflow.node.stop', 'e'],
    ] as const) {
      const spans = spansByName(name);
      expect(spans, name).toHaveLength(1);
      const span = spans[0];
      expect(span.attributes['valet.workflow.run.id']).toBe('run-1');
      expect(span.attributes['valet.workflow.node.id']).toBe(nodeId);
      expect(span.attributes['valet.workflow.node.status']).toBe('completed');
      expect(span.parentSpanContext?.spanId, `${name} parent`).toBe(driveSpanId);
      expect(span.spanContext().traceId).toBe(drives[0].spanContext().traceId);
    }
  });

  it('marks a failed node span ERROR with the executor error and settles the drive failed', async () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'l', type: 'llm', model: 'anthropic:claude-sonnet-5', prompt: 'hi' },
      ],
      edges: [{ from: 't', to: 'l' }],
    };
    const park = await drive(new InMemoryWorkflowStore(), definition);
    expect(park.outcome).toBe('failed');

    const nodeSpans = spansByName('workflow.node.llm');
    expect(nodeSpans).toHaveLength(1);
    expect(nodeSpans[0].attributes['valet.workflow.node.status']).toBe('failed');
    expect(nodeSpans[0].status.code).toBe(2); // SpanStatusCode.ERROR
    expect(nodeSpans[0].status.message).toContain('llm exploded');

    const drives = spansByName('workflow.drive');
    expect(drives).toHaveLength(1);
    expect(drives[0].attributes['valet.workflow.run.outcome']).toBe('failed');
  });

  it('keeps the workflow.node span active across engine.prompt so the admission stamp links the session turn', async () => {
    // Pins the cross-trace linkage contract from the run-host spec's
    // Tracing section: the engine stamps `activeTraceparent()` into the
    // queue item at admission, so the traceparent visible inside
    // `engine.prompt` must be exactly the workflow.node.session span.
    let promptTraceparent: string | undefined;
    const engine = makeFakeEngineDeps();
    engine.prompt = vi.fn(async () => {
      promptTraceparent = activeTraceparent();
      return { threadId: 'thread', queueItemId: 'queue' };
    });
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'sess', type: 'session', mode: 'start', prompt: 'do the thing', wait: { mode: 'none' } },
      ],
      edges: [{ from: 't', to: 'sess' }],
    };
    await drive(new InMemoryWorkflowStore(), definition, engine);

    const nodeSpans = spansByName('workflow.node.session');
    expect(nodeSpans).toHaveLength(1);
    const ctx = nodeSpans[0].spanContext();
    expect(promptTraceparent).toBe(`00-${ctx.traceId}-${ctx.spanId}-01`);
  });

  it('records a parked drive with the wait kinds it parked on', async () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'w', type: 'wait', mode: 'duration', duration: '5m' },
      ],
      edges: [{ from: 't', to: 'w' }],
    };
    const park = await drive(new InMemoryWorkflowStore(), definition);
    expect(park.status).toBe('parked');

    const drives = spansByName('workflow.drive');
    expect(drives).toHaveLength(1);
    expect(drives[0].attributes['valet.workflow.run.status']).toBe('parked');
    expect(drives[0].attributes['valet.workflow.run.waiting']).toEqual(['timer']);

    const waitSpans = spansByName('workflow.node.wait');
    expect(waitSpans).toHaveLength(1);
    expect(waitSpans[0].attributes['valet.workflow.node.status']).toBe('parked');
  });
});
