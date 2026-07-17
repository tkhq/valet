/**
 * Ungated unit coverage for the boot-restore routing decision
 * (`restoreOneSession`). Previously this `wf:` vs regular-session branch
 * was exercised only by the key-gated Docker E2E — this file covers it
 * without ANTHROPIC_API_KEY or Docker, per CLAUDE.md's
 * persistence-shape-drift guidance.
 */
import { describe, it, expect, vi } from "vitest";
import { restoreOneSession, type RestoreSessionDeps, type RestoreSessionMeta } from "./boot-restore.js";

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
