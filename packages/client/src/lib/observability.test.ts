import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransportItem } from '@grafana/faro-web-sdk';
import type { User } from '@valet/shared';

const mocks = vi.hoisted(() => {
  const api = {
    pushEvent: vi.fn(),
    pushError: vi.fn(),
    setUser: vi.fn(),
    resetUser: vi.fn(),
    setView: vi.fn(),
  };
  return {
    api,
    initializeFaro: vi.fn((_config: unknown) => ({ api })),
    getWebInstrumentations: vi.fn(() => []),
    TracingInstrumentation: vi.fn(),
  };
});

vi.mock('@grafana/faro-web-sdk', () => ({
  initializeFaro: mocks.initializeFaro,
  getWebInstrumentations: mocks.getWebInstrumentations,
}));
vi.mock('@grafana/faro-web-tracing', () => ({
  TracingInstrumentation: mocks.TracingInstrumentation,
}));

async function freshImport() {
  vi.resetModules();
  const observability = await import('./observability');
  const { useAuthStore } = await import('@/stores/auth');
  return { ...observability, useAuthStore };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('initFaro', () => {
  it('is a hard no-op when VITE_FARO_URL is unset', async () => {
    vi.stubEnv('VITE_FARO_URL', '');
    const { initFaro, isFaroEnabled } = await freshImport();

    expect(isFaroEnabled()).toBe(false);
    await initFaro();

    expect(mocks.initializeFaro).not.toHaveBeenCalled();
  });

  it('initializes the SDK with scrubbing and console capture off when enabled', async () => {
    vi.stubEnv('VITE_FARO_URL', 'https://faro.example.com/collect');
    const { initFaro, scrubBeforeSend } = await freshImport();

    await initFaro();

    expect(mocks.initializeFaro).toHaveBeenCalledTimes(1);
    const config = mocks.initializeFaro.mock.calls[0][0] as Record<string, unknown>;
    expect(config.url).toBe('https://faro.example.com/collect');
    expect(config.app).toMatchObject({ name: 'valet-client' });
    expect(config.beforeSend).toBe(scrubBeforeSend);
    expect(mocks.getWebInstrumentations).toHaveBeenCalledWith({ captureConsole: false });
  });

  it('only initializes once', async () => {
    vi.stubEnv('VITE_FARO_URL', 'https://faro.example.com/collect');
    const { initFaro } = await freshImport();

    await initFaro();
    await initFaro();

    expect(mocks.initializeFaro).toHaveBeenCalledTimes(1);
  });
});

describe('trackEvent', () => {
  it('never throws and sends nothing before/without init', async () => {
    vi.stubEnv('VITE_FARO_URL', '');
    const { initFaro, trackEvent } = await freshImport();

    expect(() => trackEvent('session_created', { 'valet.session.id': 'abc' })).not.toThrow();
    await initFaro();
    expect(() => trackEvent('session_created', { 'valet.session.id': 'abc' })).not.toThrow();

    expect(mocks.api.pushEvent).not.toHaveBeenCalled();
  });

  it('stringifies attributes and drops null/undefined after init', async () => {
    vi.stubEnv('VITE_FARO_URL', 'https://faro.example.com/collect');
    const { initFaro, trackEvent } = await freshImport();
    await initFaro();

    trackEvent('prompt_submitted', {
      'valet.session.id': 'sess-1',
      attachments: 2,
      missing: undefined,
      empty: null,
    });

    expect(mocks.api.pushEvent).toHaveBeenCalledWith('prompt_submitted', {
      'valet.session.id': 'sess-1',
      attachments: '2',
    });
  });
});

describe('user identity', () => {
  it('sets only the opaque user id on login and resets on logout', async () => {
    vi.stubEnv('VITE_FARO_URL', 'https://faro.example.com/collect');
    const { initFaro, useAuthStore } = await freshImport();
    await initFaro();

    // No user at init time → identity is reset, never guessed.
    expect(mocks.api.resetUser).toHaveBeenCalled();
    mocks.api.resetUser.mockClear();

    const user = { id: 'user-1', email: 'x@example.com', name: 'X' } as unknown as User;
    useAuthStore.getState().setAuth('token-1', user);

    expect(mocks.api.setUser).toHaveBeenCalledWith({ id: 'user-1' });
    const identity = mocks.api.setUser.mock.calls[0][0] as Record<string, unknown>;
    expect(identity).not.toHaveProperty('email');
    expect(identity).not.toHaveProperty('username');

    useAuthStore.getState().clearAuth();
    expect(mocks.api.resetUser).toHaveBeenCalled();
  });
});

describe('scrubBeforeSend', () => {
  it('strips query strings from every URL field without mutating the input', async () => {
    vi.stubEnv('VITE_FARO_URL', '');
    const { scrubBeforeSend } = await freshImport();

    const item = {
      type: 'exception',
      payload: {
        value: 'Failed to fetch https://api.valet.dev/api/files/read?sessionId=s1&path=.env',
        stacktrace: {
          frames: [
            { filename: 'https://app.valet.dev/assets/index.js?v=123', function: 'submit' },
          ],
        },
      },
      meta: {
        page: { url: 'https://app.valet.dev/auth/callback?code=oauth-secret&state=xyz' },
      },
    } as unknown as TransportItem;

    const scrubbed = scrubBeforeSend(item) as unknown as {
      payload: { value: string; stacktrace: { frames: Array<{ filename: string }> } };
      meta: { page: { url: string } };
    };

    expect(scrubbed.meta.page.url).toBe('https://app.valet.dev/auth/callback');
    expect(scrubbed.payload.value).toBe('Failed to fetch https://api.valet.dev/api/files/read');
    expect(scrubbed.payload.stacktrace.frames[0].filename).toBe(
      'https://app.valet.dev/assets/index.js'
    );
    // Input is not mutated — meta objects are shared across beacons.
    expect(
      (item as unknown as { meta: { page: { url: string } } }).meta.page.url
    ).toContain('code=oauth-secret');
  });

  it('scrubs URLs nested deep inside trace payloads (fetch spans)', async () => {
    vi.stubEnv('VITE_FARO_URL', '');
    const { scrubBeforeSend } = await freshImport();

    const item = {
      type: 'traces',
      payload: {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    name: 'HTTP GET',
                    attributes: [
                      {
                        key: 'http.url',
                        value: { stringValue: 'https://worker.dev/api/sessions?token=abc' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      meta: {},
    } as unknown as TransportItem;

    const scrubbed = scrubBeforeSend(item) as unknown as {
      payload: {
        resourceSpans: Array<{
          scopeSpans: Array<{
            spans: Array<{ attributes: Array<{ value: { stringValue: string } }> }>;
          }>;
        }>;
      };
    };

    expect(
      scrubbed.payload.resourceSpans[0].scopeSpans[0].spans[0].attributes[0].value.stringValue
    ).toBe('https://worker.dev/api/sessions');
  });

  it('redacts token-shaped values', async () => {
    vi.stubEnv('VITE_FARO_URL', '');
    const { scrubValue } = await freshImport();

    expect(scrubValue('key glc_eyJvIjoiMTIzNCJ9 leaked')).toBe('key [REDACTED] leaked');
    expect(scrubValue('token gho_abcDEF1234567890')).toBe('token [REDACTED]');
    expect(scrubValue('header Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig')).toBe(
      'header [REDACTED]'
    );
    expect(scrubValue('api-token=super-secret-value fetch failed')).toBe(
      'api-token=[REDACTED] fetch failed'
    );
  });

  it('leaves ordinary strings alone', async () => {
    vi.stubEnv('VITE_FARO_URL', '');
    const { scrubValue } = await freshImport();

    expect(scrubValue('What happened? Nothing.')).toBe('What happened? Nothing.');
    expect(scrubValue('https://app.valet.dev/sessions/abc')).toBe(
      'https://app.valet.dev/sessions/abc'
    );
  });
});

describe('getTracePropagationUrls', () => {
  it('derives a regex for the API origin from an absolute VITE_API_URL', async () => {
    vi.stubEnv('VITE_API_URL', 'https://worker.example.com/api');
    const { getTracePropagationUrls } = await freshImport();

    const urls = getTracePropagationUrls();
    expect(urls).toHaveLength(1);
    expect(urls[0].test('https://worker.example.com/api/sessions')).toBe(true);
    expect(urls[0].test('https://worker.example.com')).toBe(true);
    expect(urls[0].test('https://evil.example.com/api')).toBe(false);
    // Origin must end at a path boundary — suffix domains must not match.
    expect(urls[0].test('https://worker.example.com.evil.com/api')).toBe(false);
  });

  it('returns nothing for a relative API base (same-origin dev proxy)', async () => {
    vi.stubEnv('VITE_API_URL', '/api');
    const { getTracePropagationUrls } = await freshImport();

    expect(getTracePropagationUrls()).toHaveLength(0);
  });
});

describe('observeRouter', () => {
  it('does not subscribe when dark', async () => {
    vi.stubEnv('VITE_FARO_URL', '');
    const { observeRouter } = await freshImport();

    const subscribe = vi.fn();
    observeRouter({ subscribe });

    expect(subscribe).not.toHaveBeenCalled();
  });

  it('pushes route_change with from/to pathnames only', async () => {
    vi.stubEnv('VITE_FARO_URL', 'https://faro.example.com/collect');
    const { initFaro, observeRouter } = await freshImport();
    await initFaro();

    let listener:
      | ((event: {
          toLocation: { pathname: string };
          fromLocation?: { pathname: string };
          pathChanged: boolean;
        }) => void)
      | undefined;
    const subscribe = vi.fn((_event: 'onResolved', fn: typeof listener) => {
      listener = fn;
      return () => {};
    });

    observeRouter({ subscribe: subscribe as never });
    expect(subscribe).toHaveBeenCalledWith('onResolved', expect.any(Function));

    listener?.({
      toLocation: { pathname: '/sessions/sess-1' },
      fromLocation: { pathname: '/' },
      pathChanged: true,
    });

    expect(mocks.api.setView).toHaveBeenCalledWith({ name: '/sessions/sess-1' });
    expect(mocks.api.pushEvent).toHaveBeenCalledWith('route_change', {
      to: '/sessions/sess-1',
      from: '/',
    });

    // Initial load has no fromLocation — the event carries `to` only.
    mocks.api.pushEvent.mockClear();
    listener?.({
      toLocation: { pathname: '/' },
      fromLocation: undefined,
      pathChanged: false,
    });
    expect(mocks.api.pushEvent).toHaveBeenCalledWith('route_change', { to: '/' });

    // Search-param-only navigation is not a route change.
    mocks.api.pushEvent.mockClear();
    listener?.({
      toLocation: { pathname: '/sessions/sess-1' },
      fromLocation: { pathname: '/sessions/sess-1' },
      pathChanged: false,
    });
    expect(mocks.api.pushEvent).not.toHaveBeenCalled();
  });
});
