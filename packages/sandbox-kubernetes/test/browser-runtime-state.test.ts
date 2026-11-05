import { readFileSync } from "node:fs";
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
  it("rejects missing identity and unsafe profile paths", () => {
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
  });

  it.each([{ docker: true }, { nestedKubernetes: true }])("isolates the browser companion from elevated workload %j", (capabilities) => {
    const manifest = buildSandboxManifest({ ...cfg, browserImage: "stock-browser:2", dockerRuntimeClassName: "valet-docker" }, "combined", {
      ...capabilities, sessionId: "session", image: "repository-bake:1",
      browser: { enabled: true, viewer: true }, credsFiles: { token: "secret" },
      env: { SECRET: "secret", VALET_BROWSER_VIEWER: "1", VALET_BROWSER_DEV_PORTS: "3000" },
    });
    const pod = manifest.spec.podTemplate.spec;
    const workload = pod.containers.find(container => container.name === "sandbox");
    const browser = pod.containers.find(container => container.name === "browser");
    expect(pod.hostUsers).toBe(false);
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(browser?.env).toContainEqual({ name: "VALET_SESSION_ID", value: "session" });
    expect(pod.runtimeClassName).toBe("valet-docker");
    expect(workload?.image).toBe("repository-bake:1");
    expect(workload?.volumeMounts?.some(mount => mount.name === "runtime-state")).toBe(false);
    expect(workload?.env?.some(entry => entry.name.startsWith("VALET_BROWSER_"))).toBe(false);
    expect(browser?.image).toBe("stock-browser:2");
    expect(browser?.volumeMounts).toEqual([
      { name: "workspace", mountPath: "/workspace", subPath: ".valet-storage/workspace", readOnly: true },
      { name: "runtime-state", mountPath: "/var/lib/valet" },
    ]);
    expect(browser?.env).toContainEqual({ name: "VALET_BROWSER_WORKSPACE_READONLY", value: "1" });
    expect(browser?.securityContext).toEqual({ seccompProfile: { type: "Localhost", localhostProfile: "valet/browser.json" } });
    expect(browser?.env).toContainEqual({ name: "VALET_BROWSER_DEV_PORTS", value: "3000" });
    expect(browser?.env?.some(entry => ["SECRET", "VALET_BROWSER_VIEWER", "VALET_SANDBOX_DOCKER"].includes(entry.name))).toBe(false);
    expect(browser?.command).toEqual(["/usr/bin/tini", "-g", "--", "/bin/bash", "-c", "/browser-preflight.sh && exec tail -f /dev/null"]);
    expect(browser?.readinessProbe?.exec.command).toEqual(["test", "-f", "/run/valet-browser-ready"]);
    expect(browser?.resources?.limits?.memory).toBe("2Gi");
    expect(manifest.metadata.annotations?.["valet.dev/browser-topology"]).toBe("companion");
    expect(manifest.spec.service).toBeUndefined();
  });

  it("uses the configured default image for the companion when no browser image is set", () => {
    const manifest = buildSandboxManifest(cfg, "combined", { sessionId: "session", docker: true, image: "bake:1", browser: { enabled: true } });
    expect(manifest.spec.podTemplate.spec.containers.find(container => container.name === "browser")?.image).toBe(cfg.defaultImage);
  });

  it("keeps the shared runtime root traversable without taking persisted home ownership", () => {
    const manifest = buildSandboxManifest(cfg, "sandbox-a", {
      sessionId: "session-a",
      browser: { enabled: true },
    });
    const mounts = manifest.spec.podTemplate.spec.containers[0].volumeMounts ?? [];
    expect(mounts).toContainEqual({
      name: "runtime-state",
      mountPath: "/var/lib/valet",
    });
    expect(mounts).toContainEqual({
      name: "workspace",
      mountPath: "/var/lib/valet/home",
      subPath: ".valet-storage/home",
    });

    const preflight = readFileSync(
      new URL("../../../docker/browser-preflight.sh", import.meta.url),
      "utf8",
    );
    expect(preflight).toContain(
      "install -d -m 0755 -o root -g root /var/lib/valet",
    );
    expect(preflight).toContain(
      'install -d -m 0700 -o "$browser_uid" -g "$browser_gid" /var/lib/valet/browser',
    );
    expect(preflight).not.toMatch(/chown\s+-R[^\n]*\/var\/lib\/valet(?:\s|$)/);

    const dockerfile = readFileSync(
      new URL("../../../docker/Dockerfile.sandbox-k8s", import.meta.url),
      "utf8",
    );
    expect(dockerfile).toContain("chmod 0755 /var/lib/valet");
    expect(dockerfile).not.toMatch(/chown\s+-R[^\n]*\/var\/lib\/valet(?:\s|\\)/);
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
