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

function fakeHost(overrides: { orgOf?: Record<string, string>; ready?: Record<string, number> } = {}): {
  host: CapacityGateHost;
  setReady: (orgId: string, n: number) => void;
} {
  const ready = new Map(Object.entries(overrides.ready ?? {}));
  return {
    host: {
      sessionOrgId: (sessionId) => overrides.orgOf?.[sessionId] ?? "org1",
      countReadySandboxSessions: (orgId) => ready.get(orgId) ?? 0,
    },
    setReady: (orgId, n) => ready.set(orgId, n),
  };
}

describe("withSandboxCapacityGate", () => {
  it("ceiling <= 0 returns the inner provider untouched", () => {
    const inner = fakeInner();
    const gated = withSandboxCapacityGate(inner, { ceiling: 0, waitMs: 0, host: () => null });
    expect(gated).toBe(inner);
  });

  it("admits under the ceiling and delegates create", async () => {
    const inner = fakeInner();
    const { host } = fakeHost({ ready: { org1: 2 } });
    const gated = withSandboxCapacityGate(inner, { ceiling: 5, waitMs: 0, host: () => host });

    const sb = await gated.create({ sessionId: "s1" });

    expect(sb.id).toBe("sbx-1");
    expect(inner.created).toEqual(["s1"]);
  });

  it("fails fast at the ceiling when waitMs is 0, naming the corrective action", async () => {
    const inner = fakeInner();
    const { host } = fakeHost({ ready: { org1: 5 } });
    const gated = withSandboxCapacityGate(inner, { ceiling: 5, waitMs: 0, host: () => host });

    await expect(gated.create({ sessionId: "s1" })).rejects.toThrow(SandboxStartupError);
    await expect(gated.create({ sessionId: "s1" })).rejects.toThrow(/VALET_ORG_SANDBOX_CEILING/);
    expect(inner.created).toEqual([]);
  });

  it("a waiter admits once capacity frees", async () => {
    const inner = fakeInner();
    const { host, setReady } = fakeHost({ ready: { org1: 5 } });
    const gated = withSandboxCapacityGate(inner, {
      ceiling: 5,
      waitMs: 5_000,
      pollIntervalMs: 5,
      host: () => host,
    });

    const pending = gated.create({ sessionId: "s1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inner.created).toEqual([]); // still waiting
    setReady("org1", 4); // a sandbox freed

    const sb = await pending;
    expect(sb.id).toBe("sbx-1");
  });

  it("counts its own admitted-but-not-ready creates (a burst cannot over-admit)", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = fakeInner({
      create: async (opts) => {
        await blocked; // hold every admitted create in flight
        return fakeSandbox(opts.sessionId ?? "?");
      },
    });
    const { host } = fakeHost({ ready: { org1: 0 } });
    const gated = withSandboxCapacityGate(inner, {
      ceiling: 2,
      waitMs: 200,
      pollIntervalMs: 5,
      host: () => host,
    });

    const results = [
      gated.create({ sessionId: "a" }),
      gated.create({ sessionId: "b" }),
      gated.create({ sessionId: "c" }),
    ].map((p) =>
      p.then(
        (sb) => ({ ok: true as const, id: sb.id }),
        (err: unknown) => ({ ok: false as const, err }),
      ),
    );
    // Hold a+b in flight past c's gate timeout (200ms): while they hold
    // the only two slots, c must never admit.
    await new Promise((resolve) => setTimeout(resolve, 250));
    release?.();
    const settled = await Promise.all(results);

    const admitted = settled.filter((r) => r.ok);
    const rejected = settled.filter((r) => !r.ok);
    // Two slots: exactly two admitted; the third timed out at the gate.
    expect(admitted).toHaveLength(2);
    expect(rejected).toHaveLength(1);
  });

  it("a failed create frees its in-flight slot", async () => {
    let calls = 0;
    const inner = fakeInner({
      create: async (opts) => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return fakeSandbox(opts.sessionId ?? "?");
      },
    });
    const { host } = fakeHost({ ready: { org1: 0 } });
    const gated = withSandboxCapacityGate(inner, { ceiling: 1, waitMs: 0, host: () => host });

    await expect(gated.create({ sessionId: "a" })).rejects.toThrow("boom");
    // The slot the failed create held is free again — no wait needed.
    const sb = await gated.create({ sessionId: "b" });
    expect(sb.id).toBe("b");
  });

  it("admits ungated when the host is not yet bound or the org is unresolvable", async () => {
    const inner = fakeInner();
    const gatedNoHost = withSandboxCapacityGate(inner, { ceiling: 1, waitMs: 0, host: () => null });
    await gatedNoHost.create({ sessionId: "s1" });

    const { host } = fakeHost({ orgOf: {}, ready: { org1: 99 } });
    const hostNoOrg: CapacityGateHost = { ...host, sessionOrgId: () => null };
    const gatedNoOrg = withSandboxCapacityGate(inner, { ceiling: 1, waitMs: 0, host: () => hostNoOrg });
    await gatedNoOrg.create({}); // no sessionId at all

    expect(inner.created).toHaveLength(2);
  });

  it("orgs do not contend with each other", async () => {
    const inner = fakeInner();
    const { host } = fakeHost({
      orgOf: { a: "org1", b: "org2" },
      ready: { org1: 5, org2: 0 },
    });
    const gated = withSandboxCapacityGate(inner, { ceiling: 5, waitMs: 0, host: () => host });

    await expect(gated.create({ sessionId: "a" })).rejects.toThrow(SandboxStartupError);
    await expect(gated.create({ sessionId: "b" })).resolves.toBeDefined();
  });

  it("preserves optional-member ABSENCE (capability presence checks stay honest)", () => {
    const bare = fakeInner();
    const gatedBare = withSandboxCapacityGate(bare, { ceiling: 1, waitMs: 0, host: () => null });
    expect(gatedBare.updateCreds).toBeUndefined();
    expect(gatedBare.deriveId).toBeUndefined();
    expect(gatedBare.list).toBeUndefined();
    expect(gatedBare.suspend).toBeUndefined();

    const full = fakeInner({
      deriveId: (key) => `d-${key}`,
      updateCreds: async () => {},
    });
    const gatedFull = withSandboxCapacityGate(full, { ceiling: 1, waitMs: 0, host: () => null });
    expect(gatedFull.deriveId?.("k")).toBe("d-k");
    expect(gatedFull.updateCreds).toBeDefined();
    expect(gatedFull.list).toBeUndefined();
  });
});
