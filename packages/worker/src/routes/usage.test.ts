import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';

const mocks = vi.hoisted(() => ({
  hero: vi.fn(), day: vi.fn(), user: vi.fn(), model: vi.fn(), userModel: vi.fn(),
  purpose: vi.fn(), workflow: vi.fn(), sandboxHero: vi.fn(), sandboxDay: vi.fn(), sandboxUser: vi.fn(),
}));

vi.mock('../lib/db/analytics.js', () => ({
  getUsageHeroStats: mocks.hero,
  getUsageByDay: mocks.day,
  getUsageByUser: mocks.user,
  getUsageByModel: mocks.model,
  getUsageByUserModel: mocks.userModel,
  getUsageByPurposeModel: mocks.purpose,
  getUsageByWorkflowModel: mocks.workflow,
  getSandboxHeroStats: mocks.sandboxHero,
  getSandboxByDay: mocks.sandboxDay,
  getSandboxByUser: mocks.sandboxUser,
  billableInputTokens: (row: { inputTokens: number }) => row.inputTokens,
  billableOutputTokens: (row: { outputTokens: number }) => row.outputTokens,
}));
vi.mock('../services/model-catalog.js', () => ({ getModelPricing: vi.fn().mockResolvedValue(new Map()), computeCost: vi.fn(() => null) }));
vi.mock('../lib/drizzle.js', () => ({ getDb: vi.fn(() => ({})) }));

import { usageRouter } from './usage.js';

function app(role: 'admin' | 'member' = 'admin') {
  const instance = new Hono<{ Bindings: Env; Variables: Variables }>();
  instance.use('*', async (c, next) => {
    c.set('user', { id: 'u1', email: 'u1@example.com', role });
    await next();
  });
  instance.route('/', usageRouter);
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hero.mockResolvedValue({ totalInputTokens: 0, totalOutputTokens: 0, totalSessions: 0, totalUsers: 0 });
  mocks.day.mockResolvedValue([]); mocks.user.mockResolvedValue([]); mocks.model.mockResolvedValue([]);
  mocks.userModel.mockResolvedValue([]); mocks.purpose.mockResolvedValue([]); mocks.workflow.mockResolvedValue([]);
  mocks.sandboxHero.mockResolvedValue({ totalActiveSeconds: 0 }); mocks.sandboxDay.mockResolvedValue([]); mocks.sandboxUser.mockResolvedValue([]);
});

describe('usage report API', () => {
  it('passes the exact month and personal scope to every aggregate', async () => {
    const response = await app('member').request('/stats?scope=personal&periodType=month&month=2024-02', {}, { DB: {} } as Env);
    expect(response.status).toBe(200);
    expect(mocks.hero).toHaveBeenCalledWith({}, '2024-02-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z', 'u1');
    expect(mocks.workflow).toHaveBeenCalledWith({}, '2024-02-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z', 'u1');
    const body = await response.json() as { report: { scope: string; boundary: string } };
    expect(body.report).toMatchObject({ scope: 'personal', boundary: 'start-inclusive/end-exclusive' });
  });

  it('preserves org authorization and rejects unenforceable team scope', async () => {
    expect((await app('member').request('/stats?scope=org&period=24', {}, { DB: {} } as Env)).status).toBe(403);
    expect((await app('admin').request('/stats?scope=org&period=24', {}, { DB: {} } as Env)).status).toBe(200);
    expect((await app('admin').request('/stats?scope=team&period=24', {}, { DB: {} } as Env)).status).toBe(400);
  });

  it('keeps assembled sandbox-only daily totals consistent in CSV exports', async () => {
    mocks.sandboxHero.mockResolvedValue({ totalActiveSeconds: 30 });
    mocks.sandboxDay.mockResolvedValue([{ date: '2024-02-29', activeSeconds: 30 }]);

    const response = await app().request('/export.csv?scope=org&periodType=month&month=2024-02', {}, { DB: {} } as Env);
    const dayRow = (await response.text()).split('\n').find((line) => line.includes('"day","2024-02-29"'));

    expect(dayRow).toContain('"0.0019755","","","0.0019755","30"');
  });

  it('returns deterministic validation and empty CSV output', async () => {
    expect((await app().request('/stats?periodType=range&start=2024-02-02&end=2024-02-01', {}, { DB: {} } as Env)).status).toBe(400);
    const csv = await app().request('/export.csv?scope=org&periodType=month&month=2024-02', {}, { DB: {} } as Env);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toBe('attachment; filename="valet-usage-org-calendar-month_2024-02_UTC.csv"');
    expect(await csv.text()).toContain('"total","all"');
    const rolling = await app().request('/export.csv?scope=org&period=24&asOf=2024-03-15T12%3A30%3A00.000Z', {}, { DB: {} } as Env);
    expect(rolling.headers.get('content-disposition')).not.toContain(':');
  });
});
