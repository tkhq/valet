/**
 * Tests for SandboxAttachment.reconcile() — observe/diff/converge (Task 5).
 *
 * Uses a VirtualSandbox-backed provider so the applied-state exec round-trip
 * (cat/printf) runs for real, plus a mutable fake specProvider the test drives
 * between reconcile passes to model spec drift.
 */
import { describe, it, expect, vi } from "vitest";
import {
  SandboxAttachment,
  OBSERVE_TTL_MS,
  VirtualSandbox,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxCreateOpts,
  type SandboxProvider,
  type SandboxStatus,
  type DesiredSandboxSpec,
  type PrepStep,
  type SpecProvider,
} from "../src/index.js";
import { readAppliedState } from "../src/sandbox/applied-state.js";

// ── Provider ──────────────────────────────────────────────────────────

/**
 * Provider that mints real VirtualSandboxes (so applied-state exec works) and
 * records every create with the image it booted, plus optional suspend/resume.
 */
class RecordingProvider implements SandboxProvider {
  readonly backend = "recording";
  createImages: (string | undefined)[] = [];
  destroyCalls: string[] = [];
  releaseCalls: string[] = [];
  suspendCalls: string[] = [];
  resumeCalls: string[] = [];
  sandboxes: VirtualSandbox[] = [];
  private nextId = 1;
  private hibernation: boolean;
  // Optional seams: assigned as instance properties ONLY when enabled so the
  // attachment's `provider.release ?`/`provider.resume ?` capability checks see
  // them as absent otherwise (deleting a prototype method would not work).
  release?: (id: string) => Promise<void>;
  suspend?: (id: string) => Promise<void>;
  resume?: (id: string) => Promise<void>;

  constructor(opts: { hibernation?: boolean; release?: boolean } = {}) {
    this.hibernation = opts.hibernation ?? false;
    if (opts.release) {
      this.release = async (id: string) => {
        this.releaseCalls.push(id);
      };
    }
    if (this.hibernation) {
      this.suspend = async (id: string) => {
        this.suspendCalls.push(id);
      };
      this.resume = async (id: string) => {
        this.resumeCalls.push(id);
      };
    }
  }

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: this.hibernation,
      tunnels: false,
      warmPool: false,
      hibernation: this.hibernation,
      customImage: true,
      coldStartEstimateMs: 0,
    };
  }

  async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    this.createImages.push(opts.image);
    const sb = new VirtualSandbox(`sb-${this.nextId++}`);
    this.sandboxes.push(sb);
    return sb;
  }

  async restore(id: string): Promise<Sandbox> {
    return new VirtualSandbox(id);
  }

  async destroy(id: string): Promise<void> {
    this.destroyCalls.push(id);
  }

  async status(id: string): Promise<SandboxStatus> {
    return { id, state: "ready" };
  }
}

// ── Mutable fake specProvider ─────────────────────────────────────────

function step(id: string, hash: string, applyFn?: (sb: Sandbox) => Promise<void>): PrepStep {
  return { id, hash, critical: true, apply: applyFn ?? (async () => {}) };
}

/**
 * A specProvider whose returned spec the test mutates between reconcile passes.
 * `calls` counts invocations — used to pin single-flight.
 */
class FakeSpecProvider {
  spec: DesiredSandboxSpec;
  calls = 0;
  gate: Promise<void> | null = null;

  constructor(spec: DesiredSandboxSpec) {
    this.spec = spec;
  }

  provider(): SpecProvider {
    return async () => {
      this.calls++;
      if (this.gate) await this.gate;
      return this.spec;
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

async function reachReady(
  provider: RecordingProvider,
  fake: FakeSpecProvider,
  createOpts: SandboxCreateOpts = {},
): Promise<SandboxAttachment> {
  const att = new SandboxAttachment(provider, createOpts, fake.provider());
  await att.ensureReady({ timeoutMs: 5000 });
  return att;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("SandboxAttachment.reconcile", () => {
  it("no drift → no provider create and no observation exec beyond the boot write", async () => {
    const provider = new RecordingProvider();
    const fake = new FakeSpecProvider({
      image: "img:v1",
      specHash: "h1",
      steps: [step("s1", "sh1")],
    });
    const att = await reachReady(provider, fake, { image: "img:v1" });
    const bootCreates = provider.createImages.length;
    const specCallsAfterBoot = fake.calls;

    // Spy exec on the live sandbox — a fresh cache means no cat read.
    const sb = att.current();
    if (!sb) throw new Error("expected a ready sandbox");
    const execSpy = vi.spyOn(sb, "exec");

    await att.reconcile();

    expect(provider.createImages.length).toBe(bootCreates); // no re-provision
    expect(execSpy).not.toHaveBeenCalled(); // fresh cache → no cat
    expect(fake.calls).toBe(specCallsAfterBoot + 1); // one specProvider call
    expect(att.state).toBe("ready");
    expect(att.currentEpoch()).toBe(1);
  });

  it("step drift → same epoch, only the drifted step re-applied", async () => {
    const provider = new RecordingProvider();
    const applied: string[] = [];
    const fake = new FakeSpecProvider({
      image: "img:v1",
      specHash: "h1",
      steps: [
        step("s1", "sh1", async () => {
          applied.push("s1");
        }),
        step("s2", "sh2", async () => {
          applied.push("s2");
        }),
      ],
    });
    const att = await reachReady(provider, fake, { image: "img:v1" });
    applied.length = 0; // clear boot applies

    // Drift only s2's hash; keep the image.
    fake.spec = {
      image: "img:v1",
      specHash: "h2",
      steps: [
        step("s1", "sh1", async () => {
          applied.push("s1");
        }),
        step("s2", "sh2-NEW", async () => {
          applied.push("s2");
        }),
      ],
    };

    await att.reconcile();

    expect(applied).toEqual(["s2"]); // only the drifted step ran
    expect(att.currentEpoch()).toBe(1); // same epoch — in-place
    expect(provider.createImages.length).toBe(1); // no re-provision
    expect(att.observedImage()).toBe("img:v1");

    // Applied file now records the new hash.
    const sb = att.current();
    if (!sb) throw new Error("expected ready");
    const state = await readAppliedState(sb);
    expect(state?.steps).toEqual({ s1: "sh1", s2: "sh2-NEW" });
  });

  it("image drift → new epoch, create with the new image, steps re-applied", async () => {
    const provider = new RecordingProvider();
    const applied: string[] = [];
    const mkSteps = () => [
      step("s1", "sh1", async () => {
        applied.push("s1");
      }),
    ];
    const fake = new FakeSpecProvider({ image: "img:v1", specHash: "h1", steps: mkSteps() });
    const att = await reachReady(provider, fake, { image: "img:v1" });
    expect(provider.createImages).toEqual(["img:v1"]);
    applied.length = 0;

    // Drift the image.
    fake.spec = { image: "img:v2", specHash: "h2", steps: mkSteps() };

    await att.reconcile();
    // The replacement kicks a fresh provision; let it settle.
    await att.ensureReady({ timeoutMs: 5000 });

    expect(att.currentEpoch()).toBe(2); // new epoch
    expect(provider.createImages).toEqual(["img:v1", "img:v2"]); // booted new image
    // The old sandbox teardown is fire-and-forget (void .catch()) — flush it.
    await new Promise((r) => setTimeout(r, 0));
    expect(provider.destroyCalls).toEqual(["sb-1"]); // old sandbox released via destroy
    expect(applied).toEqual(["s1"]); // steps re-applied on the fresh container
    expect(att.observedImage()).toBe("img:v2");
    expect(att.state).toBe("ready");
  });

  it("single-flight: 5 concurrent reconcile calls invoke specProvider once", async () => {
    const provider = new RecordingProvider();
    const fake = new FakeSpecProvider({ image: "img:v1", specHash: "h1", steps: [step("s1", "sh1")] });
    const att = await reachReady(provider, fake, { image: "img:v1" });
    const before = fake.calls;

    // Block the specProvider so all five calls land while the first is in flight.
    let release!: () => void;
    fake.gate = new Promise<void>((r) => {
      release = r;
    });

    const runs = [att.reconcile(), att.reconcile(), att.reconcile(), att.reconcile(), att.reconcile()];
    release();
    await Promise.all(runs);

    expect(fake.calls).toBe(before + 1); // exactly one run executed
  });

  it("backoff: a failed replace no-ops within the window, then retries after it", async () => {
    vi.useFakeTimers();
    try {
      const provider = new RecordingProvider();
      const fake = new FakeSpecProvider({ image: "img:v1", specHash: "h1", steps: [step("s1", "sh1")] });
      const att = new SandboxAttachment(provider, { image: "img:v1" }, fake.provider());
      await att.ensureReady({ timeoutMs: 5000 });

      // Any create that boots img:v2 throws — the canonical failed replace. The
      // provision lands in `error`; reconcile records the backoff memo.
      provider.create = async (opts: SandboxCreateOpts) => {
        provider.createImages.push(opts.image);
        if (opts.image === "img:v2") throw new Error("v2 boot failed");
        return new VirtualSandbox(`sb-r${provider.createImages.length}`);
      };

      // Drift to v2 → first reconcile kicks the replace → v2 create throws.
      fake.spec = { image: "img:v2", specHash: "h2", steps: [step("s1", "sh1")] };
      const before = provider.createImages.length;
      await att.reconcile();
      await vi.advanceTimersByTimeAsync(1);
      expect(att.state).toBe("error");
      expect(provider.createImages.length).toBe(before + 1); // one v2 attempt

      // Recover to `ready` on img:v1 (spec back to v1). doProvisionInner selects
      // the spec's image for the fresh boot, so recovery lands on v1.
      fake.spec = { image: "img:v1", specHash: "h1", steps: [step("s1", "sh1")] };
      await att.ensureReady({ timeoutMs: 5000 });
      expect(att.state).toBe("ready");
      expect(att.observedImage()).toBe("img:v1");
      const afterRecovery = provider.createImages.length;

      // Re-introduce the v2 drift within the backoff window → memo skips it.
      fake.spec = { image: "img:v2", specHash: "h2", steps: [step("s1", "sh1")] };
      await att.reconcile();
      expect(provider.createImages.length).toBe(afterRecovery); // skipped, no create
      expect(att.state).toBe("ready"); // working sandbox untouched

      // Past the window (2^1 * 60s), the matching-spec replace is retried.
      await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
      await att.reconcile();
      await vi.advanceTimersByTimeAsync(1);
      expect(provider.createImages.length).toBeGreaterThan(afterRecovery); // retried
    } finally {
      vi.useRealTimers();
    }
  });

  it("throttle: a second reconcile within OBSERVE_TTL_MS does not exec cat", async () => {
    const provider = new RecordingProvider();
    const fake = new FakeSpecProvider({ image: "img:v1", specHash: "h1", steps: [step("s1", "sh1")] });
    const att = await reachReady(provider, fake, { image: "img:v1" });
    const sb = att.current();
    if (!sb) throw new Error("expected ready");
    const execSpy = vi.spyOn(sb, "exec");

    // Two reconciles back to back — the cache is fresh, so neither reads.
    await att.reconcile();
    await att.reconcile();

    const catCalls = execSpy.mock.calls.filter((c) => String(c[0]).startsWith("cat "));
    expect(catCalls.length).toBe(0);
  });

  it("throttle expiry: once the cache ages past OBSERVE_TTL_MS, reconcile reads the applied file", async () => {
    vi.useFakeTimers();
    try {
      const provider = new RecordingProvider();
      const fake = new FakeSpecProvider({
        image: "img:v1",
        specHash: "h1",
        steps: [step("s1", "sh1")],
      });
      const att = new SandboxAttachment(provider, { image: "img:v1" }, fake.provider());
      await att.ensureReady({ timeoutMs: 5000 });
      const sb = att.current();
      if (!sb) throw new Error("expected ready");
      const execSpy = vi.spyOn(sb, "exec");

      // Age the cache past the TTL.
      await vi.advanceTimersByTimeAsync(OBSERVE_TTL_MS + 1);
      await att.reconcile();

      const catCalls = execSpy.mock.calls.filter((c) => String(c[0]).startsWith("cat "));
      expect(catCalls.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("no-op unless ready: reconcile on a detached attachment does nothing", async () => {
    const provider = new RecordingProvider();
    const fake = new FakeSpecProvider({ image: "img:v1", specHash: "h1", steps: [step("s1", "sh1")] });
    const att = new SandboxAttachment(provider, { image: "img:v1" }, fake.provider());

    await att.reconcile();

    expect(fake.calls).toBe(0);
    expect(provider.createImages.length).toBe(0);
    expect(att.state).toBe("detached");
  });
});

describe("SandboxAttachment wake folding", () => {
  it("wake-when-stale: a suspended attachment with a changed image cold-provisions and does NOT resume", async () => {
    const provider = new RecordingProvider({ hibernation: true });
    const fake = new FakeSpecProvider({
      image: "img:v1",
      specHash: "h1",
      steps: [step("s1", "sh1")],
    });
    const att = new SandboxAttachment(provider, { image: "img:v1" }, fake.provider());
    await att.ensureReady({ timeoutMs: 5000 });
    expect(att.observedImage()).toBe("img:v1");

    await att.suspend();
    expect(att.state).toBe("suspended");

    // The desired image changed while the sandbox was hibernated.
    fake.spec = { image: "img:v2", specHash: "h2", steps: [step("s1", "sh1")] };

    const resumed = await att.ensureReady({ timeoutMs: 5000 });

    expect(provider.resumeCalls).toEqual([]); // no resume of the stale image
    expect(provider.createImages).toEqual(["img:v1", "img:v2"]); // fresh boot
    expect(resumed.epoch).toBe(2); // re-provision bumped the epoch
    expect(att.observedImage()).toBe("img:v2");
    expect(att.state).toBe("ready");
  });

  it("wake-when-fresh: a suspended attachment with an unchanged image resumes, no re-provision", async () => {
    const provider = new RecordingProvider({ hibernation: true });
    const fake = new FakeSpecProvider({
      image: "img:v1",
      specHash: "h1",
      steps: [step("s1", "sh1")],
    });
    const att = new SandboxAttachment(provider, { image: "img:v1" }, fake.provider());
    await att.ensureReady({ timeoutMs: 5000 });
    await att.suspend();

    // Same image — a clean wake resumes and keeps the epoch.
    const resumed = await att.ensureReady({ timeoutMs: 5000 });

    expect(provider.resumeCalls).toEqual(["sb-1"]);
    expect(provider.createImages).toEqual(["img:v1"]); // no re-provision
    expect(resumed.epoch).toBe(1); // clean suspend/resume keeps the epoch
    expect(att.state).toBe("ready");
  });
});
