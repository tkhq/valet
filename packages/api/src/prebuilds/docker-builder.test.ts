import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDockerBuildArgs, DockerImageBuilder, type SpawnedProcess, type SpawnFn } from "./docker-builder.js";
import type { PrebuildSpec } from "./builder.js";

function baseSpec(overrides: Partial<PrebuildSpec> = {}): PrebuildSpec {
  return {
    configId: "cfg-1",
    prebuildId: "pb-1",
    cloneUrl: "https://github.com/octocat/Hello-World.git",
    commitSha: "abc123",
    baseImage: "alpine:3",
    recipe: [],
    imageRef: "valet-prebuild/octocat-hello-world:abc123",
    ...overrides,
  };
}

describe("buildDockerBuildArgs", () => {
  it("builds the expected docker build argv", () => {
    const spec = baseSpec();
    const args = buildDockerBuildArgs(spec, "/tmp/x/git-token", "/tmp/x/context");
    expect(args).toEqual([
      "build",
      "-f",
      "-",
      "-t",
      "valet-prebuild/octocat-hello-world:abc123",
      "--secret",
      "id=git-token,src=/tmp/x/git-token",
      "/tmp/x/context",
    ]);
  });

  it("never puts the raw git token in argv — only the secret file path", () => {
    const spec = baseSpec({ gitToken: "ghp_supersecrettoken" });
    const args = buildDockerBuildArgs(spec, "/tmp/x/git-token", "/tmp/x/context");
    for (const arg of args) {
      expect(arg).not.toContain("ghp_supersecrettoken");
    }
    expect(args.join(" ")).toContain("src=/tmp/x/git-token");
  });
});

/** Minimal fake `SpawnedProcess` driven manually by the test — emits data
 * on stdout/stderr, then a close/error event on command. */
class FakeChild extends EventEmitter implements SpawnedProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    // Real docker processes emit "close" after being SIGKILLed; the fake
    // mirrors that so DockerImageBuilder's cancel path can be exercised.
    process.nextTick(() => this.emit("close", null, "SIGKILL"));
    return true;
  }
}

interface RecordedCall {
  command: string;
  args: string[];
}

function fakeSpawnFn(onSpawn: (child: FakeChild, call: RecordedCall) => void): {
  spawnFn: SpawnFn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const spawnFn: SpawnFn = (command, args) => {
    const call = { command, args };
    calls.push(call);
    const child = new FakeChild();
    // Swallow stdin writes; nothing reads from it in the fake.
    child.stdin.on("data", () => {});
    setImmediate(() => onSpawn(child, call));
    return child;
  };
  return { spawnFn, calls };
}

/** Polls `status(buildId)` until it leaves queued/building or the deadline
 * passes. Real `mkdtemp`/`writeFile` calls happen inside the builder even
 * with a fake spawn, so a fixed tick count is not reliably enough — poll
 * instead of guessing an event-loop-turn count. */
async function waitForTerminal(
  builder: DockerImageBuilder,
  buildId: string,
  timeoutMs = 5000,
): Promise<import("./builder.js").BuildStatus> {
  const deadline = Date.now() + timeoutMs;
  let status = await builder.status(buildId);
  while (status.state === "queued" || status.state === "building") {
    if (Date.now() > deadline) throw new Error(`build did not finish in time: ${JSON.stringify(status)}`);
    await new Promise((r) => setTimeout(r, 10));
    status = await builder.status(buildId);
  }
  return status;
}

describe("DockerImageBuilder lifecycle", () => {
  it("reports queued then building then pushed on a successful build", async () => {
    const { spawnFn } = fakeSpawnFn((child) => {
      child.emit("close", 0, null);
    });
    const builder = new DockerImageBuilder({ spawnFn });

    const { buildId } = await builder.build(baseSpec());
    const status = await waitForTerminal(builder, buildId);
    expect(status.state).toBe("pushed");
    expect(status.error).toBeUndefined();
  });

  it("reports failed with error text when the process exits nonzero", async () => {
    const { spawnFn } = fakeSpawnFn((child) => {
      child.stderr.write("failed to resolve base image\n");
      child.emit("close", 1, null);
    });
    const builder = new DockerImageBuilder({ spawnFn });

    const { buildId } = await builder.build(baseSpec());
    const status = await waitForTerminal(builder, buildId);
    expect(status.state).toBe("failed");
    expect(status.error).toContain("exited with code 1");
    expect(status.logTail).toContain("failed to resolve base image");
  });

  it("caps concurrency at 1 — a second build queues until the first finishes", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    // Count only docker build spawns (args[0] === "build"), not prune spawns.
    const buildCalls: RecordedCall[] = [];
    const { spawnFn } = fakeSpawnFn((child, call) => {
      const isBuild = call.args[0] === "build";
      if (isBuild) {
        buildCalls.push(call);
        if (buildCalls.length === 1) {
          // First build: wait for the test to release it.
          void firstGate.then(() => child.emit("close", 0, null));
        } else {
          child.emit("close", 0, null);
        }
      } else {
        // Prune spawn — resolve immediately.
        child.emit("close", 0, null);
      }
    });
    const builder = new DockerImageBuilder({ spawnFn });

    const first = await builder.build(baseSpec({ configId: "cfg-1" }));
    const second = await builder.build(baseSpec({ configId: "cfg-2" }));

    // Wait until the first build spawn actually happens (real fs I/O precedes it).
    const spawnDeadline = Date.now() + 5000;
    while (buildCalls.length < 1) {
      if (Date.now() > spawnDeadline) throw new Error("first build never spawned");
      await new Promise((r) => setTimeout(r, 10));
    }
    // Second must still be queued — only one build spawn has happened.
    expect(buildCalls.length).toBe(1);
    const secondStatusBefore = await builder.status(second.buildId);
    expect(secondStatusBefore.state).toBe("queued");

    releaseFirst?.();
    const firstStatus = await waitForTerminal(builder, first.buildId);
    const secondStatus = await waitForTerminal(builder, second.buildId);

    expect(buildCalls.length).toBe(2);
    expect(firstStatus.state).toBe("pushed");
    expect(secondStatus.state).toBe("pushed");
  });

  it("cancel kills the in-flight child and reports failed(cancelled)", async () => {
    let buildChild: FakeChild | undefined;
    const spawnFn: SpawnFn = (_command, args) => {
      const child = new FakeChild();
      child.stdin.on("data", () => {});
      if (args[0] === "build") {
        // Build spawn: captured for cancel — never closes on its own.
        buildChild = child;
      } else {
        // Prune spawn: resolve immediately so the finally can complete.
        setImmediate(() => child.emit("close", 0, null));
      }
      return child;
    };
    const builder = new DockerImageBuilder({ spawnFn });

    const { buildId } = await builder.build(baseSpec());
    // Wait for the build process to be spawned (real fs I/O precedes it).
    const spawnDeadline = Date.now() + 5000;
    while (!buildChild) {
      if (Date.now() > spawnDeadline) throw new Error("build never spawned a child");
      await new Promise((r) => setTimeout(r, 10));
    }

    await builder.cancel(buildId);
    const status = await waitForTerminal(builder, buildId);

    expect(buildChild.killed).toBe(true);
    expect(status.state).toBe("failed");
    expect(status.error).toBe("cancelled");
  });

  it("writes the git token to a 0600 temp file and cleans it up afterward", async () => {
    let capturedSecretPath: string | undefined;
    const { spawnFn } = fakeSpawnFn((child, call) => {
      if (call.args[0] === "build") {
        const secretArg = call.args.find((a) => a.startsWith("--secret"));
        const idx = call.args.indexOf(secretArg ?? "");
        const srcArg = call.args[idx + 1] ?? "";
        capturedSecretPath = srcArg.replace("id=git-token,src=", "");
      }
      child.emit("close", 0, null);
    });
    const builder = new DockerImageBuilder({ spawnFn });

    const { buildId } = await builder.build(baseSpec({ gitToken: "ghp_secret" }));
    await waitForTerminal(builder, buildId);

    expect(capturedSecretPath).toBeDefined();
    // The temp dir (and its secret file) must be gone after the build.
    await expect(readFile(capturedSecretPath as string)).rejects.toThrow();
  });

  it("pins the git-token secret file to mode 0600 during the build", async () => {
    let statedMode: number | undefined;
    const { spawnFn } = fakeSpawnFn((child, call) => {
      if (call.args[0] === "build") {
        const secretArg = call.args.find((a) => a.startsWith("--secret"));
        const idx = call.args.indexOf(secretArg ?? "");
        const srcArg = call.args[idx + 1] ?? "";
        const secretPath = srcArg.replace("id=git-token,src=", "");
        // Inspect the file's mode while the build is still "in flight" (the
        // fake spawn callback runs before the test emits `close`).
        void stat(secretPath).then((st) => {
          statedMode = st.mode & 0o777;
          child.emit("close", 0, null);
        });
      } else {
        // Prune spawn: resolve immediately.
        child.emit("close", 0, null);
      }
    });
    const builder = new DockerImageBuilder({ spawnFn });

    const { buildId } = await builder.build(baseSpec({ gitToken: "ghp_secret" }));
    await waitForTerminal(builder, buildId);

    expect(statedMode).toBe(0o600);
  });

  it("marshals a pre-spawn failure (e.g. mkdtemp ENOSPC) to failed without an unhandled rejection, and keeps the queue pumping", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      let call = 0;
      const mkdtempFn = async (prefix: string): Promise<string> => {
        call += 1;
        if (call === 1) {
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        }
        return mkdtemp(prefix);
      };
      const { spawnFn, calls } = fakeSpawnFn((child) => {
        child.emit("close", 0, null);
      });
      const builder = new DockerImageBuilder({ spawnFn, mkdtempFn });

      const failing = await builder.build(baseSpec({ configId: "cfg-fail" }));
      const failingStatus = await waitForTerminal(builder, failing.buildId);
      expect(failingStatus.state).toBe("failed");
      expect(failingStatus.error).toContain("ENOSPC");

      // The queue must not be wedged: a subsequently queued build still runs.
      const ok = await builder.build(baseSpec({ configId: "cfg-ok" }));
      const okStatus = await waitForTerminal(builder, ok.buildId);
      expect(okStatus.state).toBe("pushed");
      // Only the second (successful) build + its prune ever spawned docker —
      // the first build failed before spawn (mkdtemp ENOSPC).
      const buildSpawnCount = calls.filter((c) => c.args[0] === "build").length;
      expect(buildSpawnCount).toBe(1);

      // Give any stray unhandled-rejection microtask a turn to surface.
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("cancel on a queued (not-yet-spawned) build marks it failed(cancelled), never spawns it, and lets the running build finish", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    // Count only build spawns; prune spawns close immediately.
    const buildCalls: RecordedCall[] = [];
    const { spawnFn } = fakeSpawnFn((child, call) => {
      if (call.args[0] === "build") {
        buildCalls.push(call);
        void firstGate.then(() => child.emit("close", 0, null));
      } else {
        child.emit("close", 0, null);
      }
    });
    const builder = new DockerImageBuilder({ spawnFn });

    const first = await builder.build(baseSpec({ configId: "cfg-1" }));
    const second = await builder.build(baseSpec({ configId: "cfg-2" }));

    // Wait until the first build actually spawns, confirming the second is
    // still sitting in the queue (never having spawned).
    const spawnDeadline = Date.now() + 5000;
    while (buildCalls.length < 1) {
      if (Date.now() > spawnDeadline) throw new Error("first build never spawned");
      await new Promise((r) => setTimeout(r, 10));
    }
    const secondStatusBefore = await builder.status(second.buildId);
    expect(secondStatusBefore.state).toBe("queued");

    await builder.cancel(second.buildId);
    const secondStatus = await waitForTerminal(builder, second.buildId);
    expect(secondStatus.state).toBe("failed");
    expect(secondStatus.error).toBe("cancelled");

    releaseFirst?.();
    const firstStatus = await waitForTerminal(builder, first.buildId);
    expect(firstStatus.state).toBe("pushed");

    // The cancelled queued build never reached spawn — only the first build did.
    expect(buildCalls.length).toBe(1);
  });

  it("triggers a builder prune spawn after a completed bake", async () => {
    // The bake spawn (call 0) closes with exit 0; the prune spawn (call 1)
    // closes with exit 0. Both use the same fake spawnFn.
    const { spawnFn, calls } = fakeSpawnFn((child) => {
      child.emit("close", 0, null);
    });
    const builder = new DockerImageBuilder({ spawnFn, buildCacheCapGb: 10 });

    const { buildId } = await builder.build(baseSpec());
    await waitForTerminal(builder, buildId);

    // Wait for the prune spawn — it is fired async in the `finally` after the
    // bake resolves, so the build may already be "pushed" before it spawns.
    const spawnDeadline = Date.now() + 5000;
    while (calls.length < 2) {
      if (Date.now() > spawnDeadline) throw new Error("prune was never spawned");
      await new Promise((r) => setTimeout(r, 10));
    }

    // First spawn: docker build; second spawn: docker builder prune.
    expect(calls[1]!.command).toBe("docker");
    expect(calls[1]!.args).toEqual(["builder", "prune", "-f", "--keep-storage", "10GB"]);
  });

  it("triggers a builder prune spawn even when the bake fails (non-zero exit)", async () => {
    // Prune runs in the `finally` block — it must fire on failure paths too,
    // not only on success. The bake spawn exits 1; the prune spawn exits 0.
    const { spawnFn, calls } = fakeSpawnFn((child, call) => {
      if (call.args[0] === "build") {
        child.emit("close", 1, null); // bake fails
      } else {
        child.emit("close", 0, null); // prune succeeds
      }
    });
    const builder = new DockerImageBuilder({ spawnFn, buildCacheCapGb: 10 });

    const { buildId } = await builder.build(baseSpec());
    await waitForTerminal(builder, buildId);

    // Wait for the prune spawn — fired async in `finally` after the failed bake.
    const spawnDeadline = Date.now() + 5000;
    while (calls.length < 2) {
      if (Date.now() > spawnDeadline) throw new Error("prune was never spawned after failed bake");
      await new Promise((r) => setTimeout(r, 10));
    }

    // Build must have reported failed; prune must still have been spawned.
    const status = await builder.status(buildId);
    expect(status.state).toBe("failed");
    expect(calls[1]!.command).toBe("docker");
    expect(calls[1]!.args).toEqual(["builder", "prune", "-f", "--keep-storage", "10GB"]);
  });
});

/** Skip the docker-gated suite entirely when the daemon isn't reachable. */
function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe" });
  return r.status === 0;
}

const describeDocker = dockerAvailable() ? describe : describe.skip;

describeDocker("DockerImageBuilder (live docker)", () => {
  const imagesToClean: string[] = [];

  afterEach(async () => {
    for (const ref of imagesToClean.splice(0)) {
      spawnSync("docker", ["rmi", "-f", ref], { stdio: "pipe" });
    }
  });

  it("builds a trivial public-repo spec end-to-end and pushes to the local daemon", async () => {
    const imageRef = `valet-prebuild-test/hello-world:${Date.now()}`;
    imagesToClean.push(imageRef);
    const builder = new DockerImageBuilder();

    const { buildId } = await builder.build({
      configId: "live-test",
      prebuildId: "pb-live",
      cloneUrl: "https://github.com/octocat/Hello-World.git",
      commitSha: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11",
      // Plain `alpine:3` has no `git` binary — the generated Dockerfile's
      // clone step needs one already present in the base image (recipe.ts,
      // Task 1, doesn't install git itself). `alpine/git` is alpine + git
      // with an `ENTRYPOINT ["git"]`; that's irrelevant here since `RUN`
      // always executes via `/bin/sh -c`, never through the image's
      // entrypoint.
      baseImage: "alpine/git:latest",
      recipe: [],
      imageRef,
    });

    let status = await builder.status(buildId);
    const deadline = Date.now() + 120_000;
    while (status.state === "queued" || status.state === "building") {
      if (Date.now() > deadline) throw new Error(`build did not finish in time: ${JSON.stringify(status)}`);
      await new Promise((r) => setTimeout(r, 1000));
      status = await builder.status(buildId);
    }

    expect(status.state).toBe("pushed");

    const inspect = spawnSync("docker", ["image", "inspect", imageRef], { stdio: "pipe" });
    expect(inspect.status).toBe(0);
    const parsed: Array<{ Config?: { Labels?: Record<string, string> } }> = JSON.parse(inspect.stdout.toString());
    expect(parsed[0]?.Config?.Labels?.["valet.prebuild.identity"]).toBeDefined();
  }, 150_000);

  it("reports failed with error text when the base image doesn't exist", async () => {
    const imageRef = `valet-prebuild-test/bad-base:${Date.now()}`;
    const builder = new DockerImageBuilder();

    const { buildId } = await builder.build({
      configId: "live-test-fail",
      prebuildId: "pb-live-fail",
      cloneUrl: "https://github.com/octocat/Hello-World.git",
      commitSha: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11",
      baseImage: "this-image-definitely-does-not-exist-anywhere:v999",
      recipe: [],
      imageRef,
    });

    let status = await builder.status(buildId);
    const deadline = Date.now() + 60_000;
    while (status.state === "queued" || status.state === "building") {
      if (Date.now() > deadline) throw new Error(`build did not finish in time: ${JSON.stringify(status)}`);
      await new Promise((r) => setTimeout(r, 1000));
      status = await builder.status(buildId);
    }

    expect(status.state).toBe("failed");
    expect((status.error ?? "") + (status.logTail ?? "")).toMatch(/not found|pull access denied|manifest/i);
  }, 90_000);
});

describe("temp dir hygiene sanity (no live docker required)", () => {
  it("mkdtemp/rm pattern used by the builder actually removes files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "valet-prebuild-selftest-"));
    await rm(dir, { recursive: true, force: true });
    await expect(readFile(join(dir, "git-token"))).rejects.toThrow();
  });
});
