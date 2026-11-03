import { expect, it, vi } from "vitest";
import { buildSandboxManifest, sandboxCrName } from "../src/manifest.js";
import { KubernetesSandboxProvider } from "../src/provider.js";
import { SANDBOX_CR_API_VERSION } from "../src/types.js";
import { ensureRuntimeState, type RuntimeStateApi, type RuntimeStateClaim } from "../src/runtime-state.js";

const cfg = { namespace: "test", defaultImage: "browser:1", apiVersion: SANDBOX_CR_API_VERSION };

// Turn settlement and teardown ask about one session. A fleet listing here
// read about 110 MB of CR JSON per settle on dev and tripped liveness on 2026-10-29.
async function fixture() {
  const workspace = "browser-working-directory";
  const name = sandboxCrName(workspace);
  const built = buildSandboxManifest(cfg, name, { workspace, sessionId: "owner" });
  const cr = { ...built, metadata: { ...built.metadata, creationTimestamp: "2026-11-03T00:00:00Z" } };
  const claims = new Map<string, RuntimeStateClaim>();
  const claimLists = vi.fn(async () => [...claims.values()]);
  const runtimeStateApi: RuntimeStateApi = {
    read: async (_namespace, claimName) => claims.get(claimName),
    create: async (_namespace, claim) => { claims.set(claim.metadata.name, claim); },
    list: async (_namespace, sandboxId) => sandboxId === undefined
      ? claimLists()
      : [...claims.values()].filter((claim) => claim.metadata.labels?.["valet.dev/runtime-sandbox"] === sandboxId),
    delete: async (_namespace, claimName) => { claims.delete(claimName); },
  };
  const listCrs = vi.fn(async () => ({ items: [cr] }));
  const provider = new KubernetesSandboxProvider({
    objectsApi: {
      getNamespacedCustomObject: async ({ name: requested }: { name: string }) => {
        if (requested === name) return cr;
        throw Object.assign(new Error("not found"), { code: 404 });
      },
      listNamespacedCustomObject: listCrs,
      createNamespacedCustomObject: vi.fn(),
      replaceNamespacedCustomObject: vi.fn(),
      patchNamespacedCustomObject: vi.fn(),
      deleteNamespacedCustomObject: vi.fn(),
    },
    podsApi: { listNamespacedPod: async () => ({ items: [] }), patchNamespacedPod: async () => ({}) },
    execApi: { exec: vi.fn() },
    livenessApi: { getPodUid: async () => null },
    runtimeStateApi,
  }, cfg);
  return { name, provider, runtimeStateApi, listCrs, claimLists };
}

it("finds a session's browser sandbox from its own claim, without listing CRs or claims", async () => {
  const f = await fixture();
  await ensureRuntimeState(f.runtimeStateApi, cfg.namespace, "owner", f.name, "1Gi", false);

  expect(await f.provider.listBrowserForSession("owner")).toEqual([
    { id: f.name, sessionId: "owner", browserEnabled: true, createdAtMs: Date.parse("2026-11-03T00:00:00Z") },
  ]);
  expect(await f.provider.listBrowserForSession("someone-else")).toEqual([]);
  expect(f.listCrs).not.toHaveBeenCalled();
  expect(f.claimLists).not.toHaveBeenCalled();
});

it("describes one sandbox by id and rejects mismatched owners", async () => {
  const f = await fixture();
  expect(await f.provider.describe(f.name)).toMatchObject({ id: f.name, sessionId: "owner", browserEnabled: false });
  expect(await f.provider.describe("missing")).toBeNull();
  await ensureRuntimeState(f.runtimeStateApi, cfg.namespace, "intruder", f.name, "1Gi", false);
  await expect(f.provider.describe(f.name)).rejects.toThrow(/different session owners/);
  expect(f.listCrs).not.toHaveBeenCalled();
});
