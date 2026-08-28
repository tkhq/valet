/**
 * MinIO integration suite for the object-store workspace backend
 * (workspace-persistence spec: the acceptance scenario, INV-1, INV-2,
 * INV-4). Skip-gated on a local docker daemon.
 *
 * Two layers get real coverage here:
 *   1. The Node-side `ObjectStoreWorkspaceStore` (checkpoint/latest/
 *      restore/purge/prune) against real MinIO.
 *   2. The REAL in-pod shell scripts (`buildRestoreScript`,
 *      `buildCheckpointScript`) executed inside a container on the same
 *      docker network as MinIO — the acceptance scenario's six steps,
 *      minus only the kubernetes scheduler: a bind-mounted directory
 *      stands in for the workspace emptyDir, and "reap + reopen on a
 *      different node" is destroying that directory and running the
 *      restore in a fresh container over a fresh one.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { WorkspaceRef } from "@valet/engine";
import { checkpointDataKey } from "@valet/engine";
import { ObjectStoreWorkspaceStore } from "../src/workspace-object-store.js";
import type { ObjectStoreConfig } from "../src/workspace-persistence.js";
import {
  RESTORE_ENV,
  buildCheckpointScript,
  buildRestoreScript,
  checkpointScriptEnv,
} from "../src/workspace-scripts.js";

const dockerReady = (() => {
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe" });
  return r.status === 0;
})();

const NETWORK = "valet-ws-minio-test";
const MINIO_CONTAINER = "valet-ws-minio";
const MINIO_INTERNAL = `http://${MINIO_CONTAINER}:9000`;
const ACCESS_KEY = "minioadmin";
const SECRET_KEY = "minioadmin";
const BUCKET = "valet-workspaces-dev";
/** Image for the script-runner containers: alpine sh + busybox tar + a curl
 * new enough for --aws-sigv4 (>= 7.75), installed at container start. */
const SCRIPT_IMAGE = "alpine:3.21";

// The spec's worked example.
const ref: WorkspaceRef = {
  orgId: "org_39828000-1c89-4735-874e-2150e09dc225",
  ownerId: "user_zeke",
  workspaceId: "root-valet-assistants-asst-11111111-2222-3333-4444-555555555555",
};

let hostPort = 0;
let hostStore: ObjectStoreWorkspaceStore;
/** Presigns against the in-network endpoint so script containers can use
 * the URLs (a presigned URL signs the host header). */
let presignStore: ObjectStoreWorkspaceStore;

function storeCfg(endpoint: string): ObjectStoreConfig {
  return {
    bucket: BUCKET,
    endpoint,
    region: "us-east-1",
    prefix: "",
    credentialsSecret: "unused-in-tests",
    gzip: true,
    keepCheckpoints: 2,
  };
}

function s3Client(endpoint: string): S3Client {
  return new S3Client({
    region: "us-east-1",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });
}

function docker(args: string[], opts: { allowFail?: boolean } = {}): string {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`docker ${args.slice(0, 3).join(" ")} failed (exit ${r.status}): ${r.stderr}`);
  }
  return r.stdout;
}

/** Runs a workspace script inside a fresh container on the MinIO network.
 * `workspaceDir` bind-mounts as /workspace; `credsDir` (when set) as the
 * restore credentials mount. */
function runScriptContainer(args: {
  script: string;
  workspaceDir: string;
  credsDir?: string;
  env?: Record<string, string>;
}): { status: number; stdout: string; stderr: string } {
  const dockerArgs = [
    "run",
    "--rm",
    "--network",
    NETWORK,
    "-v",
    `${args.workspaceDir}:/workspace`,
    ...(args.credsDir ? ["-v", `${args.credsDir}:/etc/valet/workspace-store:ro`] : []),
    ...Object.entries(args.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    SCRIPT_IMAGE,
    "sh",
    "-c",
    `apk add --no-cache curl >/dev/null 2>&1 && cd /workspace && ${args.script}`,
  ];
  const r = spawnSync("docker", dockerArgs, { encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

function makeCredsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ws-creds-"));
  writeFileSync(join(dir, "AWS_ACCESS_KEY_ID"), ACCESS_KEY);
  writeFileSync(join(dir, "AWS_SECRET_ACCESS_KEY"), SECRET_KEY);
  return dir;
}

function restoreEnvFor(target: WorkspaceRef, onFailure: "fallback" | "block"): Record<string, string> {
  return {
    [RESTORE_ENV.baseUrl]: `${MINIO_INTERNAL}/${BUCKET}`,
    [RESTORE_ENV.region]: "us-east-1",
    [RESTORE_ENV.workspacePrefix]: `${target.orgId}/${target.ownerId}/${target.workspaceId}/`,
    [RESTORE_ENV.onRestoreFailure]: onFailure,
  };
}

describe.skipIf(!dockerReady)("object-store backend against MinIO", () => {
  const tempDirs: string[] = [];

  beforeAll(async () => {
    docker(["rm", "-f", MINIO_CONTAINER], { allowFail: true });
    docker(["network", "rm", NETWORK], { allowFail: true });
    docker(["network", "create", NETWORK]);
    docker([
      "run",
      "-d",
      "--name",
      MINIO_CONTAINER,
      "--network",
      NETWORK,
      "-p",
      "127.0.0.1:0:9000",
      "-e",
      `MINIO_ROOT_USER=${ACCESS_KEY}`,
      "-e",
      `MINIO_ROOT_PASSWORD=${SECRET_KEY}`,
      "minio/minio",
      "server",
      "/data",
    ]);
    const portLine = execFileSync("docker", ["port", MINIO_CONTAINER, "9000/tcp"], {
      encoding: "utf8",
    }).trim();
    hostPort = Number(portLine.split("\n")[0]?.split(":").pop());
    const hostEndpoint = `http://127.0.0.1:${hostPort}`;

    // Wait for MinIO to accept requests, then create the bucket.
    const client = s3Client(hostEndpoint);
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
        break;
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") break;
        if (Date.now() > deadline) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    hostStore = new ObjectStoreWorkspaceStore(storeCfg(hostEndpoint), {
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    });
    presignStore = new ObjectStoreWorkspaceStore(storeCfg(MINIO_INTERNAL), {
      client: s3Client(MINIO_INTERNAL),
    });
  }, 120_000);

  afterAll(() => {
    docker(["rm", "-f", MINIO_CONTAINER], { allowFail: true });
    docker(["network", "rm", NETWORK], { allowFail: true });
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  function tempWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "ws-"));
    tempDirs.push(dir);
    return dir;
  }

  it(
    "acceptance scenario: write → checkpoint → reap → reopen elsewhere → file is present",
    { timeout: 180_000 },
    async () => {
      const credsDir = makeCredsDir();
      tempDirs.push(credsDir);
      const env = restoreEnvFor(ref, "fallback");

      // Step 1: first open — no committed checkpoint, cold start, empty workspace.
      const ws1 = tempWorkspace();
      const first = runScriptContainer({
        script: buildRestoreScript(),
        workspaceDir: ws1,
        credsDir,
        env,
      });
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain("cold start from image");

      // Step 2: the agent writes NOTES.md.
      writeFileSync(join(ws1, "NOTES.md"), "hello-durable");
      // Derived dir that must stay out of the checkpoint (Appendix C).
      mkdirSync(join(ws1, "node_modules"));
      writeFileSync(join(ws1, "node_modules", "big.js"), "x".repeat(1000));

      // Step 3: hibernate — the suspend-time checkpoint commits via the
      // real in-pod script and presigned PUTs (INV-2 order inside).
      const checkpointId = `ck-test-${Date.now().toString(36)}`;
      const urls = await presignStore.presignCheckpointPuts(ref, checkpointId);
      const ckpt = runScriptContainer({
        script: buildCheckpointScript({ checkpointId, createdAtMs: Date.now() }),
        workspaceDir: ws1,
        env: checkpointScriptEnv(urls),
      });
      expect(ckpt.status, ckpt.stderr).toBe(0);
      expect(ckpt.stdout).toContain("checkpoint-committed");

      const manifest = await hostStore.latest(ref);
      expect(manifest?.checkpointId).toBe(checkpointId);
      expect(manifest && manifest.entryCount).toBeGreaterThanOrEqual(1);

      // Step 4: reap — the pod and its emptyDir are destroyed.
      rmSync(ws1, { recursive: true, force: true });

      // Step 5: reopen the same workspace id "on a different node": a fresh
      // container over a fresh empty workspace runs the restore.
      const ws2 = tempWorkspace();
      const second = runScriptContainer({
        script: buildRestoreScript(),
        workspaceDir: ws2,
        credsDir,
        env,
      });
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain(`restored checkpoint ${checkpointId}`);

      // Step 6: the file is present with the exact body.
      expect(readFileSync(join(ws2, "NOTES.md"), "utf8")).toBe("hello-durable");
      // The ignore list held: node_modules did not round-trip.
      expect(() => readFileSync(join(ws2, "node_modules", "big.js"))).toThrow();
    },
  );

  it("INV-1: restore skips a non-empty workspace", { timeout: 120_000 }, async () => {
    const credsDir = makeCredsDir();
    tempDirs.push(credsDir);
    const ws = tempWorkspace();
    writeFileSync(join(ws, "existing.txt"), "already here");
    const result = runScriptContainer({
      script: buildRestoreScript(),
      workspaceDir: ws,
      credsDir,
      env: restoreEnvFor(ref, "fallback"),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("skipping restore (INV-1)");
    expect(readFileSync(join(ws, "existing.txt"), "utf8")).toBe("already here");
  });

  it("INV-2: an interrupted upload never becomes the latest checkpoint", async () => {
    const target: WorkspaceRef = { ...ref, workspaceId: "inv2-workspace" };
    const committed = await hostStore.checkpoint(target, tarStream({ "a.txt": "one" }), {
      createdAtMs: Date.now(),
    });

    // Simulate an interrupt: data for a NEWER checkpoint lands, but the
    // manifest and latest pointer never do.
    const orphan = "ck-orphan-1";
    const raw = s3Client(`http://127.0.0.1:${hostPort}`);
    await raw.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: checkpointDataKey("", target, orphan),
        Body: "partial-bytes",
      }),
    );

    const latest = await hostStore.latest(target);
    expect(latest?.checkpointId).toBe(committed.checkpointId);
    const restored = await hostStore.restore(target);
    expect(restored).not.toBeNull();
  });

  it("Node-side store round-trips a tar and prunes beyond keepCheckpoints", async () => {
    const target: WorkspaceRef = { ...ref, workspaceId: "node-roundtrip" };
    const first = await hostStore.checkpoint(target, tarStream({ "one.txt": "1" }), {
      createdAtMs: Date.now() - 3000,
    });
    const second = await hostStore.checkpoint(target, tarStream({ "two.txt": "2" }), {
      createdAtMs: Date.now() - 2000,
    });
    const third = await hostStore.checkpoint(target, tarStream({ "three.txt": "3" }), {
      createdAtMs: Date.now() - 1000,
    });
    // ">= 1", not an exact count: the host tar adds platform entries (the
    // "./" directory; AppleDouble files on macOS despite COPYFILE_DISABLE).
    expect(first.entryCount).toBeGreaterThanOrEqual(1);

    const latest = await hostStore.latest(target);
    expect(latest?.checkpointId).toBe(third.checkpointId);

    // keepCheckpoints=2: the first checkpoint's objects are pruned.
    const restoredFirst = await restoreSpecific(target, first.checkpointId);
    expect(restoredFirst).toBe(false);
    const restoredSecond = await restoreSpecific(target, second.checkpointId);
    expect(restoredSecond).toBe(true);

    // purge removes everything for the workspace.
    await hostStore.purge(target);
    expect(await hostStore.latest(target)).toBeNull();
  });

  it("prune never deletes the checkpoint the live latest pointer names", async () => {
    const target: WorkspaceRef = { ...ref, workspaceId: "prune-race" };
    const keepOne = new ObjectStoreWorkspaceStore(
      { ...storeCfg(`http://127.0.0.1:${hostPort}`), keepCheckpoints: 1 },
      { credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY } },
    );
    const a = await keepOne.checkpoint(target, tarStream({ "a.txt": "a" }), {
      createdAtMs: Date.now() - 2000,
    });
    const b = await keepOne.checkpoint(target, tarStream({ "b.txt": "b" }), {
      createdAtMs: Date.now() - 1000,
    });
    // Simulate the raced interleaving: commit A's post-commit prune runs
    // AFTER commit B's latest PUT. The caller protects only its own id —
    // the prune must also protect whatever `latest` names now, or it
    // deletes B's objects and leaves the pointer dangling.
    await keepOne.pruneCheckpoints(target, a.checkpointId);

    const latest = await keepOne.latest(target);
    expect(latest?.checkpointId).toBe(b.checkpointId);
    expect(await restoreSpecific(target, b.checkpointId)).toBe(true);
  });

  /** True when the checkpoint's data object still exists. */
  async function restoreSpecific(target: WorkspaceRef, checkpointId: string): Promise<boolean> {
    const raw = s3Client(`http://127.0.0.1:${hostPort}`);
    try {
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      await raw.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: checkpointDataKey("", target, checkpointId) }),
      );
      return true;
    } catch {
      return false;
    }
  }
});

/** Builds a real (uncompressed) tar stream from a name→content map by
 * shelling out to the host tar — the store gzips internally. */
function tarStream(files: Record<string, string>): Readable {
  const dir = mkdtempSync(join(tmpdir(), "ws-tar-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  const bytes = execFileSync("tar", ["-cf", "-", "-C", dir, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  rmSync(dir, { recursive: true, force: true });
  return Readable.from(bytes);
}
