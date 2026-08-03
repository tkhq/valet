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
  private isolated: boolean;
  // Optional seams: assigned as instance properties ONLY when enabled so the
  // attachment's `provider.release ?`/`provider.resume ?` capability checks see
  // them as absent otherwise (deleting a prototype method would not work).
  release?: (id: string) => Promise<void>;
  suspend?: (id: string) => Promise<void>;
  resume?: (id: string) => Promise<void>;

  constructor(opts: { hibernation?: boolean; release?: boolean; isolated?: boolean } = {}) {
    this.hibernation = opts.hibernation ?? false;
    // Default isolated:true so existing image-drift tests still exercise the
    // pod-replace branch (decision 8 gates it on isolation). A non-isolated
    // provider (opts.isolated:false) must never pod-replace.
    this.isolated = opts.isolated ?? true;
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
      isolated: this.isolated,
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

  it("deleted applied file + stock session: re-applies in place, rewritten file carries createOpts image not \"\"", async () => {
    // Regression: observe() previously normalized a null readAppliedState into
    // { image: "" }, so the rewritten applied file would carry "image":"" —
    // observed live after a delete-file + reconcile cycle.
    const provider = new RecordingProvider();
    const applied: string[] = [];
    const fake = new FakeSpecProvider({
      // desired.image is undefined — stock session, no prebuild image requirement.
      specHash: "h1",
      steps: [
        step("s1", "sh1", async () => {
          applied.push("s1");
        }),
      ],
    });
    const att = await reachReady(provider, fake, { image: "stock:latest" });
    applied.length = 0;

    // Simulate the applied-state file being deleted from the sandbox.
    const sb = att.current();
    if (!sb) throw new Error("expected ready sandbox");
    await sb.exec('rm -f /etc/valet/applied.json');

    // Advance past the observation TTL so observe() re-reads the (now missing) file.
    await new Promise((r) => setTimeout(r, 0));
    // Manually expire the cache by wiping it through a fresh reconcile after
    // forcing the observation timestamp to be stale. We do this by running
    // reconcile with a faked-stale cache via vi.useFakeTimers inside the test.
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(OBSERVE_TTL_MS + 1);
      // Drift a step so reconcile has something to re-apply in place.
      fake.spec = {
        specHash: "h2",
        steps: [
          step("s1", "sh1-NEW", async () => {
            applied.push("s1");
          }),
        ],
      };
      await att.reconcile();
    } finally {
      vi.useRealTimers();
    }

    // Steps were re-applied in place (no new provision).
    expect(provider.createImages.length).toBe(1);
    expect(applied).toEqual(["s1"]);
    expect(att.currentEpoch()).toBe(1);

    // The rewritten applied file must carry createOpts.image, not "".
    const state = await readAppliedState(sb);
    expect(state).not.toBeNull();
    expect(state!.image).toBe("stock:latest");
    // observedImage() must also reflect the real image, not "".
    expect(att.observedImage()).toBe("stock:latest");
  });

  it("deleted applied file + desired.image equal to boot image: no replacement, re-applies in place", async () => {
    // Regression: when desired.image === createOpts.image, the missing file
    // must NOT be mistaken for image drift. If observe() returns image:"" but
    // desired.image is "valet-sandbox:dev", the comparison "" !== "valet-sandbox:dev"
    // would force a full pod replacement after any pod restart, where an
    // in-place re-apply was sufficient (the restarted pod runs the same image).
    const provider = new RecordingProvider();
    const bootImage = "valet-sandbox:dev";
    const applied: string[] = [];
    const fake = new FakeSpecProvider({
      image: bootImage,
      specHash: "h1",
      steps: [
        step("s1", "sh1", async () => {
          applied.push("s1");
        }),
      ],
    });
    const att = await reachReady(provider, fake, { image: bootImage });
    applied.length = 0;

    // Simulate a pod restart: delete the applied-state file.
    const sb = att.current();
    if (!sb) throw new Error("expected ready sandbox");
    await sb.exec('rm -f /etc/valet/applied.json');

    // Expire the observation cache, then drift a step so there is work to do.
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(OBSERVE_TTL_MS + 1);
      fake.spec = {
        image: bootImage,
        specHash: "h2",
        steps: [
          step("s1", "sh1-DRIFTED", async () => {
            applied.push("s1");
          }),
        ],
      };
      await att.reconcile();
    } finally {
      vi.useRealTimers();
    }

    // Must NOT have re-provisioned — no new provider.create call.
    expect(provider.createImages.length).toBe(1);
    expect(att.currentEpoch()).toBe(1);
    // Step was re-applied in place.
    expect(applied).toEqual(["s1"]);
    expect(att.observedImage()).toBe(bootImage);
  });

  it("existing behavior pin: desired.image genuinely different from booted image still replaces", async () => {
    // Confirm the fix does not suppress legitimate image-drift replacements.
    // When desired.image differs from what createOpts.image was booted with,
    // reconcile must still bump the epoch and re-provision.
    const provider = new RecordingProvider();
    const fake = new FakeSpecProvider({
      image: "img:v1",
      specHash: "h1",
      steps: [step("s1", "sh1")],
    });
    const att = await reachReady(provider, fake, { image: "img:v1" });
    expect(provider.createImages).toEqual(["img:v1"]);

    // Change the desired image to a genuinely different value.
    fake.spec = { image: "img:v2", specHash: "h2", steps: [step("s1", "sh1")] };

    await att.reconcile();
    // Let the replacement re-provision complete.
    await att.ensureReady({ timeoutMs: 5000 });

    expect(att.currentEpoch()).toBe(2); // epoch bumped → replacement happened
    expect(provider.createImages).toEqual(["img:v1", "img:v2"]);
    expect(att.observedImage()).toBe("img:v2");
  });

  it("non-isolated backend never pod-replaces on image drift; steps still converge (decision 8, I5)", async () => {
    // A non-isolated provider (docker/local/virtual shape) must skip the
    // image-replace branch entirely even when desired.image differs, and fall
    // through to step-drift convergence in place.
    const provider = new RecordingProvider({ isolated: false });
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

    // Drift BOTH the image and a step hash. The image drift must be ignored
    // (non-isolated), but the step drift must still converge in place.
    fake.spec = {
      image: "img:v2",
      specHash: "h2",
      steps: [
        step("s1", "sh1-NEW", async () => {
          applied.push("s1");
        }),
      ],
    };

    await att.reconcile();

    expect(att.currentEpoch()).toBe(1); // NO replace → epoch unchanged
    expect(provider.createImages).toEqual(["img:v1"]); // no second create
    expect(applied).toEqual(["s1"]); // step drift converged in place
  });

  it("failed non-critical step is NOT cache-applied and re-runs on the next reconcile within TTL (decision 10)", async () => {
    // C1 regression: step A succeeds, step B fails non-critically on the first
    // reconcile. A second reconcile WITHIN OBSERVE_TTL_MS (trusting the cache,
    // no file re-read) must RE-RUN step B rather than treat it as applied. Once
    // B succeeds, the cache and the applied file agree.
    const provider = new RecordingProvider();
    const aCalls: number[] = [];
    let bAttempts = 0;
    let bShouldFail = true;
    const nonCritical = (id: string, hash: string, apply: (sb: Sandbox) => Promise<void>): PrepStep => ({
      id,
      hash,
      critical: false,
      apply,
    });
    const mkSteps = () => [
      nonCritical("a", "ah1", async () => {
        aCalls.push(bAttempts);
      }),
      nonCritical("b", "bh1", async () => {
        bAttempts++;
        if (bShouldFail) throw new Error("step b transient failure");
      }),
    ];
    const fake = new FakeSpecProvider({ image: "img:v1", specHash: "h1", steps: mkSteps() });
    // Boot with no desired steps applied yet: use createOpts.image only, then
    // drift the spec so reconcile runs the full plan (a fresh boot already ran
    // the plan once, so start from an empty applied file for clarity).
    const att = new SandboxAttachment(provider, { image: "img:v1" }, fake.provider());
    await att.ensureReady({ timeoutMs: 5000 });

    // Wipe the applied file so the next reconcile diffs against empty state and
    // runs both steps. (The boot apply already ran a=ok, b=fail once.)
    const sb = att.current();
    if (!sb) throw new Error("expected a ready sandbox");
    await sb.exec("rm -f /etc/valet/applied.json");
    // Force the cached observation to be re-read from the (now empty) file by
    // pushing its timestamp past the TTL is not exposed; instead drift the spec
    // hash so diffSteps runs the steps regardless of the stale cache read.
    fake.spec = { image: "img:v1", specHash: "h2", steps: mkSteps() };

    aCalls.length = 0;
    bAttempts = 0;

    // First reconcile: a ok, b fails non-critically.
    await att.reconcile();
    expect(bAttempts).toBe(1); // b ran once and failed

    // The applied file must NOT record b (it failed non-critically); a is there.
    const stateAfterFail = await readAppliedState(sb);
    expect(stateAfterFail?.steps.a).toBe("ah1");
    expect(stateAfterFail?.steps.b).toBeUndefined();

    // Second reconcile WITHIN the TTL — trusts the in-memory cache (no file
    // re-read). Because the cache reflects the ACTUAL applied state (b absent),
    // b MUST be re-run. Make it succeed this time.
    bShouldFail = false;
    await att.reconcile();
    expect(bAttempts).toBe(2); // b re-ran — the whole point of the fix

    // Now the cache and the file agree: both a and b are applied.
    const stateAfterSuccess = await readAppliedState(sb);
    expect(stateAfterSuccess?.steps).toEqual({ a: "ah1", b: "bh1" });
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
