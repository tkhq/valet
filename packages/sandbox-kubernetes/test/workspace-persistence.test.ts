import { describe, expect, it } from "vitest";
import { workspaceObjectPrefix } from "@valet/engine";
import {
  ORG_ANNOTATION_KEY,
  OWNER_ANNOTATION_KEY,
  RESTORE_ENV,
  SANDBOX_CR_API_VERSION,
  WORKSPACE_MOUNT_PATH,
  WORKSPACE_RESTORE_INIT_CONTAINER_NAME,
  WORKSPACE_STORE_CREDS_MOUNT_PATH,
  WORKSPACE_STORE_VOLUME_NAME,
  WORKSPACE_VOLUME_NAME,
  buildCheckpointScript,
  buildRestoreScript,
  buildSandboxManifest,
  checkpointScriptEnv,
  objectStoreBaseUrl,
  parseCheckpointResult,
} from "../src/index.js";
import type { K8sProviderConfig, WorkspacePersistenceConfig } from "../src/index.js";

// The spec's worked example, reused everywhere.
const ORG = "org_39828000-1c89-4735-874e-2150e09dc225";
const OWNER = "user_zeke";

const objectStoreWp: WorkspacePersistenceConfig = {
  backend: "object-store",
  objectStore: {
    bucket: "valet-workspaces-dev",
    endpoint: "http://minio.valet-dev.svc:9000",
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
    onRestoreFailure: "fallback",
  },
};

function cfgWith(wp: WorkspacePersistenceConfig | undefined): K8sProviderConfig {
  return {
    namespace: "valet-sandboxes",
    defaultImage: "valet-sandbox:latest",
    apiVersion: SANDBOX_CR_API_VERSION,
    ...(wp ? { workspacePersistence: wp } : {}),
  };
}

const opts = { workspace: "ws-1", orgId: ORG, ownerId: OWNER };

describe("manifest workspace volume per backend (spec 05.1)", () => {
  it("legacy (no workspacePersistence config) keeps the RWO PVC", () => {
    const m = buildSandboxManifest(cfgWith(undefined), "s1", opts);
    expect(m.spec.volumeClaimTemplates).toHaveLength(1);
    expect(m.spec.volumeClaimTemplates[0]?.spec.accessModes).toEqual(["ReadWriteOnce"]);
    expect(m.spec.podTemplate.spec.volumes ?? []).toEqual([]);
    expect(m.spec.podTemplate.spec.initContainers).toBeUndefined();
  });

  it("none backend switches /workspace to an emptyDir with no PVC and no init container", () => {
    const m = buildSandboxManifest(
      cfgWith({ backend: "none", policy: objectStoreWp.policy }),
      "s1",
      opts,
    );
    expect(m.spec.volumeClaimTemplates).toEqual([]);
    expect(m.spec.podTemplate.spec.volumes).toEqual([{ name: WORKSPACE_VOLUME_NAME, emptyDir: {} }]);
    expect(m.spec.podTemplate.spec.initContainers).toBeUndefined();
  });

  it("object-store backend: emptyDir + workspace-restore init container + creds volume", () => {
    const m = buildSandboxManifest(cfgWith(objectStoreWp), "s1", opts);
    expect(m.spec.volumeClaimTemplates).toEqual([]);
    const volumes = m.spec.podTemplate.spec.volumes ?? [];
    expect(volumes).toContainEqual({ name: WORKSPACE_VOLUME_NAME, emptyDir: {} });
    expect(volumes).toContainEqual({
      name: WORKSPACE_STORE_VOLUME_NAME,
      secret: { secretName: "valet-workspace-store" },
    });

    const init = m.spec.podTemplate.spec.initContainers?.[0];
    expect(init?.name).toBe(WORKSPACE_RESTORE_INIT_CONTAINER_NAME);
    // The sandbox's own image (already on the node).
    expect(init?.image).toBe("valet-sandbox:latest");
    // Workspace + credentials mounts; credentials read-only, outside /workspace.
    expect(init?.volumeMounts).toContainEqual({
      name: WORKSPACE_VOLUME_NAME,
      mountPath: WORKSPACE_MOUNT_PATH,
    });
    expect(init?.volumeMounts).toContainEqual({
      name: WORKSPACE_STORE_VOLUME_NAME,
      mountPath: WORKSPACE_STORE_CREDS_MOUNT_PATH,
      readOnly: true,
    });
    // Ref + config env (spec 05.2), including the worked example's prefix.
    const env = Object.fromEntries((init?.env ?? []).map((e) => [e.name, e.value]));
    expect(env[RESTORE_ENV.baseUrl]).toBe("http://minio.valet-dev.svc:9000/valet-workspaces-dev");
    expect(env[RESTORE_ENV.workspacePrefix]).toBe(`${ORG}/${OWNER}/s1/`);
    expect(env[RESTORE_ENV.onRestoreFailure]).toBe("fallback");
    expect(env[RESTORE_ENV.orgId]).toBe(ORG);
    expect(env[RESTORE_ENV.ownerId]).toBe(OWNER);
    expect(env[RESTORE_ENV.workspaceId]).toBe("s1");
  });

  it("INV-6: the main container never mounts the workspace-store credentials", () => {
    const m = buildSandboxManifest(cfgWith(objectStoreWp), "s1", opts);
    const main = m.spec.podTemplate.spec.containers[0];
    expect(main?.volumeMounts?.some((v) => v.name === WORKSPACE_STORE_VOLUME_NAME)).toBe(false);
    expect(main?.env?.some((e) => e.name.startsWith("AWS_"))).toBeFalsy();
  });

  it("object-store without org/owner ids gets the emptyDir but no restore init container", () => {
    const m = buildSandboxManifest(cfgWith(objectStoreWp), "s1", { workspace: "ws-1" });
    expect(m.spec.podTemplate.spec.initContainers).toBeUndefined();
    expect(m.spec.podTemplate.spec.volumes).toContainEqual({ name: WORKSPACE_VOLUME_NAME, emptyDir: {} });
  });

  it("rwx-volume backend keeps a PVC on the operator's RWX class", () => {
    const m = buildSandboxManifest(
      cfgWith({
        backend: "rwx-volume",
        rwxVolume: { storageClassName: "efs-sc" },
        policy: objectStoreWp.policy,
      }),
      "s1",
      opts,
    );
    expect(m.spec.volumeClaimTemplates).toHaveLength(1);
    const pvc = m.spec.volumeClaimTemplates[0];
    expect(pvc?.spec.storageClassName).toBe("efs-sc");
    expect(pvc?.spec.accessModes).toEqual(["ReadWriteMany"]);
    expect(m.spec.podTemplate.spec.initContainers).toBeUndefined();
  });

  it("DinD state stays an emptyDir and is never the workspace volume (Part 06)", () => {
    const m = buildSandboxManifest(cfgWith(objectStoreWp), "s1", { ...opts, docker: true });
    const volumes = m.spec.podTemplate.spec.volumes ?? [];
    expect(volumes).toContainEqual({ name: "docker-state", emptyDir: {} });
    expect(volumes).toContainEqual({ name: WORKSPACE_VOLUME_NAME, emptyDir: {} });
  });

  it("stamps org/owner annotations for the suspend/reap-time WorkspaceRef", () => {
    const m = buildSandboxManifest(cfgWith(objectStoreWp), "s1", { ...opts, sessionId: "sess-9" });
    expect(m.metadata.annotations?.[ORG_ANNOTATION_KEY]).toBe(ORG);
    expect(m.metadata.annotations?.[OWNER_ANNOTATION_KEY]).toBe(OWNER);
  });
});

describe("objectStoreBaseUrl", () => {
  it("uses the configured endpoint verbatim (INV-4)", () => {
    expect(objectStoreBaseUrl({ endpoint: "http://minio:9000/", region: "us-east-1" })).toBe(
      "http://minio:9000",
    );
  });

  it("defaults to the AWS regional endpoint when unset", () => {
    expect(objectStoreBaseUrl({ endpoint: "", region: "us-west-2" })).toBe(
      "https://s3.us-west-2.amazonaws.com",
    );
  });
});

describe("workspace scripts", () => {
  it("restore script checks emptiness before anything else (INV-1)", () => {
    const script = buildRestoreScript();
    const emptinessCheck = script.indexOf('ls -A "$WS"');
    const credsRead = script.indexOf("AWS_ACCESS_KEY_ID");
    expect(emptinessCheck).toBeGreaterThan(-1);
    expect(credsRead).toBeGreaterThan(emptinessCheck);
  });

  it("restore script treats a 404 latest pointer as a cold start, not a failure", () => {
    expect(buildRestoreScript()).toContain('[ "$code" = "404" ]');
    expect(buildRestoreScript()).toContain("cold start from image");
  });

  it("restore script validates the checkpoint id before using it in a URL", () => {
    const script = buildRestoreScript();
    expect(script.indexOf("case \"$CKPT\"")).toBeLessThan(script.indexOf("data.tar.gz"));
  });

  it("checkpoint script uploads data, then manifest, then latest (INV-2 order)", () => {
    const script = buildCheckpointScript({ checkpointId: "ck-1", createdAtMs: 1000 });
    const data = script.indexOf("$VALET_WS_DATA_URL");
    const manifest = script.indexOf("$VALET_WS_MANIFEST_URL");
    const latest = script.indexOf("$VALET_WS_LATEST_URL");
    expect(data).toBeGreaterThan(-1);
    expect(manifest).toBeGreaterThan(data);
    expect(latest).toBeGreaterThan(manifest);
  });

  it("checkpoint script excludes the default derived directories", () => {
    const script = buildCheckpointScript({ checkpointId: "ck-1", createdAtMs: 1000 });
    expect(script).toContain("--exclude='node_modules'");
    expect(script).toContain("--exclude='__pycache__'");
  });

  it("checkpoint env carries exactly the three presigned URLs", () => {
    expect(
      checkpointScriptEnv({ dataUrl: "u1", manifestUrl: "u2", latestUrl: "u3" }),
    ).toEqual({
      VALET_WS_DATA_URL: "u1",
      VALET_WS_MANIFEST_URL: "u2",
      VALET_WS_LATEST_URL: "u3",
    });
  });

  it("parseCheckpointResult round-trips the committed line and rejects garbage", () => {
    expect(parseCheckpointResult("noise\ncheckpoint-committed size=123 entries=4\n")).toEqual({
      sizeBytes: 123,
      entryCount: 4,
    });
    expect(parseCheckpointResult("tar: error\n")).toBeNull();
  });

  it("workspaceObjectPrefix matches the spec's worked-example key", () => {
    const prefix = workspaceObjectPrefix("", {
      orgId: ORG,
      ownerId: OWNER,
      workspaceId: "root-valet-assistants-asst-11111111-2222-3333-4444-555555555555",
    });
    expect(prefix).toBe(
      `${ORG}/${OWNER}/root-valet-assistants-asst-11111111-2222-3333-4444-555555555555/`,
    );
  });
});
