import { describe, it, expect, vi } from "vitest";
import {
  SandboxAttachment,
  PolicySandbox,
  SandboxPreparationError,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxCreateOpts,
  type SandboxProvider,
  type SandboxStatus,
} from "../src/index.js";

// ── Fakes ────────────────────────────────────────────────────────────

function makeFakeSandbox(id: string): Sandbox {
  return {
    id,
    readFile: vi.fn(async (_path: string) => "content"),
    readBinary: vi.fn(async (_path: string) => new Uint8Array([1, 2, 3])),
    writeFile: vi.fn(async (_path: string, _content: string) => {}),
    writeBinary: vi.fn(async (_path: string, _data: Uint8Array) => {}),
    readdir: vi.fn(async (_path: string) => [] as string[]),
    stat: vi.fn(async (_path: string) => ({ isFile: true, isDirectory: false, size: 0 })),
    mkdir: vi.fn(async (_path: string) => {}),
    rm: vi.fn(async (_path: string) => {}),
    exec: vi.fn(async (_command: string) => ({ stdout: "", stderr: "", exitCode: 0 })),
  };
}

/** A sandbox whose files map is honored by readFile/writeFile — used to pin
 * prep→waiter ordering via a marker the prep writes and the waiter reads. */
function makeStatefulSandbox(id: string): Sandbox {
  const files = new Map<string, string>();
  return {
    ...makeFakeSandbox(id),
    writeFile: vi.fn(async (path: string, content: string) => {
      files.set(path, content);
    }),
    readFile: vi.fn(async (path: string) => {
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return v;
    }),
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeProvider implements SandboxProvider {
  readonly backend = "fake";
  createCalls = 0;
  destroyCalls: string[] = [];
  private pending: Array<Deferred<Sandbox>> = [];
  private caps: SandboxCapabilities = {
    snapshot: "none",
    persistentWorkspace: false,
    tunnels: false,
    warmPool: false,
    hibernation: false,
    customImage: false,
    coldStartEstimateMs: 5000,
  };

  capabilities(): SandboxCapabilities {
    return this.caps;
  }

  nextDeferred(): Deferred<Sandbox> {
    const d = defer<Sandbox>();
    this.pending.push(d);
    return d;
  }

  async create(_opts: SandboxCreateOpts): Promise<Sandbox> {
    this.createCalls++;
    const d = this.pending.shift();
    if (!d) return makeFakeSandbox(`fake-auto`);
    return d.promise;
  }

  async restore(id: string): Promise<Sandbox> {
    return makeFakeSandbox(id);
  }

  async destroy(id: string): Promise<void> {
    this.destroyCalls.push(id);
  }

  async status(id: string): Promise<SandboxStatus> {
    return { id, state: "ready" };
  }
}

describe("SandboxAttachment prepareSandbox seam", () => {
  it("absent hook: provision path is unchanged — ready at epoch 1, no prep", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 5000 });

    provider.nextDeferred().resolve(makeFakeSandbox("sb-1"));
    await expect(wrapper.readFile("/x.txt")).resolves.toBe("content");
    expect(attachment.state).toBe("ready");
    expect(attachment.currentEpoch()).toBe(1);
  });

  it("prep runs exactly once, with the live sandbox + epoch, before any waiter resolves", async () => {
    const provider = new FakeProvider();
    const sb = makeFakeSandbox("sb-1");
    const prepareSandbox = vi.fn(async (_sandbox: Sandbox, _epoch: number) => {});
    const attachment = new SandboxAttachment(provider, {}, prepareSandbox);
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 5000 });

    provider.nextDeferred().resolve(sb);
    await wrapper.readFile("/x.txt");

    expect(prepareSandbox).toHaveBeenCalledTimes(1);
    expect(prepareSandbox).toHaveBeenCalledWith(sb, 1);
  });

  it("ordering pin: a marker prep writes is visible to the first waiter's read", async () => {
    const provider = new FakeProvider();
    const sb = makeStatefulSandbox("sb-1");
    const prepareSandbox = vi.fn(async (sandbox: Sandbox, _epoch: number) => {
      await sandbox.writeFile("/prep-marker", "prepped");
    });
    const attachment = new SandboxAttachment(provider, {}, prepareSandbox);
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 5000 });

    provider.nextDeferred().resolve(sb);
    // If prep had not completed before this read is dispatched, the marker
    // would be missing and readFile would throw ENOENT.
    await expect(wrapper.readFile("/prep-marker")).resolves.toBe("prepped");
  });

  it("no waiter observes the sandbox mid-prep: current() is null while prep runs", async () => {
    const provider = new FakeProvider();
    const prepGate = defer<void>();
    const prepareSandbox = vi.fn(async (_sandbox: Sandbox, _epoch: number) => {
      await prepGate.promise;
    });
    const attachment = new SandboxAttachment(provider, {}, prepareSandbox);
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 5000 });

    provider.nextDeferred().resolve(makeFakeSandbox("sb-1"));
    const op = wrapper.readFile("/x.txt");
    // Let create() resolve and prep begin.
    await new Promise((r) => setTimeout(r, 20));
    expect(attachment.current()).toBeNull();
    expect(attachment.state).toBe("provisioning");

    prepGate.resolve();
    await expect(op).resolves.toBe("content");
    expect(attachment.state).toBe("ready");
  });

  it("prep rejection: waiters reject with `sandbox preparation failed: …`, attachment -> error, no leak", async () => {
    const provider = new FakeProvider();
    // huge timeout so a fast rejection proves the fail path, not the timeout
    const attachment = new SandboxAttachment(provider, {}, async () => {
      throw new Error("clone failed");
    });
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 60_000 });

    provider.nextDeferred().resolve(makeFakeSandbox("sb-1"));
    const start = Date.now();
    await expect(wrapper.readFile("/x.txt")).rejects.toThrow("sandbox preparation failed: clone failed");
    expect(Date.now() - start).toBeLessThan(1000);
    expect(attachment.state).toBe("error");
    // The unprepped sandbox must not leak.
    expect(provider.destroyCalls).toContain("sb-1");
  });

  it("prep rejection surfaces a SandboxPreparationError instance", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {}, async () => {
      throw new Error("boom");
    });
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 60_000 });
    provider.nextDeferred().resolve(makeFakeSandbox("sb-1"));
    await expect(wrapper.readFile("/x.txt")).rejects.toBeInstanceOf(SandboxPreparationError);
  });

  it("re-provision after prep failure re-runs prep and can succeed", async () => {
    const provider = new FakeProvider();
    let calls = 0;
    const prepareSandbox = vi.fn(async (_sandbox: Sandbox, _epoch: number) => {
      calls++;
      if (calls === 1) throw new Error("first attempt failed");
    });
    const attachment = new SandboxAttachment(provider, {}, prepareSandbox);
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 60_000 });

    provider.nextDeferred().resolve(makeFakeSandbox("sb-1"));
    await expect(wrapper.readFile("/x.txt")).rejects.toThrow("sandbox preparation failed");
    expect(attachment.state).toBe("error");

    provider.nextDeferred().resolve(makeFakeSandbox("sb-2"));
    await expect(wrapper.readFile("/y.txt")).resolves.toBe("content");
    expect(attachment.state).toBe("ready");
    expect(prepareSandbox).toHaveBeenCalledTimes(2);
  });

  it("destroy during prep: the created sandbox is torn down and no waiter is left with a handle", async () => {
    const provider = new FakeProvider();
    const prepGate = defer<void>();
    const attachment = new SandboxAttachment(provider, {}, async () => {
      await prepGate.promise;
    });
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 5000 });

    provider.nextDeferred().resolve(makeFakeSandbox("sb-1"));
    const op = wrapper.readFile("/x.txt").catch((e) => e);
    await new Promise((r) => setTimeout(r, 20)); // let prep begin
    await attachment.destroy();
    prepGate.resolve();

    const result = await op;
    expect(result).toBeInstanceOf(Error);
    expect(attachment.state).toBe("released");
    expect(provider.destroyCalls).toContain("sb-1");
  });
});
