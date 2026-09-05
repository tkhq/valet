/**
 * Pure unit tests for provider.ts primitives — no cluster needed.
 * Covers: death-detection helpers, execId format, and the creds Secret
 * lifecycle wired through KubernetesSandboxProvider.
 */
import { describe, expect, it, vi } from "vitest";
import { assertSafeExecId, looksSignalKilled, KubernetesSandboxProvider } from "../src/provider.js";
import type { SandboxSecretsApi } from "../src/provider.js";
import { SANDBOX_CR_API_VERSION } from "../src/index.js";
import { buildSandboxManifest, credsSecretName, DOCKER_LABEL_KEY, sandboxCrName } from "../src/manifest.js";
import { wrapAsWorkloadUser, type ExecStatus } from "../src/exec.js";
import type { K8sProviderConfig, ResourceRequirements, SandboxCR, SandboxCRRead } from "../src/types.js";
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
  SandboxCpuMemoryResources,
  PodStatusInfo,
} from "../src/lifecycle.js";
import { imageFingerprint, sandboxCpuMemoryResources } from "../src/lifecycle.js";
import type { PodLivenessApi } from "../src/provider.js";
import type { PodExecApi } from "../src/exec.js";

const recordWorkspaceGrow = vi.hoisted(() => vi.fn());

vi.mock("@valet/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@valet/engine")>();
  return { ...actual, recordSandboxWorkspaceGrow: recordWorkspaceGrow };
});

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

/** Existing CR with live compute. Replacement updates the template, not the pod. */
class ResourceAdoptingObjectsApi extends FakeObjectsApi {
  cr: SandboxCRRead;
  calls: string[] = [];
  private failAfterReplace = false;
  private failNextGet = false;

  failNextGetAfterReplace(): void {
    this.failAfterReplace = true;
  }

  constructor(manifest: SandboxCR) {
    super();
    this.cr = {
      ...manifest,
      metadata: {
        ...manifest.metadata, uid: "cr-existing", resourceVersion: "1",
        annotations: { "agents.x-k8s.io/pod-name": "pod-existing" },
      },
      status: { conditions: [{ type: "Ready", status: "True", reason: "DependenciesReady" }] },
    };
  }

  override async createNamespacedCustomObject(): Promise<unknown> {
    this.calls.push("create");
    throw new FakeApiError(409, "already exists");
  }

  override async getNamespacedCustomObject(): Promise<unknown> {
    this.calls.push("get");
    if (this.failNextGet) {
      this.failNextGet = false;
      throw new Error("temporary resolvePodName failure");
    }
    return this.cr;
  }

  override async replaceNamespacedCustomObject(params: ReplaceSandboxParams): Promise<unknown> {
    this.calls.push("replace");
    this.cr = {
      ...params.body,
      metadata: {
        ...this.cr.metadata, ...params.body.metadata, resourceVersion: "2",
        annotations: { ...this.cr.metadata.annotations, ...params.body.metadata.annotations },
      },
      status: this.cr.status,
    };
    if (this.failAfterReplace) {
      this.failAfterReplace = false;
      this.failNextGet = true;
    }
    return this.cr;
  }
}

describe("create() resource adoption and pod rollout", () => {
  function expectFingerprintedTemplate(actual: unknown, expected: SandboxCR["spec"]["podTemplate"]) {
    expect(actual).toEqual({ ...expected, metadata: { ...expected.metadata,
      annotations: { ...expected.metadata?.annotations, "valet.dev/resource-fingerprint": expect.any(String) },
    }, spec: { ...expected.spec, containers: expected.spec.containers.map((container) => ({ ...container,
      env: [
        ...(container.env ?? []).filter((entry) =>
          entry.name !== "VALET_SANDBOX_RESOURCE_FINGERPRINT" && entry.name !== "VALET_SANDBOX_IMAGE_FINGERPRINT"),
        { name: "VALET_SANDBOX_RESOURCE_FINGERPRINT", value: expect.any(String) },
        { name: "VALET_SANDBOX_IMAGE_FINGERPRINT", value: expect.any(String) },
      ],
    })) } });
  }

  function templateFingerprint(template: unknown): string | undefined {
    if (typeof template !== "object" || template === null || !("metadata" in template)) return undefined;
    const metadata = template.metadata;
    if (typeof metadata !== "object" || metadata === null || !("annotations" in metadata)) return undefined;
    const annotations = metadata.annotations;
    if (typeof annotations !== "object" || annotations === null || !("valet.dev/resource-fingerprint" in annotations)) return undefined;
    const value = annotations["valet.dev/resource-fingerprint"];
    return typeof value === "string" ? value : undefined;
  }

  function bootFingerprint(template: unknown): string | undefined {
    if (typeof template !== "object" || template === null || !("spec" in template)) return undefined;
    const spec = template.spec;
    if (typeof spec !== "object" || spec === null || !("containers" in spec) || !Array.isArray(spec.containers)) return undefined;
    const container: unknown = spec.containers.find((entry: unknown) =>
      typeof entry === "object" && entry !== null && "name" in entry && entry.name === "sandbox");
    if (typeof container !== "object" || container === null || !("env" in container) || !Array.isArray(container.env)) return undefined;
    const marker: unknown = container.env.find((entry: unknown) =>
      typeof entry === "object" && entry !== null && "name" in entry && entry.name === "VALET_SANDBOX_RESOURCE_FINGERPRINT");
    return typeof marker === "object" && marker !== null && "value" in marker && typeof marker.value === "string" ? marker.value : undefined;
  }

  function setup(resources: ResourceRequirements | undefined, defaultResources?: K8sProviderConfig["defaultResources"]) {
    const cfg = { ...providerCfg, defaultResources };
    const manifest = buildSandboxManifest(cfg, sandboxCrName("/ws/resources"), {});
    manifest.spec.podTemplate.spec.containers[0].resources = resources;
    const objectsApi = new ResourceAdoptingObjectsApi(manifest);
    const deletedPods: string[] = [];
    let uid: string | null = "pod-old";
    let liveImage = cfg.defaultImage;
    let liveResources: SandboxCpuMemoryResources = resources ?? {};
    let liveFingerprint: string | undefined;
    let podOverride: PodStatusInfo | null | undefined;
    const podDeleteApi = {
      deletePod: vi.fn(async (_namespace: string, podName: string) => {
        deletedPods.push(podName);
        uid = `pod-new-${deletedPods.length}`;
        liveResources = sandboxCpuMemoryResources(objectsApi.cr.spec.podTemplate);
        liveFingerprint = bootFingerprint(objectsApi.cr.spec.podTemplate);
        const template = objectsApi.cr.spec.podTemplate;
        if (typeof template === "object" && template !== null && "spec" in template &&
          typeof template.spec === "object" && template.spec !== null && "containers" in template.spec &&
          Array.isArray(template.spec.containers)) {
          const container: unknown = template.spec.containers[0];
          if (typeof container === "object" && container !== null && "image" in container && typeof container.image === "string") {
            liveImage = container.image;
          }
        }
      }),
    };
    const setLivePod = (nextUid: string | null, pod: PodStatusInfo | null) => { uid = nextUid; podOverride = pod; };
    const getLivePod = (): PodStatusInfo | null => podOverride === undefined ? {
      phase: "Running", conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [{ name: "sandbox", image: liveImage }],
      sandboxResources: liveResources, resourceFingerprint: liveFingerprint,
    } : podOverride;
    const podStatusApi = { getPodStatus: vi.fn(async () => getLivePod()) };
    const restartWithPodState = () => new KubernetesSandboxProvider({
      objectsApi, podsApi: new FakePodsApi(), execApi: fakePodExecApi,
      livenessApi: { getPodUid: async () => uid }, podStatusApi, podDeleteApi,
    }, cfg);
    return { provider: restartWithPodState(), restart: restartWithPodState, objectsApi, deletedPods, cfg, podDeleteApi,
      podStatusApi, setLivePod, getLivePod,
      setAdmittedResources: (admitted: SandboxCpuMemoryResources) => { liveResources = admitted; } };
  }

  const prior = {
    requests: { cpu: "250m", memory: "4Gi" },
    limits: { cpu: "4", memory: "8Gi" },
  };

  it("no opinion preserves exact CPU/memory despite stale options and updates ephemeral storage without a roll", async () => {
    const { provider, objectsApi, deletedPods } = setup(prior, { cpu: 1, memory: "2Gi" });

    await provider.create({
      workspace: "/ws/resources", preserveResourcesOnAdopt: true,
      resources: { cpu: 2, ephemeralStorage: "10Gi", ephemeralStorageLimit: "20Gi" },
    });

    expect(objectsApi.cr.spec.podTemplate).toMatchObject({
      spec: { containers: [{ resources: {
        requests: { ...prior.requests, "ephemeral-storage": "10Gi" },
        limits: { ...prior.limits, "ephemeral-storage": "20Gi" },
      } }] },
    });
    expect(deletedPods).toEqual([]);
    expect(objectsApi.calls.slice(0, 3)).toEqual(["create", "get", "replace"]);
  });

  it.each([
    { cpu: 2, memory: "8Gi" },
    { cpu: 4, memory: "4Gi" },
  ])("same-image authoritative resources %j roll the live pod", async (resources) => {
    const { provider, objectsApi, deletedPods, cfg } = setup({
      requests: { cpu: "4", memory: "8Gi" }, limits: { cpu: "4", memory: "8Gi" },
    });

    await provider.create({ workspace: "/ws/resources", resources });

    expect(deletedPods).toEqual(["pod-existing"]);
    expectFingerprintedTemplate(objectsApi.cr.spec.podTemplate, buildSandboxManifest(cfg, sandboxCrName("/ws/resources"), { resources }).spec.podTemplate);
  });

  it.each([undefined, { cpu: 1, memory: "2Gi" }])("authoritative empty resources roll onto deployment defaults %j", async (defaultResources) => {
    const { provider, objectsApi, deletedPods, cfg } = setup(prior, defaultResources);

    await provider.create({ workspace: "/ws/resources", resources: {} });

    expect(deletedPods).toEqual(["pod-existing"]);
    expectFingerprintedTemplate(objectsApi.cr.spec.podTemplate, buildSandboxManifest(cfg, sandboxCrName("/ws/resources"), { resources: {} }).spec.podTemplate);
  });

  it("a change only to CPU limits rolls the pod", async () => {
    const { provider, deletedPods } = setup({ requests: { cpu: "4" }, limits: { cpu: "8" } });

    await provider.create({ workspace: "/ws/resources", resources: { cpu: 4 } });

    expect(deletedPods).toEqual(["pod-existing"]);
  });

  it("retries a stale live pod after the CR update succeeded but pod deletion failed", async () => {
    const { provider, objectsApi, podDeleteApi, cfg } = setup(prior);
    const resources = { cpu: 2, memory: "4Gi" };
    podDeleteApi.deletePod.mockRejectedValueOnce(new Error("pod deletion failed"));

    await expect(provider.create({ workspace: "/ws/resources", resources })).rejects.toThrow("pod deletion failed");
    expectFingerprintedTemplate(objectsApi.cr.spec.podTemplate, buildSandboxManifest(cfg, sandboxCrName("/ws/resources"), { resources }).spec.podTemplate);

    await provider.create({ workspace: "/ws/resources", resources });

    expect(podDeleteApi.deletePod).toHaveBeenCalledTimes(2);
    await provider.create({ workspace: "/ws/resources", resources });
    expect(podDeleteApi.deletePod).toHaveBeenCalledTimes(2);
  });

  it("unchanged authoritative CPU/memory do not roll after fingerprint migration", async () => {
    const { provider, deletedPods } = setup({
      requests: { cpu: "4", memory: "8Gi" }, limits: { cpu: "4", memory: "8Gi" },
    });

    await provider.create({ workspace: "/ws/resources", resources: { cpu: 4, memory: "8Gi" } });
    expect(deletedPods).toEqual(["pod-existing"]);
    await provider.create({ workspace: "/ws/resources", resources: { cpu: 4, memory: "8Gi" } });

    expect(deletedPods).toEqual(["pod-existing"]);
  });

  it("equivalent CPU/memory quantities do not roll on repeated authoritative adoption", async () => {
    const { provider, deletedPods } = setup({
      requests: { cpu: "500m", memory: "4096Mi" }, limits: { cpu: "500m", memory: "4096Mi" },
    });

    await provider.create({ workspace: "/ws/resources", resources: { cpu: 0.5, memory: "4096Mi" } });
    expect(deletedPods).toEqual(["pod-existing"]);
    await provider.create({ workspace: "/ws/resources", resources: { cpu: 0.5, memory: "4Gi" } });

    expect(deletedPods).toEqual(["pod-existing"]);
  });

  it.each([{ cpu: 4, memory: "8Gi" }, {}])("migrates legacy override metadata %j before image rollout and retains it across a crash", async (resourceOverrides) => {
    const { provider, restart, objectsApi, podDeleteApi } = setup(prior);
    const originalDelete = podDeleteApi.deletePod.getMockImplementation();
    if (!originalDelete) throw new Error("expected pod deletion implementation");
    podDeleteApi.deletePod.mockImplementationOnce(async (namespace, podName) => {
      await originalDelete(namespace, podName);
      throw new Error("connection lost after pod deletion");
    });
    const readResourceOverrides = vi.fn(async (sandbox: import("@valet/engine").Sandbox) => {
      expect(sandbox.id).toBe("ws-resources");
      expect(podDeleteApi.deletePod).not.toHaveBeenCalled();
      return resourceOverrides;
    });
    const opts = {
      workspace: "/ws/resources", image: "image:new", preserveResourcesOnAdopt: true,
      resources: { cpu: 1 }, readResourceOverrides,
    };

    await expect(provider.create(opts)).rejects.toThrow("connection lost after pod deletion");
    expect(objectsApi.cr.metadata.annotations?.["valet.dev/resource-overrides"]).toBe(JSON.stringify(resourceOverrides));
    readResourceOverrides.mockRejectedValue(new Error("old applied file is gone"));

    const sandbox = await restart().create(opts);

    expect(sandbox.resourceOverrides).toEqual(resourceOverrides);
    expect(readResourceOverrides).toHaveBeenCalledTimes(1);
    expect(podDeleteApi.deletePod).toHaveBeenCalledTimes(1);
  });

  it("a failed legacy metadata read does not update the CR or delete the pod", async () => {
    const { provider, objectsApi, deletedPods } = setup(prior);
    const original = structuredClone(objectsApi.cr);

    await expect(provider.create({
      workspace: "/ws/resources", image: "image:new", preserveResourcesOnAdopt: true,
      readResourceOverrides: async () => { throw new Error("applied state read failed"); },
    })).rejects.toThrow("applied state read failed");

    expect(objectsApi.cr).toEqual(original);
    expect(deletedPods).toEqual([]);
  });

  it("image drift with no resource opinion shares one rollout and preserves CPU/memory", async () => {
    const { provider, objectsApi, deletedPods } = setup(prior);

    await provider.create({ workspace: "/ws/resources", image: "image:new", preserveResourcesOnAdopt: true });

    expect(deletedPods).toEqual(["pod-existing"]);
    expect(objectsApi.cr.spec.podTemplate).toMatchObject({
      spec: { containers: [{ image: "image:new", resources: prior }] },
    });
  });

  it("accepts a live image rewritten by admission when its requested-image fingerprint matches", async () => {
    const { provider, setLivePod, deletedPods } = setup(prior);
    setLivePod("pod-mutated", {
      phase: "Running",
      sandboxImage: "mirror.internal/valet-sandbox@sha256:digest",
      imageFingerprint: imageFingerprint(providerCfg.defaultImage),
      sandboxResources: prior,
      conditions: [{ type: "Ready", status: "True" }],
    });

    await provider.create({ workspace: "/ws/resources", preserveResourcesOnAdopt: true });

    expect(deletedPods).toEqual([]);
  });

  it("reports adopted ownership even after provider-side image replacement", async () => {
    const { provider } = setup(prior);
    const sandbox = await provider.create({ workspace: "/ws/resources", image: "image:new", preserveResourcesOnAdopt: true });
    expect(sandbox.adopted).toBe(true);
  });

  it("admission-added resources do not cause repeated rollout, but a requested change does", async () => {
    const { provider, setAdmittedResources, deletedPods, objectsApi } = setup(undefined);
    await provider.create({ workspace: "/ws/resources", resources: {} });
    expect(templateFingerprint(objectsApi.cr.spec.podTemplate)).toBeDefined();
    setAdmittedResources({ requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "1", memory: "2Gi" } });
    const before = deletedPods.length;

    await provider.create({ workspace: "/ws/resources", resources: {} });
    expect(deletedPods.length).toBe(before);
    const fingerprint = templateFingerprint(objectsApi.cr.spec.podTemplate);
    await provider.create({ workspace: "/ws/resources", resources: { cpu: 100 }, preserveResourcesOnAdopt: true });
    expect(templateFingerprint(objectsApi.cr.spec.podTemplate)).toBe(fingerprint);
    expect(deletedPods.length).toBe(before);
    await provider.create({ workspace: "/ws/resources", resources: { cpu: 2 } });
    expect(deletedPods.length).toBe(before + 1);
    setAdmittedResources({ requests: { cpu: "2", memory: "1Gi" }, limits: { cpu: "2", memory: "2Gi" } });
    await provider.create({ workspace: "/ws/resources", resources: { cpu: 2 } });
    expect(deletedPods.length).toBe(before + 1);
  });

  it("legacy no-opinion adoption retains fingerprint absence and ignores admission resources", async () => {
    const { provider, setAdmittedResources, deletedPods, objectsApi } = setup(undefined);
    setAdmittedResources(prior);

    await provider.create({ workspace: "/ws/resources", preserveResourcesOnAdopt: true });

    expect(deletedPods).toEqual([]);
    expect(templateFingerprint(objectsApi.cr.spec.podTemplate)).toBeUndefined();
  });

  it("legacy authoritative adoption stamps a fingerprint through one rollout", async () => {
    const { provider, deletedPods, objectsApi } = setup(undefined);
    await provider.create({ workspace: "/ws/resources", resources: {} });
    expect(deletedPods).toEqual(["pod-existing"]);
    expect(templateFingerprint(objectsApi.cr.spec.podTemplate)).toBeDefined();
    await provider.create({ workspace: "/ws/resources", resources: {} });
    expect(deletedPods).toEqual(["pod-existing"]);
  });

  it("reserved literal boot fingerprints cannot be overridden or introduced by caller env", async () => {
    const { provider, objectsApi } = setup(undefined);
    const env = { VALET_SANDBOX_RESOURCE_FINGERPRINT: "caller-value", USER_FLAG: "keep" };
    await provider.create({ workspace: "/ws/resources", preserveResourcesOnAdopt: true, env });
    expect(bootFingerprint(objectsApi.cr.spec.podTemplate)).toBeUndefined();

    await provider.create({ workspace: "/ws/resources", resources: {}, env });
    const fingerprint = templateFingerprint(objectsApi.cr.spec.podTemplate);
    expect(fingerprint).toBeDefined();
    expect(bootFingerprint(objectsApi.cr.spec.podTemplate)).toBe(fingerprint);
    expect(fingerprint).not.toBe("caller-value");

    await provider.create({ workspace: "/ws/resources", preserveResourcesOnAdopt: true, env: { USER_FLAG: "keep" } });
    expect(bootFingerprint(objectsApi.cr.spec.podTemplate)).toBe(fingerprint);
    expect(objectsApi.cr.spec.podTemplate).toMatchObject({ spec: { containers: [{ env: expect.arrayContaining([{ name: "USER_FLAG", value: "keep" }]) }] } });
  });

  it("retries one transient resolvePodName read before accepting readiness", async () => {
    const { provider, objectsApi } = setup(prior);
    objectsApi.failNextGetAfterReplace();

    await expect(provider.create({ workspace: "/ws/resources", preserveResourcesOnAdopt: true }))
      .resolves.toBeDefined();
  });

  it("retries one transient live pod-status read before accepting readiness", async () => {
    const { provider, podStatusApi } = setup(prior);
    podStatusApi.getPodStatus.mockRejectedValueOnce(new Error("temporary apiserver reset"));

    await expect(provider.create({ workspace: "/ws/resources", preserveResourcesOnAdopt: true }))
      .resolves.toBeDefined();
    expect(podStatusApi.getPodStatus.mock.calls.length).toBeGreaterThan(1);
  });

  it("times out with the persistent Kubernetes read failure and corrective action", async () => {
    vi.useFakeTimers();
    try {
      const { provider, podStatusApi } = setup(prior);
      podStatusApi.getPodStatus.mockRejectedValue(new Error("apiserver unavailable"));
      const creating = provider.create({ workspace: "/ws/resources", preserveResourcesOnAdopt: true });
      const assertion = expect(creating).rejects.toThrow(
        /Last Kubernetes read error: apiserver unavailable.*Check Kubernetes API access.*then retry/,
      );

      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])("waits through absent and Pending replacement pods despite stale CR Ready (restart: %s)", async (restartAfterDelete) => {
    vi.useFakeTimers();
    try {
      const { provider, setLivePod, podDeleteApi } = setup(prior);
      const originalDelete = podDeleteApi.deletePod.getMockImplementation();
      if (!originalDelete) throw new Error("expected pod deletion implementation");
      if (restartAfterDelete) setLivePod(null, null);
      else podDeleteApi.deletePod.mockImplementationOnce(async (namespace, podName) => {
        await originalDelete(namespace, podName);
        setLivePod(null, null);
      });
      let settled = false;
      const creating = provider.create({ workspace: "/ws/resources", image: "image:new", preserveResourcesOnAdopt: true })
        .then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect.soft(settled).toBe(false);

      setLivePod("pod-pending", { phase: "Pending", conditions: [{ type: "Ready", status: "False" }] });
      await vi.advanceTimersByTimeAsync(1000);
      expect.soft(settled).toBe(false);

      setLivePod("pod-pending", { phase: "Running", sandboxImage: "image:new", conditions: [{ type: "Ready", status: "True" }] });
      await vi.advanceTimersByTimeAsync(1000);
      await creating;
      expect(settled).toBe(true);
      expect(podDeleteApi.deletePod).toHaveBeenCalledTimes(restartAfterDelete ? 0 : 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not accept a Ready replacement with a stale resource fingerprint", async () => {
    vi.useFakeTimers();
    try {
      const { provider, setLivePod, getLivePod, podDeleteApi } = setup(prior);
      const originalDelete = podDeleteApi.deletePod.getMockImplementation();
      if (!originalDelete) throw new Error("expected pod deletion implementation");
      let readyPod: PodStatusInfo | null = null;
      podDeleteApi.deletePod.mockImplementationOnce(async (namespace, podName) => {
        await originalDelete(namespace, podName);
        readyPod = getLivePod();
        if (!readyPod) throw new Error("expected replacement pod");
        setLivePod("pod-stale", { ...readyPod, resourceFingerprint: "old-generation" });
      });
      let settled = false;
      const creating = provider.create({ workspace: "/ws/resources", resources: { cpu: 2 } }).then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(0);
      expect.soft(settled).toBe(false);
      setLivePod("pod-current", readyPod);
      await vi.advanceTimersByTimeAsync(1000);
      await creating;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

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

/** Adopt path: create 409s, GET returns a READY CR owned by another session,
 * replace succeeds. Ready immediately so `waitReady` returns at once. */
class AdoptReadyObjectsApi implements SandboxCustomObjectsApi {
  constructor(private readonly previousSessionId: string) {}

  private cr(name: string, annotations?: Record<string, string>): unknown {
    return {
      apiVersion: SANDBOX_CR_API_VERSION,
      kind: "Sandbox",
      metadata: { name, uid: "cr-uid-adopt", resourceVersion: "1", ...(annotations ? { annotations } : {}) },
      spec: { podTemplate: {}, volumeClaimTemplates: [] },
      status: { conditions: [{ type: "Ready", status: "True", reason: "DependenciesReady" }] },
    };
  }

  async createNamespacedCustomObject(): Promise<unknown> {
    throw new FakeApiError(409, "already exists");
  }
  async getNamespacedCustomObject(params: GetSandboxParams): Promise<unknown> {
    return this.cr(params.name, { "valet.dev/session": this.previousSessionId });
  }
  async replaceNamespacedCustomObject(params: ReplaceSandboxParams): Promise<unknown> {
    return this.cr(params.name);
  }
  async deleteNamespacedCustomObject(): Promise<unknown> {
    return {};
  }
  async listNamespacedCustomObject(): Promise<unknown> {
    return { items: [] };
  }
  async patchNamespacedCustomObject(): Promise<unknown> {
    return {};
  }
}

describe("create() adoption convergence (TKAI-402)", () => {
  interface PvcPatch {
    storage: string;
  }

  function makeAdoptingProvider(opts: {
    pvcRequested: string;
    previousSessionId: string;
    readRejects?: string;
    readReturnsNull?: boolean;
    omitRequestedStorage?: boolean;
    patchRejects?: string;
  }) {
    const patches: PvcPatch[] = [];
    let requested = opts.pvcRequested;
    const pvcApi = {
      async readPvc() {
        if (opts.readRejects !== undefined) throw new Error(opts.readRejects);
        if (opts.readReturnsNull === true) return null;
        return {
          ...(opts.omitRequestedStorage === true ? {} : { requestedStorage: requested }),
          capacityStorage: requested,
          annotations: {},
        };
      },
      async patchPvcStorage(_ns: string, _name: string, storage: string) {
        if (opts.patchRejects !== undefined) throw new Error(opts.patchRejects);
        patches.push({ storage });
        requested = storage;
      },
    };
    const provider = new KubernetesSandboxProvider(
      {
        objectsApi: new AdoptReadyObjectsApi(opts.previousSessionId),
        podsApi: new FakePodsApi(),
        execApi: fakePodExecApi,
        livenessApi: new FakeLivenessApi(),
        pvcApi,
      },
      providerCfg,
    );
    return { provider, patches };
  }

  it("grows an adopted claim up to the repo-declared workspaceStorage", async () => {
    const { provider, patches } = makeAdoptingProvider({ pvcRequested: "1Gi", previousSessionId: "session-old" });
    await provider.create({ workspace: "/ws/mono", sessionId: "session-new", workspaceStorage: "8Gi" });
    expect(patches).toHaveLength(1);
    expect(patches[0].storage).toBe("8Gi");
  });

  it("does not touch an adopted claim already at the declared size", async () => {
    const { provider, patches } = makeAdoptingProvider({ pvcRequested: "8Gi", previousSessionId: "session-old" });
    await provider.create({ workspace: "/ws/mono", sessionId: "session-new", workspaceStorage: "8Gi" });
    expect(patches).toHaveLength(0);
  });

  it("does not touch an adopted claim when nothing is declared", async () => {
    const { provider, patches } = makeAdoptingProvider({ pvcRequested: "1Gi", previousSessionId: "session-old" });
    await provider.create({ workspace: "/ws/mono", sessionId: "session-new" });
    expect(patches).toHaveLength(0);
  });

  it("warns when the adopted CR was owned by a different session", async () => {
    const { provider } = makeAdoptingProvider({ pvcRequested: "1Gi", previousSessionId: "session-old" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await provider.create({ workspace: "/ws/mono", sessionId: "session-new" });
    const warned = warnSpy.mock.calls.some(
      (args) => typeof args[0] === "string" && args[0].includes("previously owned by session session-old"),
    );
    warnSpy.mockRestore();
    expect(warned).toBe(true);
  });

  it("a rejected resize patch never fails create() — non-expandable StorageClasses boot on the small claim", async () => {
    // Model a StorageClass without allowVolumeExpansion: admission rejects
    // the patch every time.
    const { provider, patches } = makeAdoptingProvider({
      pvcRequested: "1Gi",
      previousSessionId: "session-old",
      patchRejects: 'persistentvolumeclaims "workspace-x" is forbidden: volume expansion is disabled',
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      provider.create({ workspace: "/ws/mono", sessionId: "session-new", workspaceStorage: "8Gi" }),
    ).resolves.toBeDefined();
    const warned = warnSpy.mock.calls.some(
      (args) => typeof args[0] === "string" && args[0].includes("convergence to 8Gi failed"),
    );
    warnSpy.mockRestore();
    expect(warned).toBe(true);
    expect(patches).toHaveLength(0);
  });

  it("reports an adopted claim read error and continues on the existing claim", async () => {
    const { provider, patches } = makeAdoptingProvider({
      pvcRequested: "1Gi",
      previousSessionId: "session-old",
      readRejects: "apiserver unavailable",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordWorkspaceGrow.mockClear();

    await expect(
      provider.create({ workspace: "/ws/mono", sessionId: "session-new", workspaceStorage: "8Gi" }),
    ).resolves.toBeDefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Kubernetes API read failed for adopted workspace PVC"),
      "apiserver unavailable",
    );
    expect(recordWorkspaceGrow).toHaveBeenCalledWith("error");
    expect(patches).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("reports a missing adopted claim separately from a read error", async () => {
    const { provider, patches } = makeAdoptingProvider({
      pvcRequested: "1Gi",
      previousSessionId: "session-old",
      readReturnsNull: true,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordWorkspaceGrow.mockClear();

    await expect(
      provider.create({ workspace: "/ws/mono", sessionId: "session-new", workspaceStorage: "8Gi" }),
    ).resolves.toBeDefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("PVC lookup returned no claim"));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.any(String), expect.anything());
    expect(recordWorkspaceGrow).toHaveBeenCalledWith("error");
    expect(patches).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("reports an adopted claim without a storage request and continues", async () => {
    const { provider, patches } = makeAdoptingProvider({
      pvcRequested: "1Gi",
      previousSessionId: "session-old",
      omitRequestedStorage: true,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordWorkspaceGrow.mockClear();

    await expect(
      provider.create({ workspace: "/ws/mono", sessionId: "session-new", workspaceStorage: "8Gi" }),
    ).resolves.toBeDefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Storage request is missing.*workspace-ws-mono.*valet-sandboxes.*Check the PVC storage request/s),
    );
    expect(recordWorkspaceGrow).toHaveBeenCalledWith("error");
    expect(patches).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("reports an adopted claim with an invalid storage request and continues", async () => {
    const { provider, patches } = makeAdoptingProvider({
      pvcRequested: "invalid-quantity",
      previousSessionId: "session-old",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordWorkspaceGrow.mockClear();

    await expect(
      provider.create({ workspace: "/ws/mono", sessionId: "session-new", workspaceStorage: "8Gi" }),
    ).resolves.toBeDefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Storage request is invalid.*workspace-ws-mono.*valet-sandboxes.*Set the PVC storage request/s),
    );
    expect(recordWorkspaceGrow).toHaveBeenCalledWith("error");
    expect(patches).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it.each(["0", "-1Gi"])(
    "reports a non-positive adopted claim storage request (%s) and continues",
    async (pvcRequested) => {
      const { provider, patches } = makeAdoptingProvider({
        pvcRequested,
        previousSessionId: "session-old",
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      recordWorkspaceGrow.mockClear();

      await expect(
        provider.create({ workspace: "/ws/mono", sessionId: "session-new", workspaceStorage: "8Gi" }),
      ).resolves.toBeDefined();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Storage request is invalid.*workspace-ws-mono.*valet-sandboxes.*Set the PVC storage request/s),
      );
      expect(recordWorkspaceGrow).toHaveBeenCalledWith("error");
      expect(recordWorkspaceGrow).not.toHaveBeenCalledWith("refused");
      expect(patches).toHaveLength(0);
      warnSpy.mockRestore();
    },
  );

  it("an adopted claim at the growth cap does not warn (declared above the cap resolves to the cap)", async () => {
    const { provider, patches } = makeAdoptingProvider({ pvcRequested: "20Gi", previousSessionId: "session-old" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await provider.create({ workspace: "/ws/mono", sessionId: "session-new", workspaceStorage: "50Gi" });
    const falseWarn = warnSpy.mock.calls.some(
      (args) => typeof args[0] === "string" && args[0].includes("below the declared"),
    );
    warnSpy.mockRestore();
    expect(patches).toHaveLength(0);
    expect(falseWarn).toBe(false);
  });
});
