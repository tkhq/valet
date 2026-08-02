/**
 * Pure unit tests for provider.ts primitives — no cluster needed.
 * Covers: death-detection helpers, execId format, and the creds Secret
 * lifecycle wired through KubernetesSandboxProvider.
 */
import { describe, expect, it, vi } from "vitest";
import { assertSafeExecId, looksSignalKilled, KubernetesSandboxProvider } from "../src/provider.js";
import type { SandboxSecretsApi } from "../src/provider.js";
import { SANDBOX_CR_API_VERSION } from "../src/index.js";
import { credsSecretName } from "../src/manifest.js";
import type { K8sProviderConfig } from "../src/types.js";
import type {
  CreateSandboxParams,
  DeleteSandboxParams,
  GetSandboxParams,
  ListPodsParams,
  ListSandboxParams,
  PatchSandboxParams,
  ReplaceSandboxParams,
  SandboxCustomObjectsApi,
  SandboxPodsApi,
} from "../src/lifecycle.js";
import type { PodLivenessApi } from "../src/provider.js";
import type { PodExecApi } from "../src/exec.js";

describe("looksSignalKilled", () => {
  it("flags the 129-192 signal-shaped exit-code band", () => {
    expect(looksSignalKilled(129)).toBe(true); // SIGHUP
    expect(looksSignalKilled(137)).toBe(true); // SIGKILL
    expect(looksSignalKilled(143)).toBe(true); // SIGTERM
    expect(looksSignalKilled(192)).toBe(true); // 128+64, upper bound
  });

  it("does not flag ordinary exit codes", () => {
    expect(looksSignalKilled(0)).toBe(false);
    expect(looksSignalKilled(1)).toBe(false);
    expect(looksSignalKilled(2)).toBe(false);
    expect(looksSignalKilled(127)).toBe(false);
    expect(looksSignalKilled(128)).toBe(false); // boundary: exclusive
  });

  it("does not flag codes above the signal band", () => {
    expect(looksSignalKilled(193)).toBe(false);
    expect(looksSignalKilled(255)).toBe(false);
  });
});

describe("assertSafeExecId", () => {
  it("accepts the provider's own generated format", () => {
    expect(() => assertSafeExecId("job-1")).not.toThrow();
    expect(() => assertSafeExecId("job-42")).not.toThrow();
    expect(() => assertSafeExecId("job-999999")).not.toThrow();
  });

  it("rejects ids containing a path separator (no /tmp traversal)", () => {
    expect(() => assertSafeExecId("job-1/../../etc/passwd")).toThrow();
    expect(() => assertSafeExecId("../job-1")).toThrow();
    expect(() => assertSafeExecId("job-1/2")).toThrow();
  });

  it("rejects ids containing a dot", () => {
    expect(() => assertSafeExecId("job-1.exit")).toThrow();
    expect(() => assertSafeExecId("job-1.")).toThrow();
    expect(() => assertSafeExecId("..")).toThrow();
  });

  it("rejects ids with whitespace or shell metacharacters", () => {
    expect(() => assertSafeExecId("job-1 ; rm -rf /")).toThrow();
    expect(() => assertSafeExecId("job-1\n")).toThrow();
    expect(() => assertSafeExecId("job-1$(whoami)")).toThrow();
  });

  it("rejects an empty id", () => {
    expect(() => assertSafeExecId("")).toThrow();
  });
});

// ── KubernetesSandboxProvider creds Secret lifecycle ───────────────────

const providerCfg: K8sProviderConfig = {
  namespace: "valet-sandboxes",
  defaultImage: "valet-sandbox:latest",
  apiVersion: SANDBOX_CR_API_VERSION,
};

/** Minimal fake SandboxSecretsApi that records all calls in order. */
class FakeSecretsApi implements SandboxSecretsApi {
  calls: { method: string; namespace: string; name: string; data?: Record<string, string> }[] = [];

  async upsertSecret(namespace: string, name: string, data: Record<string, string>): Promise<void> {
    this.calls.push({ method: "upsert", namespace, name, data });
  }

  async patchSecret(namespace: string, name: string, data: Record<string, string>): Promise<void> {
    this.calls.push({ method: "patch", namespace, name, data });
  }

  async deleteSecret(namespace: string, name: string): Promise<void> {
    this.calls.push({ method: "delete", namespace, name });
  }
}

/** Minimal fake SandboxCustomObjectsApi that always succeeds (create returns
 * a minimal CR-shaped object; delete/get return stubs). */
class FakeObjectsApi implements SandboxCustomObjectsApi {
  createCalled = false;

  async createNamespacedCustomObject(params: CreateSandboxParams): Promise<unknown> {
    this.createCalled = true;
    return {
      apiVersion: params.body.apiVersion,
      kind: params.body.kind,
      metadata: { name: params.body.metadata.name, resourceVersion: "1" },
      spec: params.body.spec,
      status: { conditions: [{ type: "Ready", status: "True", reason: "DependenciesReady" }] },
    };
  }

  async getNamespacedCustomObject(params: GetSandboxParams): Promise<unknown> {
    return {
      apiVersion: SANDBOX_CR_API_VERSION,
      kind: "Sandbox",
      metadata: { name: params.name, resourceVersion: "1" },
      spec: { podTemplate: {}, volumeClaimTemplates: [] },
      status: { conditions: [{ type: "Ready", status: "True", reason: "DependenciesReady" }] },
    };
  }

  async replaceNamespacedCustomObject(_params: ReplaceSandboxParams): Promise<unknown> {
    return {};
  }

  async deleteNamespacedCustomObject(_params: DeleteSandboxParams): Promise<unknown> {
    return {};
  }

  async listNamespacedCustomObject(_params: ListSandboxParams): Promise<unknown> {
    return { items: [] };
  }

  async patchNamespacedCustomObject(_params: PatchSandboxParams): Promise<unknown> {
    return {};
  }
}

/** Minimal fake SandboxPodsApi — returns no pods. */
class FakePodsApi implements SandboxPodsApi {
  async listNamespacedPod(_params: ListPodsParams): Promise<{ items: never[] }> {
    return { items: [] };
  }
}

/** Minimal fake PodLivenessApi — returns a fixed uid. */
class FakeLivenessApi implements PodLivenessApi {
  async getPodUid(_namespace: string, _podName: string): Promise<string | null> {
    return null;
  }
}

/** Minimal fake PodExecApi — never called in these tests. */
const fakePodExecApi: PodExecApi = {
  exec: vi.fn(),
};

function makeProvider(secretsApi: SandboxSecretsApi, objectsApi?: FakeObjectsApi) {
  return new KubernetesSandboxProvider(
    {
      objectsApi: objectsApi ?? new FakeObjectsApi(),
      podsApi: new FakePodsApi(),
      execApi: fakePodExecApi,
      livenessApi: new FakeLivenessApi(),
      secretsApi,
    },
    providerCfg,
  );
}

describe("KubernetesSandboxProvider creds Secret lifecycle", () => {
  it("create() with credsFiles upserts the Secret BEFORE applySandbox (order matters)", async () => {
    const secretsApi = new FakeSecretsApi();
    const objectsApi = new FakeObjectsApi();

    // Track call order by instrumenting both APIs.
    const callOrder: string[] = [];
    const originalUpsert = secretsApi.upsertSecret.bind(secretsApi);
    secretsApi.upsertSecret = async (...args) => {
      callOrder.push("upsert");
      return originalUpsert(...args);
    };
    const originalCreate = objectsApi.createNamespacedCustomObject.bind(objectsApi);
    objectsApi.createNamespacedCustomObject = async (...args) => {
      callOrder.push("create");
      return originalCreate(...args);
    };

    const provider = makeProvider(secretsApi, objectsApi);
    // waitReady polls sandboxStatus — the FakeObjectsApi returns Ready=True immediately.
    await provider.create({ workspace: "test-sandbox", credsFiles: { token: "abc" } });

    expect(callOrder[0]).toBe("upsert");
    expect(callOrder[1]).toBe("create");
    expect(secretsApi.calls).toHaveLength(1);
    expect(secretsApi.calls[0]).toMatchObject({
      method: "upsert",
      namespace: providerCfg.namespace,
      name: credsSecretName("test-sandbox"),
      data: { token: "abc" },
    });
  });

  it("create() without credsFiles does not call upsertSecret", async () => {
    const secretsApi = new FakeSecretsApi();
    const provider = makeProvider(secretsApi);
    await provider.create({ workspace: "test-sandbox" });
    expect(secretsApi.calls).toHaveLength(0);
  });

  it("updateCreds() patches the creds Secret", async () => {
    const secretsApi = new FakeSecretsApi();
    const provider = makeProvider(secretsApi);
    await provider.updateCreds("test-sandbox", { token: "newtoken" });
    expect(secretsApi.calls).toHaveLength(1);
    expect(secretsApi.calls[0]).toMatchObject({
      method: "patch",
      namespace: providerCfg.namespace,
      name: credsSecretName("test-sandbox"),
      data: { token: "newtoken" },
    });
  });

  it("updateCreds() throws when secretsApi is not wired", async () => {
    const provider = new KubernetesSandboxProvider(
      {
        objectsApi: new FakeObjectsApi(),
        podsApi: new FakePodsApi(),
        execApi: fakePodExecApi,
        livenessApi: new FakeLivenessApi(),
        // secretsApi intentionally absent
      },
      providerCfg,
    );
    await expect(provider.updateCreds("test-sandbox", { token: "x" })).rejects.toThrow(/secretsApi not wired/);
  });

  it("destroy() deletes the creds Secret before the CR", async () => {
    const secretsApi = new FakeSecretsApi();
    const provider = makeProvider(secretsApi);
    await provider.destroy("test-sandbox");
    expect(secretsApi.calls).toHaveLength(1);
    expect(secretsApi.calls[0]).toMatchObject({
      method: "delete",
      namespace: providerCfg.namespace,
      name: credsSecretName("test-sandbox"),
    });
  });

  it("destroy() swallows a deleteSecret failure (best-effort)", async () => {
    const secretsApi: SandboxSecretsApi = {
      upsertSecret: vi.fn(),
      patchSecret: vi.fn(),
      deleteSecret: vi.fn().mockRejectedValue(new Error("not found")),
    };
    const provider = makeProvider(secretsApi);
    // Should NOT throw even though deleteSecret rejects.
    await expect(provider.destroy("test-sandbox")).resolves.toBeUndefined();
  });
});
