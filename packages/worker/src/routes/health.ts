import type { Env } from '../env.js';

export interface DependencyCheck {
  ok: boolean;
  ms: number;
}

export interface DeepHealthResult {
  status: 'ok' | 'degraded';
  checks: {
    d1: DependencyCheck;
    r2: DependencyCheck;
    eventbus: DependencyCheck;
  };
}

const PROBE_TIMEOUT_MS = 2000;

async function probe(fn: () => Promise<unknown>): Promise<DependencyCheck> {
  const start = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS)),
    ]);
    return { ok: true, ms: Date.now() - start };
  } catch {
    return { ok: false, ms: Date.now() - start };
  }
}

/**
 * Exercise the critical backing dependencies (D1, R2, EventBus DO) so an
 * external canary can distinguish "worker up" from "worker up but a store is
 * unreachable". Each probe is time-boxed; a hung dependency reports ok:false
 * rather than hanging the request. Exposes only a per-check ok flag + latency.
 */
export async function runDeepHealthProbe(
  env: Pick<Env, 'DB' | 'STORAGE' | 'EVENT_BUS'>,
): Promise<DeepHealthResult> {
  const [d1, r2, eventbus] = await Promise.all([
    probe(() => env.DB.prepare('SELECT 1').first()),
    probe(() => env.STORAGE.list({ limit: 1 })),
    probe(() => env.EVENT_BUS.get(env.EVENT_BUS.idFromName('health')).fetch('https://do/health')),
  ]);

  const checks = { d1, r2, eventbus };
  const status = d1.ok && r2.ok && eventbus.ok ? 'ok' : 'degraded';
  return { status, checks };
}
