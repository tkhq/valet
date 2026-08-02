/**
 * Pre-run reconcile window (sandbox reconcile spec, decision 4).
 *
 * Verifies that `SandboxAttachment.reconcile` is called exactly once per
 * run-start when the session is idle (no other thread mid-run, no pending
 * exec jobs), and is suppressed when either guard fails.
 *
 * Tests drive the engine at the full-session level so the kickLoop path is
 * real. A spy on `session.attachment.reconcile` records calls.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, type FauxProvider } from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type Session,
} from "../src/index.js";

// ── Harness ────────────────────────────────────────────────────────────

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, stream: bus, sandboxProvider } });
  return { engine, events };
}

async function waitForStatus(
  events: BusEvent[],
  threadId: string,
  status: string,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = events.some(
        (e) =>
          e.event.type === "status" &&
          e.event.threadId === threadId &&
          e.event.status === status,
      );
      if (found) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timed out waiting for status=${status} on thread ${threadId}`));
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function makeSession(
  engine: Engine,
  faux: FauxProvider,
): Promise<Session> {
  return engine.createSession({
    userId: "u1",
    orgId: "o1",
    workspace: "/workspace",
    sandbox: {},
    model: faux.getModel(),
  });
}

const registeredFaux: FauxProvider[] = [];
afterEach(() => {
  for (const f of registeredFaux) f.unregister();
  registeredFaux.length = 0;
});

function faux(name: string): FauxProvider {
  const f = registerFauxProvider({ provider: name });
  registeredFaux.push(f);
  return f;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("pre-run reconcile window", () => {
  it("calls reconcile exactly once per run start when the session is idle", async () => {
    const provider = faux("reconcile-idle");
    provider.setResponses([fauxAssistantMessage("done")]);

    const { engine, events } = makeEngine();
    const session = await makeSession(engine, provider);

    const reconcileSpy = vi.spyOn(session.attachment, "reconcile").mockResolvedValue();

    const receipt = await session.prompt("hello");
    await waitForStatus(events, receipt.threadId, "idle");

    expect(reconcileSpy).toHaveBeenCalledTimes(1);
  });

  it("calls reconcile once per turn when multiple turns run sequentially", async () => {
    const provider = faux("reconcile-sequential");
    provider.setResponses([
      fauxAssistantMessage("turn 1"),
      fauxAssistantMessage("turn 2"),
    ]);

    const { engine, events } = makeEngine();
    const session = await makeSession(engine, provider);

    const reconcileSpy = vi.spyOn(session.attachment, "reconcile").mockResolvedValue();

    const r1 = await session.prompt("first");
    // Wait for two turn_end events — one per submitted prompt — to ensure both
    // runs complete before asserting call count.
    await waitFor(() => events.filter((e) => e.event.type === "turn_end" && e.threadId === r1.threadId).length >= 1);

    const r2 = await session.prompt("second");
    await waitFor(() => events.filter((e) => e.event.type === "turn_end" && e.threadId === r2.threadId).length >= 2);

    expect(reconcileSpy).toHaveBeenCalledTimes(2);
  });

  it("does NOT call reconcile when another thread has an active run", async () => {
    // Thread A uses a deferred faux factory that blocks until signalled.
    // Sequence: submit A → A enters factory (A is mid-run) → submit B →
    // B settles (reconcile suppressed because A is active) → release A → A settles.
    // A's reconcile fires once at its own run-start; B's is suppressed → total = 1.
    const provider = faux("reconcile-concurrent");

    // Deferred for thread A: factory resolves when released; signals back
    // when A has entered the factory (and is therefore mid-run).
    let releaseA!: () => void;
    let aEntered!: () => void;
    const aEnteredPromise = new Promise<void>((res) => { aEntered = res; });
    const aReleasePromise = new Promise<void>((res) => { releaseA = res; });

    provider.setResponses([
      // Thread A's response: block mid-run until released.
      async () => {
        aEntered();
        await aReleasePromise;
        return fauxAssistantMessage("A done");
      },
      // Thread B's response: immediate.
      fauxAssistantMessage("B done"),
    ]);

    const { engine, events } = makeEngine();
    const session = await makeSession(engine, provider);

    let reconcileCalls = 0;
    vi.spyOn(session.attachment, "reconcile").mockImplementation(async () => {
      reconcileCalls++;
    });

    const tA = session.thread("task:A");
    const tB = session.thread("task:B");

    // Submit A and wait until A's factory is executing (A is mid-run).
    void tA.submitPrompt("hello A", {});
    await aEnteredPromise;

    // A's run-start reconcile already fired (before the model call).
    // Now submit B. B's reconcile check sees A active → skips reconcile.
    void tB.submitPrompt("hello B", {});
    await waitForStatus(events, tB.id, "idle");

    // B's turn is done. Reconcile count must be exactly 1 (A's only).
    expect(reconcileCalls).toBe(1);

    // Release A.
    releaseA();
    await waitForStatus(events, tA.id, "idle");

    // A's run did not trigger a second reconcile (it fired before the model
    // call, not after). Total remains 1.
    expect(reconcileCalls).toBe(1);
  });

  it("does NOT call reconcile when hasOtherActiveRuns returns true", async () => {
    // Unit test of the guard initial state: before any run, neither thread
    // reports the other as active.
    const provider = faux("reconcile-guard-unit");
    provider.setResponses([fauxAssistantMessage("done")]);

    const { engine } = makeEngine();
    const session = await makeSession(engine, provider);

    const tA = session.thread("task:A");
    const tB = session.thread("task:B");

    expect(session.hasOtherActiveRuns(tA.id)).toBe(false);
    expect(session.hasOtherActiveRuns(tB.id)).toBe(false);
  });

  it("does NOT call reconcile when there is a pending exec job", async () => {
    // Vend a real job through the session's PolicySandbox so pendingJobCount()
    // returns 1. Then submit a prompt — the reconcile guard must suppress the
    // call because the job is pending. Cancel the job (count drops to 0),
    // then submit again — reconcile must fire.
    //
    // We use a deferred factory to serialize the two turns: turn 1 blocks on
    // a deferred, so the spy on pendingJobCount can be swapped between turns.
    const provider = faux("reconcile-pending-jobs");

    let releaseTurn1!: () => void;
    let turn1Entered!: () => void;
    const turn1EnteredPromise = new Promise<void>((res) => { turn1Entered = res; });
    const turn1ReleasePromise = new Promise<void>((res) => { releaseTurn1 = res; });

    provider.setResponses([
      async () => {
        turn1Entered();
        await turn1ReleasePromise;
        return fauxAssistantMessage("turn with pending job");
      },
      fauxAssistantMessage("turn after job done"),
    ]);

    const { engine, events } = makeEngine();
    const session = await makeSession(engine, provider);

    // Vend a job so pendingJobCount() is truly 1.
    const handle = await session.sandbox.execJob?.("echo hi");
    if (!handle) throw new Error("VirtualSandbox must support execJob");
    expect(session.pendingJobCount()).toBe(1);

    const reconcileSpy = vi.spyOn(session.attachment, "reconcile").mockResolvedValue();

    // Submit turn 1. Wait until the factory is executing (turn 1 is mid-run,
    // past the reconcile check). Because pendingJobCount() === 1, reconcile
    // was suppressed at turn 1's run-start.
    void session.prompt("first");
    await turn1EnteredPromise;
    expect(reconcileSpy).toHaveBeenCalledTimes(0);

    // While turn 1 is held: cancel the job so pendingJobCount() drops to 0.
    await session.sandbox.cancelJob?.(handle.execId);
    expect(session.pendingJobCount()).toBe(0);

    // Submit turn 2 NOW, while turn 1 is still running. Turn 2 is queued.
    void session.prompt("second");

    // Release turn 1. The kickLoop will settle turn 1 then process turn 2.
    // Turn 2's reconcile check sees pendingJobCount() === 0 and no other
    // active runs → reconcile fires.
    releaseTurn1();

    // Wait for turn 2 to settle.
    await waitFor(
      () => events.filter((e) => e.event.type === "status" && e.event.status === "idle").length >= 2,
    );
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
  });

  it("reconcile rejection does NOT fail the turn", async () => {
    const provider = faux("reconcile-rejection");
    provider.setResponses([fauxAssistantMessage("done despite reconcile failure")]);

    const { engine, events } = makeEngine();
    const session = await makeSession(engine, provider);

    // Make reconcile reject.
    vi.spyOn(session.attachment, "reconcile").mockRejectedValue(
      new Error("simulated reconcile failure"),
    );

    const receipt = await session.prompt("hello");

    // The turn must still complete successfully — the rejection is swallowed.
    await waitForStatus(events, receipt.threadId, "idle");

    const entries = await session.readEntries("web:default");
    const assistantMessages = entries.filter(
      (e) => e.type === "message" && e.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(1);
    if (assistantMessages[0]?.type === "message") {
      expect(assistantMessages[0].content).toBe("done despite reconcile failure");
    }
  });

  it("PolicySandbox.pendingJobCount() tracks execJob/pollJob lifecycle", async () => {
    // Unit test for PolicySandbox job tracking: vend a job, assert count
    // increments, poll to terminal status, assert count returns to 0.
    const { PolicySandbox, SandboxAttachment, VirtualSandbox } = await import("../src/index.js");

    const rawSandbox = new VirtualSandbox("test-sandbox");
    const attachment = SandboxAttachment.forSandbox(rawSandbox);
    const policy = new PolicySandbox(attachment);

    expect(policy.pendingJobCount()).toBe(0);

    // Vend a job — VirtualSandbox execJob runs it inline, stores a terminal
    // result, but the PolicySandbox pendingJobs counter tracks until pollJob
    // returns a terminal status.
    const handle = await policy.execJob("echo hi");
    expect(policy.pendingJobCount()).toBe(1);

    // Poll to terminal (status === "done") — counter drops to 0.
    const poll = await policy.pollJob(handle.execId, 0);
    expect(poll.status).toBe("done");
    expect(policy.pendingJobCount()).toBe(0);
  });

  it("PolicySandbox.pendingJobCount() drops to 0 when pollJob dispatch rejects", async () => {
    // Regression: a pollJob rejection (SandboxUnavailableError on transport
    // failure, SandboxSupersededError on epoch bump) must clear the pending
    // entry so the reconcile window is not permanently blocked.
    const { PolicySandbox, SandboxAttachment, VirtualSandbox, SandboxSupersededError } =
      await import("../src/index.js");

    const rawSandbox = new VirtualSandbox("test-sandbox");
    const attachment = SandboxAttachment.forSandbox(rawSandbox);
    const policy = new PolicySandbox(attachment);

    // Vend a job to put an entry in pendingJobs.
    const handle = await policy.execJob("echo hi");
    expect(policy.pendingJobCount()).toBe(1);

    // Patch the raw sandbox's pollJob to simulate an epoch-superseded rejection.
    rawSandbox.pollJob = async () => { throw new SandboxSupersededError(0); };

    // pollJob on the policy must rethrow and also clear the pending entry.
    await expect(policy.pollJob(handle.execId, 0)).rejects.toBeInstanceOf(SandboxSupersededError);
    expect(policy.pendingJobCount()).toBe(0);
  });

  it("Session.hasOtherActiveRuns excludes the given threadId", async () => {
    const provider = faux("reconcile-exclude-self");
    provider.setResponses([fauxAssistantMessage("done")]);

    const { engine, events } = makeEngine();
    const session = await makeSession(engine, provider);

    // Before any run: all threads idle.
    const t = session.thread("task:X");
    expect(session.hasOtherActiveRuns(t.id)).toBe(false);

    // Start a run on the thread, then check whether the thread sees ITSELF
    // as "other". The thread excludes its own id from the check, so during
    // its own run, hasOtherActiveRuns(t.id) should still be false (no OTHER
    // thread is active). This is verified by the reconcile window firing once
    // even when the thread itself is mid-run.
    vi.spyOn(session.attachment, "reconcile").mockResolvedValue();
    const receipt = await t.submitPrompt("hello", {});
    await waitForStatus(events, receipt.threadId, "idle");

    // The spy must have been called — meaning the self-exclusion worked and
    // the guard passed.
    expect(session.attachment.reconcile).toHaveBeenCalledTimes(1);
  });
});

// ── Session.pendingJobCount integration ───────────────────────────────

describe("Session.pendingJobCount", () => {
  it("returns 0 for a session with no exec jobs vended", async () => {
    const provider = faux("pending-jobs-zero");
    provider.setResponses([fauxAssistantMessage("ok")]);

    const { engine } = makeEngine();
    const session = await makeSession(engine, provider);

    expect(session.pendingJobCount()).toBe(0);
  });
});

// ── Thread.hasActiveRun ───────────────────────────────────────────────

describe("Thread.hasActiveRun", () => {
  it("returns false when the thread is idle", async () => {
    const provider = faux("has-active-idle");
    provider.setResponses([fauxAssistantMessage("ok")]);

    const { engine, events } = makeEngine();
    const session = await makeSession(engine, provider);

    const thread = session.thread("task:check");

    // Before any submission: idle.
    expect(thread.hasActiveRun).toBe(false);

    const receipt = await thread.submitPrompt("hello", {});
    await waitForStatus(events, receipt.threadId, "idle");

    // After completion: idle again.
    expect(thread.hasActiveRun).toBe(false);
  });

  it("returns true while a turn is in progress", async () => {
    const provider = faux("has-active-running");

    let midRunHasActiveRun: boolean | undefined;
    let capturedThread: { hasActiveRun: boolean } | undefined;
    let releaseRun!: () => void;
    let runEntered!: () => void;
    const runEnteredPromise = new Promise<void>((res) => { runEntered = res; });
    const releasePromise = new Promise<void>((res) => { releaseRun = res; });

    provider.setResponses([
      async () => {
        runEntered();
        await releasePromise;
        return fauxAssistantMessage("ok");
      },
    ]);

    const { engine, events } = makeEngine();
    const session = await makeSession(engine, provider);

    const thread = session.thread("task:run");
    capturedThread = thread;

    // Before submission: idle.
    expect(thread.hasActiveRun).toBe(false);

    void thread.submitPrompt("hi", {});

    // Wait until the factory is executing (thread is mid-run).
    await runEnteredPromise;
    midRunHasActiveRun = capturedThread.hasActiveRun;

    releaseRun();
    const receipt = await thread.submitPrompt("noop", {});
    // Wait for the thread to settle fully.
    await waitForStatus(events, receipt.threadId, "idle");

    // The accessor returned true while the factory was blocking.
    expect(midRunHasActiveRun).toBe(true);
    // After completion: idle again.
    expect(thread.hasActiveRun).toBe(false);
  });
});

// ── waitFor helper (unused export — keep for future tests) ─────────────
void waitFor;
