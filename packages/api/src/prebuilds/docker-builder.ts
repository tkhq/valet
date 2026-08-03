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
import { pruneBuildCache } from "./build-cache.js";
import { generateBaseDockerfile, generateDockerfile } from "./recipe.js";

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
  /** Injected `mkdtemp`; defaults to `node:fs/promises`'s `mkdtemp`. Tests
   * substitute a rejecting fake to exercise pre-spawn failure paths (e.g.
   * ENOSPC/EMFILE) without needing to actually exhaust host resources. */
  mkdtempFn?: (prefix: string) => Promise<string>;
  /** Maximum moby build-cache size in GB. After each bake the builder runs
   * `docker builder prune --keep-storage=<n>GB` to keep the local daemon
   * from filling the disk. Default: 10. */
  buildCacheCapGb?: number;
}

export class DockerImageBuilder implements ImageBuilder {
  readonly backend = "docker";

  private readonly spawnFn: SpawnFn;
  private readonly mkdtempFn: (prefix: string) => Promise<string>;
  private readonly buildCacheCapGb: number;
  private readonly builds = new Map<string, BuildRecord>();
  private readonly pendingSpecs = new Map<string, PrebuildSpec>();
  private readonly queue: string[] = [];
  private running: string | null = null;
  private nextId = 1;

  constructor(opts: DockerImageBuilderOpts = {}) {
    this.spawnFn = opts.spawnFn ?? spawn;
    this.mkdtempFn = opts.mkdtempFn ?? mkdtemp;
    this.buildCacheCapGb = opts.buildCacheCapGb ?? 10;
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

  /** No-op: the docker builder leaves nothing durable behind (the git-token
   * temp dir is removed in `runBuild`'s `finally`, and dies with the process
   * regardless), so there is nothing for the restart sweep to reclaim by row
   * id. Present to satisfy `ImageBuilder.cleanupOrphan` uniformly. */
  async cleanupOrphan(_prebuildId: string): Promise<void> {
    // intentionally empty — see docblock
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
    } catch (err) {
      // Defense in depth: `runBuild` wraps its entire body in try/catch and
      // should always resolve normally with `rec.state = "failed"`. If some
      // unexpected exception still escapes it, don't let it become an
      // unhandled rejection (crashes the whole api process — Node default)
      // or wedge the queue — mark the record failed here too so callers
      // waiting on `status()` aren't stuck at "building" forever.
      const rec = this.builds.get(buildId);
      if (rec) {
        rec.state = "failed";
        rec.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this.running = null;
      void this.pump();
    }
  }

  private async runBuild(buildId: string, spec: PrebuildSpec): Promise<void> {
    const rec = this.builds.get(buildId);
    if (!rec) return;
    rec.state = "building";

    // Everything below — including Dockerfile generation and `mkdtemp` — is
    // inside this try/catch on purpose. A pre-spawn throw (e.g. mkdtemp
    // ENOSPC/EMFILE) must still marshal to `rec.state = "failed"` instead of
    // rejecting the fire-and-forget `void this.pump()` chain and crashing
    // the process via an unhandled rejection.
    //
    // The terminal `rec.state` write is deliberately deferred until *after*
    // the `finally` cleanup below (rather than set inline before it), so a
    // caller polling `status()` never observes "pushed"/"failed" while the
    // secret tmpdir still exists on disk — avoids a cleanup-vs-poll race.
    let tmpDir: string | undefined;
    let outcome: { ok: true } | { ok: false; error: string };
    try {
      const dockerfile =
        spec.kind === "base"
          ? generateBaseDockerfile({ baseImage: spec.baseImage, setup: spec.setup ?? [] })
          : generateDockerfile({
              baseImage: spec.baseImage,
              cloneUrl: spec.cloneUrl,
              commitSha: spec.commitSha,
              recipe: spec.recipe,
              setup: spec.setup,
            });

      tmpDir = await this.mkdtempFn(join(tmpdir(), "valet-prebuild-"));
      const secretPath = join(tmpDir, "git-token");
      const contextDir = join(tmpDir, "context");
      await mkdir(contextDir, { recursive: true });
      // 0600: never readable by other users on the host. Written even when
      // there's no token (empty file) so the CLI shape — and the
      // Dockerfile's unconditional `--mount=type=secret,id=git-token` — stay
      // uniform between the public-repo and private-repo cases.
      await writeFile(secretPath, spec.gitToken ?? "", { mode: 0o600 });

      const args = buildDockerBuildArgs(spec, secretPath, contextDir);
      await this.runDockerBuild(rec, args, dockerfile);
      outcome = { ok: true };
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      // Best-effort cleanup. If the process was SIGKILLed mid-build (cancel
      // path), the docker child may still hold the tmpdir/secret file open
      // briefly; a failed `rm` here is accepted as an OS temp-dir leak that
      // the host's normal temp GC will reclaim, not something we retry.
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      // Bound the moby build cache on every bake (success or failure).
      // `pruneBuildCache` always resolves — the `.catch` would be dead code.
      await pruneBuildCache(this.spawnFn, this.buildCacheCapGb);
    }

    if (outcome.ok) {
      rec.state = "pushed";
    } else {
      rec.state = "failed";
      rec.error = outcome.error;
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
