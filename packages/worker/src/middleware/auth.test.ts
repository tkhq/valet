import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { extractBearerToken } from '../lib/ws-auth';
import { errorHandler } from './error-handler.js';
import { authMiddleware } from './auth.js';

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('requestId', 'req-test');
    await next();
  });
  app.use('/api/*', authMiddleware);
  app.get('/api/sessions/:id/runner-attachment', (c) => c.text('ok'));
  app.get('/api/sessions/:id/messages', (c) => c.text('ok'));
  return app;
}

interface DbStub {
  prepare: (sql: string) => {
    bind: (...args: unknown[]) => {
      first: <T>() => Promise<T | null>;
      run: () => Promise<void>;
    };
  };
}

function stubDb(row: Record<string, unknown> | null, capturedWrites?: string[]): DbStub {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async <T>() => (row as T) ?? null,
        run: async () => {
          capturedWrites?.push(sql);
        },
      }),
    }),
  };
}

describe('extractBearerToken', () => {
  it('reads Authorization bearer token', () => {
    const req = new Request('https://example.com/api/sessions/1/ws?role=client', {
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(extractBearerToken(req)).toBe('secret-token');
  });

  it('reads websocket token from Sec-WebSocket-Protocol', () => {
    const req = new Request('https://example.com/api/sessions/1/ws?role=client', {
      headers: { 'Sec-WebSocket-Protocol': 'valet, bearer.ws-token-123' },
    });
    expect(extractBearerToken(req)).toBe('ws-token-123');
  });

  it('ignores token in query params', () => {
    const req = new Request('https://example.com/api/sessions/1/ws?role=client&token=legacy-token');
    expect(extractBearerToken(req)).toBeNull();
  });
});

describe('authMiddleware', () => {
  it('lets runner attachment fetches reach the DO for token validation', async () => {
    const app = buildApp();

    const res = await app.fetch(
      new Request('http://localhost/api/sessions/session-1/runner-attachment?messageId=msg-1&index=0&token=runner-token'),
      { DB: { prepare: () => ({ bind: () => ({ first: () => null }) }) } } as any,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('still requires user authentication for ordinary session APIs', async () => {
    const app = buildApp();

    const res = await app.fetch(
      new Request('http://localhost/api/sessions/session-1/messages'),
      { DB: stubDb(null) } as any,
    );

    expect(res.status).toBe(401);
  });

  it('returns AUTH_MISSING code when no bearer token is provided', async () => {
    const app = buildApp();

    const res = await app.fetch(
      new Request('http://localhost/api/sessions/session-1/messages'),
      { DB: stubDb(null) } as any,
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('AUTH_MISSING');
  });

  it('returns AUTH_INVALID code when a bearer token is present but unknown', async () => {
    const app = buildApp();

    const res = await app.fetch(
      new Request('http://localhost/api/sessions/session-1/messages', {
        headers: { Authorization: 'Bearer bogus-token' },
      }),
      { DB: stubDb(null) } as any,
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('AUTH_INVALID');
  });

  it('extends expires_at on every authenticated request (sliding window)', async () => {
    const app = buildApp();
    const writes: string[] = [];

    const db: DbStub = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async <T>() =>
            (sql.includes('FROM auth_sessions')
              ? { id: 'user-1', email: 'u@example.com', role: 'member' }
              : null) as T | null,
          run: async () => {
            writes.push(sql);
          },
        }),
      }),
    };

    const res = await app.fetch(
      new Request('http://localhost/api/sessions/session-1/messages', {
        headers: { Authorization: 'Bearer valid-token' },
      }),
      { DB: db } as any,
    );

    expect(res.status).toBe(200);

    // The middleware fires the UPDATE fire-and-forget; wait a tick for it.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const slidingUpdate = writes.find((sql) => sql.includes('UPDATE auth_sessions'));
    expect(slidingUpdate).toBeDefined();
    expect(slidingUpdate).toContain('expires_at');
    expect(slidingUpdate).toContain("datetime('now', '+30 days')");
  });
});
