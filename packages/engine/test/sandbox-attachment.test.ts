import { describe, it, expect, vi } from "vitest";
import {
  SandboxAttachment,
  PolicySandbox,
  SandboxStartupError,
  WorkspaceProvisioningError,
  SandboxSupersededError,
  SandboxUnavailableError,
  type AttachmentStatus,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxCreateOpts,
  type SandboxProvider,
  type SandboxStatus,
} from "../src/index.js";

// ── Fake provider ────────────────────────────────────────────────────

/** A controllable in-memory Sandbox stub. exec/readFile/writeFile/mkdir are
 * spies so tests can assert call counts and control rejections. */
function makeFakeSandbox(id: string): Sandbox & {
  exec: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  execJob: ReturnType<typeof vi.fn>;
  pollJob: ReturnType<typeof vi.fn>;
  cancelJob: ReturnType<typeof vi.fn>;
} {
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
    execJob: vi.fn(async (_command: string) => ({ execId: "job-1" })),
    pollJob: vi.fn(async (_execId: string, offset: number) => ({
      status: "done" as const,
      exitCode: 0,
      output: "",
      nextOffset: offset,
    })),
    cancelJob: vi.fn(async (_execId: string) => {}),
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

/** FakeProvider whose `create` resolves on command via an exposed deferred
 * queue — each call to `create` pulls (or creates) the next deferred. */
class FakeProvider implements SandboxProvider {
  readonly backend = "fake";
  createCalls = 0;
  destroyCalls: string[] = [];
  private nextId = 1;
  private pending: Array<Deferred<Sandbox>> = [];
  private caps: SandboxCapabilities;

  constructor(caps: Partial<SandboxCapabilities> = {}) {
    this.caps = {
      snapshot: "none",
      persistentWorkspace: false,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      customImage: false,
      coldStartEstimateMs: 5000,
      ...caps,
    };
  }

  capabilities(): SandboxCapabilities {
    return this.caps;
  }

  /** Queue up the next deferred that `create()` will return; resolve it
   * later with `resolveCreate` / `rejectCreate`. */
  nextDeferred(): Deferred<Sandbox> {
    const d = defer<Sandbox>();
    this.pending.push(d);
    return d;
  }

  async create(_opts: SandboxCreateOpts): Promise<Sandbox> {
    this.createCalls++;
    const d = this.pending.shift();
    if (!d) {
      // No deferred queued — auto-resolve immediately with a fresh sandbox.
      return makeFakeSandbox(`fake-${this.nextId++}`);
    }
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

function collectStatuses(attachment: SandboxAttachment): AttachmentStatus[] {
  const seen: AttachmentStatus[] = [];
  attachment.onStatus((s) => seen.push(s));
  return seen;
}

describe("SandboxAttachment", () => {
  it("1. lazy: constructing attachment + wrapper calls provider.create zero times", () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    new PolicySandbox(attachment, { readyTimeoutMs: 1000 });
    expect(provider.createCalls).toBe(0);
  });

  it("1b. current() peeks without provisioning: null while detached, the live sandbox once ready, null again after destroy", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 1000 });

    // Detached: current() must not kick a provision.
    expect(attachment.current()).toBeNull();
    expect(provider.createCalls).toBe(0);

    const d = provider.nextDeferred();
    const opPromise = wrapper.readFile("/x.txt");
    // Still provisioning: current() stays null, no false-positive readiness.
    expect(attachment.current()).toBeNull();

    d.resolve(makeFakeSandbox("sb-current"));
    await opPromise;
    expect(attachment.state).toBe("ready");
    expect(attachment.current()?.id).toBe("sb-current");

    await attachment.destroy();
    expect(attachment.current()).toBeNull();
  });

  it("2. warm() kicks exactly one create even when called 5x concurrently", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    attachment.warm();
    attachment.warm();
    attachment.warm();
    attachment.warm();
    attachment.warm();
    // let the single in-flight provision settle
    await new Promise((r) => setTimeout(r, 10));
    expect(provider.createCalls).toBe(1);
  });

  it("3. first op awaits readiness: op completes once create resolves; state ready, epoch 1", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 5000 });
    const d = provider.nextDeferred();

    const opPromise = wrapper.readFile("/x.txt");
    setTimeout(() => d.resolve(makeFakeSandbox("sb-1")), 50);

    await expect(opPromise).resolves.toBe("content");
    expect(attachment.state).toBe("ready");
    expect(attachment.currentEpoch()).toBe(1);
  });

  it("4. ready-timeout: create never resolves -> WorkspaceProvisioningError within ~timeout; attachment stays provisioning", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 100 });
    provider.nextDeferred(); // never resolved

    const start = Date.now();
    await expect(wrapper.readFile("/x.txt")).rejects.toBeInstanceOf(WorkspaceProvisioningError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(400);
    expect(attachment.state).toBe("provisioning");
  });

  it("4b. terminal startup failure: create() rejects with SandboxStartupError -> pending ensureReady waiters are rejected with it immediately (fast fail, not a generic timeout)", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 60_000 });
    const d = provider.nextDeferred();

    const startupErr = new SandboxStartupError("sess-1", "image pull failed (ImagePullBackOff): valet-sandbox:dev");
    const start = Date.now();
    const opPromise = wrapper.readFile("/x.txt");
    setTimeout(() => d.reject(startupErr), 20);

    await expect(opPromise).rejects.toBe(startupErr);
    const elapsed = Date.now() - start;
    // Must resolve on the create() rejection itself, not the (deliberately
    // huge, 60s) readyTimeoutMs — proves the fast-fail path, not the
    // generic-timeout path.
    expect(elapsed).toBeLessThan(1000);
    expect(attachment.state).toBe("error");
  });

  it("4c. non-terminal create() failure (plain Error) keeps the swallow behavior: waiter is not force-rejected, it hits its OWN ensureReady timeout instead (pins docker/local semantics unchanged)", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 100 });
    const d = provider.nextDeferred();

    const start = Date.now();
    const opPromise = wrapper.readFile("/x.txt");
    // A generic transient failure (e.g. docker/local's plain Error) rejects
    // create() almost immediately...
    setTimeout(() => d.reject(new Error("docker run failed (1): some transient error")), 10);

    // ...but the waiter must NOT see that rejection directly — it should
    // still be waiting until its own 100ms ensureReady timeout fires with
    // WorkspaceProvisioningError, exactly like case 4's never-resolving
    // scenario.
    await expect(opPromise).rejects.toBeInstanceOf(WorkspaceProvisioningError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(attachment.state).toBe("error");
  });

  it("5. degradation + re-provision: transport-death exec error triggers reprovision to epoch 2", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 5000 });
    const statuses = collectStatuses(attachment);

    // Get to ready epoch 1 first.
    const sb1 = makeFakeSandbox("sb-1");
    provider.nextDeferred().resolve(sb1);
    await wrapper.readFile("/x.txt");
    expect(attachment.currentEpoch()).toBe(1);

    // exec rejects with a container-death signature. Queue a controllable
    // deferred for the reprovision `create` so we can observe the
    // intermediate "provisioning epoch 2" state before letting it resolve.
    const d2 = provider.nextDeferred();
    sb1.exec.mockRejectedValueOnce(new Error("No such container abc"));
    await expect(wrapper.exec("ls")).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(attachment.state).toBe("provisioning");
    expect(attachment.currentEpoch()).toBe(2);

    // Re-provision completes.
    const sb2 = makeFakeSandbox("sb-2");
    const nextOp = wrapper.readFile("/y.txt");
    d2.resolve(sb2);
    await expect(nextOp).resolves.toBe("content");
    expect(attachment.state).toBe("ready");
    expect(attachment.currentEpoch()).toBe(2);

    const provisioningEpoch2Index = statuses.findIndex((s) => s.state === "provisioning" && s.epoch === 2);
    const readyEpoch2Index = statuses.findIndex((s) => s.state === "ready" && s.epoch === 2);
    expect(provisioningEpoch2Index).toBeGreaterThanOrEqual(0);
    expect(readyEpoch2Index).toBeGreaterThan(provisioningEpoch2Index);
  });

  it("5b. job op awaits readiness: execJob completes once create resolves; state ready, epoch 1", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 5000 });
    const d = provider.nextDeferred();

    const opPromise = wrapper.execJob("sleep 100");
    setTimeout(() => d.resolve(makeFakeSandbox("sb-1")), 50);

    await expect(opPromise).resolves.toEqual({ execId: "job-1" });
    expect(attachment.state).toBe("ready");
    expect(attachment.currentEpoch()).toBe(1);
  });

  it("5c. pollJob transport failure degrades + reprovisions", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 5000 });
    const statuses = collectStatuses(attachment);

    const sb1 = makeFakeSandbox("sb-1");
    provider.nextDeferred().resolve(sb1);
    await wrapper.readFile("/x.txt");
    expect(attachment.currentEpoch()).toBe(1);

    const d2 = provider.nextDeferred();
    sb1.pollJob.mockRejectedValueOnce(new Error("No such container abc"));
    await expect(wrapper.pollJob("job-1", 0)).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(attachment.state).toBe("provisioning");
    expect(attachment.currentEpoch()).toBe(2);

    const sb2 = makeFakeSandbox("sb-2");
    const nextOp = wrapper.readFile("/y.txt");
    d2.resolve(sb2);
    await expect(nextOp).resolves.toBe("content");
    expect(attachment.state).toBe("ready");
    expect(attachment.currentEpoch()).toBe(2);

    const provisioningEpoch2Index = statuses.findIndex((s) => s.state === "provisioning" && s.epoch === 2);
    const readyEpoch2Index = statuses.findIndex((s) => s.state === "ready" && s.epoch === 2);
    expect(provisioningEpoch2Index).toBeGreaterThanOrEqual(0);
    expect(readyEpoch2Index).toBeGreaterThan(provisioningEpoch2Index);
  });

  it("6. supersession discard: op A dispatched at epoch 1 hangs, then resolves after re-provision -> SandboxSupersededError", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 5000 });

    const sb1 = makeFakeSandbox("sb-1");
    provider.nextDeferred().resolve(sb1);
    await wrapper.readFile("/x.txt");

    // op A: exec hangs on the raw sandbox.
    const hangDeferred = defer<{ stdout: string; stderr: string; exitCode: number }>();
    sb1.exec.mockImplementationOnce(() => hangDeferred.promise);
    const opA = wrapper.exec("sleep 100");

    // op B fails, triggering reportFailure(epoch=1) directly (simulating a
    // concurrent op's degradation) which bumps to epoch 2 and re-provisions.
    attachment.reportFailure(1, new Error("simulated failure"));
    const sb2 = makeFakeSandbox("sb-2");
    const d2 = provider.nextDeferred();
    d2.resolve(sb2);
    await wrapper.readFile("/y.txt"); // wait for epoch 2 to be ready
    expect(attachment.currentEpoch()).toBe(2);

    // Now op A's underlying (stale) raw promise finally resolves successfully.
    hangDeferred.resolve({ stdout: "ok", stderr: "", exitCode: 0 });
    await expect(opA).rejects.toBeInstanceOf(SandboxSupersededError);
  });

  it("7. stale failure ignored: reportFailure(1, ...) when current epoch is 2 -> no state change, no extra create", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 5000 });

    provider.nextDeferred().resolve(makeFakeSandbox("sb-1"));
    await wrapper.readFile("/x.txt");

    // Force to epoch 2 via a real degradation.
    attachment.reportFailure(1, new Error("degrade"));
    provider.nextDeferred().resolve(makeFakeSandbox("sb-2"));
    await wrapper.readFile("/y.txt");
    expect(attachment.currentEpoch()).toBe(2);

    const createsBefore = provider.createCalls;
    const stateBefore = attachment.state;
    attachment.reportFailure(1, new Error("stale failure"));
    expect(attachment.state).toBe(stateBefore);
    expect(attachment.currentEpoch()).toBe(2);
    expect(provider.createCalls).toBe(createsBefore);
  });

  it("7b. reportFailure prefers provider.release over provider.destroy when release is implemented", async () => {
    class FakeProviderWithRelease extends FakeProvider {
      releaseCalls: string[] = [];
      async release(id: string): Promise<void> {
        this.releaseCalls.push(id);
      }
    }
    const provider = new FakeProviderWithRelease();
    const attachment = new SandboxAttachment(provider, {});
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 5000 });

    const sb1 = makeFakeSandbox("sb-1");
    provider.nextDeferred().resolve(sb1);
    await wrapper.readFile("/x.txt");

    sb1.exec.mockRejectedValueOnce(new Error("No such container abc"));
    const d2 = provider.nextDeferred();
    d2.resolve(makeFakeSandbox("sb-2"));
    await expect(wrapper.exec("ls")).rejects.toBeInstanceOf(SandboxUnavailableError);
    await wrapper.readFile("/y.txt"); // wait for epoch 2 to settle

    expect(provider.releaseCalls).toEqual(["sb-1"]);
    expect(provider.destroyCalls).toEqual([]);
  });

  it("7c. reportFailure falls back to provider.destroy when the provider has no release (pins docker/local behavior)", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 5000 });

    const sb1 = makeFakeSandbox("sb-1");
    provider.nextDeferred().resolve(sb1);
    await wrapper.readFile("/x.txt");

    sb1.exec.mockRejectedValueOnce(new Error("No such container abc"));
    const d2 = provider.nextDeferred();
    d2.resolve(makeFakeSandbox("sb-2"));
    await expect(wrapper.exec("ls")).rejects.toBeInstanceOf(SandboxUnavailableError);
    await wrapper.readFile("/y.txt"); // wait for epoch 2 to settle

    expect(provider.destroyCalls).toEqual(["sb-1"]);
  });

  it("8. non-degrading errors: ENOENT rethrown as-is, state stays ready, no re-provision", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 5000 });

    const sb1 = makeFakeSandbox("sb-1");
    provider.nextDeferred().resolve(sb1);
    await wrapper.readFile("/x.txt");

    sb1.readFile.mockRejectedValueOnce(new Error("ENOENT: no such file"));
    await expect(wrapper.readFile("/missing.txt")).rejects.toThrow("ENOENT: no such file");
    expect(attachment.state).toBe("ready");
    expect(attachment.currentEpoch()).toBe(1);
    expect(provider.createCalls).toBe(1);
  });

  it("9. write-parent-retry: writeFile rejects once, wrapper mkdirs + retries -> 2 write attempts, 1 mkdir", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 5000 });

    const sb1 = makeFakeSandbox("sb-1");
    provider.nextDeferred().resolve(sb1);

    sb1.writeFile.mockRejectedValueOnce(new Error("ENOENT: parent missing"));
    await wrapper.writeFile("/a/b/c.txt", "hello");

    expect(sb1.writeFile).toHaveBeenCalledTimes(2);
    expect(sb1.mkdir).toHaveBeenCalledTimes(1);
    expect(sb1.mkdir).toHaveBeenCalledWith("/a/b");
  });

  it("10. pre-dispatch abort: exec with an already-aborted signal rejects immediately, raw exec never called", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 5000 });

    const sb1 = makeFakeSandbox("sb-1");
    provider.nextDeferred().resolve(sb1);
    await wrapper.readFile("/x.txt"); // reach ready so only the abort gates the exec

    const controller = new AbortController();
    controller.abort();
    await expect(wrapper.exec("ls", { signal: controller.signal })).rejects.toThrow();
    expect(sb1.exec).not.toHaveBeenCalled();
  });

  it("11. default output limit: exec with no maxOutputBytes passes 262144 to the raw op", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 5000 });

    const sb1 = makeFakeSandbox("sb-1");
    provider.nextDeferred().resolve(sb1);

    await wrapper.exec("ls");
    expect(sb1.exec).toHaveBeenCalledWith("ls", expect.objectContaining({ maxOutputBytes: 262_144 }));
  });

  it("12. destroy(): destroys the raw sandbox, cancels in-flight provisioning, emits released status", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 5000 });
    const statuses = collectStatuses(attachment);

    const sb1 = makeFakeSandbox("sb-1");
    provider.nextDeferred().resolve(sb1);
    await wrapper.readFile("/x.txt");

    await attachment.destroy();

    expect(provider.destroyCalls).toContain("sb-1");
    expect(statuses.some((s) => s.state === "released")).toBe(true);
    await expect(wrapper.readFile("/y.txt")).rejects.toThrow();
  });

  it("12b. destroy() cancels an in-flight provision: the eventually-created sandbox is discarded", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 5000 });
    const d = provider.nextDeferred();

    const opPromise = wrapper.readFile("/x.txt").catch((e) => e);
    await attachment.destroy();
    d.resolve(makeFakeSandbox("sb-late"));

    const result = await opPromise;
    expect(result).toBeInstanceOf(Error);
    expect(attachment.state).toBe("released");
  });

  it("13. forSandbox: ops pass through immediately, epoch 1, no provider calls", async () => {
    const raw = makeFakeSandbox("preexisting");
    const attachment = SandboxAttachment.forSandbox(raw);
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 5000 });

    expect(attachment.state).toBe("ready");
    expect(attachment.currentEpoch()).toBe(1);

    const result = await wrapper.readFile("/x.txt");
    expect(result).toBe("content");
    expect(attachment.state).toBe("ready");
    expect(attachment.currentEpoch()).toBe(1);
  });

  it("forSandbox: reportFailure/reprovision transitions to error and stays there", () => {
    const raw = makeFakeSandbox("preexisting");
    const attachment = SandboxAttachment.forSandbox(raw);
    attachment.reportFailure(1, new Error("boom"));
    expect(attachment.state).toBe("error");
    attachment.warm(); // no-op: no provider to reprovision with
    expect(attachment.state).toBe("error");
  });

  it("14. a throwing onStatus listener does not break the ready transition: ensureReady still resolves, state stays ready", async () => {
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    const wrapper = new PolicySandbox(attachment, { readyTimeoutMs: 1000 });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    attachment.onStatus(() => {
      throw new Error("listener boom");
    });

    const d = provider.nextDeferred();
    const opPromise = wrapper.readFile("/x.txt");
    setTimeout(() => d.resolve(makeFakeSandbox("sb-1")), 10);

    await expect(opPromise).resolves.toBe("content");
    expect(attachment.state).toBe("ready");
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
