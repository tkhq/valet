/**
 * Docker-backed `ImageBuilder` (sandbox images v2 plan, Task 2). Shells out
 * to `docker build` via `node:child_process.spawn` — mirrors
 * `packages/sandbox-docker`'s `execProcess` convention rather than adding a
 * `dockerode` dependency. Builds land in the local daemon's image store;
 * there is no registry push (spec decision 3) — `"pushed"` here means
 * "image available in the daemon", the terminal success state either way.
 *
 * The generated Dockerfile is piped over stdin (`-f -`); the build context
 * is an empty temp directory (the Dockerfile clones the repo itself via a
 * BuildKit secret mount, so no local context is needed). The git token
 * never appears in argv: it's written to a 0600 temp file and referenced
 * only by path (`--secret id=git-token,src=<path>`), deleted in a `finally`
 * once the build finishes.
 *
 * Concurrency is capped at 1: only one `docker build` runs at a time, extra
 * `build()` calls queue in FIFO order and report `state: "queued"` until
 * their turn.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { BuildStatus, ImageBuilder, PrebuildSpec } from "./builder.js";
import { generateDockerfile } from "./recipe.js";

/** Ring buffer cap for retained build log lines (`BuildStatus.logTail`). */
const LOG_RING_LIMIT = 200;

/**
 * Minimal surface of `child_process.ChildProcess` the docker builder
 * actually uses. Narrower than `ChildProcess` on purpose: a real
 * `spawn(...)` return value satisfies it structurally (no cast needed to
 * pass one in), and tests can implement a small fake that satisfies it
 * directly (no cast needed there either) instead of double-casting a
 * partial `ChildProcess`.
 */
export interface SpawnedProcess {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly stdin: Writable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

/** Injectable spawn function. `node:child_process`'s `spawn` satisfies this
 * (its `ChildProcess` return is a superset of `SpawnedProcess`); tests
 * substitute a fake to exercise queueing/lifecycle without a real daemon. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "pipe"]; env: NodeJS.ProcessEnv },
) => SpawnedProcess;

/**
 * Pure helper: builds the argv for `docker build` from a `PrebuildSpec`.
 * Extracted so the CLI-shape can be unit-tested without spawning anything
 * and without touching the filesystem. Deliberately takes `secretPath` and
 * `contextDir` as separate params (rather than deriving them internally)
 * so tests can assert the token's raw value never appears anywhere in the
 * returned array — only `secretPath` does.
 */
export function buildDockerBuildArgs(spec: PrebuildSpec, secretPath: string, contextDir: string): string[] {
  return ["build", "-f", "-", "-t", spec.imageRef, "--secret", `id=git-token,src=${secretPath}`, contextDir];
}

interface BuildRecord {
  state: BuildStatus["state"];
  log: string[];
  error?: string;
  child?: SpawnedProcess;
  cancelled?: boolean;
}

export interface DockerImageBuilderOpts {
  /** Injected spawn function; defaults to `node:child_process`'s `spawn`.
   * Tests supply a fake to exercise queueing/lifecycle without touching a
   * real docker daemon. */
  spawnFn?: SpawnFn;
}

export class DockerImageBuilder implements ImageBuilder {
  readonly backend = "docker";

  private readonly spawnFn: SpawnFn;
  private readonly builds = new Map<string, BuildRecord>();
  private readonly pendingSpecs = new Map<string, PrebuildSpec>();
  private readonly queue: string[] = [];
  private running: string | null = null;
  private nextId = 1;

  constructor(opts: DockerImageBuilderOpts = {}) {
    this.spawnFn = opts.spawnFn ?? spawn;
  }

  async build(spec: PrebuildSpec): Promise<{ buildId: string }> {
    const buildId = `docker-build-${this.nextId++}`;
    this.builds.set(buildId, { state: "queued", log: [] });
    this.pendingSpecs.set(buildId, spec);
    this.queue.push(buildId);
    // Fire-and-forget: `build()` resolves once the build is accepted, not
    // once it finishes (port contract). Errors are captured into the
    // record's `state`/`error`, never thrown here.
    void this.pump();
    return { buildId };
  }

  async status(buildId: string): Promise<BuildStatus> {
    const rec = this.builds.get(buildId);
    if (!rec) throw new Error(`DockerImageBuilder: unknown buildId "${buildId}"`);
    return {
      state: rec.state,
      logTail: rec.log.length > 0 ? rec.log.join("\n") : undefined,
      error: rec.error,
    };
  }

  async cancel(buildId: string): Promise<void> {
    const rec = this.builds.get(buildId);
    if (!rec) return;
    if (rec.child) {
      // In-flight: kill the child; the `close` handler transitions the
      // record to failed("cancelled").
      rec.cancelled = true;
      rec.child.kill("SIGKILL");
      return;
    }
    if (rec.state === "queued") {
      const idx = this.queue.indexOf(buildId);
      if (idx >= 0) this.queue.splice(idx, 1);
      this.pendingSpecs.delete(buildId);
      rec.state = "failed";
      rec.error = "cancelled";
    }
  }

  /** Drains the FIFO queue one build at a time (concurrency cap 1). */
  private async pump(): Promise<void> {
    if (this.running) return;
    const buildId = this.queue.shift();
    if (!buildId) return;
    const spec = this.pendingSpecs.get(buildId);
    this.pendingSpecs.delete(buildId);
    if (!spec) return;

    this.running = buildId;
    try {
      await this.runBuild(buildId, spec);
    } finally {
      this.running = null;
      void this.pump();
    }
  }

  private async runBuild(buildId: string, spec: PrebuildSpec): Promise<void> {
    const rec = this.builds.get(buildId);
    if (!rec) return;
    rec.state = "building";

    const dockerfile = generateDockerfile({
      baseImage: spec.baseImage,
      cloneUrl: spec.cloneUrl,
      commitSha: spec.commitSha,
      recipe: spec.recipe,
      setup: spec.setup,
    });

    const tmpDir = await mkdtemp(join(tmpdir(), "valet-prebuild-"));
    const secretPath = join(tmpDir, "git-token");
    const contextDir = join(tmpDir, "context");
    try {
      await mkdir(contextDir, { recursive: true });
      // 0600: never readable by other users on the host. Written even when
      // there's no token (empty file) so the CLI shape — and the
      // Dockerfile's unconditional `--mount=type=secret,id=git-token` — stay
      // uniform between the public-repo and private-repo cases.
      await writeFile(secretPath, spec.gitToken ?? "", { mode: 0o600 });

      const args = buildDockerBuildArgs(spec, secretPath, contextDir);
      await this.runDockerBuild(rec, args, dockerfile);
      rec.state = "pushed";
    } catch (err) {
      rec.state = "failed";
      rec.error = err instanceof Error ? err.message : String(err);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  private runDockerBuild(rec: BuildRecord, args: string[], dockerfile: string): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = this.spawnFn("docker", args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, DOCKER_BUILDKIT: "1" },
      });
      rec.child = child;

      const appendLog = (chunk: string) => {
        const lines = chunk.split(/\r?\n/).filter((l) => l.length > 0);
        if (lines.length === 0) return;
        rec.log.push(...lines);
        if (rec.log.length > LOG_RING_LIMIT) rec.log.splice(0, rec.log.length - LOG_RING_LIMIT);
      };

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", appendLog);
      child.stderr?.on("data", appendLog);

      child.stdin?.write(dockerfile);
      child.stdin?.end();

      child.on("error", (err) => {
        rec.child = undefined;
        rejectPromise(err);
      });

      child.on("close", (code) => {
        rec.child = undefined;
        if (rec.cancelled) {
          rejectPromise(new Error("cancelled"));
          return;
        }
        if (code === 0) {
          resolvePromise();
          return;
        }
        const tail = rec.log.slice(-40).join("\n");
        rejectPromise(new Error(`docker build exited with code ${code}${tail ? `: ${tail}` : ""}`));
      });
    });
  }
}
