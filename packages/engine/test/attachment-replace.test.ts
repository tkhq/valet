/**
 * SandboxAttachment.replace() — user-requested sandbox replacement.
 *
 * Replace tears down the current sandbox and re-provisions a fresh one at a
 * bumped epoch with the same persisted createOpts. It reuses the image-drift
 * replace semantics (epoch bump, handle drop, release-else-destroy) but is
 * caller-driven instead of reconcile-driven.
 */
import { describe, it, expect, vi } from "vitest";
import {
  SandboxAttachment,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxCreateOpts,
  type SandboxProvider,
  type SandboxStatus,
} from "../src/index.js";

function makeFakeSandbox(id: string): Sandbox {
  return {
    id,
    readFile: vi.fn(async () => "content"),
    readBinary: vi.fn(async () => new Uint8Array()),
    writeFile: vi.fn(async () => {}),
    writeBinary: vi.fn(async () => {}),
    readdir: vi.fn(async () => [] as string[]),
    stat: vi.fn(async () => ({ isFile: true, isDirectory: false, size: 0 })),
    mkdir: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    execJob: vi.fn(async () => ({ execId: "job-1" })),
    pollJob: vi.fn(async (_id: string, offset: number) => ({
      status: "done" as const,
      exitCode: 0,
      output: "",
      nextOffset: offset,
    })),
    cancelJob: vi.fn(async () => {}),
  };
}

class FakeProvider implements SandboxProvider {
  readonly backend = "fake";
  createCalls = 0;
  destroyCalls: string[] = [];
  releaseCalls: string[] = [];
  private nextId = 1;

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: false,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      customImage: false,
    };
  }

  async create(_opts: SandboxCreateOpts): Promise<Sandbox> {
    this.createCalls++;
    return makeFakeSandbox(`fake-${this.nextId++}`);
  }

  async restore(id: string): Promise<Sandbox> {
    return makeFakeSandbox(id);
  }

  async destroy(id: string): Promise<void> {
    this.destroyCalls.push(id);
  }

  async release(id: string): Promise<void> {
    this.releaseCalls.push(id);
  }

  async status(id: string): Promise<SandboxStatus> {
    return { id, state: "ready" };
  }
}

async function readyAttachment(provider: FakeProvider): Promise<SandboxAttachment> {
  const attachment = new SandboxAttachment(provider, {});
  await attachment.ensureReady({ timeoutMs: 1000 });
  return attachment;
}

describe("SandboxAttachment.replace", () => {
  it("re-provisions a fresh sandbox at a bumped epoch and releases the old one", async () => {
    const provider = new FakeProvider();
    const attachment = await readyAttachment(provider);
    const oldId = attachment.sandboxId;
    const oldEpoch = attachment.currentEpoch();
    expect(oldId).toBeDefined();

    await attachment.replace();

    expect(attachment.state).toBe("ready");
    expect(attachment.sandboxId).toBeDefined();
    expect(attachment.sandboxId).not.toBe(oldId);
    expect(attachment.currentEpoch()).toBeGreaterThan(oldEpoch);
    expect(attachment.isSuperseded(oldEpoch)).toBe(true);
    // Old sandbox handed back via release (falls back to destroy when the
    // provider has no release).
    expect(provider.releaseCalls).toEqual([oldId]);
    expect(provider.createCalls).toBe(2);
  });

  it("rejects while a provision is already in flight", async () => {
    const provider = new FakeProvider();
    // Slow create: hold the first provision open.
    let resolveCreate!: (s: Sandbox) => void;
    provider.create = () =>
      new Promise<Sandbox>((res) => {
        resolveCreate = res;
      });
    const attachment = new SandboxAttachment(provider, {});
    const pending = attachment.ensureReady({ timeoutMs: 5000 });

    await expect(attachment.replace()).rejects.toThrow(/provisioning/);

    resolveCreate(makeFakeSandbox("late"));
    await pending;
  });

  it("rejects after destroy", async () => {
    const provider = new FakeProvider();
    const attachment = await readyAttachment(provider);
    await attachment.destroy();
    await expect(attachment.replace()).rejects.toThrow(/destroyed/);
  });
});
