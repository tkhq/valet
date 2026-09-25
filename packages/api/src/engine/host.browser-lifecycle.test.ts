import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualSandbox, VirtualSandboxProvider, type Sandbox, type SandboxProvider } from '@valet/engine';
import { bootTestApi, type TestApi } from '../integration/_setup.js';

describe('EngineHost browser teardown races', () => {
  let api: TestApi | undefined;
  afterEach(async () => { await api?.cleanup(); api = undefined; });

  it.each(['replace', 'failure', 'audit-retry'] as const)('waits for %s release and deletes retained browser state', async (action) => {
    const records = new Map<string, { sandbox: Sandbox; sessionId: string; released: boolean }>();
    const base = new VirtualSandboxProvider();
    const calls: string[] = [];
    let failAudit = action === 'audit-retry';
    let finishRelease: (() => void) | undefined;
    const releasing = new Promise<void>((resolve) => { finishRelease = resolve; });
    const provider: SandboxProvider = {
      backend: 'fixture', capabilities: () => ({ ...base.capabilities(), browserAutomation: true }),
      create: async (opts) => {
        calls.push('create');
        const sandbox = new VirtualSandbox(`sandbox-${calls.length}`);
        vi.spyOn(sandbox, 'exec').mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
        records.set(sandbox.id, { sandbox, sessionId: opts.sessionId ?? '', released: false });
        return sandbox;
      },
      restore: async (id) => {
        const row = records.get(id);
        if (!row) throw new Error('Missing fixture sandbox.');
        return row.sandbox;
      },
      status: async (id) => ({ id, state: records.get(id)?.released ? 'released' : 'ready' }),
      list: async () => [...records].map(([id, row]) => ({ id, sessionId: row.sessionId, createdAtMs: 0, browserEnabled: true })),
      release: async (id) => {
        calls.push('release');
        await releasing;
        const row = records.get(id);
        if (row) row.released = true;
        calls.push('released');
      },
      readBrowserAudit: async () => {
        calls.push('audit');
        if (failAudit) throw new Error('Audit unavailable. Restore audit storage before deleting the sandbox.');
        return { entries: [], total: 0 };
      },
      destroy: async (id) => { calls.push('destroy'); records.delete(id); },
    };
    api = await bootTestApi({ sandboxProvider: provider });
    const { engineHost, engineStore } = api.providers;
    const session = await engineHost.sessionFor(`race-${action}`, { userId: 'local-user', orgId: 'local-org', workspace: `/tmp/race-${action}` });
    await session.attachment.ensureReady({ timeoutMs: 1000 });
    const replacement = action === 'replace' ? session.attachment.replace() : undefined;
    if (action !== 'replace') session.attachment.reportFailure(session.attachment.currentEpoch(), new Error('lost execution'));
    await vi.waitFor(() => expect(calls).toContain('release'));
    let deleted = false;
    const deleting = engineHost.destroy(session.id).then(() => { deleted = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(deleted).toBe(false);
      expect(await engineStore.getSession(session.id)).not.toBeNull();
      finishRelease?.();
      if (action === 'audit-retry') {
        await expect(deleting).rejects.toThrow('Audit unavailable');
        expect(await engineStore.getSession(session.id)).not.toBeNull();
        expect(records.size).toBe(1);
        failAudit = false;
        await engineHost.destroy(session.id);
      } else await deleting;
      await replacement;
      expect(records.size).toBe(0);
      expect(calls.filter((call) => call === 'create')).toHaveLength(1);
      expect(calls.indexOf('destroy')).toBeGreaterThan(calls.indexOf('released'));
      if (action !== 'replace') expect(calls).toContain('audit');
      expect(await engineStore.getSession(session.id)).toBeNull();
    } finally {
      finishRelease?.();
      await Promise.allSettled([deleting, replacement]);
    }
  });
});
