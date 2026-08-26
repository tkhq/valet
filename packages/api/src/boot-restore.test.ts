/**
 * Ungated unit coverage for the boot-restore routing decision
 * (`restoreOneSession`). Previously this `wf:` vs regular-session branch
 * was exercised only by the key-gated Docker E2E — this file covers it
 * without ANTHROPIC_API_KEY or Docker, per CLAUDE.md's
 * persistence-shape-drift guidance.
 */
import { describe, it, expect, vi } from "vitest";
import {
  restoreOneSession,
  runBoundedRestore,
  type RestoreSessionDeps,
  type RestoreSessionMeta,
} from "./boot-restore.js";

function makeDeps(overrides: Partial<RestoreSessionDeps> = {}): {
  deps: RestoreSessionDeps;
  ensureWorkflowSession: ReturnType<typeof vi.fn>;
  lookupAgentSession: ReturnType<typeof vi.fn>;
  sessionFor: ReturnType<typeof vi.fn>;
} {
  const ensureWorkflowSession = vi.fn(async (sessionId: string) => ({ id: sessionId }));
  const lookupAgentSession = vi.fn(
    async (): Promise<RestoreSessionMeta | undefined> => ({
      userId: "u1",
      orgId: "o1",
      workspace: "/tmp/ws",
      profile: "headless",
    }),
  );
  const sessionFor = vi.fn(async () => undefined);
  return {
    deps: { ensureWorkflowSession, lookupAgentSession, sessionFor, ...overrides },
    ensureWorkflowSession,
    lookupAgentSession,
    sessionFor,
  };
}

describe("restoreOneSession", () => {
  it("routes a wf: session id to ensureWorkflowSession, not the regular sessionFor path", async () => {
    const { deps, ensureWorkflowSession, lookupAgentSession, sessionFor } = makeDeps();

    await restoreOneSession("wf:run-1:node-1", deps);

    expect(ensureWorkflowSession).toHaveBeenCalledWith("wf:run-1:node-1");
    expect(lookupAgentSession).not.toHaveBeenCalled();
    expect(sessionFor).not.toHaveBeenCalled();
  });

  it("routes a non-wf session id to the regular lookupAgentSession/sessionFor path", async () => {
    const { deps, ensureWorkflowSession, lookupAgentSession, sessionFor } = makeDeps();

    await restoreOneSession("sess-abc", deps);

    expect(ensureWorkflowSession).not.toHaveBeenCalled();
    expect(lookupAgentSession).toHaveBeenCalledWith("sess-abc");
    expect(sessionFor).toHaveBeenCalledWith("sess-abc", {
      userId: "u1",
      orgId: "o1",
      workspace: "/tmp/ws",
      profile: "headless",
    });
  });

  it("skips a non-wf session id with no app row without calling sessionFor", async () => {
    const { deps, sessionFor } = makeDeps({
      lookupAgentSession: vi.fn(async () => undefined),
    });

    await restoreOneSession("sess-missing", deps);

    expect(sessionFor).not.toHaveBeenCalled();
  });

  it("propagates a missing-run failure from ensureWorkflowSession so a caller's per-session try/catch can isolate it", async () => {
    const { deps } = makeDeps({
      ensureWorkflowSession: vi.fn(async () => {
        throw new Error("workflow engine-deps: run not found: run-missing");
      }),
    });

    await expect(restoreOneSession("wf:run-missing:node-1", deps)).rejects.toThrow("run not found");
  });
});

describe("boot-restore loop isolation (via restoreOneSession)", () => {
  it("catching restoreOneSession per-id lets the loop continue past a missing-run wf: session", async () => {
    // Mirrors the try/catch loop body in main.ts's restoreUnsettledSessions:
    // a missing-run failure on one wf: id must not stop the next id from
    // being restored.
    const ensureWorkflowSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("workflow engine-deps: run not found: run-missing"))
      .mockResolvedValueOnce({ id: "wf:run-2:node-1" });
    const lookupAgentSession = vi.fn(async () => undefined);
    const sessionFor = vi.fn(async () => undefined);
    const deps: RestoreSessionDeps = { ensureWorkflowSession, lookupAgentSession, sessionFor };

    const ids = ["wf:run-missing:node-1", "wf:run-2:node-1"];
    const errors: unknown[] = [];
    let restored = 0;
    for (const id of ids) {
      try {
        await restoreOneSession(id, deps);
        restored++;
      } catch (err) {
        errors.push(err);
      }
    }

    expect(errors).toHaveLength(1);
    expect(restored).toBe(1);
    expect(ensureWorkflowSession).toHaveBeenCalledTimes(2);
  });
});

describe("runBoundedRestore", () => {
  const opts = { concurrency: 4, timeoutMs: 5_000 };

  it("restores every id and reports the count", async () => {
    const restore = vi.fn(async () => undefined);

    const result = await runBoundedRestore(["a", "b", "c"], restore, opts);

    expect(result).toEqual({ restored: 3, failed: 0, timedOut: 0, stopped: false });
    expect(restore).toHaveBeenCalledTimes(3);
  });

  it("isolates a rejecting session: counts it failed and restores the rest", async () => {
    const restore = vi.fn(async (id: string) => {
      if (id === "bad") throw new Error("bad row");
    });

    const result = await runBoundedRestore(["a", "bad", "c"], restore, opts);

    expect(result.restored).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.timedOut).toBe(0);
  });

  it("abandons a session past the timeout and still restores the ids behind it", async () => {
    // One id hangs forever; with concurrency 1 it sits in front of the
    // others, so only the timeout lets the queue advance — exactly the
    // wedged-sandbox case from the sha-a6eadbe rollout RCA.
    let hung: (() => void) | undefined;
    const restore = vi.fn((id: string) => {
      if (id === "wedged") return new Promise<void>((res) => (hung = res));
      return Promise.resolve();
    });

    const result = await runBoundedRestore(["wedged", "b", "c"], restore, {
      concurrency: 1,
      timeoutMs: 20,
    });

    expect(result.restored).toBe(2);
    expect(result.timedOut).toBe(1);
    expect(restore).toHaveBeenCalledTimes(3);
    hung?.(); // settle the abandoned promise so the test leaves nothing pending
  });

  it("logs a post-timeout failure instead of swallowing it", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let rejectHung: ((err: Error) => void) | undefined;
    const restore = vi.fn((id: string) => {
      if (id === "wedged") return new Promise<void>((_res, rej) => (rejectHung = rej));
      return Promise.resolve();
    });

    const result = await runBoundedRestore(["wedged", "b"], restore, {
      concurrency: 1,
      timeoutMs: 20,
    });
    expect(result.timedOut).toBe(1);
    expect(result.restored).toBe(1);

    // The abandoned attempt fails AFTER the pass completed — the late error
    // must still reach the log (it is the only trail for a session that
    // never came back), and it must not surface as an unhandledRejection.
    rejectHung?.(new Error("late auth failure"));
    await new Promise((r) => setTimeout(r, 0));
    const logged = errSpy.mock.calls.some(
      (call) => String(call[0]).includes("later failed in the background") && String(call[1]).includes("late auth failure"),
    );
    expect(logged).toBe(true);
    errSpy.mockRestore();
  });

  it("never runs more sessions at once than the concurrency cap", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const restore = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((res) => setTimeout(res, 5));
      inFlight--;
    });

    const ids = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const result = await runBoundedRestore(ids, restore, { concurrency: 3, timeoutMs: 5_000 });

    expect(result.restored).toBe(10);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // it actually parallelized
  });

  it("stops pulling new ids once shouldStop reports true", async () => {
    const restored: string[] = [];
    let calls = 0;
    const restore = vi.fn(async (id: string) => {
      restored.push(id);
    });

    const result = await runBoundedRestore(["a", "b", "c", "d"], restore, {
      concurrency: 1,
      timeoutMs: 5_000,
      shouldStop: () => ++calls > 2,
    });

    expect(result.stopped).toBe(true);
    expect(restored.length).toBeLessThan(4);
  });
});
