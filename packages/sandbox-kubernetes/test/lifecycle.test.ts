import { describe, expect, it } from "vitest";
import { SANDBOX_CR_API_VERSION, buildSandboxManifest } from "../src/index.js";
import type { K8sProviderConfig, SandboxCR, SandboxCRRead } from "../src/index.js";
import {
  SANDBOX_KIND,
  SANDBOX_PLURAL,
  applySandbox,
  deleteSandbox,
  getSandbox,
  listSandboxes,
  mapConditionsToStatus,
  parseSandboxCRRead,
  resolvePodName,
  sandboxStatus,
} from "../src/lifecycle.js";
import type {
  CreateSandboxParams,
  DeleteSandboxParams,
  GetSandboxParams,
  ListPodsParams,
  ListSandboxParams,
  ReplaceSandboxParams,
  SandboxCustomObjectsApi,
  SandboxPodsApi,
} from "../src/lifecycle.js";

const cfg: K8sProviderConfig = {
  namespace: "valet-sandboxes",
  defaultImage: "valet-sandbox:latest",
  apiVersion: SANDBOX_CR_API_VERSION,
};

/** Minimal 409 ApiException-shaped error, matching client-node's real
 * `ApiException` (`code: number`) without depending on the real class. */
class FakeApiError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function toCRRead(manifest: SandboxCR, extra: Partial<SandboxCRRead["metadata"]> = {}): SandboxCRRead {
  return {
    apiVersion: manifest.apiVersion,
    kind: manifest.kind,
    metadata: { ...manifest.metadata, resourceVersion: "1", uid: "uid-1", ...extra },
    spec: manifest.spec,
    status: { conditions: [] },
  };
}

/**
 * Fake `SandboxCustomObjectsApi` backed by an in-memory Map, keyed by CR
 * name. Honest to the real client-node contract this module drives: create
 * throws a 409 (FakeApiError) when the name already exists, get/delete
 * throw 404 when absent, replace bumps `resourceVersion` and requires it to
 * match (optimistic concurrency), matching the real API server's behavior
 * closely enough to exercise applySandbox's adopt path.
 */
class FakeCustomObjectsApi implements SandboxCustomObjectsApi {
  private store = new Map<string, SandboxCRRead>();
  public createCalls = 0;
  public replaceCalls = 0;

  seed(cr: SandboxCRRead): void {
    this.store.set(cr.metadata.name, cr);
  }

  get(name: string): SandboxCRRead | undefined {
    return this.store.get(name);
  }

  async createNamespacedCustomObject(params: CreateSandboxParams): Promise<unknown> {
    this.createCalls++;
    const name = params.body.metadata.name;
    if (this.store.has(name)) {
      throw new FakeApiError(409, `sandboxes.agents.x-k8s.io "${name}" already exists`);
    }
    const created = toCRRead(params.body);
    this.store.set(name, created);
    return created;
  }

  async getNamespacedCustomObject(params: GetSandboxParams): Promise<unknown> {
    const found = this.store.get(params.name);
    if (!found) {
      throw new FakeApiError(404, `sandboxes.agents.x-k8s.io "${params.name}" not found`);
    }
    return found;
  }

  async replaceNamespacedCustomObject(params: ReplaceSandboxParams): Promise<unknown> {
    this.replaceCalls++;
    const existing = this.store.get(params.name);
    if (!existing) {
      throw new FakeApiError(404, `sandboxes.agents.x-k8s.io "${params.name}" not found`);
    }
    if (params.body.metadata.resourceVersion !== existing.metadata.resourceVersion) {
      throw new FakeApiError(409, "resourceVersion conflict");
    }
    const nextVersion = String(Number(existing.metadata.resourceVersion ?? "0") + 1);
    // Real apiserver PUT semantics: server-managed immutable identity
    // fields (uid) are preserved regardless of what the client sends —
    // only resourceVersion is bumped and spec/labels/annotations are
    // replaced wholesale.
    const replaced: SandboxCRRead = {
      apiVersion: params.body.apiVersion,
      kind: params.body.kind,
      metadata: { ...params.body.metadata, uid: existing.metadata.uid, resourceVersion: nextVersion },
      spec: params.body.spec,
      status: existing.status,
    };
    this.store.set(params.name, replaced);
    return replaced;
  }

  async deleteNamespacedCustomObject(params: DeleteSandboxParams): Promise<unknown> {
    if (!this.store.has(params.name)) {
      throw new FakeApiError(404, `sandboxes.agents.x-k8s.io "${params.name}" not found`);
    }
    this.store.delete(params.name);
    return {};
  }

  async listNamespacedCustomObject(_params: ListSandboxParams): Promise<unknown> {
    return { items: Array.from(this.store.values()) };
  }
}

interface FakePod {
  name: string;
  ownerReferences?: { kind: string; name: string; controller?: boolean }[];
}

class FakePodsApi implements SandboxPodsApi {
  constructor(private pods: FakePod[]) {}

  async listNamespacedPod(_params: ListPodsParams): Promise<{ items: FakePod[] }> {
    return { items: this.pods };
  }
}

describe("mapConditionsToStatus (pure)", () => {
  it("maps no conditions to provisioning", () => {
    expect(mapConditionsToStatus("sess-1", [])).toEqual({ id: "sess-1", state: "provisioning" });
  });

  it("maps Ready=True to ready", () => {
    const status = mapConditionsToStatus("sess-1", [
      { type: "Ready", status: "True", reason: "DependenciesReady" },
    ]);
    expect(status).toEqual({ id: "sess-1", state: "ready" });
  });

  it("maps Ready=False to provisioning", () => {
    const status = mapConditionsToStatus("sess-1", [{ type: "Ready", status: "False", reason: "PodPending" }]);
    expect(status).toEqual({ id: "sess-1", state: "provisioning" });
  });

  it("maps Ready=Unknown to provisioning", () => {
    const status = mapConditionsToStatus("sess-1", [{ type: "Ready", status: "Unknown" }]);
    expect(status).toEqual({ id: "sess-1", state: "provisioning" });
  });

  it("maps an error-shaped condition to error, carrying the message", () => {
    const status = mapConditionsToStatus("sess-1", [
      { type: "Ready", status: "False" },
      { type: "Error", status: "True", message: "image pull failed" },
    ]);
    expect(status).toEqual({ id: "sess-1", state: "error", error: "image pull failed" });
  });

  it("falls back to reason then type when an error condition has no message", () => {
    expect(mapConditionsToStatus("sess-1", [{ type: "Failed", status: "True", reason: "BadSpec" }])).toEqual({
      id: "sess-1",
      state: "error",
      error: "BadSpec",
    });
    expect(mapConditionsToStatus("sess-1", [{ type: "Failed", status: "True" }])).toEqual({
      id: "sess-1",
      state: "error",
      error: "Failed",
    });
  });

  it("ignores an error-shaped condition that is not status=True", () => {
    const status = mapConditionsToStatus("sess-1", [
      { type: "Ready", status: "True" },
      { type: "Error", status: "False" },
    ]);
    expect(status).toEqual({ id: "sess-1", state: "ready" });
  });
});

describe("parseSandboxCRRead", () => {
  it("throws on a non-object response", () => {
    expect(() => parseSandboxCRRead("not-an-object")).toThrow(/not an object/);
    expect(() => parseSandboxCRRead(null)).toThrow(/not an object/);
  });

  it("throws when metadata.name is missing", () => {
    expect(() => parseSandboxCRRead({ spec: { podTemplate: {}, volumeClaimTemplates: [] } })).toThrow(
      /metadata.name/,
    );
  });

  it("throws when spec.podTemplate or volumeClaimTemplates is missing", () => {
    expect(() => parseSandboxCRRead({ metadata: { name: "x" }, spec: {} })).toThrow(/spec.podTemplate/);
    expect(() =>
      parseSandboxCRRead({ metadata: { name: "x" }, spec: { podTemplate: {} } }),
    ).toThrow(/spec.podTemplate/);
  });

  it("parses a minimal valid response", () => {
    const parsed = parseSandboxCRRead({
      metadata: { name: "sess-1" },
      spec: { podTemplate: {}, volumeClaimTemplates: [] },
    });
    expect(parsed.metadata.name).toBe("sess-1");
    expect(parsed.status).toBeUndefined();
  });

  it("parses annotations, labels, resourceVersion, uid, and status.conditions", () => {
    const parsed = parseSandboxCRRead({
      metadata: {
        name: "sess-1",
        namespace: "valet-sandboxes",
        resourceVersion: "42",
        uid: "abc-123",
        labels: { "valet.dev/session-id": "sess-1" },
        annotations: { "agents.x-k8s.io/pod-name": "sess-1" },
      },
      spec: { podTemplate: {}, volumeClaimTemplates: [] },
      status: {
        conditions: [
          { type: "Ready", status: "True", reason: "DependenciesReady", message: "Pod is Ready" },
        ],
        selector: "agents.x-k8s.io/sandbox-name-hash=deadbeef",
      },
    });
    expect(parsed.metadata.namespace).toBe("valet-sandboxes");
    expect(parsed.metadata.resourceVersion).toBe("42");
    expect(parsed.metadata.uid).toBe("abc-123");
    expect(parsed.metadata.labels).toEqual({ "valet.dev/session-id": "sess-1" });
    expect(parsed.metadata.annotations).toEqual({ "agents.x-k8s.io/pod-name": "sess-1" });
    expect(parsed.status?.conditions).toEqual([
      { type: "Ready", status: "True", reason: "DependenciesReady", message: "Pod is Ready" },
    ]);
    expect(parsed.status?.selector).toBe("agents.x-k8s.io/sandbox-name-hash=deadbeef");
  });

  it("drops a malformed condition (missing status) rather than throwing", () => {
    const parsed = parseSandboxCRRead({
      metadata: { name: "sess-1" },
      spec: { podTemplate: {}, volumeClaimTemplates: [] },
      status: { conditions: [{ type: "Ready" }, { type: "Weird", status: "True" }] },
    });
    expect(parsed.status?.conditions).toEqual([{ type: "Weird", status: "True" }]);
  });
});

describe("applySandbox", () => {
  it("creates a new CR when none exists", async () => {
    const api = new FakeCustomObjectsApi();
    const manifest = buildSandboxManifest(cfg, "sess-1", {});
    const result = await applySandbox(api, cfg, manifest);
    expect(result.metadata.name).toBe("sess-1");
    expect(api.createCalls).toBe(1);
    expect(api.replaceCalls).toBe(0);
  });

  it("adopts an existing CR on 409 — GET + replace, preserving resourceVersion, never an error", async () => {
    const api = new FakeCustomObjectsApi();
    const manifest = buildSandboxManifest(cfg, "sess-1", {});
    api.seed(toCRRead(manifest, { resourceVersion: "7" }));

    const result = await applySandbox(api, cfg, manifest);

    expect(result.metadata.name).toBe("sess-1");
    // The fake bumps resourceVersion on a successful replace — proves the
    // replace call actually carried the existing resourceVersion (7),
    // since a mismatched version would have thrown 409 from the fake too.
    expect(result.metadata.resourceVersion).toBe("8");
    expect(api.createCalls).toBe(1);
    expect(api.replaceCalls).toBe(1);
  });

  it("is idempotent — applying the same manifest twice in a row does not error and keeps the same name/uid", async () => {
    const api = new FakeCustomObjectsApi();
    const manifest = buildSandboxManifest(cfg, "sess-1", {});
    const first = await applySandbox(api, cfg, manifest);
    const second = await applySandbox(api, cfg, manifest);
    expect(second.metadata.name).toBe(first.metadata.name);
    expect(second.metadata.uid).toBe(first.metadata.uid);
  });

  it("propagates non-409 errors from create without attempting to adopt", async () => {
    const api = new FakeCustomObjectsApi();
    api.createNamespacedCustomObject = async () => {
      throw new FakeApiError(500, "internal error");
    };
    const manifest = buildSandboxManifest(cfg, "sess-1", {});
    await expect(applySandbox(api, cfg, manifest)).rejects.toThrow(/internal error/);
  });
});

describe("getSandbox", () => {
  it("returns null for an absent CR (never throws for the 404 case)", async () => {
    const api = new FakeCustomObjectsApi();
    await expect(getSandbox(api, cfg, "does-not-exist")).resolves.toBeNull();
  });

  it("returns the parsed CR when present", async () => {
    const api = new FakeCustomObjectsApi();
    const manifest = buildSandboxManifest(cfg, "sess-1", {});
    api.seed(toCRRead(manifest));
    const result = await getSandbox(api, cfg, "sess-1");
    expect(result?.metadata.name).toBe("sess-1");
  });

  it("propagates non-404 errors", async () => {
    const api = new FakeCustomObjectsApi();
    api.getNamespacedCustomObject = async () => {
      throw new FakeApiError(500, "boom");
    };
    await expect(getSandbox(api, cfg, "sess-1")).rejects.toThrow(/boom/);
  });
});

describe("deleteSandbox", () => {
  it("deletes an existing CR", async () => {
    const api = new FakeCustomObjectsApi();
    const manifest = buildSandboxManifest(cfg, "sess-1", {});
    api.seed(toCRRead(manifest));
    await deleteSandbox(api, cfg, "sess-1");
    expect(api.get("sess-1")).toBeUndefined();
  });

  it("is idempotent — deleting an absent CR does not throw", async () => {
    const api = new FakeCustomObjectsApi();
    await expect(deleteSandbox(api, cfg, "does-not-exist")).resolves.toBeUndefined();
  });

  it("propagates non-404 errors", async () => {
    const api = new FakeCustomObjectsApi();
    api.deleteNamespacedCustomObject = async () => {
      throw new FakeApiError(500, "boom");
    };
    await expect(deleteSandbox(api, cfg, "sess-1")).rejects.toThrow(/boom/);
  });
});

describe("listSandboxes", () => {
  it("returns all seeded CRs parsed", async () => {
    const api = new FakeCustomObjectsApi();
    api.seed(toCRRead(buildSandboxManifest(cfg, "sess-1", {})));
    api.seed(toCRRead(buildSandboxManifest(cfg, "sess-2", {})));
    const results = await listSandboxes(api, cfg);
    expect(results.map((r) => r.metadata.name).sort()).toEqual(["sess-1", "sess-2"]);
  });
});

describe("sandboxStatus", () => {
  it("maps an absent CR to released", async () => {
    const api = new FakeCustomObjectsApi();
    await expect(sandboxStatus(api, cfg, "does-not-exist")).resolves.toEqual({
      id: "does-not-exist",
      state: "released",
    });
  });

  it("maps a Ready=True CR to ready", async () => {
    const api = new FakeCustomObjectsApi();
    const manifest = buildSandboxManifest(cfg, "sess-1", {});
    const cr = toCRRead(manifest);
    cr.status = { conditions: [{ type: "Ready", status: "True", reason: "DependenciesReady" }] };
    api.seed(cr);
    await expect(sandboxStatus(api, cfg, "sess-1")).resolves.toEqual({ id: "sess-1", state: "ready" });
  });

  it("maps a freshly-created CR with no conditions yet to provisioning", async () => {
    const api = new FakeCustomObjectsApi();
    const manifest = buildSandboxManifest(cfg, "sess-1", {});
    api.seed(toCRRead(manifest));
    await expect(sandboxStatus(api, cfg, "sess-1")).resolves.toEqual({ id: "sess-1", state: "provisioning" });
  });
});

describe("resolvePodName", () => {
  it("returns null when the CR does not exist", async () => {
    const objectsApi = new FakeCustomObjectsApi();
    const podsApi = new FakePodsApi([]);
    await expect(resolvePodName(objectsApi, podsApi, cfg, "does-not-exist")).resolves.toBeNull();
  });

  it("prefers the agents.x-k8s.io/pod-name annotation when present", async () => {
    const objectsApi = new FakeCustomObjectsApi();
    const manifest = buildSandboxManifest(cfg, "sess-1", {});
    objectsApi.seed(
      toCRRead(manifest, { annotations: { "agents.x-k8s.io/pod-name": "sess-1-abc123" } }),
    );
    const podsApi = new FakePodsApi([]);
    await expect(resolvePodName(objectsApi, podsApi, cfg, "sess-1")).resolves.toBe("sess-1-abc123");
  });

  it("falls back to an ownerReference scan when the annotation is absent", async () => {
    const objectsApi = new FakeCustomObjectsApi();
    const manifest = buildSandboxManifest(cfg, "sess-1", {});
    objectsApi.seed(toCRRead(manifest));
    const podsApi = new FakePodsApi([
      { name: "unrelated-pod", ownerReferences: [{ kind: "ReplicaSet", name: "sess-1", controller: true }] },
      { name: "sess-1", ownerReferences: [{ kind: SANDBOX_KIND, name: "sess-1", controller: true }] },
    ]);
    await expect(resolvePodName(objectsApi, podsApi, cfg, "sess-1")).resolves.toBe("sess-1");
  });

  it("returns null when the CR exists but no pod is resolvable yet (pending)", async () => {
    const objectsApi = new FakeCustomObjectsApi();
    const manifest = buildSandboxManifest(cfg, "sess-1", {});
    objectsApi.seed(toCRRead(manifest));
    const podsApi = new FakePodsApi([]);
    await expect(resolvePodName(objectsApi, podsApi, cfg, "sess-1")).resolves.toBeNull();
  });

  it("does not match a pod whose ownerReference names this Sandbox but controller is not true", async () => {
    const objectsApi = new FakeCustomObjectsApi();
    const manifest = buildSandboxManifest(cfg, "sess-1", {});
    objectsApi.seed(toCRRead(manifest));
    const podsApi = new FakePodsApi([
      { name: "sess-1", ownerReferences: [{ kind: SANDBOX_KIND, name: "sess-1", controller: false }] },
    ]);
    await expect(resolvePodName(objectsApi, podsApi, cfg, "sess-1")).resolves.toBeNull();
  });
});

describe("SANDBOX_PLURAL / SANDBOX_KIND constants", () => {
  it("match the vendored CRD (sandboxes.agents.x-k8s.io, kind Sandbox)", () => {
    expect(SANDBOX_PLURAL).toBe("sandboxes");
    expect(SANDBOX_KIND).toBe("Sandbox");
  });
});
