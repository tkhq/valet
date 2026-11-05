import { describe, expect, it, vi } from 'vitest';
import { SandboxAttachment, VirtualSandboxProvider, type SandboxProvider } from '../src/index.js';

describe('sandbox lifecycle callbacks', () => {
  it('retries failed ready cleanup on the same sandbox before exposing it', async () => {
    const provider = new VirtualSandboxProvider();
    const create = vi.spyOn(provider, 'create');
    const ready = vi.fn().mockRejectedValueOnce(new Error('cleanup unavailable')).mockResolvedValue(undefined);
    const attachment = new SandboxAttachment(provider, {}, undefined, { beforeStop: async () => {}, afterReady: ready });
    await expect(attachment.ensureReady({ timeoutMs: 20 })).rejects.toThrow();
    expect(attachment.current()).toBeNull();
    await attachment.ensureReady({ timeoutMs: 1000 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledTimes(2);
    expect(ready.mock.calls[0]?.[0]).toBe(ready.mock.calls[1]?.[0]);
  });

  it('does not publish ready after destruction interrupts cleanup', async () => {
    const provider = new VirtualSandboxProvider();
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const ready = vi.fn(async () => pending);
    const attachment = new SandboxAttachment(provider, {}, undefined, { beforeStop: async () => {}, afterReady: ready });
    const acquisition = attachment.ensureReady({ timeoutMs: 1000 }).catch(() => undefined);
    await vi.waitFor(() => expect(ready).toHaveBeenCalled());
    await attachment.destroy();
    release?.();
    await acquisition;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attachment.state).toBe('released');
  });

  it('awaits old execution release before creating its replacement', async () => {
    const base = new VirtualSandboxProvider();
    const calls: string[] = [];
    let finishRelease: (() => void) | undefined;
    const releasing = new Promise<void>((resolve) => { finishRelease = resolve; });
    const provider: SandboxProvider = { backend: 'fixture', capabilities: () => base.capabilities(), create: async (opts) => { calls.push('create'); return base.create(opts); }, restore: (id) => base.restore(id), status: (id) => base.status(id), destroy: (id) => base.destroy(id), release: async () => { calls.push('release'); await releasing; calls.push('released'); } };
    const attachment = new SandboxAttachment(provider, {});
    await attachment.ensureReady({ timeoutMs: 1000 });
    const replacing = attachment.replace();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(['create', 'release']);
    finishRelease?.();
    await replacing;
    expect(calls).toEqual(['create', 'release', 'released', 'create']);
  });

  it('retries failed release before provisioning a replacement', async () => {
    const provider = new VirtualSandboxProvider();
    const create = vi.spyOn(provider, 'create');
    const release = vi.fn().mockRejectedValueOnce(new Error('release unavailable')).mockResolvedValue(undefined);
    const attachment = new SandboxAttachment({ backend: 'fixture', capabilities: () => provider.capabilities(), create: (opts) => provider.create(opts), restore: (id) => provider.restore(id), status: (id) => provider.status(id), destroy: (id) => provider.destroy(id), release }, {});
    await attachment.ensureReady({ timeoutMs: 1000 });
    await expect(attachment.replace()).rejects.toThrow('release unavailable');
    expect(create).toHaveBeenCalledTimes(1);
    await attachment.ensureReady({ timeoutMs: 1000 });
    expect(release).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('flushes before suspension and blocks suspension when flush fails', async () => {
    const calls: string[] = [];
    const base = new VirtualSandboxProvider();
    const provider: SandboxProvider = { backend: 'fixture', capabilities: () => ({ ...base.capabilities(), hibernation: true }), create: (opts) => base.create(opts), restore: (id) => base.restore(id), status: (id) => base.status(id), destroy: (id) => base.destroy(id), suspend: async () => { calls.push('suspend'); } };
    const attachment = new SandboxAttachment(provider, {}, undefined, { beforeStop: async (_sandbox, reason) => { calls.push(reason); throw new Error('flush failed'); } });
    await attachment.ensureReady({ timeoutMs: 1000 });
    await expect(attachment.suspend()).rejects.toThrow('flush failed');
    expect(calls).toEqual(['suspend']);
    expect(attachment.state).toBe('ready');
  });
  it('keeps a sandbox when its audit export fails, then permits a retry', async () => {
    const base = new VirtualSandboxProvider();
    let fail = true;
    const attachment = new SandboxAttachment(base, {}, undefined, { beforeStop: async () => { if (fail) throw new Error('audit export failed'); } });
    await attachment.ensureReady({ timeoutMs: 1000 });
    await expect(attachment.destroy()).rejects.toThrow('audit export failed');
    expect(attachment.state).toBe('ready');
    fail = false;
    await expect(attachment.destroy()).resolves.toBe(true);
    expect(attachment.state).toBe('released');
  });
});
