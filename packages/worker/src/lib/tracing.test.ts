import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { context, trace, TraceFlags } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { activeTraceparent, buildTraceConfig, isTracingEnabled, parseOtlpHeaders, redactUrlAttributes, setSessionAttributes, withTraceparent } from './tracing.js';

describe('isTracingEnabled', () => {
  it('is false when the endpoint is unset or blank', () => {
    expect(isTracingEnabled({})).toBe(false);
    expect(isTracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: '   ' })).toBe(false);
  });
  it('is true when the endpoint is set', () => {
    expect(isTracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' })).toBe(true);
  });
});

describe('parseOtlpHeaders', () => {
  it('returns empty for undefined', () => {
    expect(parseOtlpHeaders(undefined)).toEqual({});
  });
  it('parses comma-separated key=value pairs, trimming, keeping = in values', () => {
    expect(parseOtlpHeaders('Authorization=Basic abc, k=a=b, bad')).toEqual({
      Authorization: 'Basic abc',
      k: 'a=b',
    });
  });
  it('percent-decodes values so a %20-encoded token matches the backend parser', () => {
    expect(parseOtlpHeaders('Authorization=Basic%20abc123')).toEqual({
      Authorization: 'Basic abc123',
    });
  });
  it('leaves a malformed percent-sequence verbatim', () => {
    expect(parseOtlpHeaders('k=100%')).toEqual({ k: '100%' });
  });
  it('decodes valid escapes and keeps malformed ones literal per-sequence, matching Python unquote', () => {
    // Python: unquote('a%zzb%20c') == 'a%zzb c' — the bad '%zz' stays literal
    // while the valid '%20' still decodes to a space. decodeURIComponent would
    // instead throw and leave the whole value ('a%zzb%20c') undecoded.
    expect(parseOtlpHeaders('k=a%zzb%20c')).toEqual({ k: 'a%zzb c' });
  });
});

describe('buildTraceConfig', () => {
  it('is a no-op when disabled: head sampler ratio 0', () => {
    const cfg = buildTraceConfig({}, 'valet-worker');
    expect(cfg.service.name).toBe('valet-worker');
    expect(cfg.sampling?.headSampler).toMatchObject({ ratio: 0, acceptRemote: false });
    if (!('exporter' in cfg)) throw new Error('expected exporter config');
    expect(cfg.exporter).toMatchObject({ url: 'http://localhost:4318/v1/traces' });
  });

  it('uses endpoint + headers and strips a trailing slash when enabled (ratio 1)', () => {
    const cfg = buildTraceConfig(
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://tempo.example/', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic xyz' },
      'valet-worker',
    );
    expect(cfg.sampling?.headSampler).toMatchObject({ ratio: 1, acceptRemote: true });
    if (!('exporter' in cfg)) throw new Error('expected exporter config');
    expect(cfg.exporter).toMatchObject({
      url: 'https://tempo.example/v1/traces',
      headers: { Authorization: 'Basic xyz' },
    });
  });
});

describe('redactUrlAttributes', () => {
  it('strips the query string from url.full and clears url.query (keeps path)', () => {
    const attrs: Record<string, unknown> = {
      'url.full': 'https://valet/auth/github/callback?code=SECRET&state=xyz',
      'url.query': '?code=SECRET&state=xyz',
      'url.path': '/auth/github/callback',
      'http.request.method': 'GET',
    };
    redactUrlAttributes(attrs);
    expect(attrs['url.full']).toBe('https://valet/auth/github/callback');
    expect(attrs['url.query']).toBe('');
    expect(attrs['url.path']).toBe('/auth/github/callback');
    expect(attrs['http.request.method']).toBe('GET');
  });

  it('leaves a query-less url unchanged', () => {
    const attrs: Record<string, unknown> = { 'url.full': 'https://valet/health' };
    redactUrlAttributes(attrs);
    expect(attrs['url.full']).toBe('https://valet/health');
  });

  it('scrubs a Telegram bot token from the path of url.full and url.path', () => {
    const attrs: Record<string, unknown> = {
      'url.full': 'https://api.telegram.org/bot123456789:AA-Example_Token-xyz/sendMessage',
      'url.path': '/bot123456789:AA-Example_Token-xyz/sendMessage',
    };
    redactUrlAttributes(attrs);
    expect(attrs['url.full']).toBe('https://api.telegram.org/bot<redacted>/sendMessage');
    expect(attrs['url.path']).toBe('/bot<redacted>/sendMessage');
  });

  it('strips the query from http.url (cache spans) too', () => {
    const attrs: Record<string, unknown> = { 'http.url': 'https://valet/auth/cb?code=SECRET' };
    redactUrlAttributes(attrs);
    expect(attrs['http.url']).toBe('https://valet/auth/cb');
  });
});

describe('setSessionAttributes', () => {
  const exporter = new InMemorySpanExporter();
  let provider: BasicTracerProvider;

  beforeAll(() => {
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });
  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });
  beforeEach(() => exporter.reset());

  it('sets valet.* on the active span (span scope, not resource)', async () => {
    await trace.getTracer('t').startActiveSpan('op', async (span) => {
      setSessionAttributes({ sessionId: 's1', userId: 'u1', orgId: 'o1' });
      span.end();
    });
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes['valet.session.id']).toBe('s1');
    expect(span.attributes['valet.user.id']).toBe('u1');
    expect(span.attributes['valet.org.id']).toBe('o1');
  });

  it('omits null/undefined ids', async () => {
    await trace.getTracer('t').startActiveSpan('op', async (span) => {
      setSessionAttributes({ sessionId: 's1', userId: null });
      span.end();
    });
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes['valet.session.id']).toBe('s1');
    expect(span.attributes['valet.user.id']).toBeUndefined();
  });

  it('is a no-op (does not throw) when there is no active span', () => {
    expect(() => setSessionAttributes({ sessionId: 's1' })).not.toThrow();
  });
});

describe('activeTraceparent', () => {
  let provider: BasicTracerProvider;
  beforeAll(() => {
    provider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(provider);
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });
  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  it('is null when there is no active span', () => {
    expect(activeTraceparent()).toBeNull();
  });

  it('formats the active span context as a sampled W3C traceparent', () => {
    trace.getTracer('t').startActiveSpan('op', (span) => {
      const sc = span.spanContext();
      expect(activeTraceparent()).toBe(`00-${sc.traceId}-${sc.spanId}-01`);
      span.end();
    });
  });

  it('is null when the active span context has an all-zero trace id', () => {
    const sc = { traceId: '0'.repeat(32), spanId: '1'.repeat(16), traceFlags: TraceFlags.SAMPLED };
    context.with(trace.setSpanContext(context.active(), sc), () => {
      expect(activeTraceparent()).toBeNull();
    });
  });

  it('emits the unsampled 00 flag when the active span is not sampled', () => {
    const sc = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: TraceFlags.NONE };
    context.with(trace.setSpanContext(context.active(), sc), () => {
      expect(activeTraceparent()).toBe(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-00`);
    });
  });
});

describe('withTraceparent', () => {
  let provider: BasicTracerProvider;
  beforeAll(() => {
    provider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(provider);
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });
  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  it('adds a traceparent to the base headers when a span is active', () => {
    trace.getTracer('t').startActiveSpan('op', (span) => {
      const sc = span.spanContext();
      expect(withTraceparent({ 'Content-Type': 'application/json' })).toEqual({
        'Content-Type': 'application/json',
        traceparent: `00-${sc.traceId}-${sc.spanId}-01`,
      });
      span.end();
    });
  });

  it('returns the base headers unchanged when no span is active', () => {
    expect(withTraceparent({ 'Content-Type': 'application/json' })).toEqual({
      'Content-Type': 'application/json',
    });
  });
});
