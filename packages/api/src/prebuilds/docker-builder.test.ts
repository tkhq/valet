import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDockerBuildArgs, DockerImageBuilder, type SpawnedProcess, type SpawnFn } from "./docker-builder.js";
import type { PrebuildSpec } from "./builder.js";

function baseSpec(overrides: Partial<PrebuildSpec> = {}): PrebuildSpec {
  return {
    configId: "cfg-1",
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

    const { spawnFn, calls } = fakeSpawnFn((child, call) => {
      if (calls.length === 1) {
        // First build: wait for the test to release it.
        void firstGate.then(() => child.emit("close", 0, null));
      } else {
        child.emit("close", 0, null);
      }
    });
    const builder = new DockerImageBuilder({ spawnFn });

    const first = await builder.build(baseSpec({ configId: "cfg-1" }));
    const second = await builder.build(baseSpec({ configId: "cfg-2" }));

    // Wait until the first spawn actually happens (real fs I/O precedes it).
    const spawnDeadline = Date.now() + 5000;
    while (calls.length < 1) {
      if (Date.now() > spawnDeadline) throw new Error("first build never spawned");
      await new Promise((r) => setTimeout(r, 10));
    }
    // Second must still be queued — only one spawn has happened.
    expect(calls.length).toBe(1);
    const secondStatusBefore = await builder.status(second.buildId);
    expect(secondStatusBefore.state).toBe("queued");

    releaseFirst?.();
    const firstStatus = await waitForTerminal(builder, first.buildId);
    const secondStatus = await waitForTerminal(builder, second.buildId);

    expect(calls.length).toBe(2);
    expect(firstStatus.state).toBe("pushed");
    expect(secondStatus.state).toBe("pushed");
  });

  it("cancel kills the in-flight child and reports failed(cancelled)", async () => {
    let spawnedChild: FakeChild | undefined;
    const spawnFn: SpawnFn = (command, args) => {
      const child = new FakeChild();
      child.stdin.on("data", () => {});
      spawnedChild = child;
      // Never closes on its own — only via kill().
      return child;
    };
    const builder = new DockerImageBuilder({ spawnFn });

    const { buildId } = await builder.build(baseSpec());
    // Wait for the fake process to actually be spawned (real fs I/O precedes it).
    const spawnDeadline = Date.now() + 5000;
    while (!spawnedChild) {
      if (Date.now() > spawnDeadline) throw new Error("build never spawned a child");
      await new Promise((r) => setTimeout(r, 10));
    }

    await builder.cancel(buildId);
    const status = await waitForTerminal(builder, buildId);

    expect(spawnedChild.killed).toBe(true);
    expect(status.state).toBe("failed");
    expect(status.error).toBe("cancelled");
  });

  it("writes the git token to a 0600 temp file and cleans it up afterward", async () => {
    let capturedSecretPath: string | undefined;
    const { spawnFn } = fakeSpawnFn((child, call) => {
      const secretArg = call.args.find((a) => a.startsWith("--secret"));
      const idx = call.args.indexOf(secretArg ?? "");
      const srcArg = call.args[idx + 1] ?? "";
      capturedSecretPath = srcArg.replace("id=git-token,src=", "");
      child.emit("close", 0, null);
    });
    const builder = new DockerImageBuilder({ spawnFn });

    const { buildId } = await builder.build(baseSpec({ gitToken: "ghp_secret" }));
    await waitForTerminal(builder, buildId);

    expect(capturedSecretPath).toBeDefined();
    // The temp dir (and its secret file) must be gone after the build.
    await expect(readFile(capturedSecretPath as string)).rejects.toThrow();
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
