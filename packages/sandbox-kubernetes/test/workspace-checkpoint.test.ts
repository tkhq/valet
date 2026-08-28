/**
 * Provider-level workspace checkpoint orchestration (spec 05.3), against
 * fakes — no cluster, no S3. Covers: suspend triggers the presign → in-pod
 * exec → prune chain in order, reap without a live pod skips, a checkpoint
 * failure never blocks the lifecycle (INV-7), and legacy config never
 * touches the store.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { CheckpointManifest, WorkspaceRef } from "@valet/engine";
import { KubernetesSandboxProvider } from "../src/provider.js";
import { SANDBOX_CR_API_VERSION } from "../src/types.js";
import type { K8sProviderConfig } from "../src/types.js";
import type { WorkspaceCheckpointStore } from "../src/workspace-object-store.js";
import type { CheckpointUploadUrls } from "../src/workspace-scripts.js";
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
  SandboxPodStatusApi,
} from "../src/lifecycle.js";
import type { PodLivenessApi } from "../src/provider.js";
import type { ExecStatus, PodExecApi } from "../src/exec.js";

const ORG = "org_39828000-1c89-4735-874e-2150e09dc225";
const OWNER = "user_zeke";
const POD_NAME_ANNOTATION = "agents.x-k8s.io/pod-name";

function providerCfg(withObjectStore: boolean): K8sProviderConfig {
  return {
    namespace: "valet-sandboxes",
    defaultImage: "valet-sandbox:latest",
    apiVersion: SANDBOX_CR_API_VERSION,
    ...(withObjectStore
      ? {
          workspacePersistence: {
            backend: "object-store" as const,
            objectStore: {
              bucket: "valet-workspaces-dev",
              endpoint: "http://minio:9000",
              region: "us-east-1",
              prefix: "",
              credentialsSecret: "valet-workspace-store",
              gzip: true,
              keepCheckpoints: 2,
            },
            policy: {
              minCheckpointIntervalMs: 5 * 60_000,
              checkpointOnReap: true,
              periodicCheckpoint: true,
              onRestoreFailure: "fallback" as const,
            },
          },
        }
      : {}),
  };
}

class FakeObjectsApi implements SandboxCustomObjectsApi {
  patches: PatchSandboxParams[] = [];
  deletes: DeleteSandboxParams[] = [];
  /** When false, the CR carries no pod-name annotation (no live pod). */
  hasPod = true;
  /** When false, the CR carries no org/owner annotations. */
  hasTenantAnnotations = true;
  /** CR names returned by list (drives the periodic sweep). */
  listedNames: string[] = [];

  async createNamespacedCustomObject(_params: CreateSandboxParams): Promise<unknown> {
    throw new Error("not used");
  }

  async getNamespacedCustomObject(params: GetSandboxParams): Promise<unknown> {
    return {
      apiVersion: SANDBOX_CR_API_VERSION,
      kind: "Sandbox",
      metadata: {
        name: params.name,
        uid: "cr-uid-123",
        annotations: {
          ...(this.hasTenantAnnotations ? { "valet.dev/org": ORG, "valet.dev/owner": OWNER } : {}),
          ...(this.hasPod ? { [POD_NAME_ANNOTATION]: `${params.name}-pod` } : {}),
        },
      },
      spec: { podTemplate: {}, volumeClaimTemplates: [] },
      status: { conditions: [{ type: "Ready", status: "True", reason: "DependenciesReady" }] },
    };
  }

  async replaceNamespacedCustomObject(_params: ReplaceSandboxParams): Promise<unknown> {
    return {};
  }

  async deleteNamespacedCustomObject(params: DeleteSandboxParams): Promise<unknown> {
    this.deletes.push(params);
    return {};
  }

  async listNamespacedCustomObject(_params: ListSandboxParams): Promise<unknown> {
    return {
      items: this.listedNames.map((name) => ({
        apiVersion: SANDBOX_CR_API_VERSION,
        kind: "Sandbox",
        metadata: {
          name,
          annotations: {
            ...(this.hasTenantAnnotations ? { "valet.dev/org": ORG, "valet.dev/owner": OWNER } : {}),
            ...(this.hasPod ? { [POD_NAME_ANNOTATION]: `${name}-pod` } : {}),
          },
        },
      })),
    };
  }

  async patchNamespacedCustomObject(params: PatchSandboxParams): Promise<unknown> {
    this.patches.push(params);
    return {};
  }
}

class FakePodsApi implements SandboxPodsApi {
  async listNamespacedPod(_params: ListPodsParams): Promise<{ items: never[] }> {
    return { items: [] };
  }
}

const fakeLiveness: PodLivenessApi = {
  async getPodUid() {
    return "pod-uid-1";
  },
};

/** Records the exec'd command and plays back a scripted result. */
class FakeExecApi implements PodExecApi {
  commands: string[] = [];
  stdout = "checkpoint-committed size=1234 entries=7\n";
  status: ExecStatus = { status: "Success" };

  async exec(
    _ns: string,
    _pod: string,
    _container: string,
    command: string[],
    stdout: PassThrough | null,
    _stderr: PassThrough | null,
    _stdin: unknown,
    _tty: boolean,
    statusCallback?: (status: ExecStatus) => void,
  ): Promise<{ close(): void }> {
    this.commands.push(command[2] ?? "");
    setImmediate(() => {
      stdout?.write(this.stdout);
      statusCallback?.(this.status);
    });
    return { close() {} };
  }
}

class FakeStore implements WorkspaceCheckpointStore {
  calls: string[] = [];
  refs: WorkspaceRef[] = [];
  latestResult: CheckpointManifest | null = null;
  presignError: Error | null = null;

  async latest(ref: WorkspaceRef): Promise<CheckpointManifest | null> {
    this.calls.push("latest");
    this.refs.push(ref);
    return this.latestResult;
  }

  async presignCheckpointPuts(ref: WorkspaceRef, checkpointId: string): Promise<CheckpointUploadUrls> {
    this.calls.push("presign");
    this.refs.push(ref);
    if (this.presignError) throw this.presignError;
    return {
      dataUrl: `http://minio/d/${checkpointId}`,
      manifestUrl: `http://minio/m/${checkpointId}`,
      latestUrl: `http://minio/l/${checkpointId}`,
    };
  }

  async pruneCheckpoints(ref: WorkspaceRef, _latestCheckpointId: string): Promise<void> {
    this.calls.push("prune");
    this.refs.push(ref);
  }
}

function makeProvider(args: {
  objectStore: boolean;
  objectsApi?: FakeObjectsApi;
  execApi?: FakeExecApi;
  store?: FakeStore;
  podStatusApi?: SandboxPodStatusApi;
}) {
  const objectsApi = args.objectsApi ?? new FakeObjectsApi();
  const execApi = args.execApi ?? new FakeExecApi();
  const store = args.store ?? new FakeStore();
  const provider = new KubernetesSandboxProvider(
    {
      objectsApi,
      podsApi: new FakePodsApi(),
      execApi,
      livenessApi: fakeLiveness,
      workspaceStore: store,
      ...(args.podStatusApi ? { podStatusApi: args.podStatusApi } : {}),
    },
    providerCfg(args.objectStore),
  );
  return { provider, objectsApi, execApi, store };
}

describe("workspace checkpoint on suspend", () => {
  it("presigns, execs the in-pod script, prunes, then patches Suspended", async () => {
    const { provider, objectsApi, execApi, store } = makeProvider({ objectStore: true });
    await provider.suspend("ws-1");

    expect(store.calls).toEqual(["latest", "presign", "prune"]);
    // Tenant-scoped ref from the CR annotations (INV-3).
    expect(store.refs[0]).toEqual({ orgId: ORG, ownerId: OWNER, workspaceId: "ws-1" });
    // The in-pod script carries INV-2's upload order.
    expect(execApi.commands).toHaveLength(1);
    const dataIdx = execApi.commands[0]!.indexOf("VALET_WS_DATA_URL");
    const latestIdx = execApi.commands[0]!.indexOf("VALET_WS_LATEST_URL");
    expect(dataIdx).toBeGreaterThan(-1);
    expect(latestIdx).toBeGreaterThan(dataIdx);
    // The suspend still happened, after the checkpoint.
    expect(objectsApi.patches).toHaveLength(1);
  });

  it("a checkpoint failure never blocks the suspend (INV-7)", async () => {
    const store = new FakeStore();
    store.presignError = new Error("minio down");
    const { provider, objectsApi, execApi } = makeProvider({ objectStore: true, store });
    await provider.suspend("ws-1");

    expect(execApi.commands).toHaveLength(0);
    expect(objectsApi.patches).toHaveLength(1); // suspend proceeded
  });

  it("a failed in-pod script records a failure and still suspends (INV-7)", async () => {
    const execApi = new FakeExecApi();
    execApi.status = {
      status: "Failure",
      reason: "NonZeroExitCode",
      details: { causes: [{ reason: "ExitCode", message: "13" }] },
    };
    execApi.stdout = "";
    const { provider, objectsApi, store } = makeProvider({ objectStore: true, execApi });
    await provider.suspend("ws-1");

    expect(store.calls).toEqual(["latest", "presign"]); // no prune after failure
    expect(objectsApi.patches).toHaveLength(1);
  });

  it("suspend is never rate-limited: a fresh checkpoint still uploads", async () => {
    // The pod (and its emptyDir workspace) goes away at suspend; skipping
    // this checkpoint would permanently lose the writes since ck-fresh.
    const store = new FakeStore();
    store.latestResult = {
      checkpointId: "ck-fresh",
      createdAtMs: Date.now() - 1000, // inside the 5-minute interval
      sizeBytes: 1,
      entryCount: 1,
    };
    const { provider, execApi } = makeProvider({ objectStore: true, store });
    await provider.suspend("ws-1");

    expect(store.calls).toEqual(["latest", "presign", "prune"]);
    expect(execApi.commands).toHaveLength(1);
  });

  it("rate-limits the periodic sweep via the kernel: a fresh checkpoint skips the upload", async () => {
    const objectsApi = new FakeObjectsApi();
    objectsApi.listedNames = ["ws-1"];
    const store = new FakeStore();
    store.latestResult = {
      checkpointId: "ck-fresh",
      createdAtMs: Date.now() - 1000, // inside the 5-minute interval
      sizeBytes: 1,
      entryCount: 1,
    };
    const { provider, execApi } = makeProvider({ objectStore: true, objectsApi, store });
    await provider.sweepWorkspaceCheckpoints();

    expect(store.calls).toEqual(["latest"]);
    expect(execApi.commands).toHaveLength(0);
  });

  it("refuses a checkpoint when the pod cold-started after a restore failure", async () => {
    // Cold-start clobber guard: committing an emptied workspace would
    // advance `latest` past the last good checkpoint and retention prune
    // would then delete the good data.
    const podStatusApi: SandboxPodStatusApi = {
      async getPodStatus() {
        return {
          phase: "Running",
          initContainerStatuses: [
            {
              name: "workspace-restore",
              terminated: { exitCode: 0, message: "cold-start reason=restore-failed" },
            },
          ],
        };
      },
    };
    const { provider, store, execApi, objectsApi } = makeProvider({ objectStore: true, podStatusApi });
    await provider.suspend("ws-1");

    expect(store.calls).toEqual(["latest"]); // kernel said checkpoint; the guard refused before presign
    expect(execApi.commands).toHaveLength(0);
    expect(objectsApi.patches).toHaveLength(1); // the suspend still proceeded (INV-7)
  });

  it("skips the commit when the in-pod script reports an unchanged workspace", async () => {
    const execApi = new FakeExecApi();
    execApi.stdout = "checkpoint-unchanged\n";
    const { provider, store, objectsApi } = makeProvider({ objectStore: true, execApi });
    await provider.suspend("ws-1");

    expect(store.calls).toEqual(["latest", "presign"]); // no prune — nothing committed
    expect(objectsApi.patches).toHaveLength(1);
  });

  it("serializes concurrent checkpoint paths for the same sandbox", async () => {
    // Suspend and destroy fire from independent timers; interleaved in-pod
    // execs would race the latest-pointer commit and prune.
    let inFlight = 0;
    let maxInFlight = 0;
    class TrackingExecApi extends FakeExecApi {
      override async exec(
        ns: string,
        pod: string,
        container: string,
        command: string[],
        stdout: PassThrough | null,
        stderr: PassThrough | null,
        stdin: unknown,
        tty: boolean,
        statusCallback?: (status: ExecStatus) => void,
      ): Promise<{ close(): void }> {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return super.exec(ns, pod, container, command, stdout, stderr, stdin, tty, (s) => {
          inFlight -= 1;
          statusCallback?.(s);
        });
      }
    }
    const { provider } = makeProvider({ objectStore: true, execApi: new TrackingExecApi() });
    await Promise.all([provider.suspend("ws-1"), provider.destroy("ws-1")]);

    expect(maxInFlight).toBe(1);
  });

  it("legacy config (no workspacePersistence) never touches the store", async () => {
    const { provider, store, execApi, objectsApi } = makeProvider({ objectStore: false });
    await provider.suspend("ws-1");

    expect(store.calls).toEqual([]);
    expect(execApi.commands).toHaveLength(0);
    expect(objectsApi.patches).toHaveLength(1);
  });
});

describe("create() identity guard (object-store)", () => {
  it("fails closed when object-store is configured without orgId/ownerId", async () => {
    // Without the guard the manifest silently emits a bare emptyDir (no
    // restore init container, no checkpoint annotations) while
    // capabilities() still advertises a persistent workspace.
    const { provider } = makeProvider({ objectStore: true });
    await expect(provider.create({ workspace: "ws-1" })).rejects.toThrow(/orgId/);
    await expect(provider.create({ workspace: "ws-1", orgId: ORG, ownerId: "" })).rejects.toThrow(
      /ownerId/,
    );
  });
});

describe("workspace checkpoint on reap (destroy)", () => {
  it("destroy() of a live sandbox checkpoints before deleting the CR", async () => {
    const { provider, objectsApi, store } = makeProvider({ objectStore: true });
    await provider.destroy("ws-1");

    expect(store.calls).toEqual(["latest", "presign", "prune"]);
    expect(objectsApi.deletes).toHaveLength(1);
  });

  it("destroy() of a hibernated sandbox (no pod) skips the checkpoint and deletes", async () => {
    const objectsApi = new FakeObjectsApi();
    objectsApi.hasPod = false;
    const { provider, store, execApi } = makeProvider({ objectStore: true, objectsApi });
    await provider.destroy("ws-1");

    expect(store.calls).toEqual(["latest"]); // kernel said checkpoint, but no pod to tar
    expect(execApi.commands).toHaveLength(0);
    expect(objectsApi.deletes).toHaveLength(1);
  });

  it("a CR without org/owner annotations skips (no tenant key, INV-3) and deletes", async () => {
    const objectsApi = new FakeObjectsApi();
    objectsApi.hasTenantAnnotations = false;
    const { provider, store } = makeProvider({ objectStore: true, objectsApi });
    await provider.destroy("ws-1");

    expect(store.calls).toEqual([]);
    expect(objectsApi.deletes).toHaveLength(1);
  });
});

describe("capabilities per backend", () => {
  it("object-store keeps persistentWorkspace true; none reports false", () => {
    const { provider } = makeProvider({ objectStore: true });
    expect(provider.capabilities().persistentWorkspace).toBe(true);

    const noneProvider = new KubernetesSandboxProvider(
      {
        objectsApi: new FakeObjectsApi(),
        podsApi: new FakePodsApi(),
        execApi: new FakeExecApi(),
        livenessApi: fakeLiveness,
      },
      {
        namespace: "valet-sandboxes",
        defaultImage: "valet-sandbox:latest",
        apiVersion: SANDBOX_CR_API_VERSION,
        workspacePersistence: {
          backend: "none",
          policy: {
            minCheckpointIntervalMs: 5 * 60_000,
            checkpointOnReap: true,
            periodicCheckpoint: false,
            onRestoreFailure: "fallback",
          },
        },
      },
    );
    expect(noneProvider.capabilities().persistentWorkspace).toBe(false);
  });
});
