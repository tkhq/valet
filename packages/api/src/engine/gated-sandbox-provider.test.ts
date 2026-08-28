import { describe, expect, it } from "vitest";
import { SandboxStartupError, type Sandbox, type SandboxProvider } from "@valet/engine";
import { withSandboxCapacityGate, type CapacityGateHost } from "./gated-sandbox-provider.js";

/** Full-shape inert Sandbox (the gate never touches the handle; only `id`
 * is read by tests). */
function fakeSandbox(id: string): Sandbox {
  return {
    id,
    readFile: async () => "",
    readBinary: async () => new Uint8Array(),
    writeFile: async () => {},
    writeBinary: async () => {},
    readdir: async () => [],
    stat: async () => ({ isFile: true, isDirectory: false, size: 0 }),
    mkdir: async () => {},
    rm: async () => {},
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
}

function fakeInner(overrides: Partial<SandboxProvider> = {}): SandboxProvider & { created: string[] } {
  const created: string[] = [];
  return {
    backend: "fake",
    capabilities: () => ({
      snapshot: "none",
      persistentWorkspace: false,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      customImage: false,
    }),
    create: async (opts) => {
      created.push(opts.sessionId ?? "?");
      return fakeSandbox(`sbx-${created.length}`);
    },
    restore: async (id) => fakeSandbox(id),
    destroy: async () => {},
    status: async (id) => ({ id, state: "ready" as const }),
    created,
    ...overrides,
  };
}

/**
 * Fake gate host. `countLive` mirrors the real semantics: cached sessions
 * with a `provisioning` or `ready` attachment — which INCLUDES every
 * session currently inside `gated.create()` (its attachment went
 * `provisioning` before the provider was called). Tests set `others` (the
 * org's ready pods outside the gate) and the fake adds the in-gate count
 * the test tracks via enter/leave.
 */
function fakeHost(overrides: { orgOf?: Record<string, string | null> } = {}) {
  const others = new Map<string, number>();
  const inGate = new Map<string, number>();
  const host: CapacityGateHost = {
    sessionOrgId: (sessionId) =>
      overrides.orgOf && sessionId in overrides.orgOf ? overrides.orgOf[sessionId] : "org1",
    countLiveSandboxSessions: (orgId) => (others.get(orgId) ?? 0) + (inGate.get(orgId) ?? 0),
  };
  return {
    host,
    setOthers: (orgId: string, n: number) => others.set(orgId, n),
    /** Track one session entering/leaving the gated create (its attachment
     * would be `provisioning` for that whole window in the real host). */
    enter: (orgId: string) => inGate.set(orgId, (inGate.get(orgId) ?? 0) + 1),
    leave: (orgId: string) => inGate.set(orgId, (inGate.get(orgId) ?? 0) - 1),
  };
}

/** Drive a gated create the way the attachment does: the session's
 * attachment is `provisioning` from before create() until (in these
 * tests) the create settles. */
async function createAs(
  gated: SandboxProvider,
  h: ReturnType<typeof fakeHost>,
  orgId: string,
  sessionId: string,
): Promise<Sandbox> {
  h.enter(orgId);
  try {
    return await gated.create({ sessionId });
  } finally {
    h.leave(orgId);
  }
}

describe("withSandboxCapacityGate", () => {
  it("ceiling <= 0 returns the inner provider untouched", () => {
    const inner = fakeInner();
    const gated = withSandboxCapacityGate(inner, { ceiling: 0, waitMs: 0, host: () => null });
    expect(gated).toBe(inner);
  });

  it("admits under the ceiling and delegates create", async () => {
    const inner = fakeInner();
    const h = fakeHost();
    h.setOthers("org1", 2);
    const gated = withSandboxCapacityGate(inner, { ceiling: 5, waitMs: 0, host: () => h.host });

    const sb = await createAs(gated, h, "org1", "s1");

    expect(sb.id).toBe("sbx-1");
    expect(inner.created).toEqual(["s1"]);
  });

  it("fails fast at the ceiling when waitMs is 0, naming the corrective action", async () => {
    const inner = fakeInner();
    const h = fakeHost();
    h.setOthers("org1", 5);
    const gated = withSandboxCapacityGate(inner, { ceiling: 5, waitMs: 0, host: () => h.host });

    await expect(createAs(gated, h, "org1", "s1")).rejects.toThrow(SandboxStartupError);
    await expect(createAs(gated, h, "org1", "s1")).rejects.toThrow(/VALET_ORG_SANDBOX_CEILING/);
    expect(inner.created).toEqual([]);
  });

  it("a waiter admits once capacity frees", async () => {
    const inner = fakeInner();
    const h = fakeHost();
    h.setOthers("org1", 5);
    const gated = withSandboxCapacityGate(inner, {
      ceiling: 5,
      waitMs: 5_000,
      pollIntervalMs: 5,
      host: () => h.host,
    });

    const pending = createAs(gated, h, "org1", "s1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inner.created).toEqual([]); // still waiting
    h.setOthers("org1", 4); // a sandbox freed

    const sb = await pending;
    expect(sb.id).toBe("sbx-1");
  });

  it("a burst cannot over-admit, including through the post-create prep window", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let createCalls = 0;
    const inner = fakeInner({
      create: async (opts) => {
        createCalls += 1;
        if (createCalls <= 2) {
          // The first two creates RESOLVE quickly — in the real system
          // their attachments stay `provisioning` through prep, which
          // `createAs`'s enter/leave models by holding the count until
          // the whole gated create settles. The gate must not re-admit
          // against their freed in-create state.
          return fakeSandbox(opts.sessionId ?? "?");
        }
        await blocked;
        return fakeSandbox(opts.sessionId ?? "?");
      },
    });
    const h = fakeHost();
    const gated = withSandboxCapacityGate(inner, {
      ceiling: 2,
      waitMs: 150,
      pollIntervalMs: 5,
      host: () => h.host,
    });

    // a and b admit and resolve; their sessions stay live (prep → ready):
    // model by moving them into `others` after the create settles.
    await createAs(gated, h, "org1", "a");
    await createAs(gated, h, "org1", "b");
    h.setOthers("org1", 2);

    // c must wait the full window and time out — the two slots are held
    // by a and b even though their create() calls resolved long ago.
    const outcome = await createAs(gated, h, "org1", "c").then(
      () => "admitted",
      (err: unknown) => (err instanceof SandboxStartupError ? "timeout" : "other"),
    );
    release?.();

    expect(outcome).toBe("timeout");
    expect(createCalls).toBe(2); // only a and b ever reached the provider
  });

  it("waiters do not deadlock against each other's provisioning attachments", async () => {
    const inner = fakeInner();
    const h = fakeHost();
    const gated = withSandboxCapacityGate(inner, {
      ceiling: 2,
      waitMs: 1_000,
      pollIntervalMs: 5,
      host: () => h.host,
    });

    // Three concurrent creates, zero existing pods: all three attachments
    // read `provisioning` (counted by the host), all three park at the
    // gate. Subtracting the waiting set is what lets two of them through.
    const results = await Promise.all([
      createAs(gated, h, "org1", "a").then(
        () => "admitted",
        () => "rejected",
      ),
      createAs(gated, h, "org1", "b").then(
        () => "admitted",
        () => "rejected",
      ),
      createAs(gated, h, "org1", "c").then(
        () => "admitted",
        () => "rejected",
      ),
    ]);

    expect(results.filter((r) => r === "admitted").length).toBeGreaterThanOrEqual(2);
  });

  it("a session destroyed while waiting abandons its create instead of eating the next slot", async () => {
    const inner = fakeInner();
    const orgOf: Record<string, string | null> = { s1: "org1" };
    const h = fakeHost({ orgOf });
    h.setOthers("org1", 5);
    const gated = withSandboxCapacityGate(inner, {
      ceiling: 5,
      waitMs: 5_000,
      pollIntervalMs: 5,
      host: () => h.host,
    });

    const pending = createAs(gated, h, "org1", "s1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    orgOf.s1 = null; // session evicted/destroyed
    h.setOthers("org1", 4); // capacity frees right after

    await expect(pending).rejects.toThrow(/left the host cache while waiting/);
    expect(inner.created).toEqual([]);
  });

  it("a stale (evicted) waiter does not free a slot for the waiters behind it", async () => {
    const inner = fakeInner();
    const orgOf: Record<string, string | null> = { a: "org1", b: "org1" };
    const h = fakeHost({ orgOf });
    h.setOthers("org1", 5);
    const gated = withSandboxCapacityGate(inner, {
      ceiling: 5,
      waitMs: 200,
      pollIntervalMs: 5,
      host: () => h.host,
    });

    // a is driven by hand (not createAs): its attachment leaves the count
    // at EVICTION time, exactly once — a finally-based leave would double
    // count the departure.
    h.enter("org1");
    const aPending = gated.create({ sessionId: "a" });
    const bPending = createAs(gated, h, "org1", "b");
    await new Promise((resolve) => setTimeout(resolve, 15));
    // a's session is evicted: its attachment leaves the count immediately,
    // but its waiting entry survives until a's own next poll. b must not
    // read that stale entry as freed capacity — the 5 other pods are still
    // running.
    orgOf.a = null;
    h.leave("org1");

    const [aOut, bOut] = await Promise.all([
      aPending.then(
        () => "admitted",
        (err: unknown) => (err instanceof Error && /left the host cache/.test(err.message) ? "abandoned" : "other"),
      ),
      bPending.then(
        () => "admitted",
        (err: unknown) => (err instanceof SandboxStartupError ? "timeout" : "other"),
      ),
    ]);

    expect(aOut).toBe("abandoned");
    expect(bOut).toBe("timeout");
    expect(inner.created).toEqual([]);
  });

  it("admits ungated when the host is not yet bound or the org is unresolvable", async () => {
    const inner = fakeInner();
    const gatedNoHost = withSandboxCapacityGate(inner, { ceiling: 1, waitMs: 0, host: () => null });
    await gatedNoHost.create({ sessionId: "s1" });

    const h = fakeHost({ orgOf: { s2: null } });
    h.setOthers("org1", 99);
    const gated = withSandboxCapacityGate(inner, { ceiling: 1, waitMs: 0, host: () => h.host });
    await gated.create({ sessionId: "s2" }); // uncached session
    await gated.create({}); // no sessionId at all

    expect(inner.created).toHaveLength(3);
  });

  it("orgs do not contend with each other", async () => {
    const inner = fakeInner();
    const h = fakeHost({ orgOf: { a: "org1", b: "org2" } });
    h.setOthers("org1", 5);
    const gated = withSandboxCapacityGate(inner, { ceiling: 5, waitMs: 0, host: () => h.host });

    await expect(createAs(gated, h, "org1", "a")).rejects.toThrow(SandboxStartupError);
    await expect(createAs(gated, h, "org2", "b")).resolves.toBeDefined();
  });

  it("preserves optional-member ABSENCE (capability presence checks stay honest)", () => {
    const bare = fakeInner();
    const gatedBare = withSandboxCapacityGate(bare, { ceiling: 1, waitMs: 0, host: () => null });
    expect(gatedBare.updateCreds).toBeUndefined();
    expect(gatedBare.deriveId).toBeUndefined();
    expect(gatedBare.list).toBeUndefined();
    expect(gatedBare.suspend).toBeUndefined();
    expect(gatedBare.sweepWorkspaceCheckpoints).toBeUndefined();

    const full = fakeInner({
      deriveId: (key) => `d-${key}`,
      updateCreds: async () => {},
    });
    const gatedFull = withSandboxCapacityGate(full, { ceiling: 1, waitMs: 0, host: () => null });
    expect(gatedFull.deriveId?.("k")).toBe("d-k");
    expect(gatedFull.updateCreds).toBeDefined();
    expect(gatedFull.list).toBeUndefined();
  });

  it("forwards sweepWorkspaceCheckpoints so the periodic sweep can start", async () => {
    // Regression: the wrapper dropped this member, so main.ts saw
    // `undefined` and silently never started the checkpoint sweep timer.
    let swept = 0;
    const inner = fakeInner({
      sweepWorkspaceCheckpoints: async () => {
        swept += 1;
      },
    });
    const gated = withSandboxCapacityGate(inner, { ceiling: 1, waitMs: 0, host: () => null });
    expect(gated.sweepWorkspaceCheckpoints).toBeDefined();
    await gated.sweepWorkspaceCheckpoints?.();
    expect(swept).toBe(1);
  });
});
