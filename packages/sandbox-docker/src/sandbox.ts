import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, posix, resolve } from "node:path";
import type {
  ExecJobHandle,
  ExecOpts,
  ExecResult,
  GatewayEndpoint,
  JobPoll,
  Sandbox,
  SandboxCapabilities,
  SandboxCreateOpts,
  SandboxProvider,
  SandboxStatus,
} from "@valet/engine";
import { CONTAINER_DEATH_PATTERN } from "@valet/engine";

/** 5-minute backstop eviction for job entries nobody polls to completion
 * (spec decision 9). Primary eviction is on first poll observing terminal
 * status; this timer is just a leak guard. */
const JOB_EVICTION_BACKSTOP_MS = 5 * 60 * 1000;

interface DockerJobState {
  status: "running" | "done" | "failed";
  exitCode?: number;
  output: string;
  child: ChildProcess;
  /** Set when the close/error signature indicates a `docker exec` transport
   * failure (dead container) rather than the command's own exit — pollJob
   * rejects with this instead of returning a normal terminal JobPoll. */
  transportError?: Error;
  closed: Promise<void>;
  evictTimer?: NodeJS.Timeout;
}

/**
 * True when a `docker exec`-level failure occurred (container dead/gone),
 * as opposed to the user's command inside a live container exiting
 * non-zero on its own. Only meaningful for the *docker exec* invocation —
 * never applied to `docker run`/`rm`/`inspect`, whose own failures are
 * handled separately.
 */
function isDockerExecTransportFailure(exitCode: number, stderr: string): boolean {
  return exitCode !== 0 && CONTAINER_DEATH_PATTERN.test(stderr);
}

/**
 * True when the failure is a genuine `docker` CLI / daemon-level error —
 * exit 125/126 (docker CLI usage/exec-setup failure) or a stderr message
 * that actually comes from the daemon ("Error response from daemon: ...").
 * These are trustworthy without a liveness check. Everything else that
 * merely matches CONTAINER_DEATH_PATTERN (e.g. a `curl` inside the user's
 * own command printing "Connection refused" to stderr) is only a
 * *candidate* — confirm real container death via `isContainerAlive`
 * before treating it as a transport failure.
 */
function isGenuineDockerCliFailure(exitCode: number, stderr: string): boolean {
  return exitCode === 125 || exitCode === 126 || /^Error response from daemon:/i.test(stderr.trim());
}

/**
 * A `docker rm -f` that kills a container while `docker exec` is attached
 * does NOT surface as a daemon-level error message on stderr — confirmed by
 * direct repro: the `docker exec` CLI process itself exits cleanly with
 * code 137 (128 + SIGKILL) and empty stdout/stderr, indistinguishable at
 * the child-process level from a command inside a *live* container that
 * legitimately dies to a signal (e.g. `kill -9 $$`). `isDockerExecTransportFailure`'s
 * stderr-regex check therefore never fires for this case, so container death
 * silently gets reported as an ordinary non-zero command exit instead of
 * degrading the attachment. `looksSignalKilled` flags the narrow band of
 * exit codes (128 + signal number) worth the extra `docker inspect` round
 * trip to disambiguate — ordinary command failures (1, 2, 127, ...) never
 * pay for it.
 */
function looksSignalKilled(exitCode: number): boolean {
  return exitCode > 128 && exitCode <= 128 + 64;
}

async function isContainerAlive(containerId: string): Promise<boolean> {
  const result = await execProcess("docker", ["inspect", "-f", "{{.State.Running}}", containerId], {});
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

/**
 * DockerSandbox runs shell commands inside a long-running Docker container,
 * with the workspace bind-mounted from the host. Filesystem operations
 * (read/write/edit/stat/etc.) execute on the host against the mounted
 * directory — fast, no protocol overhead — while exec() goes through
 * `docker exec`. This gives real container isolation for shell while
 * keeping FS reads cheap.
 *
 * Lifetime: one container per sandbox, started on create() and removed
 * on destroy(). Restarts are not preserved across the engine's
 * restoreSession path; the host re-creates a fresh container.
 *
 * Networking: defaults to bridge (the LocalSandbox-equivalent posture).
 * Override via DockerSandboxCreateOpts.network.
 *
 * Security: bind-mounting + bridge networking gives the container the
 * same data and outbound network access as the host process. For
 * production deployments (untrusted prompts), use --network=none and
 * a workspace dedicated to the session.
 */

const DEFAULT_IMAGE = "node:20-bookworm";
const CONTAINER_PREFIX = "valet-sandbox-";

export interface DockerSandboxCreateOpts extends SandboxCreateOpts {
  /** Workspace dir on the host. Required. Bind-mounted at /workspace inside the container. */
  workspace: string;
  /** Container image. Default: node:20-bookworm. */
  image?: string;
  /** Docker network mode. "bridge" (default), "none", "host", or a named network. */
  network?: string;
  /** Extra env vars to inject into the container at start time. */
  env?: Record<string, string>;
  /** Pull the image before creating the container if it isn't local. Default: true. */
  pullIfMissing?: boolean;
}

export interface DockerSandboxOptions {
  /** Container id assigned by Docker. */
  containerId: string;
  /** Resolved workspace path on the host. */
  workspace: string;
  /** Workspace path inside the container. */
  containerWorkspace: string;
  /** Image used to start the container. */
  image: string;
  /** Absolute host path for the creds bind mount (~/.valet/creds/<sandboxId>/).
   * Present only when the sandbox was created with credsFiles. */
  credsHostDir?: string;
}

const CONTAINER_WORKSPACE = "/workspace";

/** Port the in-sandbox auth gateway daemon listens on (Task 2 default). */
const GATEWAY_PORT = 9000;

export interface BuildDockerRunArgsOpts {
  containerName: string;
  image: string;
  /** Resolved (realpath'd) host path bind-mounted at CONTAINER_WORKSPACE. */
  workspaceHostPath: string;
  network: string;
  env?: Record<string, string>;
  resources?: { cpu?: number; memory?: string };
  /** Interactive-service profile. Default "headless" — no ports published.
   * "full" additionally publishes the gateway port to an ephemeral loopback
   * port so `DockerSandbox.gatewayEndpoint()` can resolve it via `docker
   * inspect`. */
  profile?: "headless" | "full";
  /** Absolute host path for the creds bind mount. When set, the directory is
   * mounted read-only at /etc/valet/creds inside the container. The caller
   * (create()) is responsible for writing the files BEFORE invoking docker run.
   * When absent, no creds volume is added. */
  credsHostDir?: string;
  /** Rootless docker-in-sandbox (SandboxCreateOpts.docker). Adds the
   * seccomp/AppArmor/fuse relaxations and VALET_SANDBOX_DOCKER=1 — never
   * --privileged. */
  docker?: boolean;
}

/**
 * Pure `docker run` argv builder — extracted out of
 * `DockerSandboxProvider.create` (the "extract pure function" pattern, see
 * CLAUDE.md) so the flag-composition logic is unit-testable without a live
 * Docker daemon. No I/O, no defaults resolved elsewhere (callers pass
 * already-resolved values — image/network defaults, workspace realpath,
 * etc. are `create()`'s job).
 */
export function buildDockerRunArgs(opts: BuildDockerRunArgsOpts): string[] {
  const runArgs: string[] = ["run", "-d", "--name", opts.containerName];
  runArgs.push("--workdir", CONTAINER_WORKSPACE);
  runArgs.push("-v", `${opts.workspaceHostPath}:${CONTAINER_WORKSPACE}`);
  if (opts.credsHostDir) runArgs.push("-v", `${opts.credsHostDir}:/etc/valet/creds:ro`);
  if (opts.docker) {
    runArgs.push("--security-opt", "seccomp=unconfined");
    runArgs.push("--security-opt", "apparmor=unconfined");
    runArgs.push("--device", "/dev/fuse");
    runArgs.push("--env", "VALET_SANDBOX_DOCKER=1");
  }
  if (opts.network !== "bridge") runArgs.push("--network", opts.network);
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      runArgs.push("--env", `${k}=${v}`);
    }
  }
  if (opts.resources?.cpu) runArgs.push("--cpus", String(opts.resources.cpu));
  if (opts.resources?.memory) runArgs.push("--memory", opts.resources.memory);
  if (opts.profile === "full") {
    // Ephemeral loopback-only port — never exposed beyond the host, matches
    // the auth-gateway's JWT-fronted access model (spec: sandbox auth
    // gateway plan). `DockerSandbox.gatewayEndpoint()` resolves the actual
    // assigned port via `docker inspect`.
    runArgs.push("-p", `127.0.0.1::${GATEWAY_PORT}`);
    // Full-profile containers run the same startup script the kubernetes
    // provider uses (packages/sandbox-kubernetes/src/manifest.ts) — it
    // starts the gateway/ttyd/code-server daemons and keeps the container
    // alive in the foreground of its own wait loop. Not every image passed
    // to a full-profile session is guaranteed to carry
    // docker/start-full.sh (e.g. the default `node:20-bookworm` fallback,
    // or any image supplied before a full-capable one is wired up) — probe
    // for it at container-start time and degrade to the same `tail -f
    // /dev/null` placeholder headless containers use instead of dying
    // instantly. The agent (docker exec) still works either way; the
    // gateway-fronted tabs 502 until a full-capable image is supplied.
    runArgs.push(
      opts.image,
      "sh",
      "-c",
      "[ -f /start-full.sh ] && exec /bin/bash /start-full.sh || exec tail -f /dev/null",
    );
  } else if (opts.docker) {
    // Same probe-and-degrade idiom as the full profile: images without the
    // rootless toolchain still come up (docker commands then fail inside).
    runArgs.push(
      opts.image,
      "sh",
      "-c",
      "[ -f /start-headless.sh ] && exec /bin/bash /start-headless.sh || exec tail -f /dev/null",
    );
  } else {
    // Keep the container alive — most images exit immediately if PID 1 is
    // an interactive shell and there's no TTY. `tail -f /dev/null` is a
    // tiny long-running placeholder; `docker exec` does the actual work.
    runArgs.push(opts.image, "sh", "-c", "tail -f /dev/null");
  }
  return runArgs;
}

export class DockerSandbox implements Sandbox {
  readonly id: string;
  readonly workspace: string;
  readonly containerId: string;
  readonly containerWorkspace: string;
  readonly image: string;
  readonly credsHostDir?: string;
  private jobs = new Map<string, DockerJobState>();
  private nextJobId = 1;

  constructor(id: string, opts: DockerSandboxOptions) {
    this.id = id;
    this.containerId = opts.containerId;
    this.workspace = opts.workspace;
    this.containerWorkspace = opts.containerWorkspace;
    this.image = opts.image;
    this.credsHostDir = opts.credsHostDir;
  }

  /**
   * Translate any path the agent might hand us (host absolute, container
   * absolute, or workspace-relative) into the host-side path that node:fs
   * can open. Keeps the user's mental model symmetric with bash, which
   * sees the workspace at `/workspace` inside the container.
   */
  private resolveHostPath(p: string): string {
    if (!isAbsolute(p)) return resolve(this.workspace, p);
    const cw = this.containerWorkspace;
    if (p === cw) return this.workspace;
    const cwSlash = cw.endsWith("/") ? cw : cw + "/";
    if (p.startsWith(cwSlash)) {
      return resolve(this.workspace, p.slice(cwSlash.length));
    }
    return p;
  }

  /**
   * Translate a host-side path to its container-side path. Only paths
   * inside the workspace are exposed inside the container; absolute paths
   * outside the workspace are left as-is, and exec() picks them up only
   * if the container actually has them (it doesn't for a stock image).
   */
  private resolveContainerPath(p: string): string {
    if (isAbsolute(p)) {
      const ws = this.workspace.endsWith("/") ? this.workspace : this.workspace + "/";
      if (p === this.workspace) return this.containerWorkspace;
      if (p.startsWith(ws)) {
        return this.containerWorkspace + "/" + p.slice(ws.length);
      }
      return p; // best-effort; only exists if the host path exists in the container
    }
    // Relative paths resolve against the container workspace. Callers that
    // use this as a --workdir argument need an absolute container path —
    // docker exec rejects a relative one.
    return posix.join(this.containerWorkspace, p);
  }

  async readFile(path: string): Promise<string> {
    return fs.readFile(this.resolveHostPath(path), "utf8");
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const buf = await fs.readFile(this.resolveHostPath(path));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async writeFile(path: string, content: string): Promise<void> {
    // No pre-write mkdir: the PolicySandbox wrapper owns write-with-
    // parent-creation (attempt write, mkdir parent + retry once on
    // rejection) — see spec decision 3.
    await fs.writeFile(this.resolveHostPath(path), content, "utf8");
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    await fs.writeFile(this.resolveHostPath(path), data);
  }

  async readdir(path: string): Promise<string[]> {
    return fs.readdir(this.resolveHostPath(path));
  }

  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    const s = await fs.stat(this.resolveHostPath(path));
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
  }

  async mkdir(path: string): Promise<void> {
    await fs.mkdir(this.resolveHostPath(path), { recursive: true });
  }

  async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await fs.rm(this.resolveHostPath(path), {
      recursive: opts?.recursive ?? false,
      force: true,
    });
  }

  private execArgs(command: string, opts?: ExecOpts): string[] {
    const cwd = opts?.cwd ? this.resolveContainerPath(opts.cwd) : this.containerWorkspace;
    const args = ["exec"];
    args.push("--workdir", cwd);
    if (opts?.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        args.push("--env", `${k}=${v}`);
      }
    }
    if (opts?.stdin !== undefined) args.push("--interactive");
    args.push(this.containerId, "sh", "-c", command);
    return args;
  }

  async exec(command: string, opts?: ExecOpts): Promise<ExecResult> {
    const result = await execProcess("docker", this.execArgs(command, opts), {
      timeout: opts?.timeout,
      signal: opts?.signal,
      stdin: opts?.stdin,
      maxOutputBytes: opts?.maxOutputBytes,
    });
    // `docker exec` itself failing (dead/removed/stopped container) surfaces
    // as a normal non-zero exit from the docker CLI — indistinguishable at
    // the child-process level from the user's own command failing. Detect
    // the docker-CLI failure signature and reject instead of resolving, so
    // the PolicySandbox wrapper's degradation path (which only fires on
    // rejections) actually triggers. A command-level non-zero exit inside a
    // live container still resolves normally.
    //
    // CONTAINER_DEATH_PATTERN also matches plausible *user command* stderr
    // (a `curl` to a down port prints "Connection refused") — a match alone
    // is not proof the container is dead. Genuine daemon/CLI failures
    // (isGenuineDockerCliFailure) are trusted outright; everything else is
    // confirmed against the live container state before rejecting.
    if (isDockerExecTransportFailure(result.exitCode, result.stderr)) {
      if (
        isGenuineDockerCliFailure(result.exitCode, result.stderr) ||
        !(await isContainerAlive(this.containerId))
      ) {
        throw new Error(result.stderr.trim() || `docker exec failed (${result.exitCode})`);
      }
      // Container confirmed alive: the regex match was the user's own
      // command output, not transport failure — resolve normally below.
    } else if (
      !result.timedOut &&
      looksSignalKilled(result.exitCode) &&
      !(await isContainerAlive(this.containerId))
    ) {
      // Our own timeout SIGKILLs the docker CLI child directly (`timedOut`)
      // — that's a normal timeout outcome, not container death. Otherwise, a
      // signal-shaped exit code with no daemon error message on stderr is
      // ambiguous (see looksSignalKilled) — confirm via `docker inspect`
      // whether the container itself is still running before deciding.
      throw new Error(
        `No such container: ${this.containerId} is no longer running (exec exited ${result.exitCode})`,
      );
    }
    return result;
  }

  async snapshot(): Promise<string> {
    return `${this.id}@${Date.now()}`;
  }

  async tunnels(): Promise<Record<string, string>> {
    return {};
  }

  async destroy(): Promise<void> {
    // `docker rm -f` stops + removes; idempotent.
    try {
      await execProcess("docker", ["rm", "-f", this.containerId], {});
    } catch {
      // already gone
    }
    // Remove the host-side creds dir. Best-effort: a missing dir is not an error.
    if (this.credsHostDir) {
      await fs.rm(this.credsHostDir, { recursive: true, force: true });
    }
  }

  /**
   * Job-mode exec (spec decision 9): spawn the same `docker exec` path as
   * sync exec, but detached from the request; stdout+stderr interleave into
   * one capped buffer that pollJob reads incrementally by offset.
   */
  async execJob(command: string, opts?: ExecOpts): Promise<ExecJobHandle> {
    const execId = `job-${this.nextJobId++}`;
    const limit = opts?.maxOutputBytes;

    const child = spawn("docker", this.execArgs(command, opts), {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let resolveClosed!: () => void;
    const closed = new Promise<void>((res) => {
      resolveClosed = res;
    });
    const state: DockerJobState = { status: "running", output: "", child, closed };
    this.jobs.set(execId, state);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    let stderrTail = "";
    const appendOutput = (chunk: string, isStderr: boolean) => {
      if (isStderr) {
        stderrTail = (stderrTail + chunk).slice(-4096);
      }
      if (limit && state.output.length >= limit) return;
      state.output += chunk;
      if (limit && state.output.length > limit) state.output = state.output.slice(0, limit);
    };
    child.stdout?.on("data", (chunk: string) => appendOutput(chunk, false));
    child.stderr?.on("data", (chunk: string) => appendOutput(chunk, true));

    if (opts?.stdin !== undefined) child.stdin?.write(opts.stdin);
    child.stdin?.end();

    const scheduleEviction = () => {
      const t = setTimeout(() => this.jobs.delete(execId), JOB_EVICTION_BACKSTOP_MS);
      const unrefable = t as { unref?: () => void };
      if (typeof unrefable.unref === "function") unrefable.unref();
      state.evictTimer = t;
    };

    child.on("error", (err) => {
      state.status = "failed";
      state.transportError = err;
      resolveClosed();
      scheduleEviction();
    });
    child.on("close", (code, sig) => {
      const exitCode = code ?? (sig ? 128 : 1);
      void (async () => {
        try {
          // See the sync exec() comment: CONTAINER_DEATH_PATTERN alone is
          // only a candidate — confirm real death via isContainerAlive
          // before rejecting, unless it's a genuine daemon/CLI-level error.
          if (isDockerExecTransportFailure(exitCode, stderrTail)) {
            if (
              isGenuineDockerCliFailure(exitCode, stderrTail) ||
              !(await isContainerAlive(this.containerId))
            ) {
              state.status = "failed";
              state.transportError = new Error(stderrTail.trim() || `docker exec failed (${exitCode})`);
            } else {
              state.status = "done";
              state.exitCode = exitCode;
            }
          } else if (looksSignalKilled(exitCode) && !(await isContainerAlive(this.containerId))) {
            // Container-death mid-job-exec exits cleanly with a
            // signal-shaped code and no stderr message.
            state.status = "failed";
            state.transportError = new Error(
              `No such container: ${this.containerId} is no longer running (exec exited ${exitCode})`,
            );
          } else {
            state.status = "done";
            state.exitCode = exitCode;
          }
        } catch (err) {
          // isContainerAlive (an `execProcess` invocation of `docker
          // inspect`) can itself reject. Without this catch, that becomes
          // an unhandled rejection and resolveClosed() never runs —
          // cancelJob's `await state.closed` hangs forever.
          state.status = "failed";
          state.transportError = err instanceof Error ? err : new Error(String(err));
        } finally {
          resolveClosed();
          scheduleEviction();
        }
      })();
    });

    return { execId };
  }

  async pollJob(execId: string, offset: number): Promise<JobPoll> {
    const state = this.jobs.get(execId);
    if (!state) return { status: "failed", output: "", nextOffset: offset };

    if (state.status !== "running" && state.transportError) {
      // Docker-CLI-level failure (dead container), not a command outcome:
      // reject like `exec()` does, so the PolicySandbox degradation path
      // fires instead of treating this as a normal terminal job state.
      if (state.evictTimer) clearTimeout(state.evictTimer);
      this.jobs.delete(execId);
      throw state.transportError;
    }

    const output = state.output.slice(offset);
    const nextOffset = state.output.length;
    const result: JobPoll = { status: state.status, output, nextOffset };
    if (state.status === "done") result.exitCode = state.exitCode;

    if (state.status !== "running") {
      if (state.evictTimer) clearTimeout(state.evictTimer);
      this.jobs.delete(execId);
    }
    return result;
  }

  async cancelJob(execId: string): Promise<void> {
    const state = this.jobs.get(execId);
    if (!state) return;
    state.child.kill("SIGKILL");
    await state.closed;
  }

  /**
   * The in-sandbox auth gateway's reachable endpoint (Task 3). Resolves the
   * host port `-p 127.0.0.1::9000` was mapped to via `docker inspect` —
   * headless containers never publish the port, so the Go template resolves
   * to nothing (or `docker inspect` itself errors on a torn-down container)
   * and this returns `null` for both cases rather than throwing.
   */
  async gatewayEndpoint(): Promise<GatewayEndpoint | null> {
    const result = await execProcess(
      "docker",
      [
        "inspect",
        "-f",
        `{{with index .NetworkSettings.Ports "${GATEWAY_PORT}/tcp"}}{{(index . 0).HostPort}}{{end}}`,
        this.containerId,
      ],
      {},
    );
    if (result.exitCode !== 0) return null;
    const port = Number(result.stdout.trim());
    if (!Number.isInteger(port) || port <= 0) return null;
    return { host: "127.0.0.1", port };
  }
}

interface ExecProcessOpts {
  timeout?: number;
  signal?: AbortSignal;
  stdin?: string;
  maxOutputBytes?: number;
}

/**
 * Spawn a process and capture stdout/stderr. Honors timeout (SIGKILL),
 * abort signal, optional stdin, and maxOutputBytes truncation. Reused
 * for both `docker run` setup and `docker exec` runtime calls.
 */
function execProcess(
  bin: string,
  args: string[],
  opts: ExecProcessOpts,
): Promise<ExecResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child: ChildProcess = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const limit = opts.maxOutputBytes;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      if (limit && stdout.length >= limit) {
        truncated = true;
        return;
      }
      stdout += chunk;
      if (limit && stdout.length > limit) {
        stdout = stdout.slice(0, limit);
        truncated = true;
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      if (limit && stderr.length >= limit) return;
      stderr += chunk;
      if (limit && stderr.length > limit) stderr = stderr.slice(0, limit);
    });

    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
    }
    child.stdin?.end();

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeout);
      const t = timer as { unref?: () => void };
      if (typeof t.unref === "function") t.unref();
    }

    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      rejectResult(err);
    });

    child.on("close", (code, sig) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const exitCode = code ?? (sig ? 128 : 1);
      resolveResult({
        stdout,
        stderr,
        exitCode,
        timedOut: timedOut ? true : undefined,
        truncated: truncated ? true : undefined,
      });
    });
  });
}

// ── Provider ──────────────────────────────────────────────────────

/** Absolute host path for the creds dir of a given sandbox id.
 * e.g. ~/.valet/creds/dsb-1/ */
function credsHostDir(sandboxId: string): string {
  return join(homedir(), ".valet", "creds", sandboxId);
}

/** Throw when any name is not a plain filename ("../evil", "a/b", ".", "..").
 * Guards every place a creds key becomes part of a path — host writes and
 * the in-container check script alike. */
function assertPlainFilenames(caller: string, names: string[]): void {
  for (const name of names) {
    if (name === "." || name === ".." || basename(name) !== name) {
      throw new Error(
        `${caller}: unsafe key "${name}" — keys must be plain filenames with no path separators`,
      );
    }
  }
}

/** Write credential files into the given directory (mode 0600). Creates the
 * directory (mode 0700, mkdir -p equivalent) before writing.
 *
 * Throws if any key is not a plain filename (e.g. "../evil" or "a/b") to
 * prevent path-traversal writes outside the creds dir.
 *
 * Exported for unit testing. */
export async function writeCredsFiles(dir: string, files: Record<string, string>): Promise<void> {
  assertPlainFilenames("writeCredsFiles", Object.keys(files));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(files)) {
    // Write to a sibling temp file then rename so the container-side bind
    // mount always sees a fully written file (avoids partial-read races on
    // macOS Docker Desktop where the FUSE/VirtioFS layer reflects file writes
    // as they happen rather than after flush).
    const tmp = join(dir, `.${name}.tmp`);
    await fs.writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, join(dir, name));
  }
}

/** In-container mount path of the creds dir (the `-v` target above). */
const CREDS_MOUNT_PATH = "/etc/valet/creds";
/** Give up waiting for the container view to converge after this long. */
const CREDS_PROPAGATION_TIMEOUT_MS = 5000;
const CREDS_PROPAGATION_POLL_MS = 100;

/** Escape a string for a single-quoted POSIX shell context. */
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Build the in-container shell script that exits 0 only when every entry
 * of `files` is readable with the expected content (compared base64-encoded
 * so secrets never appear in shell syntax) and every `removed` name is
 * absent. Exported for unit testing. */
export function credsCheckScript(
  files: Record<string, string>,
  removed: string[],
): string {
  // `files` keys are validated again by writeCredsFiles and `removed` comes
  // from readdir, but this function builds in-container paths, so it
  // enforces the invariant itself rather than trusting its callers.
  assertPlainFilenames("credsCheckScript", [...Object.keys(files), ...removed]);
  const checks: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const path = shQuote(`${CREDS_MOUNT_PATH}/${name}`);
    const b64 = Buffer.from(content, "utf8").toString("base64");
    checks.push(
      `[ "$(base64 < ${path} 2>/dev/null | tr -d '\\n')" = ${shQuote(b64)} ] || exit 1`,
    );
  }
  for (const name of removed) {
    checks.push(`[ ! -e ${shQuote(`${CREDS_MOUNT_PATH}/${name}`)} ] || exit 1`);
  }
  checks.push("exit 0");
  return checks.join("\n");
}

/** Poll the container until its view of the creds mount matches the host
 * (VirtioFS on macOS Docker Desktop serves stale ENOENT for ~1-2s after a
 * host-side rename). Best-effort: returns without error when the container
 * cannot exec (stopped/removed) or the deadline passes — host files are the
 * source of truth and the mount converges on its own. */
async function awaitCredsPropagation(
  sb: DockerSandbox,
  files: Record<string, string>,
  removed: string[],
): Promise<void> {
  const script = credsCheckScript(files, removed);
  const deadline = Date.now() + CREDS_PROPAGATION_TIMEOUT_MS;
  for (;;) {
    try {
      const result = await sb.exec(script);
      if (result.exitCode === 0) return;
    } catch {
      // exec transport failure — container stopped or removed. Nothing to
      // converge against; the host files are already correct.
      return;
    }
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, CREDS_PROPAGATION_POLL_MS));
  }
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly backend = "docker";
  private sandboxes = new Map<string, DockerSandbox>();
  private nextId = 1;

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "filesystem",
      persistentWorkspace: true,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      customImage: true,
      isolated: true,
      coldStartEstimateMs: 8000,
      credsMount: true,
      dockerSupport: true,
    };
  }

  async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    const dockerOpts = opts as DockerSandboxCreateOpts;
    const workspace = dockerOpts.workspace;
    if (!workspace) {
      throw new Error(
        "DockerSandboxProvider.create: opts.workspace is required (absolute host path).",
      );
    }
    const requested = isAbsolute(workspace) ? workspace : resolve(workspace);
    const stat = await fs.stat(requested);
    if (!stat.isDirectory()) {
      throw new Error(
        `DockerSandboxProvider.create: workspace is not a directory: ${requested}`,
      );
    }
    // Resolve symlinks so the bind mount survives macOS's /tmp → /private/tmp
    // indirection. Docker Desktop refuses to follow the symlink itself, so
    // a bind from /tmp/foo silently maps to a separate, empty volume on the
    // host side — node:fs ops on the host then can't see what the container
    // wrote and vice versa. Always pass the realpath to `docker run -v`.
    const abs = await fs.realpath(requested);

    const image = dockerOpts.image ?? DEFAULT_IMAGE;
    const network = dockerOpts.network ?? "bridge";
    const id = `dsb-${this.nextId++}`;
    const containerName = `${CONTAINER_PREFIX}${id}-${Date.now()}`;

    if (dockerOpts.pullIfMissing !== false) {
      await ensureImage(image);
    }

    // Write creds files to the host dir BEFORE docker run so the bind is
    // populated at container start. Only when credsFiles is provided and
    // non-empty. The dir uses containerName (which embeds a timestamp) so
    // the path is always unique — Docker Desktop on macOS silently fails to
    // propagate file-system changes into a bind-mount whose host path was
    // previously removed and re-created at the same location.
    let sandboxCredsDir: string | undefined;
    if (opts.credsFiles && Object.keys(opts.credsFiles).length > 0) {
      sandboxCredsDir = credsHostDir(containerName);
      await writeCredsFiles(sandboxCredsDir, opts.credsFiles);
    }

    const runArgs = buildDockerRunArgs({
      containerName,
      image,
      workspaceHostPath: abs,
      network,
      env: dockerOpts.env,
      resources: opts.resources,
      profile: opts.profile,
      credsHostDir: sandboxCredsDir,
      docker: opts.docker,
    });

    const startResult = await execProcess("docker", runArgs, {});
    if (startResult.exitCode !== 0) {
      throw new Error(
        `docker run failed (${startResult.exitCode}): ${startResult.stderr.trim() || startResult.stdout.trim()}`,
      );
    }
    const containerId = startResult.stdout.trim();

    const sb = new DockerSandbox(id, {
      containerId,
      workspace: abs,
      containerWorkspace: CONTAINER_WORKSPACE,
      image,
      credsHostDir: sandboxCredsDir,
    });
    this.sandboxes.set(id, sb);
    return sb;
  }

  async restore(id: string): Promise<Sandbox> {
    const sb = this.sandboxes.get(id);
    if (!sb) throw new Error(`DockerSandbox not found: ${id}`);
    return sb;
  }

  /** Rewrites the credential files on the host bind dir. The bind mount is
   * read-only from the container's view — no restart needed. Files present
   * in the existing dir but absent from `files` are deleted so stale
   * credentials do not survive key rotation. Throws when the sandbox is not
   * found or was created without a creds dir.
   *
   * Propagation is NOT instant on macOS Docker Desktop: VirtioFS caches
   * dentries, so a host-side rename serves ENOENT inside the container for
   * ~1-2s until the cache expires. After writing, this method polls the
   * container view (via exec) until every file matches and every removed
   * file is gone, bounded by CREDS_PROPAGATION_TIMEOUT_MS. The wait is
   * best-effort: if the container is not running or the deadline passes,
   * the method returns anyway — the host files are the source of truth and
   * the mount converges on its own.
   *
   * Known limitation: restore() cannot call updateCreds after an API restart
   * because the in-memory sandbox map is empty — no on-disk inventory lets us
   * reconstruct credsHostDir. The sandbox-replacement path covers this case
   * (new create writes fresh creds); a future design may add a persistent
   * index. */
  async updateCreds(id: string, files: Record<string, string>): Promise<void> {
    const sb = this.sandboxes.get(id);
    if (!sb) throw new Error(`DockerSandboxProvider.updateCreds: sandbox not found: ${id}`);
    if (!sb.credsHostDir) {
      throw new Error(
        `DockerSandboxProvider.updateCreds: sandbox "${id}" was not created with credsFiles`,
      );
    }
    const dir = sb.credsHostDir;
    // Remove files that are no longer in the new map before writing the new
    // set. This prevents stale credentials from persisting across rotations.
    let existing: string[] = [];
    try {
      existing = await fs.readdir(dir);
    } catch {
      // Dir may not exist yet if the initial write was skipped — treat as empty.
    }
    const incoming = new Set(Object.keys(files));
    const removed = existing.filter((f) => !incoming.has(f));
    await Promise.all(
      removed.map((f) => fs.unlink(join(dir, f)).catch(() => undefined)),
    );
    await writeCredsFiles(dir, files);
    await awaitCredsPropagation(sb, files, removed);
  }

  async destroy(id: string): Promise<void> {
    const sb = this.sandboxes.get(id);
    if (sb) await sb.destroy?.();
    this.sandboxes.delete(id);
  }

  async status(id: string): Promise<SandboxStatus> {
    const sb = this.sandboxes.get(id);
    if (!sb) return { id, state: "released" };
    const inspect = await execProcess(
      "docker",
      ["inspect", "-f", "{{.State.Running}}", sb.containerId],
      {},
    );
    if (inspect.exitCode !== 0) return { id, state: "released" };
    return inspect.stdout.trim() === "true"
      ? { id, state: "ready", startedAt: Date.now() }
      : { id, state: "released" };
  }
}

async function ensureImage(image: string): Promise<void> {
  // `docker image inspect` exits 0 if the image is local, non-zero otherwise.
  const probe = await execProcess("docker", ["image", "inspect", image], {});
  if (probe.exitCode === 0) return;
  const pull = await execProcess("docker", ["pull", image], { timeout: 120_000 });
  if (pull.exitCode !== 0) {
    throw new Error(
      `docker pull ${image} failed: ${pull.stderr.trim() || pull.stdout.trim()}`,
    );
  }
}
