/**
 * Unit coverage for on-demand workspace PVC growth (`workspace-pvc.ts`)
 * against a fake `SandboxPvcApi` — no cluster. Pins the growth policy the
 * workspace-fit spec mandates: double-up-to-cap, EBS cooldown rate limit,
 * online-resize wait, and refusal (never throw) on every policy stop.
 */
import { describe, it, expect, vi } from "vitest";
import { KubernetesSandbox } from "../src/provider.js";
import type { PodLivenessApi } from "../src/provider.js";
import type { PodExecApi } from "../src/exec.js";
import type { SandboxCustomObjectsApi, SandboxPodsApi } from "../src/lifecycle.js";
import { SANDBOX_CR_API_VERSION } from "../src/types.js";
import {
  DEFAULT_WORKSPACE_STORAGE_MAX,
  WORKSPACE_GROW_ANNOTATION,
  WORKSPACE_GROW_COOLDOWN_MS,
  formatStorageQuantity,
  growWorkspacePvc,
  parseStorageQuantity,
  workspacePvcName,
  type SandboxPvcApi,
  type WorkspacePvcRead,
} from "../src/workspace-pvc.js";

const NS = "valet-sandboxes";
const CR = "vs-abc123";
const PVC = `workspace-${CR}`;

interface PatchCall {
  name: string;
  storage: string;
  annotations: Record<string, string>;
}

/** Fake PvcApi over a single mutable PVC record. `capacityLagReads` delays
 * the status.capacity update by that many readbacks, modeling the CSI
 * resize window the grow waits out. */
class FakePvcApi implements SandboxPvcApi {
  patches: PatchCall[] = [];
  reads = 0;
  private capacityLagReads: number;
  private pvc: WorkspacePvcRead | null;

  constructor(pvc: WorkspacePvcRead | null, opts: { capacityLagReads?: number } = {}) {
    this.pvc = pvc;
    this.capacityLagReads = opts.capacityLagReads ?? 0;
  }

  async readPvc(namespace: string, name: string): Promise<WorkspacePvcRead | null> {
    expect(namespace).toBe(NS);
    expect(name).toBe(PVC);
    this.reads += 1;
    if (this.pvc === null) return null;
    // Model online expansion: capacity follows the request after the lag.
    if (this.patches.length > 0 && this.capacityLagReads > 0) {
      this.capacityLagReads -= 1;
    } else if (this.patches.length > 0) {
      this.pvc = { ...this.pvc, capacityStorage: this.patches[this.patches.length - 1].storage };
    }
    return this.pvc;
  }

  async patchPvcStorage(
    namespace: string,
    name: string,
    storage: string,
    annotations: Record<string, string>,
  ): Promise<void> {
    expect(namespace).toBe(NS);
    this.patches.push({ name, storage, annotations });
    if (this.pvc) {
      this.pvc = {
        ...this.pvc,
        requestedStorage: storage,
        annotations: { ...this.pvc.annotations, ...annotations },
      };
    }
  }
}

function pvc(overrides: Partial<WorkspacePvcRead> = {}): WorkspacePvcRead {
  return {
    requestedStorage: "1Gi",
    capacityStorage: "1Gi",
    annotations: {},
    ...overrides,
  };
}

/** Fake clock: `sleep` advances it, so the resize wait loop runs without
 * real timers. */
function fakeTime(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      nowMs += ms;
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
    startMs,
  };
}

describe("quantity math", () => {
  it("parses binary, decimal, and plain-byte quantities", () => {
    expect(parseStorageQuantity("1Gi")).toBe(2 ** 30);
    expect(parseStorageQuantity("512Mi")).toBe(512 * 2 ** 20);
    expect(parseStorageQuantity("1.5Gi")).toBe(1.5 * 2 ** 30);
    expect(parseStorageQuantity("2G")).toBe(2e9);
    expect(parseStorageQuantity("1073741824")).toBe(2 ** 30);
    expect(parseStorageQuantity(" 20Gi ")).toBe(20 * 2 ** 30);
  });

  it("returns null on unparseable quantities", () => {
    expect(parseStorageQuantity("")).toBeNull();
    expect(parseStorageQuantity("lots")).toBeNull();
    expect(parseStorageQuantity("1Zi")).toBeNull();
  });

  it("formats bytes as the largest evenly-dividing binary suffix", () => {
    expect(formatStorageQuantity(2 ** 31)).toBe("2Gi");
    expect(formatStorageQuantity(3 * 2 ** 20)).toBe("3Mi");
    expect(formatStorageQuantity(2 ** 10)).toBe("1Ki");
    expect(formatStorageQuantity(1000)).toBe("1000");
  });

  it("names the workspace PVC by the controller convention <template>-<crName>", () => {
    expect(workspacePvcName(CR)).toBe(PVC);
  });
});

describe("growWorkspacePvc", () => {
  it("doubles the request, stamps the rate-limit annotation, waits for capacity, and reports grown", async () => {
    const api = new FakePvcApi(pvc(), { capacityLagReads: 2 });
    const t = fakeTime();
    const result = await growWorkspacePvc(api, { namespace: NS, crName: CR, now: t.now, sleep: t.sleep });
    expect(result).toEqual({ grown: true, from: "1Gi", to: "2Gi" });
    expect(api.patches).toHaveLength(1);
    expect(api.patches[0].storage).toBe("2Gi");
    expect(api.patches[0].annotations[WORKSPACE_GROW_ANNOTATION]).toBe(new Date(t.startMs).toISOString());
  });

  it("caps at maxStorage, using the configured max quantity verbatim", async () => {
    const api = new FakePvcApi(pvc({ requestedStorage: "16Gi", capacityStorage: "16Gi" }));
    const t = fakeTime();
    const result = await growWorkspacePvc(api, {
      namespace: NS,
      crName: CR,
      maxStorage: "20Gi",
      now: t.now,
      sleep: t.sleep,
    });
    expect(result).toEqual({ grown: true, from: "16Gi", to: "20Gi" });
    expect(api.patches[0].storage).toBe("20Gi");
  });

  it("refuses at the cap without patching, naming the cap and the knob", async () => {
    const api = new FakePvcApi(pvc({ requestedStorage: "20Gi", capacityStorage: "20Gi" }));
    const result = await growWorkspacePvc(api, { namespace: NS, crName: CR, maxStorage: "20Gi" });
    expect(result.grown).toBe(false);
    expect(result.reason).toMatch(/20Gi growth cap/);
    expect(result.reason).toMatch(/VALET_SANDBOX_WORKSPACE_MAX/);
    expect(api.patches).toHaveLength(0);
  });

  it("refuses inside the EBS cooldown window without patching", async () => {
    const t = fakeTime();
    const recentGrow = new Date(t.startMs - 3_600_000).toISOString(); // 1h ago
    const api = new FakePvcApi(pvc({ annotations: { [WORKSPACE_GROW_ANNOTATION]: recentGrow } }));
    const result = await growWorkspacePvc(api, { namespace: NS, crName: CR, now: t.now, sleep: t.sleep });
    expect(result.grown).toBe(false);
    expect(result.reason).toMatch(/one volume modification/);
    expect(api.patches).toHaveLength(0);
  });

  it("grows again once the cooldown has passed", async () => {
    const t = fakeTime();
    const staleGrow = new Date(t.startMs - WORKSPACE_GROW_COOLDOWN_MS - 60_000).toISOString();
    const api = new FakePvcApi(pvc({ annotations: { [WORKSPACE_GROW_ANNOTATION]: staleGrow } }));
    const result = await growWorkspacePvc(api, { namespace: NS, crName: CR, now: t.now, sleep: t.sleep });
    expect(result.grown).toBe(true);
    expect(api.patches).toHaveLength(1);
  });

  it("refuses when the PVC is missing", async () => {
    const api = new FakePvcApi(null);
    const result = await growWorkspacePvc(api, { namespace: NS, crName: CR });
    expect(result.grown).toBe(false);
    expect(result.reason).toMatch(/not found/);
  });

  it("refuses on an unparseable storage request", async () => {
    const api = new FakePvcApi(pvc({ requestedStorage: "unlimited" }));
    const result = await growWorkspacePvc(api, { namespace: NS, crName: CR });
    expect(result.grown).toBe(false);
    expect(result.reason).toMatch(/not a parseable quantity/);
    expect(api.patches).toHaveLength(0);
  });

  it("reports pending (patch already sent, NOT a refusal) when the resize never lands within the wait window", async () => {
    const api = new FakePvcApi(pvc(), { capacityLagReads: Number.MAX_SAFE_INTEGER });
    const t = fakeTime();
    const result = await growWorkspacePvc(api, {
      namespace: NS,
      crName: CR,
      now: t.now,
      sleep: t.sleep,
      resizeWaitTimeoutMs: 10_000,
    });
    expect(result.grown).toBe(false);
    expect(result.pending).toBe(true);
    expect(result.reason).toMatch(/did not complete/);
    expect(api.patches).toHaveLength(1);
  });

  it("fails CLOSED on a future-dated grow annotation (clock skew never bypasses the cooldown)", async () => {
    const t = fakeTime();
    const futureGrow = new Date(t.startMs + 3_600_000).toISOString(); // 1h ahead
    const api = new FakePvcApi(pvc({ annotations: { [WORKSPACE_GROW_ANNOTATION]: futureGrow } }));
    const result = await growWorkspacePvc(api, { namespace: NS, crName: CR, now: t.now, sleep: t.sleep });
    expect(result.grown).toBe(false);
    expect(result.pending).toBeUndefined();
    expect(api.patches).toHaveLength(0);
  });

  it("stops waiting immediately when the PVC is deleted mid-resize", async () => {
    const api = new FakePvcApi(pvc(), { capacityLagReads: Number.MAX_SAFE_INTEGER });
    const t = fakeTime();
    let reads = 0;
    const original = api.readPvc.bind(api);
    api.readPvc = async (namespace, name) => {
      reads += 1;
      // First read feeds the policy check; the PVC vanishes on wait reads.
      return reads === 1 ? original(namespace, name) : null;
    };
    const result = await growWorkspacePvc(api, { namespace: NS, crName: CR, now: t.now, sleep: t.sleep });
    expect(result.grown).toBe(false);
    expect(result.reason).toMatch(/deleted while waiting/);
    // Returned on the FIRST wait read, not after the full timeout window.
    expect(reads).toBe(2);
  });

  it("defaults the cap to DEFAULT_WORKSPACE_STORAGE_MAX", async () => {
    const atDefault = parseStorageQuantity(DEFAULT_WORKSPACE_STORAGE_MAX)!;
    const api = new FakePvcApi(
      pvc({
        requestedStorage: formatStorageQuantity(atDefault),
        capacityStorage: formatStorageQuantity(atDefault),
      }),
    );
    const result = await growWorkspacePvc(api, { namespace: NS, crName: CR });
    expect(result.grown).toBe(false);
    expect(result.reason).toMatch(/growth cap/);
  });
});

// ── growWorkspace wiring on KubernetesSandbox ─────────────────────────

/** Deps a growWorkspace-only test never touches — every method throws. */
function unusedAsync(): Promise<never> {
  throw new Error("not used by growWorkspace");
}
const inertObjectsApi: SandboxCustomObjectsApi = {
  createNamespacedCustomObject: unusedAsync,
  getNamespacedCustomObject: unusedAsync,
  replaceNamespacedCustomObject: unusedAsync,
  deleteNamespacedCustomObject: unusedAsync,
  listNamespacedCustomObject: unusedAsync,
  patchNamespacedCustomObject: unusedAsync,
};
const inertPodsApi: SandboxPodsApi = { listNamespacedPod: unusedAsync };
const inertExecApi: PodExecApi = { exec: unusedAsync };
const inertLivenessApi: PodLivenessApi = { getPodUid: unusedAsync };

describe("KubernetesSandbox.growWorkspace wiring", () => {
  function makeSandbox(pvcApi?: SandboxPvcApi) {
    return new KubernetesSandbox(
      {
        objectsApi: inertObjectsApi,
        podsApi: inertPodsApi,
        execApi: inertExecApi,
        livenessApi: inertLivenessApi,
        pvcApi,
        cfg: {
          namespace: NS,
          defaultImage: "img",
          apiVersion: SANDBOX_CR_API_VERSION,
          workspaceStorageMax: "4Gi",
        },
      },
      CR,
    );
  }

  it("without pvcApi wired: refuses with a reason, never throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await makeSandbox().growWorkspace();
    expect(result.grown).toBe(false);
    expect(result.reason).toMatch(/not wired/);
    warnSpy.mockRestore();
  });

  it("with pvcApi wired: grows the CR's workspace PVC under cfg.workspaceStorageMax", async () => {
    const api = new FakePvcApi(pvc());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await makeSandbox(api).growWorkspace();
    expect(result).toEqual({ grown: true, from: "1Gi", to: "2Gi" });
    expect(api.patches[0].name).toBe(PVC);
    logSpy.mockRestore();
  });

  it("cfg.workspaceStorageMax caps the grow", async () => {
    const api = new FakePvcApi(pvc({ requestedStorage: "4Gi", capacityStorage: "4Gi" }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await makeSandbox(api).growWorkspace();
    expect(result.grown).toBe(false);
    expect(result.reason).toMatch(/4Gi growth cap/);
    warnSpy.mockRestore();
  });
});
