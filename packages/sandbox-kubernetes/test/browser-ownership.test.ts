import { expect, it, vi } from "vitest";
import { buildSandboxManifest, sandboxCrName } from "../src/manifest.js";
import {
  KubernetesSandboxProvider,
  type KubernetesSandboxProviderDeps,
} from "../src/provider.js";
import { SANDBOX_CR_API_VERSION, type SandboxCR } from "../src/types.js";
import {
  ensureRuntimeState,
  type RuntimeStateApi,
  type RuntimeStateClaim,
} from "../src/runtime-state.js";

const cfg = {
  namespace: "test",
  defaultImage: "browser:1",
  apiVersion: SANDBOX_CR_API_VERSION,
};

it.each([
  {
    sessionId: "owner",
    browser: undefined,
    error: /retained browser state.*re-enable browser isolation/i,
  },
  {
    sessionId: "owner",
    browser: { enabled: false },
    error: /retained browser state.*re-enable browser isolation/i,
  },
  {
    sessionId: "other",
    browser: undefined,
    error: /another browser session owner/i,
  },
  {
    sessionId: "other",
    browser: { enabled: false },
    error: /another browser session owner/i,
  },
])(
  "rejects retained browser adoption by $sessionId with browser=$browser before writes",
  async ({ sessionId, browser, error }) => {
    const workspace = "shared-working-directory";
    const previous = buildSandboxManifest(cfg, sandboxCrName(workspace), {
      workspace,
      sessionId: "owner",
      browser: { enabled: true },
    });
    // The private-state annotation must protect the owner even if the browser label is absent.
    previous.metadata.labels = {};
    const mutation = vi.fn(async () => {
      throw new Error("Unexpected Kubernetes mutation");
    });
    const deps: KubernetesSandboxProviderDeps = {
      objectsApi: {
        getNamespacedCustomObject: async () => previous,
        listNamespacedCustomObject: async () => ({ items: [previous] }),
        createNamespacedCustomObject: mutation,
        replaceNamespacedCustomObject: mutation,
        patchNamespacedCustomObject: mutation,
        deleteNamespacedCustomObject: mutation,
      },
      podsApi: { listNamespacedPod: async () => ({ items: [] }) },
      execApi: { exec: vi.fn() },
      livenessApi: { getPodUid: async () => null },
      secretsApi: {
        upsertSecret: mutation,
        writeSecret: mutation,
        deleteSecret: mutation,
        patchOwnerReference: mutation,
      },
    };
    const provider = new KubernetesSandboxProvider(deps, cfg);
    await expect(
      provider.create({
        workspace,
        sessionId,
        browser,
        credsFiles: { token: "new token" },
      }),
    ).rejects.toThrow(error);
    expect(mutation).not.toHaveBeenCalled();
  },
);

it("keeps a private volume owner in inventory after its CR is deleted and volume deletion fails", async () => {
  const workspace = "retained-working-directory";
  const name = sandboxCrName(workspace);
  let previous: SandboxCR | undefined = buildSandboxManifest(cfg, name, {
    workspace,
    sessionId: "owner",
    browser: { enabled: true },
  });
  const claims = new Map<string, RuntimeStateClaim>();
  let failDeletion = true;
  const runtimeStateApi: RuntimeStateApi = {
    read: async (_namespace, claimName) => claims.get(claimName),
    create: async (_namespace, claim) => {
      claims.set(claim.metadata.name, claim);
    },
    list: async (_namespace, sandboxId) =>
      [...claims.values()].filter(
        (claim) =>
          sandboxId === undefined ||
          claim.metadata.labels?.["valet.dev/runtime-sandbox"] === sandboxId,
      ),
    delete: async (_namespace, claimName) => {
      if (failDeletion) throw new Error("Volume deletion failed");
      claims.delete(claimName);
    },
  };
  await ensureRuntimeState(
    runtimeStateApi,
    cfg.namespace,
    "owner",
    name,
    "2Gi",
    false,
  );
  const deps: KubernetesSandboxProviderDeps = {
    objectsApi: {
      getNamespacedCustomObject: async () => {
        if (!previous) throw { code: 404 };
        return previous;
      },
      listNamespacedCustomObject: async () => ({
        items: previous ? [previous] : [],
      }),
      createNamespacedCustomObject: vi.fn(),
      replaceNamespacedCustomObject: vi.fn(),
      patchNamespacedCustomObject: vi.fn(),
      deleteNamespacedCustomObject: async () => {
        previous = undefined;
        return {};
      },
    },
    podsApi: { listNamespacedPod: async () => ({ items: [] }) },
    execApi: { exec: vi.fn() },
    livenessApi: { getPodUid: async () => null },
    runtimeStateApi,
  };
  const provider = new KubernetesSandboxProvider(deps, cfg);
  expect(await provider.list()).toEqual([
    { id: name, sessionId: "owner", browserEnabled: true, createdAtMs: null },
  ]);
  await expect(provider.destroy(name)).rejects.toThrow(
    "Volume deletion failed",
  );
  expect(previous).toBeUndefined();
  expect(await provider.list()).toEqual([
    { id: name, sessionId: "owner", browserEnabled: true, createdAtMs: null },
  ]);
  await expect(
    provider.create({
      workspace,
      sessionId: "owner",
      browser: { enabled: false },
    }),
  ).rejects.toThrow(/retained browser state.*re-enable browser isolation/i);
  await expect(
    provider.create({ workspace, sessionId: "other" }),
  ).rejects.toThrow(/another browser session owner/i);

  failDeletion = false;
  await provider.destroy(name);
  expect(await provider.list()).toEqual([]);
});
