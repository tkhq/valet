import { describe, expect, it, vi } from 'vitest';
import { PolicySandbox, SandboxAttachment, VirtualSandboxProvider, type SandboxCommandChannelOptions, type SandboxProvider } from '../src/index.js';

async function fixture() {
  const base = new VirtualSandboxProvider();
  const sandbox = await base.create({});
  let callbacks: SandboxCommandChannelOptions | undefined;
  const raw = { write: vi.fn(async (_data: string) => {}), close: vi.fn() };
  sandbox.openCommandChannel = vi.fn(async (_command, options) => { callbacks = options; return raw; });
  const provider: SandboxProvider = { backend: 'test', capabilities: () => ({ ...base.capabilities(), hibernation: true }), create: async () => sandbox, restore: async () => sandbox, status: (id) => base.status(id), destroy: async () => {}, release: async () => {}, suspend: async () => {} };
  const attachment = new SandboxAttachment(provider, {});
  const policy = new PolicySandbox(attachment);
  await attachment.ensureReady({ timeoutMs: 1000 });
  return { sandbox, attachment, policy, raw, callbacks: () => { if (!callbacks) throw new Error('Expected channel callbacks.'); return callbacks; } };
}

describe('policy command channels', () => {
  it('does not provision a nonready attachment when opening a channel', async () => {
    const provider = new VirtualSandboxProvider();
    const create = vi.spyOn(provider, 'create');
    const attachment = new SandboxAttachment(provider, {});
    const policy = new PolicySandbox(attachment);
    await expect(policy.openCommandChannel('client', { waitForReady: false, onData: vi.fn(), onClose: vi.fn() })).rejects.toThrow(/ready|unavailable/);
    expect(create).not.toHaveBeenCalled();
    expect(attachment.state).toBe('detached');
  });

  it('awaits a cold attachment for authorized work', async () => {
    const base = new VirtualSandboxProvider();
    const sandbox = await base.create({});
    const raw = { write: vi.fn(async (_data: string) => {}), close: vi.fn() };
    sandbox.openCommandChannel = async () => raw;
    const create = vi.fn(async () => sandbox);
    const provider: SandboxProvider = {
      backend: 'cold-test', capabilities: () => base.capabilities(), create,
      restore: (id) => base.restore(id), status: (id) => base.status(id), destroy: (id) => base.destroy(id),
    };
    const policy = new PolicySandbox(new SandboxAttachment(provider, {}));
    const channel = await policy.openCommandChannel('client', { onData: vi.fn(), onClose: vi.fn() });
    await channel?.write('request');
    expect(create).toHaveBeenCalledOnce();
    expect(raw.write).toHaveBeenCalledWith('request');
    channel?.close();
  });

  it('returns null for an unsupported provider without executing a command', async () => {
    const base = new VirtualSandboxProvider();
    const sandbox = await base.create({});
    const exec = vi.spyOn(sandbox, 'exec');
    const policy = new PolicySandbox(SandboxAttachment.forSandbox(sandbox));
    expect(typeof policy.openCommandChannel).toBe('function');
    expect(await policy.openCommandChannel('client', { onData: vi.fn(), onClose: vi.fn() })).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(['replace', 'suspend', 'destroy'] as const)('closes on %s and rejects stale writes and data', async (action) => {
    const f = await fixture();
    const onData = vi.fn(); const onClose = vi.fn();
    expect(typeof f.policy.openCommandChannel).toBe('function');
    const channel = await f.policy.openCommandChannel('client', { onData, onClose, privileged: true });
    expect(channel).not.toBeNull();
    await channel?.write('request');
    f.callbacks().onData('current');
    await f.attachment[action]();
    f.callbacks().onData('stale');
    await expect(channel?.write('later')).rejects.toThrow();
    expect(onData.mock.calls).toEqual([['current']]);
    expect(f.raw.close).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(f.raw.write).toHaveBeenCalledTimes(1);
    if (action !== 'replace') {
      await expect(f.policy.openCommandChannel('later', { waitForReady: false, onData, onClose })).rejects.toThrow(/ready|unavailable/);
      expect(f.sandbox.openCommandChannel).toHaveBeenCalledTimes(1);
    }
  });

  it('closes a channel returned after replacement during startup', async () => {
    const f = await fixture();
    let finish: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => { finish = resolve; });
    f.sandbox.openCommandChannel = async () => { await barrier; return f.raw; };
    await f.attachment.ensureReady({ timeoutMs: 1000 });
    const onClose = vi.fn();
    const opening = f.policy.openCommandChannel('client', { onData: vi.fn(), onClose });
    await Promise.resolve();
    await f.attachment.replace();
    finish?.();
    await expect(opening).rejects.toThrow();
    expect(f.raw.close).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
