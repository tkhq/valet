import { describe, it, expect, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { createTraceProvider, parentContext } from './do-tracing.js';

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

// Pins the redact → drop-count → batch chain that createTraceProvider builds:
// the first test fails if the RedactingSpanExporter wrapping is removed, the
// second if the DropCountingSpanExporter wrapping is removed.
describe('createTraceProvider', () => {
  it('redacts URL query secrets before spans reach the terminal exporter', async () => {
    const memory = new InMemorySpanExporter();
    const keeper: SpanExporter = {
      export: (spans, cb) => memory.export(spans, cb),
      shutdown: () => Promise.resolve(),
      forceFlush: () => Promise.resolve(),
    };
    const created = await createTraceProvider({}, 'test-svc', keeper);
    expect(created).not.toBeNull();
    const tracer = created!.provider.getTracer('test-svc');
    const span = tracer.startSpan('fetch', {
      attributes: { 'url.full': 'https://api.test/cb?token=LEAKSECRET&x=1' },
    });
    span.end();
    await created!.provider.forceFlush();
    const [exported] = memory.getFinishedSpans();
    expect(exported?.attributes['url.full']).toBe('https://api.test/cb');
    expect(JSON.stringify(exported?.attributes)).not.toContain('LEAKSECRET');
  });

  it('counts failed terminal exports on the returned drop counter', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A terminal exporter that reports a non-success code (SUCCESS === 0) for
      // every batch, so the drop counter must observe the failure.
      const failing: SpanExporter = {
        export: (_spans, cb) => cb({ code: 1, error: new Error('rate limited') }),
        shutdown: () => Promise.resolve(),
        forceFlush: () => Promise.resolve(),
      };
      const created = await createTraceProvider({}, 'test-svc', failing);
      expect(created).not.toBeNull();
      const tracer = created!.provider.getTracer('test-svc');
      tracer.startSpan('fetch').end();
      // A failed export makes the batch processor reject the flush; the drop
      // counter still records it in the export callback beforehand.
      await created!.provider.forceFlush().catch(() => {});
      expect(created!.dropCounter.dropped).toBe(1);
      expect(created!.dropCounter.errors).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});
