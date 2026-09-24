import { describe, expect, it } from "vitest";
import { buildSandboxManifest } from "../src/manifest.js";
import { SANDBOX_CR_API_VERSION } from "../src/types.js";
import {
  deleteRuntimeState,
  ensureRuntimeState,
  runtimeStateClaimName,
  type RuntimeStateApi,
  type RuntimeStateClaim,
} from "../src/runtime-state.js";
const cfg = {
  namespace: "test",
  defaultImage: "browser:1",
  apiVersion: SANDBOX_CR_API_VERSION,
};
describe("browser manifests", () => {
  it("uses a separately owned private claim and Localhost profile in headless viewer mode", () => {
    const manifest = buildSandboxManifest(cfg, "sandbox-a", {
      sessionId: "session-a",
      browser: { enabled: true, viewer: true },
    });
    const container = manifest.spec.podTemplate.spec.containers[0];
    expect(container.securityContext?.seccompProfile).toEqual({
      type: "Localhost",
      localhostProfile: "valet/browser.json",
    });
    expect(container.volumeMounts).toContainEqual({
      name: "runtime-state",
      mountPath: "/var/lib/valet",
    });
    expect(manifest.spec.podTemplate.spec.volumes).toContainEqual({
      name: "runtime-state",
      persistentVolumeClaim: { claimName: runtimeStateClaimName("session-a") },
    });
    expect(
      manifest.spec.volumeClaimTemplates?.some(
        (claim) => claim.metadata.name === "runtime-state",
      ),
    ).toBe(false);
    expect(manifest.spec.service).toBe(true);
    expect(manifest.metadata.labels?.["valet.dev/browser"]).toBe("true");
    expect(manifest.spec.podTemplate.spec.securityContext?.fsGroup).toBe(1500);
    expect(container.env).toContainEqual({
      name: "VALET_BROWSER_DEV_PORTS",
      value: "5173,3000,8080",
    });
  });
  it("rejects missing identity, unsafe profile paths and elevated nested-runtime combinations", () => {
    expect(() =>
      buildSandboxManifest(cfg, "test", { browser: { enabled: true } }),
    ).toThrow(/session/i);
    expect(() =>
      buildSandboxManifest(
        { ...cfg, browserSeccompProfile: "../outside" },
        "test",
        { sessionId: "session", browser: { enabled: true } },
      ),
    ).toThrow(/profile/i);
    expect(() =>
      buildSandboxManifest(cfg, "test", {
        sessionId: "session",
        browser: { enabled: true },
        docker: true,
      }),
    ).toThrow(/Docker-in-sandbox/i);
  });
});
class MemoryStateApi implements RuntimeStateApi {
  claims = new Map<string, RuntimeStateClaim>();
  async read(_namespace: string, name: string) {
    return this.claims.get(name);
  }
  async create(_namespace: string, claim: RuntimeStateClaim) {
    this.claims.set(claim.metadata.name, claim);
  }
  async list(_namespace: string, sandboxId?: string) {
    return [...this.claims.values()].filter(
      (claim) =>
        sandboxId === undefined ||
        claim.metadata.labels?.["valet.dev/runtime-sandbox"] === sandboxId,
    );
  }
  async delete(_namespace: string, name: string) {
    this.claims.delete(name);
  }
}
it("retains a session-owned claim across adoption and rejects another owner", async () => {
  const api = new MemoryStateApi();
  await ensureRuntimeState(api, "test", "session", "sandbox", "2Gi", false);
  const claim = api.claims.get(runtimeStateClaimName("session"));
  expect(claim?.metadata.ownerReferences).toBeUndefined();
  await ensureRuntimeState(api, "test", "session", "sandbox", "2Gi", true);
  await expect(
    ensureRuntimeState(api, "test", "session", "other", "2Gi", false),
  ).rejects.toThrow(/owner/i);
  expect(api.claims.size).toBe(1);
});
it("reports a missing adopted volume without replacing the evidence", async () => {
  const api = new MemoryStateApi();
  await expect(
    ensureRuntimeState(api, "test", "session", "sandbox", "2Gi", true),
  ).rejects.toThrow(/missing/i);
  expect(api.claims.size).toBe(0);
});
it("deletes only claims owned by the final session's sandbox", async () => {
  const api = new MemoryStateApi();
  await ensureRuntimeState(api, "test", "session-a", "sandbox-a", "2Gi", false);
  await ensureRuntimeState(api, "test", "session-b", "sandbox-b", "2Gi", false);
  await deleteRuntimeState(api, "test", "sandbox-a");
  expect(api.claims.has(runtimeStateClaimName("session-a"))).toBe(false);
  expect(api.claims.has(runtimeStateClaimName("session-b"))).toBe(true);
});
