import { describe, expect, it } from "vitest";
import type { SandboxCreateOpts } from "@valet/engine";
import {
  SANDBOX_CR_API_VERSION,
  buildSandboxManifest,
  sandboxCrName,
  SESSION_LABEL_KEY,
  WORKSPACE_MOUNT_PATH,
  WORKSPACE_VOLUME_NAME,
} from "../src/index.js";
import type { K8sProviderConfig } from "../src/index.js";

const RFC1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

const baseConfig: K8sProviderConfig = {
  namespace: "valet-sandboxes",
  defaultImage: "valet-sandbox:latest",
  apiVersion: SANDBOX_CR_API_VERSION,
};

describe("sandboxCrName", () => {
  it("is deterministic for the same input", () => {
    const key = "orchestrator:user123";
    expect(sandboxCrName(key)).toBe(sandboxCrName(key));
  });

  it("is idempotent when re-derived from its own output", () => {
    const key = "orchestrator:user123";
    const name = sandboxCrName(key);
    // Re-running sanitization on an already-valid name should not change it
    // (the name itself, fed back in, is a no-op).
    expect(sandboxCrName(name)).toBe(name);
  });

  it("produces RFC1123-safe output for a typical session key", () => {
    const name = sandboxCrName("orchestrator:user123");
    expect(name).toMatch(RFC1123_LABEL);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it("lowercases and strips illegal characters (colons, dots, uppercase)", () => {
    const name = sandboxCrName("Orchestrator:User.123");
    expect(name).toMatch(RFC1123_LABEL);
    expect(name).not.toMatch(/[A-Z.:]/);
  });

  it("strips leading/trailing dashes produced by sanitization", () => {
    const name = sandboxCrName(":::leading-and-trailing:::");
    expect(name).toMatch(RFC1123_LABEL);
    expect(name.startsWith("-")).toBe(false);
    expect(name.endsWith("-")).toBe(false);
  });

  it("never exceeds 63 characters for very long keys", () => {
    const longKey = `session-${"a".repeat(200)}`;
    const name = sandboxCrName(longKey);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(RFC1123_LABEL);
  });

  it("does not collide when two long keys differ only after char 55", () => {
    const prefix = "session-" + "b".repeat(60);
    const keyA = `${prefix}-tail-alpha`;
    const keyB = `${prefix}-tail-beta`;
    const nameA = sandboxCrName(keyA);
    const nameB = sandboxCrName(keyB);
    expect(nameA).not.toBe(nameB);
    expect(nameA.length).toBeLessThanOrEqual(63);
    expect(nameB.length).toBeLessThanOrEqual(63);
  });

  it("handles input that sanitizes to an empty string", () => {
    const name = sandboxCrName(":::");
    expect(name.length).toBeGreaterThan(0);
    expect(name).toMatch(RFC1123_LABEL);
  });

  it("produces distinct names for distinct all-illegal-character inputs", () => {
    const nameA = sandboxCrName(":::");
    const nameB = sandboxCrName("...");
    expect(nameA).not.toBe(nameB);
  });
});

describe("buildSandboxManifest", () => {
  const opts: SandboxCreateOpts = {
    env: { VALET_SANDBOX_TOKEN: "tok-123", VALET_API_URL: "http://valet-api.valet.svc.cluster.local" },
    resources: { cpu: 2, memory: "4Gi" },
  };

  it("emits apiVersion/kind/metadata/spec with no top-level image/env/resources fields", () => {
    const manifest = buildSandboxManifest(baseConfig, "sess-1", opts);

    expect(manifest.apiVersion).toBe(SANDBOX_CR_API_VERSION);
    expect(manifest.kind).toBe("Sandbox");
    expect(manifest.metadata.name).toBe("sess-1");
    expect(manifest).not.toHaveProperty("image");
    expect(manifest).not.toHaveProperty("env");
    expect(manifest).not.toHaveProperty("resources");
    expect(manifest.spec).not.toHaveProperty("image");
    expect(manifest.spec).not.toHaveProperty("env");
    expect(manifest.spec).not.toHaveProperty("resources");
  });

  it("sets the session-id label from the CR name", () => {
    const manifest = buildSandboxManifest(baseConfig, "sess-1", opts);
    expect(manifest.metadata.labels).toEqual({ [SESSION_LABEL_KEY]: "sess-1" });
  });

  it("uses cfg.defaultImage when opts.image is not provided", () => {
    const manifest = buildSandboxManifest(baseConfig, "sess-1", opts);
    expect(manifest.spec.podTemplate.spec.containers[0]?.image).toBe("valet-sandbox:latest");
  });

  it("uses opts.image when provided, overriding the default", () => {
    const manifest = buildSandboxManifest(baseConfig, "sess-1", { ...opts, image: "custom:v1" });
    expect(manifest.spec.podTemplate.spec.containers[0]?.image).toBe("custom:v1");
  });

  it("maps opts.env to a name/value array", () => {
    const manifest = buildSandboxManifest(baseConfig, "sess-1", opts);
    expect(manifest.spec.podTemplate.spec.containers[0]?.env).toEqual([
      { name: "VALET_SANDBOX_TOKEN", value: "tok-123" },
      { name: "VALET_API_URL", value: "http://valet-api.valet.svc.cluster.local" },
    ]);
  });

  it("omits env when opts.env is not provided", () => {
    const manifest = buildSandboxManifest(baseConfig, "sess-1", {});
    expect(manifest.spec.podTemplate.spec.containers[0]?.env).toBeUndefined();
  });

  it("maps opts.resources cpu (number) and memory (string) to requests/limits", () => {
    const manifest = buildSandboxManifest(baseConfig, "sess-1", opts);
    const container = manifest.spec.podTemplate.spec.containers[0];
    expect(container?.resources).toEqual({
      requests: { cpu: "2", memory: "4Gi" },
      limits: { cpu: "2", memory: "4Gi" },
    });
  });

  it("falls back to cfg.defaultResources when opts.resources is absent", () => {
    const cfg: K8sProviderConfig = {
      ...baseConfig,
      defaultResources: { cpu: 1, memory: "1Gi" },
    };
    const manifest = buildSandboxManifest(cfg, "sess-1", { env: opts.env });
    const container = manifest.spec.podTemplate.spec.containers[0];
    expect(container?.resources).toEqual({
      requests: { cpu: "1", memory: "1Gi" },
      limits: { cpu: "1", memory: "1Gi" },
    });
  });

  it("omits resources entirely when neither opts nor cfg provide any", () => {
    const manifest = buildSandboxManifest(baseConfig, "sess-1", {});
    const container = manifest.spec.podTemplate.spec.containers[0];
    expect(container?.resources).toBeUndefined();
  });

  it("mounts the workspace volume in the container", () => {
    const manifest = buildSandboxManifest(baseConfig, "sess-1", opts);
    const container = manifest.spec.podTemplate.spec.containers[0];
    expect(container?.volumeMounts).toEqual([
      { name: WORKSPACE_VOLUME_NAME, mountPath: WORKSPACE_MOUNT_PATH },
    ]);
  });

  it("declares a matching workspace volumeClaimTemplate with default storage size", () => {
    const manifest = buildSandboxManifest(baseConfig, "sess-1", opts);
    expect(manifest.spec.volumeClaimTemplates).toEqual([
      {
        metadata: { name: WORKSPACE_VOLUME_NAME },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: "2Gi" } },
        },
      },
    ]);
  });

  it("uses cfg.defaultStorage when provided", () => {
    const cfg: K8sProviderConfig = { ...baseConfig, defaultStorage: "10Gi" };
    const manifest = buildSandboxManifest(cfg, "sess-1", opts);
    expect(manifest.spec.volumeClaimTemplates[0]?.spec.resources.requests.storage).toBe("10Gi");
  });

  it("uses a non-terminating container command", () => {
    const manifest = buildSandboxManifest(baseConfig, "sess-1", opts);
    const container = manifest.spec.podTemplate.spec.containers[0];
    expect(container?.command).toBeDefined();
    expect(container?.command?.join(" ")).toContain("tail -f /dev/null");
  });

  it("is a pure function — identical inputs produce deep-equal output", () => {
    const first = buildSandboxManifest(baseConfig, "sess-1", opts);
    const second = buildSandboxManifest(baseConfig, "sess-1", opts);
    expect(first).toEqual(second);
  });

  describe("profile: full", () => {
    it("sets spec.service = true", () => {
      const manifest = buildSandboxManifest(baseConfig, "sess-1", { ...opts, profile: "full" });
      expect(manifest.spec.service).toBe(true);
    });

    it("replaces the container command with the full-profile service entrypoint (not the bare tail placeholder)", () => {
      const manifest = buildSandboxManifest(baseConfig, "sess-1", { ...opts, profile: "full" });
      const container = manifest.spec.podTemplate.spec.containers[0];
      expect(container?.command).toEqual(["/bin/bash", "/start-full.sh"]);
      expect(container?.command?.join(" ")).not.toContain("tail -f /dev/null");
    });
  });

  describe("profile omitted / headless — byte-identical pin", () => {
    it("leaves spec.service undefined when profile is omitted", () => {
      const manifest = buildSandboxManifest(baseConfig, "sess-1", opts);
      expect(manifest.spec.service).toBeUndefined();
    });

    it("leaves spec.service undefined when profile is explicitly headless", () => {
      const manifest = buildSandboxManifest(baseConfig, "sess-1", { ...opts, profile: "headless" });
      expect(manifest.spec.service).toBeUndefined();
    });

    it("keeps the bare tail placeholder command when profile is omitted/headless", () => {
      const omitted = buildSandboxManifest(baseConfig, "sess-1", opts);
      const headless = buildSandboxManifest(baseConfig, "sess-1", { ...opts, profile: "headless" });
      expect(omitted.spec.podTemplate.spec.containers[0]?.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
      expect(headless.spec.podTemplate.spec.containers[0]?.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
    });
  });
});
