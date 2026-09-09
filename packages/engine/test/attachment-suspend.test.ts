import { describe, it, expect, vi } from "vitest";
import {
  SandboxAttachment,
  SandboxStartupError,
  SandboxPreparationError,
  type PrepStep,
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
      customImage: false,
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
      customImage: false,
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


describe("awaited afterResume preparation", () => {
  it("orders hooks and holds concurrent waiters until required restoration completes", async () => {
    const provider = new HibernatingProvider();
    const gate = defer<void>();
    const entered = defer<void>();
    const calls: string[] = [];
    const steps: PrepStep[] = [
      { id: "credentials", hash: "1", critical: true, apply: async () => {},
        afterResume: async () => { calls.push("credentials"); entered.resolve(); await gate.promise; } },
      { id: "identity", hash: "1", critical: true, apply: async () => {},
        afterResume: async () => { calls.push("identity"); } },
    ];
    const att = new SandboxAttachment(provider, {}, async () => ({ specHash: "1", steps }));
    await att.ensureReady({ timeoutMs: 1000 });
    await att.suspend();
    let released = false;
    const first = att.ensureReady({ timeoutMs: 1000 }).then(() => { released = true; });
    const second = att.ensureReady({ timeoutMs: 1000 });
    // The old implementation releases ready without invoking a hook.
    await Promise.race([entered.promise, first]);
    expect(calls).toEqual(["credentials"]);
    expect(released).toBe(false);
    expect(att.current()).toBeNull();
    gate.resolve();
    await Promise.all([first, second]);
    expect(calls).toEqual(["credentials", "identity"]);
    expect(provider.resumeCalls).toHaveLength(1);
  });

  it("rejects all waiters on a required hook failure", async () => {
    const provider = new HibernatingProvider();
    const steps: PrepStep[] = [{ id: "credentials", hash: "1", critical: true,
      apply: async () => {}, afterResume: async () => { throw new Error("restore failed"); } }];
    const att = new SandboxAttachment(provider, {}, async () => ({ specHash: "1", steps }));
    await att.ensureReady({ timeoutMs: 1000 });
    await att.suspend();
    const outcomes = await Promise.allSettled([
      att.ensureReady({ timeoutMs: 1000 }), att.ensureReady({ timeoutMs: 1000 }),
    ]);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(outcome.reason).toBeInstanceOf(SandboxPreparationError);
    }
    expect(att.state).toBe("error");
  });
});


describe("afterResume lifecycle races", () => {
  it("runs hooks with a retained marker and continues after optional failures", async () => {
    const provider = new HibernatingProvider();
    const sandbox = makeFakeSandbox("retained");
    const calls: string[] = [];
    sandbox.exec = async () => ({ exitCode: 0, stderr: "", stdout: JSON.stringify({
      image: "", specHash: "1", steps: { optional: "1", required: "1", unchanged: "1" },
    }) });
    provider.nextDeferred().resolve(sandbox);
    const steps: PrepStep[] = [
      { id: "optional", hash: "1", critical: false, apply: async () => { calls.push("cold optional"); },
        afterResume: async () => { calls.push("optional"); throw new Error("optional failed"); } },
      { id: "required", hash: "1", critical: true, apply: async () => { calls.push("cold required"); },
        afterResume: async () => { calls.push("required"); } },
      { id: "unchanged", hash: "1", critical: true, apply: async () => { calls.push("unchanged"); } },
    ];
    const att = new SandboxAttachment(provider, {}, async () => ({ specHash: "1", steps }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await att.ensureReady({ timeoutMs: 1000 });
      await att.suspend();
      await att.ensureReady({ timeoutMs: 1000 });
      expect(calls).toEqual(["optional", "required"]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('optional'));
    } finally { log.mockRestore(); }
  });

  it("cancels one waiter without canceling restoration for other waiters", async () => {
    const provider = new HibernatingProvider();
    const gate = defer<void>();
    const entered = defer<void>();
    const steps: PrepStep[] = [{ id: "restore", hash: "1", critical: true, apply: async () => {},
      afterResume: async () => { entered.resolve(); await gate.promise; } }];
    const att = new SandboxAttachment(provider, {}, async () => ({ specHash: "1", steps }));
    await att.ensureReady({ timeoutMs: 1000 });
    await att.suspend();
    const controller = new AbortController();
    const canceled = att.ensureReady({ timeoutMs: 1000, signal: controller.signal });
    const rejected = expect(canceled).rejects.toThrow("caller canceled");
    const survivor = att.ensureReady({ timeoutMs: 1000 });
    await entered.promise;
    controller.abort(new Error("caller canceled"));
    await rejected;
    expect(att.current()).toBeNull();
    gate.resolve();
    expect((await survivor).sandbox.id).toBe("sb-1");
    expect(provider.resumeCalls).toHaveLength(1);
  });

  it.each(["destroy", "reportFailure"] as const)("%s during a hook prevents later restoration and stale ready", async (action) => {
    const provider = new HibernatingProvider();
    const gate = defer<void>();
    const entered = defer<void>();
    let later = 0;
    const steps: PrepStep[] = [
      { id: "restore", hash: "1", critical: true, apply: async () => {},
        afterResume: async () => { entered.resolve(); await gate.promise; } },
      { id: "later", hash: "1", critical: true, apply: async () => {},
        afterResume: async () => { later++; } },
    ];
    const att = new SandboxAttachment(provider, {}, async () => ({ specHash: "1", steps }));
    const initial = await att.ensureReady({ timeoutMs: 1000 });
    await att.suspend();
    const waiter = att.ensureReady({ timeoutMs: 1000 });
    const outcome = Promise.allSettled([waiter]);
    await entered.promise;
    if (action === "destroy") await att.destroy();
    else att.reportFailure(initial.epoch, new Error("transport failed"));
    gate.resolve();
    const [result] = await outcome;
    expect(later).toBe(0);
    if (action === "destroy") {
      expect(result.status).toBe("rejected");
      expect(att.state).toBe("released");
    } else {
      expect(result.status).toBe("fulfilled");
      if (result.status === "fulfilled") expect(result.value.epoch).toBe(initial.epoch + 1);
      expect(provider.createCalls).toBe(2);
    }
  });
});


it("clears retained hook hashes before a failed restoration can leave stale applied state", async () => {
  const provider = new HibernatingProvider();
  const sandbox = makeFakeSandbox("retained");
  let marker = JSON.stringify({ image: "", specHash: "1", steps: { credentials: "1" } });
  sandbox.exec = async (command) => {
    if (command.startsWith("cat ")) return { stdout: marker, stderr: "", exitCode: 0 };
    const content = command.match(/printf '%s' '([^']*)'/)?.[1];
    if (content) marker = content;
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  provider.nextDeferred().resolve(sandbox);
  const steps: PrepStep[] = [{ id: "credentials", hash: "1", critical: true, apply: async () => {},
    afterResume: async () => { throw new Error("restore failed"); } }];
  const att = new SandboxAttachment(provider, {}, async () => ({ specHash: "1", steps }));
  await att.ensureReady({ timeoutMs: 1000 });
  await att.suspend();
  await expect(att.ensureReady({ timeoutMs: 1000 })).rejects.toBeInstanceOf(SandboxPreparationError);
  expect(JSON.parse(marker).steps).toEqual({});
});


it("reprovisions when an epoch is superseded during the wake spec lookup", async () => {
  const provider = new HibernatingProvider();
  const entered = defer<void>();
  const gate = defer<void>();
  let calls = 0;
  const att = new SandboxAttachment(provider, {}, async () => {
    calls++;
    if (calls === 2) { entered.resolve(); await gate.promise; }
    return { specHash: "1", steps: [] };
  });
  const initial = await att.ensureReady({ timeoutMs: 1000 });
  await att.suspend();
  const waiter = att.ensureReady({ timeoutMs: 100 });
  const outcome = Promise.allSettled([waiter]);
  await entered.promise;
  att.reportFailure(initial.epoch, new Error("transport failed"));
  gate.resolve();
  const [result] = await outcome;
  expect(result.status).toBe("fulfilled");
  if (result.status === "fulfilled") expect(result.value.epoch).toBe(initial.epoch + 1);
  expect(provider.resumeCalls).toHaveLength(0);
});

it("retries required resume hooks without substituting cold preparation", async () => {
  const provider = new HibernatingProvider();
  const destroy = vi.spyOn(provider, "destroy");
  let coldCalls = 0;
  let restoreCalls = 0;
  let fail = true;
  const steps: PrepStep[] = [{ id: "credentials", hash: "1", critical: true,
    apply: async () => { coldCalls++; },
    afterResume: async () => {
      restoreCalls++;
      if (fail) throw new Error("restore failed");
    },
  }];
  const att = new SandboxAttachment(provider, {}, async () => ({ specHash: "1", steps }));
  const initial = await att.ensureReady({ timeoutMs: 1000 });
  await att.suspend();
  await expect(att.ensureReady({ timeoutMs: 1000 })).rejects.toBeInstanceOf(SandboxPreparationError);
  await expect(att.ensureReady({ timeoutMs: 1000 })).rejects.toBeInstanceOf(SandboxPreparationError);
  expect(att.current()).toBeNull();
  expect(coldCalls).toBe(1);
  expect(restoreCalls).toBe(2);
  expect(provider.createCalls).toBe(1);
  expect(provider.resumeCalls).toHaveLength(1);
  expect(destroy).not.toHaveBeenCalled();
  fail = false;
  const recovered = await att.ensureReady({ timeoutMs: 1000 });
  expect(recovered).toEqual(initial);
  expect(restoreCalls).toBe(3);
});
