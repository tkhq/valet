import { describe, expect, it } from "vitest";
import type { SandboxCreateOpts } from "@valet/engine";
import {
  CREDS_MOUNT_PATH,
  CREDS_VOLUME_NAME,
  DOCKER_LABEL_KEY,
  DOCKER_STATE_MOUNT_PATH,
  DOCKER_STATE_VOLUME_NAME,
  DOCKER_WORKLOAD_FS_GROUP,
  SANDBOX_CR_API_VERSION,
  buildSandboxManifest,
  credsSecretName,
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

    it("replaces the container command with the GUARDED full-profile entrypoint (probe-and-degrade, matching sandbox-docker)", () => {
      // An image without /start-full.sh (stale pre-unification bake, or any
      // override image) must degrade to the tail placeholder — the agent
      // still works over exec; the service tabs 502 — instead of PID 1
      // exiting 127 forever (CrashLoopBackOff, the dev-v2 DinD outage).
      const manifest = buildSandboxManifest(baseConfig, "sess-1", { ...opts, profile: "full" });
      const container = manifest.spec.podTemplate.spec.containers[0];
      expect(container?.command).toEqual([
        "sh",
        "-c",
        "[ -f /start-full.sh ] && exec /bin/bash /start-full.sh || exec tail -f /dev/null",
      ]);
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

  describe("credsFiles", () => {
    it("adds the valet-creds volume and mount when credsFiles is provided", () => {
      const manifest = buildSandboxManifest(baseConfig, "sess-1", {
        ...opts,
        credsFiles: { token: "abc123" },
      });
      const container = manifest.spec.podTemplate.spec.containers[0];
      // Volume mount present
      expect(container?.volumeMounts).toContainEqual({
        name: CREDS_VOLUME_NAME,
        mountPath: CREDS_MOUNT_PATH,
      });
      // Pod-level volume present
      expect(manifest.spec.podTemplate.spec.volumes).toContainEqual({
        name: CREDS_VOLUME_NAME,
        secret: { secretName: credsSecretName("sess-1"), optional: true },
      });
    });

    it("does not add the creds volume when credsFiles is absent", () => {
      const manifest = buildSandboxManifest(baseConfig, "sess-1", opts);
      const container = manifest.spec.podTemplate.spec.containers[0];
      const hasCredsMount = container?.volumeMounts?.some((m) => m.name === CREDS_VOLUME_NAME) ?? false;
      expect(hasCredsMount).toBe(false);
      const hasCredsVol = manifest.spec.podTemplate.spec.volumes?.some((v) => v.name === CREDS_VOLUME_NAME) ?? false;
      expect(hasCredsVol).toBe(false);
    });

    it("does not add the creds volume when credsFiles is an empty object", () => {
      const manifest = buildSandboxManifest(baseConfig, "sess-1", { ...opts, credsFiles: {} });
      const container = manifest.spec.podTemplate.spec.containers[0];
      const hasCredsMount = container?.volumeMounts?.some((m) => m.name === CREDS_VOLUME_NAME) ?? false;
      expect(hasCredsMount).toBe(false);
    });

    it("is byte-identical to no-credsFiles when credsFiles is absent (regression pin)", () => {
      const without = buildSandboxManifest(baseConfig, "sess-1", opts);
      const alsoWithout = buildSandboxManifest(baseConfig, "sess-1", { ...opts });
      expect(without).toEqual(alsoWithout);
    });
  });
});

describe("docker flag (rootless DinD)", () => {
  const cfg = baseConfig;

  it("adds the docker securityContext, annotation, state volume, and userns-mode env", () => {
    const cr = buildSandboxManifest(cfg, "sb-docker", { docker: true });
    const pod = cr.spec.podTemplate;
    expect(pod.metadata?.annotations?.[
      "container.apparmor.security.beta.kubernetes.io/sandbox"
    ]).toBe("unconfined");
    const c = pod.spec.containers[0]!;
    expect(c.securityContext?.seccompProfile?.type).toBe("Unconfined");
    expect(c.securityContext?.capabilities?.add).toEqual(["SYS_ADMIN", "NET_ADMIN"]);
    expect(c.securityContext?.procMount).toBe("Unmasked");
    expect(c.env).toContainEqual({ name: "VALET_SANDBOX_DOCKER", value: "1" });
    // Selects the rootful-in-userns branch in start-docker.sh — the pod
    // userns replaces rootlesskit's nested one on kubernetes.
    expect(c.env).toContainEqual({ name: "VALET_DOCKER_USERNS", value: "1" });
    expect(c.volumeMounts).toContainEqual({
      name: DOCKER_STATE_VOLUME_NAME,
      mountPath: DOCKER_STATE_MOUNT_PATH,
    });
    expect(pod.spec.volumes).toContainEqual(
      expect.objectContaining({ name: DOCKER_STATE_VOLUME_NAME }),
    );
    // No device hostPaths: a hostPath char device cannot be idmap-mounted
    // into a hostUsers:false pod (devtmpfs has no idmap support — runc
    // fails container init with MOUNT_ATTR_IDMAP EINVAL, observed live on
    // EKS 1.33). Rootful-in-userns needs neither /dev/fuse (native
    // overlayfs) nor /dev/net/tun (no slirp4netns).
    const json = JSON.stringify(cr);
    expect(json).not.toContain("dev-fuse");
    expect(json).not.toContain("dev-tun");
    expect(json).not.toContain("hostPath");
    expect(json).not.toContain("privileged");
  });

  it("sets pod-level fsGroup 1500 so the workspace PVC is group-writable by dockerd", () => {
    const cr = buildSandboxManifest(cfg, "sb-docker", { docker: true });
    expect(DOCKER_WORKLOAD_FS_GROUP).toBe(1500);
    expect(cr.spec.podTemplate.spec.securityContext).toEqual({ fsGroup: 1500 });
  });

  it("sets hostUsers: false — k8s >=1.33 REQUIRES it for procMount: Unmasked", () => {
    // k8s validation (1.31+, enforced once ProcMountType is on — default in
    // 1.33): "hostUsers must be false to use Unmasked". Without this field
    // an upgraded cluster REJECTS the pod outright. On clusters where
    // UserNamespacesSupport is off (<=1.32 default) the API server drops
    // the field, so it is inert today and load-bearing after the upgrade.
    const cr = buildSandboxManifest(cfg, "sb-docker", { docker: true });
    expect(cr.spec.podTemplate.spec.hostUsers).toBe(false);
  });

  it("leaves hostUsers unset for non-docker sandboxes", () => {
    const cr = buildSandboxManifest(cfg, "sb-plain", {});
    expect(cr.spec.podTemplate.spec.hostUsers).toBeUndefined();
  });

  it("sets runtimeClassName from dockerRuntimeClassName for docker sandboxes", () => {
    // The runtime class maps to a containerd runtime with
    // cgroup_writable=true — without it the pod cgroupfs is read-only and
    // owned by unmapped host root, so runc cannot create per-container
    // groups and every `docker run` fails (observed live on EKS 1.33).
    const rcCfg: K8sProviderConfig = { ...cfg, dockerRuntimeClassName: "valet-docker" };
    const cr = buildSandboxManifest(rcCfg, "sb-docker", { docker: true });
    expect(cr.spec.podTemplate.spec.runtimeClassName).toBe("valet-docker");
  });

  it("leaves runtimeClassName unset when the config names none", () => {
    const cr = buildSandboxManifest(cfg, "sb-docker", { docker: true });
    expect(cr.spec.podTemplate.spec.runtimeClassName).toBeUndefined();
  });

  it("leaves runtimeClassName unset for non-docker sandboxes even when configured", () => {
    // Only docker sandboxes need writable cgroups; plain sandboxes stay on
    // the cluster-default runtime with its stricter posture.
    const rcCfg: K8sProviderConfig = { ...cfg, dockerRuntimeClassName: "valet-docker" };
    const cr = buildSandboxManifest(rcCfg, "sb-plain", {});
    expect(cr.spec.podTemplate.spec.runtimeClassName).toBeUndefined();
  });

  it("labels the CR docker-enabled so restore() can re-derive the flag", () => {
    const cr = buildSandboxManifest(cfg, "sb-docker", { docker: true });
    expect(cr.metadata.labels[DOCKER_LABEL_KEY]).toBe("true");
  });

  it("headless+docker uses the start-headless probe wrapper command", () => {
    const cr = buildSandboxManifest(cfg, "sb-docker", { docker: true });
    expect(cr.spec.podTemplate.spec.containers[0]!.command).toEqual([
      "sh",
      "-c",
      "[ -f /start-headless.sh ] && exec /bin/bash /start-headless.sh || exec tail -f /dev/null",
    ]);
  });

  it("emits nothing docker-related when the flag is absent", () => {
    const cr = buildSandboxManifest(cfg, "sb-plain", {});
    const s = JSON.stringify(cr);
    expect(s).not.toContain("seccomp");
    expect(s).not.toContain("apparmor");
    expect(s).not.toContain("VALET_SANDBOX_DOCKER");
    expect(s).not.toContain(DOCKER_STATE_VOLUME_NAME);
    expect(s).not.toContain("capabilities");
    expect(s).not.toContain("procMount");
    expect(s).not.toContain("VALET_DOCKER_USERNS");
    expect(s).not.toContain("fsGroup");
    expect(s).not.toContain(DOCKER_LABEL_KEY);
  });
});
