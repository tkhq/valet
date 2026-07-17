import { describe, it, expect } from "vitest";
import {
  SandboxAttachment,
  SandboxStartupError,
  type AttachmentStatus,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxCreateOpts,
  type SandboxProvider,
  type SandboxStatus,
} from "../src/index.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeFakeSandbox(id: string): Sandbox {
  return {
    id,
    readFile: async () => "content",
    readBinary: async () => new Uint8Array([1, 2, 3]),
    writeFile: async () => {},
    writeBinary: async () => {},
    readdir: async () => [],
    stat: async () => ({ isFile: true, isDirectory: false, size: 0 }),
    mkdir: async () => {},
    rm: async () => {},
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
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

/** Provider that implements the hibernation seam. suspend/resume record their
 * calls and delegate to overridable impls so a test can script a rejection. */
class HibernatingProvider implements SandboxProvider {
  readonly backend = "fake-hib";
  suspendCalls: string[] = [];
  resumeCalls: string[] = [];
  createCalls = 0;
  suspendImpl: (id: string) => Promise<void> = async () => {};
  resumeImpl: (id: string) => Promise<void> = async () => {};
  private pending: Array<Deferred<Sandbox>> = [];
  private nextId = 1;

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: true,
      tunnels: false,
      warmPool: false,
      hibernation: true,
      coldStartEstimateMs: 5000,
    };
  }

  nextDeferred(): Deferred<Sandbox> {
    const d = defer<Sandbox>();
    this.pending.push(d);
    return d;
  }

  async create(_opts: SandboxCreateOpts): Promise<Sandbox> {
    this.createCalls++;
    const d = this.pending.shift();
    if (!d) return makeFakeSandbox(`sb-${this.nextId++}`);
    return d.promise;
  }

  async restore(id: string): Promise<Sandbox> {
    return makeFakeSandbox(id);
  }

  async destroy(_id: string): Promise<void> {}

  async status(id: string): Promise<SandboxStatus> {
    return { id, state: "ready" };
  }

  async suspend(id: string): Promise<void> {
    this.suspendCalls.push(id);
    return this.suspendImpl(id);
  }

  async resume(id: string): Promise<void> {
    this.resumeCalls.push(id);
    return this.resumeImpl(id);
  }
}

/** A provider WITHOUT the suspend/resume seam (hibernation off). */
class PlainProvider implements SandboxProvider {
  readonly backend = "fake-plain";
  private pending: Array<Deferred<Sandbox>> = [];
  private nextId = 1;

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: false,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      coldStartEstimateMs: 5000,
    };
  }

  nextDeferred(): Deferred<Sandbox> {
    const d = defer<Sandbox>();
    this.pending.push(d);
    return d;
  }

  async create(_opts: SandboxCreateOpts): Promise<Sandbox> {
    const d = this.pending.shift();
    if (!d) return makeFakeSandbox(`sb-${this.nextId++}`);
    return d.promise;
  }
  async restore(id: string): Promise<Sandbox> {
    return makeFakeSandbox(id);
  }
  async destroy(_id: string): Promise<void> {}
  async status(id: string): Promise<SandboxStatus> {
    return { id, state: "ready" };
  }
}

function collectStatuses(attachment: SandboxAttachment): AttachmentStatus[] {
  const seen: AttachmentStatus[] = [];
  attachment.onStatus((s) => seen.push(s));
  return seen;
}

async function reachReady(
  provider: HibernatingProvider | PlainProvider,
  id = "sb-1",
): Promise<SandboxAttachment> {
  const att = new SandboxAttachment(provider, {});
  const d = provider.nextDeferred();
  const rp = att.ensureReady({ timeoutMs: 5000 });
  d.resolve(makeFakeSandbox(id));
  await rp;
  return att;
}

async function reachSuspended(provider: HibernatingProvider, id = "sb-1"): Promise<SandboxAttachment> {
  const att = await reachReady(provider, id);
  await att.suspend();
  return att;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("SandboxAttachment hibernation", () => {
  it("ready → suspend(): calls provider.suspend once, state suspended, current() null, epoch + id retained, status emitted", async () => {
    const provider = new HibernatingProvider();
    const att = await reachReady(provider, "sb-1");
    const statuses = collectStatuses(att);

    await att.suspend();

    expect(provider.suspendCalls).toEqual(["sb-1"]);
    expect(att.state).toBe("suspended");
    expect(att.current()).toBeNull();
    expect(att.currentEpoch()).toBe(1);
    expect(att.sandboxId).toBe("sb-1");
    expect(statuses.some((s) => s.state === "suspended")).toBe(true);
  });

  it("ensureReady on suspended: calls provider.resume then readiness path, state ready, SAME epoch, waiters resolve", async () => {
    const provider = new HibernatingProvider();
    const att = await reachSuspended(provider, "sb-1");
    const statuses = collectStatuses(att);

    const resumed = await att.ensureReady({ timeoutMs: 5000 });

    expect(provider.resumeCalls).toEqual(["sb-1"]);
    expect(provider.createCalls).toBe(1); // no second create — resume, not re-provision
    expect(att.state).toBe("ready");
    expect(att.currentEpoch()).toBe(1);
    expect(resumed.epoch).toBe(1);
    expect(resumed.sandbox.id).toBe("sb-1");
    expect(att.current()?.id).toBe("sb-1");

    const provIdx = statuses.findIndex((s) => s.state === "provisioning");
    const readyIdx = statuses.findIndex((s) => s.state === "ready");
    expect(provIdx).toBeGreaterThanOrEqual(0);
    expect(readyIdx).toBeGreaterThan(provIdx);
  });

  it("warm() wakes a suspended attachment via resume", async () => {
    const provider = new HibernatingProvider();
    const att = await reachSuspended(provider, "sb-1");

    att.warm();
    await new Promise((r) => setTimeout(r, 10));

    expect(provider.resumeCalls).toEqual(["sb-1"]);
    expect(provider.createCalls).toBe(1);
    expect(att.state).toBe("ready");
  });

  it("suspend() from detached is a no-op without provider calls", async () => {
    const provider = new HibernatingProvider();
    const att = new SandboxAttachment(provider, {});

    await att.suspend();

    expect(att.state).toBe("detached");
    expect(provider.suspendCalls).toEqual([]);
  });

  it("suspend() from provisioning is a no-op without provider calls", async () => {
    const provider = new HibernatingProvider();
    const att = new SandboxAttachment(provider, {});
    const d = provider.nextDeferred();
    const rp = att.ensureReady({ timeoutMs: 5000 });
    expect(att.state).toBe("provisioning");

    await att.suspend();
    expect(att.state).toBe("provisioning");
    expect(provider.suspendCalls).toEqual([]);

    d.resolve(makeFakeSandbox("sb-1"));
    await rp;
  });

  it("provider without suspend: attachment.suspend() throws 'provider does not support hibernation', state stays ready", async () => {
    const provider = new PlainProvider();
    const att = await reachReady(provider, "sb-1");

    await expect(att.suspend()).rejects.toThrow("provider does not support hibernation");
    expect(att.state).toBe("ready");
    expect(att.current()?.id).toBe("sb-1");
  });

  it("startup failure during resume rejects waiters with SandboxStartupError, state error", async () => {
    const provider = new HibernatingProvider();
    provider.resumeImpl = async () => {
      throw new SandboxStartupError("sess-1", "pod unschedulable");
    };
    const att = await reachSuspended(provider, "sb-1");

    const start = Date.now();
    await expect(att.ensureReady({ timeoutMs: 60_000 })).rejects.toBeInstanceOf(SandboxStartupError);
    // Must fail on the resume rejection, not the (huge) ensureReady timeout.
    expect(Date.now() - start).toBeLessThan(1000);
    expect(att.state).toBe("error");
  });

  it("suspend() rejection keeps the attachment ready and rethrows", async () => {
    const provider = new HibernatingProvider();
    provider.suspendImpl = async () => {
      throw new Error("suspend API 500");
    };
    const att = await reachReady(provider, "sb-1");

    await expect(att.suspend()).rejects.toThrow("suspend API 500");
    expect(att.state).toBe("ready");
    expect(att.current()?.id).toBe("sb-1");
  });

  it("reportFailure racing an in-flight resume re-provisions instead of deadlocking", async () => {
    const provider = new HibernatingProvider();
    const att = await reachSuspended(provider, "sb-1");

    // Block resume until the test fires reportFailure mid-flight.
    const resumeGate = defer<void>();
    provider.resumeImpl = async () => {
      await resumeGate.promise;
    };

    // A waiter kicked off while suspended → drives doResume, then parks.
    const readyP = att.ensureReady({ timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 0));
    expect(att.state).toBe("provisioning"); // resume in flight
    expect(provider.resumeCalls).toEqual(["sb-1"]);

    // Queue the epoch-2 create result the degradation re-provision will consume.
    const d2 = provider.nextDeferred();

    // Degradation lands on the still-current epoch 1 while resume is blocked.
    att.reportFailure(1, new Error("liveness lost"));
    expect(att.currentEpoch()).toBe(2);

    // Let the (now superseded) resume resolve. It must NOT mark ready+null.
    resumeGate.resolve();
    await new Promise((r) => setTimeout(r, 20));

    // A fresh create ran for the new epoch — not a stuck ready+null.
    expect(provider.createCalls).toBe(2); // 1 initial + 1 degradation re-provision
    expect(att.state === "ready" && att.current() === null).toBe(false);
    expect(att.state).toBe("provisioning"); // awaiting the epoch-2 create

    // Settle the re-provision; the parked waiter resolves exactly once with the
    // new sandbox at the new epoch.
    let resolveCount = 0;
    void readyP.then(() => {
      resolveCount++;
    });
    d2.resolve(makeFakeSandbox("sb-2"));
    const resolved = await readyP;

    expect(resolved.sandbox.id).toBe("sb-2");
    expect(resolved.epoch).toBe(2);
    expect(att.state).toBe("ready");
    expect(att.current()?.id).toBe("sb-2");
    await new Promise((r) => setTimeout(r, 0));
    expect(resolveCount).toBe(1);
  });
});
