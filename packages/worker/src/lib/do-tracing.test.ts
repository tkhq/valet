import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Env } from '../env.js';
import { createDoTracer, parentContext } from './do-tracing.js';

// parentContext parses the Worker→DO `traceparent` header so DO-internal spans nest
// under the worker trace. Importing it does not trigger the lazy `cloudflare:workers`
// import (that lives inside createDoTracer), so this stays Node-testable.
describe('parentContext', () => {
  it('parses a valid sampled W3C traceparent into a remote parent span context', () => {
    const req = new Request('https://do/x', {
      headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
    });
    const sc = trace.getSpanContext(parentContext(req));
    expect(sc?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(sc?.spanId).toBe('b7ad6b7169203331');
    expect(sc?.traceFlags).toBe(1);
    expect(sc?.isRemote).toBe(true);
  });

  it('parses the unsampled flag (00) as traceFlags 0', () => {
    const req = new Request('https://do/x', {
      headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00' },
    });
    expect(trace.getSpanContext(parentContext(req))?.traceFlags).toBe(0);
  });

  it('returns a parent-less context when traceparent is absent', () => {
    expect(trace.getSpanContext(parentContext(new Request('https://do/x')))).toBeUndefined();
  });

  it('returns a parent-less context when traceparent ids are the wrong length', () => {
    const req = new Request('https://do/x', { headers: { traceparent: '00-abc-def-01' } });
    expect(trace.getSpanContext(parentContext(req))).toBeUndefined();
  });
});

describe('DoTracer.traceTask', () => {
  const exporter = new InMemorySpanExporter();
  const parentProvider = new BasicTracerProvider();

  beforeAll(() => {
    trace.setGlobalTracerProvider(parentProvider);
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });

  afterAll(async () => {
    await parentProvider.shutdown();
    trace.disable();
    context.disable();
  });

  beforeEach(() => exporter.reset());

  function createTestContext() {
    return {
      waitUntil: vi.fn(),
    } as unknown as DurableObjectState;
  }

  function createTestProvider() {
    return new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
  }

  it('creates an independent lifecycle root rather than inheriting the active request', async () => {
    const ctx = createTestContext();
    const provider = createTestProvider();
    const tracer = await createDoTracer(
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector' } as Env,
      ctx,
      'test-do',
      { provider },
    );

    let parentTraceId = '';
    let taskTraceId = '';
    await trace.getTracer('parent').startActiveSpan('request', async (parent) => {
      parentTraceId = parent.spanContext().traceId;
      await tracer.traceTask('session.lifecycle.spawn', () => {
        taskTraceId = trace.getActiveSpan()?.spanContext().traceId ?? '';
      }, { 'valet.lifecycle.trigger': 'initial_start' });
      parent.end();
    });

    const [span] = exporter.getFinishedSpans();
    expect(taskTraceId).not.toBe(parentTraceId);
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.attributes).toMatchObject({
      'valet.lifecycle.trigger': 'initial_start',
    });
    // The cached tracer batches task spans; SessionAgentDO schedules the flush at the lifecycle
    // boundary rather than forcing one OTLP request per task.
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it('marks an uncaught task failure without exporting its error message or body', async () => {
    const ctx = createTestContext();
    const tracer = await createDoTracer(
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector' } as Env,
      ctx,
      'test-do',
      { provider: createTestProvider() },
    );

    await expect(
      tracer.traceTask('session.lifecycle.hibernate', () => {
        throw new Error('secret backend body');
      }),
    ).rejects.toThrow('secret backend body');

    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes).toMatchObject({
      'do.task.error.class': 'unexpected',
    });
    expect(span.events).toEqual([]);
  });

  it('is a true no-op when tracing is disabled', async () => {
    const ctx = createTestContext();
    const provider = createTestProvider();
    const tracer = await createDoTracer(
      {} as Env,
      ctx,
      'test-do',
      { provider },
    );

    await tracer.traceTask('session.lifecycle.restore', () => undefined);

    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});
