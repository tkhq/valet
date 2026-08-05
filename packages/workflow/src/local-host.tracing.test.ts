/**
 * LocalRunHost tracing detachment: a drive triggered from inside an active
 * span (an HTTP request handler calling `start`/`wake`) must NOT parent its
 * span tree under that ambient span. Drives are minutes-long and a nudge
 * can claim OTHER runnable runs, so the ambient request context would both
 * append to an ended trace and misattribute unrelated runs. `workflow.drive`
 * must always be a trace root (link-not-parent is the engine's contract for
 * this boundary; the link half needs per-run traceparent storage and is not
 * built yet).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { context as otelContext, trace as otelTrace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import type { WorkflowDefinition } from './dag/shape.js';
import type { WorkflowEngineDeps } from './engine-deps.js';
import { LocalRunHost } from './local-host.js';
import { InMemoryWorkflowStore } from './memory-store.js';
import type { RunParams } from './store.js';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const cm = new AsyncLocalStorageContextManager();
  cm.enable();
  otelContext.setGlobalContextManager(cm);
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
      throw new Error('llmComplete not exercised by this fixture');
    }),
    promptOrchestrator: vi.fn(async () => {
      throw new Error('promptOrchestrator not exercised by this fixture');
    }),
    invokeAction: vi.fn(async () => {
      throw new Error('invokeAction not exercised by this fixture');
    }),
  };
}

function simpleDefinition(): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'e', type: 'stop', outcome: 'success' },
    ],
    edges: [{ from: 't', to: 'e' }],
  };
}

function runParams(): RunParams {
  return {
    workflowId: 'wf-detached',
    definitionVersionId: 'v1',
    input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: {}, metadata: {} },
  };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('LocalRunHost tracing detachment', () => {
  it('drives triggered inside an active span produce a root workflow.drive, never children of the ambient span', async () => {
    const store = new InMemoryWorkflowStore();
    const host = new LocalRunHost({
      store,
      engine: makeFakeEngineDeps(),
      clock: () => Date.now(),
      pollMs: 10,
      sweepMs: 20,
      leaseMs: 2_000,
      heartbeatMs: 300,
    });

    host.startHost();
    try {
      // Simulate the HTTP request handler: the route span is active when it
      // calls `host.start`, and stays the ambient context of the whole
      // nudge → poll → claim → drive chain unless the host detaches.
      const tracer = otelTrace.getTracer('test-request');
      await tracer.startActiveSpan('POST /api/workflows/:id/runs', async (requestSpan) => {
        await host.start('run-detach', runParams(), simpleDefinition());
        requestSpan.end();
      });
      await waitFor(async () => (await store.getRun('run-detach'))?.status === 'settled');
    } finally {
      await host.stopHost();
    }

    const spans = exporter.getFinishedSpans();
    const requestSpan = spans.find((s) => s.name === 'POST /api/workflows/:id/runs');
    expect(requestSpan).toBeDefined();
    const requestSpanId = requestSpan?.spanContext().spanId;

    const drives = spans.filter((s) => s.name === 'workflow.drive');
    expect(drives.length).toBeGreaterThanOrEqual(1);
    for (const drive of drives) {
      expect(drive.parentSpanContext, 'workflow.drive must be a trace root').toBeUndefined();
      expect(drive.spanContext().traceId).not.toBe(requestSpan?.spanContext().traceId);
    }

    // Nothing from the drive tree — node spans, store spans, heartbeats —
    // may attach to the request span.
    for (const span of spans) {
      if (span === requestSpan) continue;
      expect(span.parentSpanContext?.spanId, `${span.name} parented under the request span`).not.toBe(requestSpanId);
      expect(span.spanContext().traceId, `${span.name} joined the request trace`).not.toBe(
        requestSpan?.spanContext().traceId,
      );
    }
  });
});
