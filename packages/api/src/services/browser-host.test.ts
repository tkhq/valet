import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemorySessionStore, VirtualSandboxProvider, type BlobStore, type SandboxProvider } from '@valet/engine';
import { browserSessionHooks, prepareBrowserSandboxStop } from './browser-host.js';
import { freshTestPgDb } from '../test-helpers/pg-test-db.js';
import { pluginStore } from './plugin-store.js';

async function fixture() {
  const { appDb } = await freshTestPgDb();
  const store = pluginStore(appDb, 'browser');
  const sessions = new InMemorySessionStore();
  const now = Date.now();
  await sessions.saveSession({ id: 'session', owner: { type: 'user', id: 'owner' }, userId: 'owner', orgId: 'org', workspace: '/', purpose: 'interactive', status: 'running', createdAt: now, updatedAt: now });
  const base = new VirtualSandboxProvider();
  const sandbox = await base.create({ sessionId: 'session' });
  const commands: string[] = [];
  vi.spyOn(sandbox, 'exec').mockImplementation(async (command, opts) => {
    if (command.startsWith('test ')) return { exitCode: 0, stdout: '', stderr: '' };
    const request: unknown = JSON.parse(opts?.stdin ?? '{}');
    if (request && typeof request === 'object') commands.push(String(Reflect.get(request, 'command')));
    return { exitCode: 0, stdout: JSON.stringify({ protocolVersion: '1.0', runtimeId: 'runtime', ok: true, events: [], cursor: 0, gap: false, audit: [], auditTotal: 0 }), stderr: '' };
  });
  const data = new Map<string, Uint8Array>();
  const blobs: BlobStore = { put: async (key, bytes) => { data.set(key, bytes instanceof Uint8Array ? bytes : new Uint8Array(await new Response(bytes).arrayBuffer())); }, get: async (key) => { const bytes = data.get(key); return bytes ? { data: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) } : null; }, delete: async (key) => { data.delete(key); } };
  const provider: SandboxProvider = { backend: 'fixture', capabilities: () => ({ ...base.capabilities(), browserAutomation: true }), create: (opts) => base.create(opts), restore: async () => sandbox, status: async () => ({ id: sandbox.id, state: 'released' }), list: async () => [{ id: sandbox.id, sessionId: 'session', createdAtMs: now }], destroy: (id) => base.destroy(id) };
  return { store, sessions, sandbox, commands, blobs, data, provider };
}

describe('browser lifecycle persistence', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('retains cleanup without waking compute and drains it after host reconstruction', async () => {
    const f = await fixture();
    await browserSessionHooks('session', f.sessions, f.blobs, f.store).onTurnComplete?.({ sessionId: 'session', submissionId: 'submission', threadId: 'thread', actorId: 'actor', owner: { type: 'user', id: 'owner' } });
    expect(f.commands).toEqual([]);
    expect((await f.store.session('session').list('turn_cleanup')).items).toHaveLength(1);
    await browserSessionHooks('session', f.sessions, f.blobs, f.store).sandboxLifecycle?.afterReady?.(f.sandbox);
    expect(f.commands).toEqual(['turn_end']);
    expect((await f.store.session('session').list('turn_cleanup')).items).toHaveLength(0);
  });

  it('exports crashed retained audit through the provider before permitting deletion', async () => {
    const f = await fixture();
    const read = vi.fn(async () => ({ entries: [], total: 0 }));
    f.provider.readBrowserAudit = read;
    await prepareBrowserSandboxStop(f.provider, f.sandbox.id, 'destroy', f.sessions, f.blobs, f.store);
    expect(read).toHaveBeenCalledWith(f.sandbox.id);
    expect(f.data.size).toBe(1);
    expect(f.commands).toEqual([]);
  });

  it('fails closed when stopped state has neither a reader nor verified audit export', async () => {
    const f = await fixture();
    await expect(prepareBrowserSandboxStop(f.provider, f.sandbox.id, 'destroy', f.sessions, f.blobs, f.store)).rejects.toThrow('audit');
  });

  it('allows cold suspended deletion only while the export checkpoint remains valid', async () => {
    const f = await fixture();
    f.provider.status = async () => ({ id: f.sandbox.id, state: 'idle' });
    const hooks = browserSessionHooks('session', f.sessions, f.blobs, f.store);
    await hooks.sandboxLifecycle?.beforeStop(f.sandbox, 'suspend');
    await expect(prepareBrowserSandboxStop(f.provider, f.sandbox.id, 'destroy', f.sessions, f.blobs, f.store)).resolves.toBeUndefined();
    await hooks.sandboxLifecycle?.afterReady?.(f.sandbox);
    await expect(prepareBrowserSandboxStop(f.provider, f.sandbox.id, 'destroy', f.sessions, f.blobs, f.store)).rejects.toThrow('audit');
  });

  it('uses the saved export to delete a warm suspended sandbox without executing in a missing pod', async () => {
    const f = await fixture();
    const hooks = browserSessionHooks('session', f.sessions, f.blobs, f.store);
    await hooks.sandboxLifecycle?.beforeStop(f.sandbox, 'suspend');
    vi.spyOn(f.sandbox, 'exec').mockRejectedValue(new Error('pod is stopped'));
    await expect(hooks.sandboxLifecycle?.beforeStop(f.sandbox, 'destroy', { suspended: true })).resolves.toBeUndefined();
  });

  it('keeps retained browser audit checks when new browser allocations are disabled', async () => {
    const f = await fixture();
    f.provider.capabilities = () => ({ snapshot: 'none', persistentWorkspace: true, tunnels: false, warmPool: false, hibernation: false, customImage: false, coldStartEstimateMs: 0, browserAutomation: false });
    f.provider.list = async () => [{ id: f.sandbox.id, sessionId: 'session', createdAtMs: 0, browserEnabled: true }];
    await expect(prepareBrowserSandboxStop(f.provider, f.sandbox.id, 'destroy', f.sessions, f.blobs, f.store)).rejects.toThrow('audit');
  });

  it('skips audit checks for sandboxes recorded without browser state', async () => {
    const f = await fixture();
    f.provider.list = async () => [{ id: f.sandbox.id, sessionId: 'session', createdAtMs: 0, browserEnabled: false }];
    await expect(prepareBrowserSandboxStop(f.provider, f.sandbox.id, 'destroy', f.sessions, f.blobs, f.store)).resolves.toBeUndefined();
    expect(f.data.size).toBe(0);
  });
});
