import { describe, it, expect, vi } from "vitest";
import {
  SandboxAttachment,
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

/**
 * A provider that records updateCreds calls and supports the credsMount
 * capability + the hibernation seam. updateCreds is a spy so tests can
 * override its implementation to exercise the rejection path.
 */
class CredsProvider implements SandboxProvider {
  readonly backend = "fake-creds";
  private pending: Array<Deferred<Sandbox>> = [];
  private nextId = 1;
  updateCredsCalls: Array<{ id: string; files: Record<string, string> }> = [];
  updateCredsImpl: (id: string, files: Record<string, string>) => Promise<void> = async () => {};
  resumeCalls: string[] = [];
  resumeImpl: (id: string) => Promise<void> = async () => {};
  private readonly caps: SandboxCapabilities;

  constructor(caps: Partial<SandboxCapabilities> = {}) {
    this.caps = {
      snapshot: "none",
      persistentWorkspace: true,
      tunnels: false,
      warmPool: false,
      hibernation: true,
      customImage: false,
      credsMount: true,
      ...caps,
    };
  }

  capabilities(): SandboxCapabilities {
    return this.caps;
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

  async suspend(_id: string): Promise<void> {}

  async resume(id: string): Promise<void> {
    this.resumeCalls.push(id);
    return this.resumeImpl(id);
  }

  async updateCreds(id: string, files: Record<string, string>): Promise<void> {
    this.updateCredsCalls.push({ id, files });
    return this.updateCredsImpl(id, files);
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe("SandboxAttachment — credential push", () => {
  it("1. cold create with credsMount: updateCreds NOT called (provider.create() owns creds on cold path)", async () => {
    // provider.create() on k8s already writes the Secret; the engine must not
    // duplicate it. Asserting zero calls guards that invariant.
    const provider = new CredsProvider();
    const credsFiles = { token: "tok-abc" };
    const att = new SandboxAttachment(provider, { credsFiles });

    await att.ensureReady({ timeoutMs: 5000 });

    expect(provider.updateCredsCalls).toHaveLength(0);
  });

  it("2. provider without credsMount capability: updateCreds NOT called even when credsFiles present", async () => {
    // credsMount: false — provider does implement updateCreds but capability is off.
    const provider = new CredsProvider({ credsMount: false });
    const att = new SandboxAttachment(provider, { credsFiles: { token: "tok-abc" } });

    await att.ensureReady({ timeoutMs: 5000 });

    expect(provider.updateCredsCalls).toHaveLength(0);
  });

  it("3. resume path (suspend → ensureReady wake): updateCreds called once after resume with correct id and files", async () => {
    const provider = new CredsProvider();
    const credsFiles = { token: "tok-resume" };
    const att = new SandboxAttachment(provider, { credsFiles });

    // Cold create must NOT call updateCreds.
    await att.ensureReady({ timeoutMs: 5000 });
    expect(provider.updateCredsCalls).toHaveLength(0);

    // Suspend and wake.
    await att.suspend();
    expect(att.state).toBe("suspended");

    await att.ensureReady({ timeoutMs: 5000 });

    // updateCreds must have been called exactly once on the resume path.
    expect(provider.updateCredsCalls).toHaveLength(1);
    expect(provider.updateCredsCalls[0]!.id).toBe("sb-1");
    expect(provider.updateCredsCalls[0]!.files).toEqual(credsFiles);
    expect(provider.resumeCalls).toEqual(["sb-1"]);
    expect(att.state).toBe("ready");
  });

  it("4. updateCreds rejection on resume path: wake still completes ready, error logged, call recorded", async () => {
    const provider = new CredsProvider();
    const credsFiles = { token: "tok-abc" };
    const att = new SandboxAttachment(provider, { credsFiles });

    await att.ensureReady({ timeoutMs: 5000 });
    await att.suspend();

    // Make updateCreds fail on the resume path.
    provider.updateCredsImpl = async () => {
      throw new Error("secret update 503");
    };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await att.ensureReady({ timeoutMs: 5000 });

    expect(att.state).toBe("ready");
    // The call was attempted (and recorded) even though it rejected.
    expect(provider.updateCredsCalls).toHaveLength(1);
    expect(provider.updateCredsCalls[0]!.id).toBe("sb-1");
    expect(provider.updateCredsCalls[0]!.files).toEqual(credsFiles);
    expect(consoleSpy).toHaveBeenCalledWith(
      "SandboxAttachment: updateCreds after resume failed (non-fatal)",
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it("5. provider without credsMount: updateCreds NOT called on resume path either", async () => {
    const provider = new CredsProvider({ credsMount: false });
    const att = new SandboxAttachment(provider, { credsFiles: { token: "tok-abc" } });

    await att.ensureReady({ timeoutMs: 5000 });
    await att.suspend();
    await att.ensureReady({ timeoutMs: 5000 });

    expect(provider.updateCredsCalls).toHaveLength(0);
  });

  it("6. no credsFiles in createOpts: updateCreds NOT called even when credsMount present", async () => {
    const provider = new CredsProvider();
    // createOpts has no credsFiles at all.
    const att = new SandboxAttachment(provider, {});

    await att.ensureReady({ timeoutMs: 5000 });
    await att.suspend();
    await att.ensureReady({ timeoutMs: 5000 });

    expect(provider.updateCredsCalls).toHaveLength(0);
  });
});
