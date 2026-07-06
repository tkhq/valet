import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { configureLogShipping, flushLogs, log, resetLogShippingForTests, setLogLevel } from './log.js';

let provider: BasicTracerProvider;

beforeAll(() => {
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});
afterEach(() => {
  setLogLevel('debug');
  resetLogShippingForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const spyConsole = (method: 'log' | 'warn' | 'error') =>
  vi.spyOn(console, method).mockImplementation(() => {});

const parse = (line: unknown): Record<string, unknown> =>
  JSON.parse(String(line)) as Record<string, unknown>;

describe('log', () => {
  it('emits one JSON line with level, message, time, and fields', () => {
    const spy = spyConsole('log');
    log.info('hello', { foo: 1, bar: 'b' });
    expect(spy).toHaveBeenCalledTimes(1);
    const entry = parse(spy.mock.calls[0][0]);
    expect(entry).toMatchObject({ level: 'info', message: 'hello', foo: 1, bar: 'b' });
    expect(typeof entry.time).toBe('string');
    expect(entry.trace_id).toBeUndefined(); // no active span
  });

  it('routes error → console.error and warn → console.warn', () => {
    const err = spyConsole('error');
    const warn = spyConsole('warn');
    log.error('bad');
    log.warn('careful');
    expect(err).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drops lines below the configured threshold', () => {
    const spy = spyConsole('log');
    setLogLevel('warn');
    log.info('skip');
    log.debug('skip');
    expect(spy).not.toHaveBeenCalled();
  });

  it('stamps trace_id/span_id when emitted inside an active span', async () => {
    const spy = spyConsole('log');
    await trace.getTracer('t').startActiveSpan('op', async (span) => {
      log.info('in-span');
      span.end();
    });
    const entry = parse(spy.mock.calls[0][0]);
    expect(entry.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(entry.span_id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('loki shipping', () => {
  const env = { LOKI_PUSH_URL: 'http://loki:3100', LOKI_BASIC_AUTH: 'dXNlcjp0b2tlbg==' };

  type StreamsBody = { streams: Array<{ stream: Record<string, string>; values: Array<[string, string]> }> };
  const sentBody = (fetchMock: ReturnType<typeof vi.fn>, call = 0): StreamsBody =>
    JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string) as StreamsBody;

  const stubFetch = (impl?: () => Promise<Response>) => {
    const fetchMock = vi.fn(impl ?? (async () => new Response('', { status: 204 })));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('unconfigured: emit buffers nothing and flushLogs makes zero fetches', async () => {
    const fetchMock = stubFetch();
    spyConsole('log');
    configureLogShipping({}); // no LOKI_PUSH_URL → dark
    log.info('never shipped');
    await flushLogs({});
    // Enabling later must not resurrect lines logged while dark.
    await flushLogs(env);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enabled but empty buffer: flushLogs is a no-op', async () => {
    const fetchMock = stubFetch();
    configureLogShipping(env);
    await flushLogs(env);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ships the exact console JSON lines with Loki labels, ns timestamps, and basic auth', async () => {
    const fetchMock = stubFetch();
    const spy = spyConsole('log');
    configureLogShipping(env);
    const before = Date.now();
    await trace.getTracer('t').startActiveSpan('op', async (span) => {
      log.info('shipped', { foo: 1 });
      span.end();
    });
    await flushLogs(env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://loki:3100/loki/api/v1/push');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init.headers as Record<string, string>).Authorization).toBe('Basic dXNlcjp0b2tlbg==');

    const { streams } = sentBody(fetchMock);
    expect(streams).toHaveLength(1);
    expect(streams[0].stream).toEqual({ service_name: 'valet-worker', level: 'info' });
    const [ts, line] = streams[0].values[0];
    // Nanosecond timestamp: our ms clock padded to ns.
    expect(ts).toMatch(/^\d{13}000000$/);
    expect(Number(ts.slice(0, 13))).toBeGreaterThanOrEqual(before);
    // The shipped line is byte-identical to the console line, trace stamp included.
    expect(line).toBe(String(spy.mock.calls[0][0]));
    expect(parse(line).trace_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('labels the stream with the flush driver service name and splits streams by level', async () => {
    const fetchMock = stubFetch();
    spyConsole('log');
    spyConsole('warn');
    configureLogShipping(env);
    log.info('a');
    log.warn('b');
    await flushLogs(env, 'valet-session-agent-do');

    const { streams } = sentBody(fetchMock);
    expect(streams.map((s) => s.stream)).toEqual([
      { service_name: 'valet-session-agent-do', level: 'info' },
      { service_name: 'valet-session-agent-do', level: 'warn' },
    ]);
  });

  it('caps the buffer at 500, dropping oldest, and reports drops on the next flush', async () => {
    const fetchMock = stubFetch();
    spyConsole('log');
    configureLogShipping(env);
    for (let i = 0; i < 520; i++) log.info(`line-${i}`);
    await flushLogs(env);

    const { streams } = sentBody(fetchMock);
    const info = streams.find((s) => s.stream.level === 'info')!;
    expect(info.values).toHaveLength(500);
    // Oldest 20 dropped: the first surviving line is line-20.
    expect(parse(info.values[0][1]).message).toBe('line-20');
    const warn = streams.find((s) => s.stream.level === 'warn')!;
    const report = parse(warn.values[0][1]);
    expect(report.dropped).toBe(20);
    expect(report.dropped_total).toBe(20);
  });

  it('swallows push failures with a single console.warn and counts the batch dropped', async () => {
    const fetchMock = stubFetch(async () => {
      throw new Error('connect refused');
    });
    spyConsole('log');
    const warnSpy = spyConsole('warn');
    configureLogShipping(env);
    log.info('doomed');
    await expect(flushLogs(env)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Next successful flush reports the failed batch as dropped.
    stubFetch();
    log.info('survivor');
    await flushLogs(env);
    const { streams } = sentBody(vi.mocked(fetch) as ReturnType<typeof vi.fn>);
    const warn = streams.find((s) => s.stream.level === 'warn')!;
    expect(parse(warn.values[0][1]).dropped_total).toBe(1);
  });

  it('treats a non-2xx response as a failure without throwing', async () => {
    stubFetch(async () => new Response('rate limited', { status: 429 }));
    spyConsole('log');
    const warnSpy = spyConsole('warn');
    configureLogShipping(env);
    log.info('doomed');
    await expect(flushLogs(env)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('is safe under concurrent invocation: each line ships exactly once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = stubFetch(async () => {
      await gate;
      return new Response('', { status: 204 });
    });
    spyConsole('log');
    configureLogShipping(env);
    log.info('once');

    const first = flushLogs(env);
    const second = flushLogs(env); // buffer already swapped out — must not re-send
    release();
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { streams } = sentBody(fetchMock);
    expect(streams[0].values).toHaveLength(1);
  });
});
