import { describe, expect, it } from 'vitest';
import type { Env } from '../env.js';
import { runDeepHealthProbe } from './health.js';

// Minimal env stub — each dependency is a thenable-returning fake we can make
// resolve or reject per test. Only the three fields runDeepHealthProbe reads
// are provided.
function makeEnv(opts: {
  d1?: () => Promise<unknown>;
  r2?: () => Promise<unknown>;
  eventbus?: () => Promise<unknown>;
}): Pick<Env, 'DB' | 'STORAGE' | 'EVENT_BUS'> {
  const d1 = opts.d1 ?? (() => Promise.resolve({ 1: 1 }));
  const r2 = opts.r2 ?? (() => Promise.resolve({ objects: [] }));
  const eventbus = opts.eventbus ?? (() => Promise.resolve(new Response('{"connected":0}')));
  return {
    DB: { prepare: () => ({ first: d1 }) } as unknown as Env['DB'],
    STORAGE: { list: r2 } as unknown as Env['STORAGE'],
    EVENT_BUS: {
      idFromName: () => 'id',
      get: () => ({ fetch: eventbus }),
    } as unknown as Env['EVENT_BUS'],
  };
}

describe('runDeepHealthProbe', () => {
  it('reports ok when every dependency resolves', async () => {
    const result = await runDeepHealthProbe(makeEnv({}));
    expect(result.status).toBe('ok');
    expect(result.checks.d1.ok).toBe(true);
    expect(result.checks.r2.ok).toBe(true);
    expect(result.checks.eventbus.ok).toBe(true);
    expect(typeof result.checks.d1.ms).toBe('number');
  });

  it('degrades and pinpoints the failing dependency', async () => {
    const result = await runDeepHealthProbe(
      makeEnv({ r2: () => Promise.reject(new Error('bucket unreachable')) }),
    );
    expect(result.status).toBe('degraded');
    expect(result.checks.d1.ok).toBe(true);
    expect(result.checks.r2.ok).toBe(false);
    expect(result.checks.eventbus.ok).toBe(true);
  });

  it('degrades when a dependency hangs past the timeout', async () => {
    const result = await runDeepHealthProbe(
      // Never resolves — the internal 2s race must trip and mark it down.
      makeEnv({ eventbus: () => new Promise(() => {}) }),
    );
    expect(result.status).toBe('degraded');
    expect(result.checks.eventbus.ok).toBe(false);
  }, 4000);
});
