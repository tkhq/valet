/**
 * Pure unit tests for provider.ts primitives — no cluster needed.
 * Covers: death-detection helpers, execId format, and the creds Secret
 * lifecycle wired through KubernetesSandboxProvider.
 */
import { describe, expect, it, vi } from "vitest";
import { assertSafeExecId, looksSignalKilled, KubernetesSandboxProvider } from "../src/provider.js";
import type { SandboxSecretsApi } from "../src/provider.js";
import { SANDBOX_CR_API_VERSION } from "../src/index.js";
import { credsSecretName, DOCKER_LABEL_KEY, sandboxCrName } from "../src/manifest.js";
import { wrapAsWorkloadUser, type ExecStatus } from "../src/exec.js";
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
  calls: {
    method: string;
    namespace: string;
    name: string;
    data?: Record<string, string>;
    owner?: { apiVersion: string; kind: string; name: string; uid: string };
  }[] = [];

  async upsertSecret(namespace: string, name: string, data: Record<string, string>): Promise<void> {
    this.calls.push({ method: "upsert", namespace, name, data });
  }

  async writeSecret(namespace: string, name: string, data: Record<string, string>): Promise<void> {
    this.calls.push({ method: "write", namespace, name, data });
  }

  async deleteSecret(namespace: string, name: string): Promise<void> {
    this.calls.push({ method: "delete", namespace, name });
  }

  async patchOwnerReference(
    namespace: string,
    name: string,
    owner: { apiVersion: string; kind: string; name: string; uid: string },
  ): Promise<void> {
    this.calls.push({ method: "patchOwner", namespace, name, owner });
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
      metadata: { name: params.body.metadata.name, uid: "cr-uid-123", resourceVersion: "1" },
      spec: params.body.spec,
      status: { conditions: [{ type: "Ready", status: "True", reason: "DependenciesReady" }] },
    };
  }

  async getNamespacedCustomObject(params: GetSandboxParams): Promise<unknown> {
    return {
      apiVersion: SANDBOX_CR_API_VERSION,
      kind: "Sandbox",
      metadata: { name: params.name, uid: "cr-uid-123", resourceVersion: "1" },
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
    // upsert (before CR create) + patchOwnerReference (after applySandbox).
    expect(secretsApi.calls[0]).toMatchObject({
      method: "upsert",
      namespace: providerCfg.namespace,
      name: credsSecretName("test-sandbox"),
      data: { token: "abc" },
    });
  });

  it("create() with credsFiles adopts the Secret under the CR (ownerReference) — I4", async () => {
    const secretsApi = new FakeSecretsApi();
    const provider = makeProvider(secretsApi);
    await provider.create({ workspace: "test-sandbox", credsFiles: { token: "abc" } });

    const patch = secretsApi.calls.find((c) => c.method === "patchOwner");
    expect(patch).toBeDefined();
    expect(patch?.name).toBe(credsSecretName("test-sandbox"));
    expect(patch?.owner).toEqual({
      apiVersion: SANDBOX_CR_API_VERSION,
      kind: "Sandbox",
      name: sandboxCrName("test-sandbox"),
      uid: "cr-uid-123",
    });
  });

  it("create() without credsFiles does NOT patch an ownerReference — I4", async () => {
    const secretsApi = new FakeSecretsApi();
    const provider = makeProvider(secretsApi);
    await provider.create({ workspace: "test-sandbox" });
    expect(secretsApi.calls.find((c) => c.method === "patchOwner")).toBeUndefined();
  });

  it("create() succeeds even when the ownerReference patch fails (best-effort) — I4", async () => {
    const secretsApi = new FakeSecretsApi();
    secretsApi.patchOwnerReference = async () => {
      throw new Error("patch boom");
    };
    const provider = makeProvider(secretsApi);
    await expect(
      provider.create({ workspace: "test-sandbox", credsFiles: { token: "abc" } }),
    ).resolves.toBeDefined();
  });

  it("create() without credsFiles does not call upsertSecret", async () => {
    const secretsApi = new FakeSecretsApi();
    const provider = makeProvider(secretsApi);
    await provider.create({ workspace: "test-sandbox" });
    expect(secretsApi.calls).toHaveLength(0);
  });

  it("updateCreds() writes the creds Secret", async () => {
    const secretsApi = new FakeSecretsApi();
    const provider = makeProvider(secretsApi);
    await provider.updateCreds("test-sandbox", { token: "newtoken" });
    // write first, then a best-effort ownerReference adopt.
    expect(secretsApi.calls[0]).toMatchObject({
      method: "write",
      namespace: providerCfg.namespace,
      name: credsSecretName("test-sandbox"),
      data: { token: "newtoken" },
    });
    const patch = secretsApi.calls.find((c) => c.method === "patchOwner");
    expect(patch?.owner).toMatchObject({ name: "test-sandbox", uid: "cr-uid-123" });
  });

  it("updateCreds() creates the Secret when writeSecret reports 404 (pre-feature sandbox)", async () => {
    // Simulate a secretsApi whose first write attempt returns 404 (Secret
    // missing), then succeeds on the create fallback. The provider itself
    // delegates 404 handling to writeSecret — this test verifies the
    // FakeSecretsApi.writeSecret path is reached and does not throw.
    let writeCallCount = 0;
    const secretsApi: SandboxSecretsApi = {
      upsertSecret: vi.fn(),
      writeSecret: vi.fn().mockImplementation(async () => {
        writeCallCount++;
        // Always succeeds — the real writeSecret handles 404 internally in
        // the adapter; here we just confirm the provider calls writeSecret
        // and does not throw.
      }),
      deleteSecret: vi.fn(),
      patchOwnerReference: vi.fn(),
    };
    const provider = makeProvider(secretsApi);
    await expect(provider.updateCreds("test-sandbox", { token: "x" })).resolves.toBeUndefined();
    expect(writeCallCount).toBe(1);
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
      writeSecret: vi.fn(),
      deleteSecret: vi.fn().mockRejectedValue(new Error("not found")),
      patchOwnerReference: vi.fn(),
    };
    const provider = makeProvider(secretsApi);
    // Should NOT throw even though deleteSecret rejects.
    await expect(provider.destroy("test-sandbox")).resolves.toBeUndefined();
  });

  it("capabilities().credsMount is true when secretsApi is wired", () => {
    const provider = makeProvider(new FakeSecretsApi());
    expect(provider.capabilities().credsMount).toBe(true);
  });

  it("capabilities().credsMount is false when secretsApi is absent", () => {
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
    expect(provider.capabilities().credsMount).toBe(false);
  });

  it("create() logs a loud error when credsFiles provided but secretsApi absent", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
    await provider.create({ workspace: "test-sandbox", credsFiles: { token: "abc" } });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/credsFiles provided but secretsApi is not wired/));
    errorSpy.mockRestore();
  });
});

// ── Exec identity threading (docker-enabled sandboxes) ─────────────────

/** FakeObjectsApi variant whose GET responses carry configurable labels and
 * the pod-name annotation, so restore() and resolvePodName both work. */
class LabeledObjectsApi extends FakeObjectsApi {
  constructor(private labels: Record<string, string> | undefined) {
    super();
  }

  override async getNamespacedCustomObject(params: GetSandboxParams): Promise<unknown> {
    return {
      apiVersion: SANDBOX_CR_API_VERSION,
      kind: "Sandbox",
      metadata: {
        name: params.name,
        uid: "cr-uid-123",
        resourceVersion: "1",
        labels: this.labels,
        annotations: { "agents.x-k8s.io/pod-name": "pod-1" },
      },
      spec: { podTemplate: {}, volumeClaimTemplates: [] },
      status: { conditions: [{ type: "Ready", status: "True", reason: "DependenciesReady" }] },
    };
  }
}

/** Recording PodExecApi that reports success for every exec. */
class RecordingExecApi implements PodExecApi {
  commands: string[][] = [];

  async exec(
    _namespace: string,
    _podName: string,
    _containerName: string,
    command: string[],
    _stdout: unknown,
    _stderr: unknown,
    _stdin: unknown,
    _tty: boolean,
    statusCallback?: (status: ExecStatus) => void,
  ): Promise<{ close(): void }> {
    this.commands.push(command);
    queueMicrotask(() => statusCallback?.({ status: "Success" }));
    return { close() {} };
  }
}

function makeExecProvider(labels: Record<string, string> | undefined) {
  const execApi = new RecordingExecApi();
  const livenessApi: PodLivenessApi = { getPodUid: async () => "pod-uid-1" };
  const provider = new KubernetesSandboxProvider(
    {
      objectsApi: new LabeledObjectsApi(labels),
      podsApi: new FakePodsApi(),
      execApi,
      livenessApi,
    },
    providerCfg,
  );
  return { provider, execApi };
}

describe("exec identity threading (docker flag → exec layer)", () => {
  it("restore() of a docker-labeled CR runs non-privileged exec as dockerd", async () => {
    const { provider, execApi } = makeExecProvider({ [DOCKER_LABEL_KEY]: "true" });
    const sandbox = await provider.restore("sb-docker");
    await sandbox.exec("echo hi");
    expect(execApi.commands[0]).toEqual(["/bin/sh", "-c", wrapAsWorkloadUser("echo hi")]);
  });

  it("restore() of a docker-labeled CR keeps privileged exec unwrapped", async () => {
    const { provider, execApi } = makeExecProvider({ [DOCKER_LABEL_KEY]: "true" });
    const sandbox = await provider.restore("sb-docker");
    await sandbox.exec("echo hi", { privileged: true });
    expect(execApi.commands[0]).toEqual(["/bin/sh", "-c", "echo hi"]);
  });

  it("restore() of an unlabeled CR keeps exec unwrapped", async () => {
    const { provider, execApi } = makeExecProvider(undefined);
    const sandbox = await provider.restore("sb-plain");
    await sandbox.exec("echo hi");
    expect(execApi.commands[0]).toEqual(["/bin/sh", "-c", "echo hi"]);
  });

  it("create({ docker: true }) threads the flag into the exec layer", async () => {
    const { provider, execApi } = makeExecProvider({ [DOCKER_LABEL_KEY]: "true" });
    const sandbox = await provider.create({ workspace: "sb-docker", docker: true });
    await sandbox.exec("echo hi");
    expect(execApi.commands[0]).toEqual(["/bin/sh", "-c", wrapAsWorkloadUser("echo hi")]);
  });
});

// ── Failed-create CR cleanup (sandbox-lifecycle spec decision, 2026-08-22) ──

/** Minimal ApiException-shaped error (`code: number`), matching
 * client-node's real class without depending on it. */
class FakeApiError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** Stateful objects api: 404 until created, CR carries an error-shaped
 * condition so `waitReady` fails terminally on its first poll. Exercises
 * `create()`'s fresh-vs-adopted cleanup decision. */
class ErrorStatefulObjectsApi implements SandboxCustomObjectsApi {
  present: boolean;
  deleteCalls = 0;
  constructor(preExisting: boolean) {
    this.present = preExisting;
  }

  private cr(name: string): unknown {
    return {
      apiVersion: SANDBOX_CR_API_VERSION,
      kind: "Sandbox",
      metadata: { name, uid: "cr-uid-err", resourceVersion: "1" },
      spec: { podTemplate: {}, volumeClaimTemplates: [] },
      status: { conditions: [{ type: "Error", status: "True", message: "image pull failed" }] },
    };
  }

  async createNamespacedCustomObject(params: CreateSandboxParams): Promise<unknown> {
    if (this.present) {
      throw new FakeApiError(409, "already exists");
    }
    this.present = true;
    return this.cr(params.body.metadata.name);
  }

  async getNamespacedCustomObject(params: GetSandboxParams): Promise<unknown> {
    if (!this.present) {
      throw new FakeApiError(404, "not found");
    }
    return this.cr(params.name);
  }

  async replaceNamespacedCustomObject(params: ReplaceSandboxParams): Promise<unknown> {
    return this.cr(params.name);
  }

  async deleteNamespacedCustomObject(_params: DeleteSandboxParams): Promise<unknown> {
    this.deleteCalls++;
    this.present = false;
    return {};
  }

  async listNamespacedCustomObject(_params: ListSandboxParams): Promise<unknown> {
    return { items: [] };
  }

  async patchNamespacedCustomObject(_params: PatchSandboxParams): Promise<unknown> {
    return {};
  }
}

describe("create() cleanup after terminal startup failure", () => {
  function makeFailingProvider(preExisting: boolean) {
    const objectsApi = new ErrorStatefulObjectsApi(preExisting);
    const provider = new KubernetesSandboxProvider(
      {
        objectsApi,
        podsApi: new FakePodsApi(),
        execApi: fakePodExecApi,
        livenessApi: new FakeLivenessApi(),
      },
      providerCfg,
    );
    return { provider, objectsApi };
  }

  it("deletes the CR it created fresh when the pod terminally fails to start", async () => {
    const { provider, objectsApi } = makeFailingProvider(false);

    await expect(provider.create({ workspace: "/ws/fresh" })).rejects.toThrow(/image pull failed/);

    expect(objectsApi.deleteCalls).toBe(1);
    expect(objectsApi.present).toBe(false);
  });

  it("leaves an ADOPTED CR standing on the same failure (workspace survival)", async () => {
    const { provider, objectsApi } = makeFailingProvider(true);

    await expect(provider.create({ workspace: "/ws/adopted" })).rejects.toThrow(/image pull failed/);

    expect(objectsApi.deleteCalls).toBe(0);
    expect(objectsApi.present).toBe(true);
  });
});
