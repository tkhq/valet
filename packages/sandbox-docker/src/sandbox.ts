import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
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
  SandboxListing,
  SandboxCommandChannel,
  SandboxCommandChannelOptions,
} from "@valet/engine";
import { openDockerCommandChannel } from './command-channel.js';
import { DockerInventory, dockerOwnerLabels, parseDockerInspection, validateDockerOwner, validateDockerBrowserOwner, type DockerContainerOwner, type DockerInventoryRecord } from "./inventory.js";
import { buildBrowserCompanionArgs } from "./browser-companion.js";
import { READ_RETAINED_BROWSER_AUDIT, parseRetainedBrowserAudit, type RetainedBrowserAudit } from "./browser-audit.js";
import {
  CappedOutputBuffer,
  CONTAINER_DEATH_PATTERN,
  parseResourceQuantity,
} from "@valet/engine";

/** 5-minute backstop eviction for job entries nobody polls to completion
 * (spec decision 9). Primary eviction is on first poll observing terminal
 * status; this timer is just a leak guard. */
const JOB_EVICTION_BACKSTOP_MS = 5 * 60 * 1000;

interface DockerJobState {
  status: "running" | "done" | "failed";
  exitCode?: number;
  output: string;
  /** Set when the maxOutputBytes cap dropped bytes — pollJob reports it. */
  truncated?: boolean;
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
 * (read/write/edit/stat/etc.) and shell commands execute inside the
 * container. Symlinks resolve within the container's mount view.
 *
 * Lifetime: one container per sandbox, started on create() and removed
 * on release(). Durable inventory supports adoption after API restart.
 * Final destroy() removes the retained private state.
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
  /** Private session state. Generic file methods never enumerate this mount. */
  runtimeStateDir?: string;
  onDestroy?: () => Promise<void>;
  browser?: boolean;
  /** Separate browser owner for Docker-enabled sessions. */
  browserContainerId?: string;
  /** Absolute host path for the creds bind mount (~/.valet/creds/<sandboxId>/).
   * Present only when the sandbox was created with credsFiles. */
  credsHostDir?: string;
  /** Rootless docker-in-sandbox (SandboxCreateOpts.docker). When set,
   * non-privileged execs run as the `dockerd` workload user (see
   * `buildDockerExecArgs`). The durable inventory restores this flag and
   * `credsHostDir` after API restart. */
  docker?: boolean;
}

const CONTAINER_WORKSPACE = "/workspace";

/** Port the in-sandbox auth gateway daemon listens on (Task 2 default). */
const GATEWAY_PORT = 9000;

/** Sentinel file the mount probe writes on the host and reads inside the
 * container. Removed again as soon as the probe ends. */
const MOUNT_PROBE_FILE = ".valet-mount-probe";

/** Bounds the mount probe. macOS file sharing (VirtioFS, gRPC-FUSE) caches
 * directory entries, so a host write can need a moment to appear inside the
 * container — the same delay `awaitCredsPropagation` waits out. */
const MOUNT_PROBE_TIMEOUT_MS = 5000;
const MOUNT_PROBE_POLL_MS = 100;

/**
 * Parent directory for sandbox workspaces that a VM-backed docker daemon can
 * always bind-mount.
 *
 * Docker Desktop, Colima and Rancher Desktop share the user's home directory
 * by default, and share little else. A workspace under this root is therefore
 * visible to the host and to the container on every common macOS setup, and
 * on Linux, where the daemon shares the whole filesystem. `os.tmpdir()` is
 * NOT such a place: on macOS it resolves to `/var/folders/...`, which Colima
 * does not share — see `verifyWorkspaceMount` for what that costs.
 */
export function sandboxWorkspaceRoot(): string {
  return join(homedir(), ".valet", "workspaces");
}

/**
 * Creates an empty sandbox workspace under `sandboxWorkspaceRoot()` and
 * returns its absolute path. `prefix` names the caller. The caller owns the
 * cleanup.
 */
export async function createSandboxWorkspace(prefix: string): Promise<string> {
  const root = sandboxWorkspaceRoot();
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(join(root, prefix));
}

/**
 * Confirms the container reads the same directory the host writes to.
 *
 * A docker daemon inside a virtual machine shares only a subset of the host
 * filesystem. `docker run -v` with a host path outside that subset does not
 * fail: the daemon creates an empty directory inside the VM and mounts that
 * instead. The container then reads a different directory than `readFile` and
 * `writeFile` write to (both run on the host — see the `DockerSandbox`
 * docblock), so every file staged from the host disappears.
 *
 * The probe exists because the mismatch is otherwise silent, and surfaces far
 * from its cause. Workspace prep, for example, stages the git credential
 * helper with `writeFile` and then installs it with `exec`; all the operator
 * sees is `cp: can't stat '.valet-prep/git-credential-valet'`.
 */
async function verifyWorkspaceMount(
  containerId: string,
  hostWorkspace: string,
  image: string,
): Promise<void> {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const probeHostPath = join(hostWorkspace, MOUNT_PROBE_FILE);
  const probeContainerPath = posix.join(CONTAINER_WORKSPACE, MOUNT_PROBE_FILE);
  try {
    await fs.writeFile(probeHostPath, token, "utf8");
    const deadline = Date.now() + MOUNT_PROBE_TIMEOUT_MS;
    for (;;) {
      const read = await execProcess(
        "docker",
        ["exec", containerId, "sh", "-c", `cat ${probeContainerPath} 2>/dev/null`],
        {},
      );
      if (read.stdout.trim() === token) return;
      if (Date.now() >= deadline) {
        // A container whose PID 1 already exited cannot read anything. Say
        // so, rather than blame a bind mount that may be correct.
        if (!(await isContainerAlive(containerId))) {
          // The container is removed right after this throw, so quote its
          // last output now — `docker logs` is useless to the operator later.
          const logs = await execProcess("docker", ["logs", "--tail", "20", containerId], {});
          const tail = (logs.stderr.trim() || logs.stdout.trim()).slice(0, 2000);
          throw new Error(
            `DockerSandboxProvider.create: the container from image "${image}" exited before the sandbox could use it. ` +
              `Correct the entrypoint of the image, then create the session again.` +
              (tail ? ` Last container output: ${tail}` : ""),
          );
        }
        throw new Error(
          `DockerSandboxProvider.create: the container cannot read the workspace bind mount at ${hostWorkspace}. ` +
            `This docker daemon runs in a virtual machine that does not share the path. ` +
            `The host and the container therefore read different directories, and staged files never arrive. ` +
            `Put the workspace under ${homedir()}, which every docker distribution shares by default. ` +
            `To keep this path, add it to the shared paths of the virtual machine. ` +
            `For Colima, add the path to "mounts" in ~/.colima/default/colima.yaml, then run "colima restart". ` +
            `For Docker Desktop, add the path in Settings > Resources > File sharing.`,
        );
      }
      await new Promise((r) => setTimeout(r, MOUNT_PROBE_POLL_MS));
    }
  } finally {
    // Never leave the sentinel in a workspace the agent will see.
    await fs.rm(probeHostPath, { force: true }).catch(() => undefined);
  }
}

async function verifyBrowserPreflight(containerId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const probe = await execProcess("docker", ["exec", containerId, "test", "-f", "/run/valet-browser-ready"], {});
    if (probe.exitCode === 0) return;
    if (!await isContainerAlive(containerId)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const logs = await execProcess("docker", ["logs", "--tail", "30", containerId], {});
  throw new Error(`Browser preflight failed. Check the runtime image and reviewed seccomp profile. ${(logs.stderr || logs.stdout).trim().slice(0, 3000)}`);
}

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
   * seccomp/AppArmor/systempaths relaxations, CAP_SYS_ADMIN, CAP_NET_ADMIN,
   * /dev/fuse, /dev/net/tun, and VALET_SANDBOX_DOCKER=1 — never --privileged. */
  docker?: boolean;
  runtimeStateDir?: string;
  browser?: { enabled: boolean; viewer?: boolean };
  browserSeccompProfile?: string;
  labels?: Record<string, string>;
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
  if (opts.runtimeStateDir) runArgs.push("-v", `${opts.runtimeStateDir}:/var/lib/valet`);
  for (const [key, value] of Object.entries(opts.labels ?? {})) runArgs.push("--label", `${key}=${value}`);
  if (opts.browser?.enabled) {
    if (!opts.browserSeccompProfile) throw new Error("Browser seccomp profile is missing. Configure the reviewed browser profile before starting this sandbox.");
    if (opts.docker) throw new Error("Browser isolation cannot use the Docker-in-sandbox security profile. Disable Docker-in-sandbox for this session.");
    runArgs.push("--security-opt", `seccomp=${opts.browserSeccompProfile}`);
    runArgs.push("--env", "VALET_BROWSER_ENABLED=1", "--env", "VALET_BROWSER_CONFINE=1", "--env", "VALET_BROWSER_STATE=/var/lib/valet/browser");
    runArgs.push("--env", `VALET_BROWSER_DEV_PORTS=${opts.env?.VALET_BROWSER_DEV_PORTS ?? "5173,3000,8080"}`);
    if (opts.browser.viewer) runArgs.push("--env", "VALET_BROWSER_VIEWER=1");
  }
  if (opts.credsHostDir) runArgs.push("-v", `${opts.credsHostDir}:/etc/valet/creds:ro`);
  if (opts.docker) {
    runArgs.push("--security-opt", "seccomp=unconfined");
    runArgs.push("--security-opt", "apparmor=unconfined");
    runArgs.push("--security-opt", "systempaths=unconfined");
    runArgs.push("--cap-add", "SYS_ADMIN");
    runArgs.push("--cap-add", "NET_ADMIN");
    runArgs.push("--device", "/dev/fuse");
    runArgs.push("--device", "/dev/net/tun");
    runArgs.push("--env", "VALET_SANDBOX_DOCKER=1");
  }
  if (opts.network !== "bridge") runArgs.push("--network", opts.network);
  // `host.docker.internal` is how a container reaches the host that runs the
  // api — the address `VALET_API_URL` carries on this backend (see
  // `resolveSandboxApiUrl`). Docker Desktop and colima publish the name
  // themselves; a Linux daemon does not, so map it explicitly. Skipped for
  // `none` (no route to anything) and `host` (the container already shares
  // the host's loopback, and Docker rejects `--add-host` there).
  if (opts.network !== "none" && opts.network !== "host") {
    runArgs.push("--add-host", "host.docker.internal:host-gateway");
  }
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (opts.browser?.enabled && (["PATH", "NODE_OPTIONS", "BASH_ENV", "ENV"].includes(k) || k.startsWith("LD_") || k.startsWith("BASH_FUNC_"))) continue;
      if (opts.browser?.enabled && ["VALET_BROWSER_ENABLED", "VALET_BROWSER_CONFINE", "VALET_BROWSER_STATE", "VALET_BROWSER_VIEWER", "VALET_BROWSER_DEV_PORTS", "VALET_BROWSER_WORKSPACE_READONLY"].includes(k)) continue;
      runArgs.push("--env", `${k}=${v}`);
    }
  }
  if (opts.resources?.cpu) runArgs.push("--cpus", String(opts.resources.cpu));
  if (opts.resources?.memory !== undefined) {
    const memoryBytes = parseResourceQuantity(opts.resources.memory);
    if (memoryBytes === null || memoryBytes <= 0) {
      throw new Error(
        `Invalid sandbox memory "${opts.resources.memory}". Use a positive Kubernetes quantity, such as "8Gi" or "500Mi".`,
      );
    }
    runArgs.push("--memory", String(memoryBytes));
  }
  if (opts.profile === "full" || opts.browser?.viewer) runArgs.push("-p", `127.0.0.1::${GATEWAY_PORT}`);
  if (opts.profile === "full") {
    // Ephemeral loopback-only port — never exposed beyond the host, matches
    // the auth-gateway's JWT-fronted access model (spec: sandbox auth
    // gateway plan). `DockerSandbox.gatewayEndpoint()` resolves the actual
    // assigned port via `docker inspect`.
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
      "[ -f /start-full.sh ] && { [ -x /usr/bin/tini ] && exec /usr/bin/tini -g -- /bin/bash /start-full.sh || exec /bin/bash /start-full.sh; } || exec tail -f /dev/null",
    );
  } else if (opts.browser?.enabled) {
    runArgs.push(opts.image, "sh", "-c", "test -x /usr/local/bin/valet-browser-client && test -f /start-headless.sh || { echo 'Browser runtime is missing. Rebuild this sandbox image.' >&2; exit 78; }; exec /usr/bin/tini -g -- /bin/bash /start-headless.sh");
  } else if (opts.docker) {
    // Same probe-and-degrade idiom as the full profile: images without the
    // rootless toolchain still come up (docker commands then fail inside).
    runArgs.push(
      opts.image,
      "sh",
      "-c",
      "[ -f /start-headless.sh ] && { [ -x /usr/bin/tini ] && exec /usr/bin/tini -g -- /bin/bash /start-headless.sh || exec /bin/bash /start-headless.sh; } || exec tail -f /dev/null",
    );
  } else {
    // Keep the container alive — most images exit immediately if PID 1 is
    // an interactive shell and there's no TTY. `tail -f /dev/null` is a
    // tiny long-running placeholder; `docker exec` does the actual work.
    runArgs.push(opts.image, "sh", "-c", "tail -f /dev/null");
  }
  return runArgs;
}

export interface BuildDockerExecArgsOpts {
  containerId: string;
  /** Already-resolved absolute container-side working directory. */
  cwd: string;
  command: string;
  env?: Record<string, string>;
  /** Adds `--interactive` (set when the caller supplies stdin). */
  interactive?: boolean;
  /** The sandbox was created with SandboxCreateOpts.docker. */
  docker?: boolean;
  /** ExecOpts.privileged — run with the container's default (root) user. */
  privileged?: boolean;
  browser?: boolean;
}

/**
 * Pure `docker exec` argv builder (same extract-pure-function pattern as
 * `buildDockerRunArgs`). Exec identity: in a docker-enabled sandbox every
 * non-privileged exec runs as the `dockerd` workload user (`-u dockerd`,
 * HOME pointed at its home dir) so files the workload creates are mapped
 * inside the rootless docker daemon's user namespace. `privileged: true`
 * (prep's system steps) and non-docker sandboxes keep the container's
 * default user — argv byte-identical to the pre-flag shape.
 */
export function buildDockerExecArgs(opts: BuildDockerExecArgsOpts): string[] {
  const args = ["exec"];
  const browserWorkload = opts.browser && !opts.privileged;
  args.push("--workdir", opts.cwd);
  if (opts.env && !browserWorkload) {
    for (const [k, v] of Object.entries(opts.env)) {
      args.push("--env", `${k}=${v}`);
    }
  }
  if (opts.interactive) args.push("--interactive");
  if ((opts.docker || opts.browser) && !opts.privileged) {
    args.push("-u", "dockerd");
    args.push("--env", "HOME=/home/dockerd");
  }
  if (browserWorkload) {
    for (const name of ["VALET_SANDBOX_JWT_SECRET", "LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "ENV", "NODE_OPTIONS"]) args.push("--env", `${name}=`);
  }
  args.push(opts.containerId);
  if (browserWorkload) {
    args.push("/usr/bin/setpriv", "--no-new-privs", "/usr/bin/env", "-u", "VALET_SANDBOX_JWT_SECRET");
    for (const [key, value] of Object.entries(opts.env ?? {})) if (key !== "VALET_SANDBOX_JWT_SECRET") args.push(`${key}=${value}`);
  }
  args.push(browserWorkload ? "/bin/sh" : "sh", "-c", opts.command);
  return args;
}

export class DockerSandbox implements Sandbox {
  readonly id: string;
  readonly workspace: string;
  readonly containerId: string;
  readonly containerWorkspace: string;
  readonly image: string;
  readonly credsHostDir?: string;
  readonly docker?: boolean;
  readonly runtimeStateDir?: string;
  readonly browser?: boolean;
  readonly browserContainerId?: string;
  private readonly browserWorkload: boolean;
  private readonly onDestroy?: () => Promise<void>;
  private jobs = new Map<string, DockerJobState>();
  private nextJobId = 1;

  constructor(id: string, opts: DockerSandboxOptions) {
    this.id = id;
    this.containerId = opts.containerId;
    this.workspace = opts.workspace;
    this.containerWorkspace = opts.containerWorkspace;
    this.image = opts.image;
    this.credsHostDir = opts.credsHostDir;
    this.docker = opts.docker;
    this.runtimeStateDir = opts.runtimeStateDir;
    this.onDestroy = opts.onDestroy;
    this.browser = opts.browser;
    this.browserContainerId = opts.browserContainerId;
    this.browserWorkload = opts.browser === true && !opts.docker;
  }

  /**
   * Translate any path the agent might hand us (host absolute, container
   * absolute, or workspace-relative) into the host-side path that node:fs
   * can open. Keeps the user's mental model symmetric with bash, which
   * sees the workspace at `/workspace` inside the container.
   */
  private resolveHostPath(p: string): string {
    const allowed = (candidate: string): string => {
      const normalized = resolve(candidate);
      if (normalized !== this.workspace && !normalized.startsWith(this.workspace + "/")) throw new Error("File path is outside the working directory. Use a file inside the session working directory.");
      return normalized;
    };
    if (!isAbsolute(p)) return allowed(resolve(this.workspace, p));
    const cw = this.containerWorkspace;
    if (p === cw) return this.workspace;
    const cwSlash = cw.endsWith("/") ? cw : cw + "/";
    if (p.startsWith(cwSlash)) {
      return allowed(resolve(this.workspace, p.slice(cwSlash.length)));
    }
    return allowed(p);
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
    if (this.browserWorkload) return this.workloadFile("read", path);
    return Buffer.from(await this.readBinary(path)).toString("utf8");
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const output = this.browserWorkload
      ? await this.workloadFile("readBinary", path)
      : await this.containerFile(path, quoted => `base64 -w0 ${quoted}`);
    return new Uint8Array(Buffer.from(output, "base64"));
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.writeBinary(path, new Uint8Array(Buffer.from(content, "utf8")));
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const encoded = Buffer.from(data).toString("base64");
    if (this.browserWorkload) { await this.workloadFile("writeBinary", path, encoded); return; }
    await this.containerFile(path, quoted => `base64 -d > ${quoted}`, encoded);
  }

  async readdir(path: string): Promise<string[]> {
    if (this.browserWorkload) {
      const value: unknown = JSON.parse(await this.workloadFile("readdir", path));
      if (!Array.isArray(value) || !value.every(entry => typeof entry === "string")) throw new Error("Invalid directory response. Inspect the sandbox runtime.");
      return value;
    }
    const output = await this.containerFile(path, quoted => `test -d ${quoted} || exit 1; for entry in ${quoted}/.[!.]* ${quoted}/..?* ${quoted}/*; do if [ -e "$entry" ] || [ -L "$entry" ]; then printf '%s\\0' "\${entry##*/}"; fi; done`);
    return output.split("\0").filter(Boolean);
  }

  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    if (this.browserWorkload) {
      const value: unknown = JSON.parse(await this.workloadFile("stat", path));
      if (typeof value !== "object" || value === null || !("isFile" in value) || typeof value.isFile !== "boolean" || !("isDirectory" in value) || typeof value.isDirectory !== "boolean" || !("size" in value) || typeof value.size !== "number") throw new Error("Invalid file metadata response. Inspect the sandbox runtime.");
      return { isFile: value.isFile, isDirectory: value.isDirectory, size: value.size };
    }
    const output = await this.containerFile(path, quoted => `if [ -d ${quoted} ]; then printf 'd 0'; elif [ -f ${quoted} ]; then printf 'f '; wc -c < ${quoted}; elif [ -e ${quoted} ]; then printf 'o 0'; else exit 2; fi`);
    const match = /^([dfo])\s+(\d+)$/.exec(output.trim());
    if (!match) throw new Error("Invalid file metadata response. Inspect the sandbox runtime.");
    return { isFile: match[1] === "f", isDirectory: match[1] === "d", size: Number(match[2]) };
  }

  async mkdir(path: string): Promise<void> {
    if (this.browserWorkload) { await this.workloadFile("mkdir", path); return; }
    await this.containerFile(path, quoted => `mkdir -p -- ${quoted}`);
  }

  async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    if (this.browserWorkload) { await this.workloadFile("rm", path, undefined, opts?.recursive); return; }
    await this.containerFile(path, quoted => `rm ${opts?.recursive ? "-rf" : "-f"} -- ${quoted}`);
  }

  /** Generic file operations resolve symlinks only within this container's mount view. */
  private async containerFile(path: string, command: (quotedPath: string) => string, stdin?: string): Promise<string> {
    this.resolveHostPath(path);
    const result = await this.exec(command(shQuote(this.resolveContainerPath(path))), { stdin, maxOutputBytes: 150 * 1024 * 1024 });
    if (result.exitCode !== 0 || result.truncated) throw new Error(`${result.stderr.trim() || "The sandbox file operation failed"}. Use an accessible file in the session working directory.`);
    return result.stdout;
  }

  /** Browser sessions enforce generic file access with the workload UID inside the container. */
  private async workloadFile(method: string, path: string, data?: string, recursive?: boolean): Promise<string> {
    this.resolveHostPath(path);
    const script = `const fs=require('node:fs/promises');(async()=>{let input='';for await(const chunk of process.stdin)input+=chunk;const v=JSON.parse(input);switch(v.method){case 'read':process.stdout.write(await fs.readFile(v.path,'utf8'));break;case 'readBinary':process.stdout.write((await fs.readFile(v.path)).toString('base64'));break;case 'write':await fs.writeFile(v.path,v.data);break;case 'writeBinary':await fs.writeFile(v.path,Buffer.from(v.data,'base64'));break;case 'readdir':process.stdout.write(JSON.stringify(await fs.readdir(v.path)));break;case 'stat':{const s=await fs.stat(v.path);process.stdout.write(JSON.stringify({isFile:s.isFile(),isDirectory:s.isDirectory(),size:s.size}));break;}case 'mkdir':await fs.mkdir(v.path,{recursive:true});break;case 'rm':await fs.rm(v.path,{recursive:v.recursive===true,force:true});break;default:throw Error('Unsupported file method');}})().catch(e=>{process.stderr.write(e.message);process.exit(1)});`;
    const result = await this.exec(`node -e '${script.replaceAll("'", "'\\''")}'`, { stdin: JSON.stringify({ method, path: this.resolveContainerPath(path), data, recursive }), maxOutputBytes: 150 * 1024 * 1024 });
    if (result.exitCode !== 0) throw new Error(`${result.stderr.trim()}. Use a file accessible to the workload user in the working directory.`);
    return result.stdout;
  }

  private execContainer(opts?: Pick<ExecOpts, "target" | "privileged">): string {
    if (opts?.target !== "browser") return this.containerId;
    if (!opts.privileged) throw new Error("Browser commands require privileged execution. Use the trusted browser transport.");
    if (!this.browser) throw new Error("Browser automation is disabled. Enable it before opening the browser transport.");
    if (this.docker && !this.browserContainerId) throw new Error("The browser companion is missing. Release this runtime before replacing it.");
    return this.browserContainerId ?? this.containerId;
  }

  private execArgs(command: string, opts?: ExecOpts): string[] {
    const containerId = this.execContainer(opts);
    const cwd = opts?.target === "browser" ? "/" : opts?.cwd ? this.resolveContainerPath(opts.cwd) : this.containerWorkspace;
    return buildDockerExecArgs({
      containerId,
      cwd,
      command,
      env: opts?.env,
      interactive: opts?.stdin !== undefined,
      docker: this.docker,
      browser: this.browserWorkload,
      privileged: opts?.privileged,
    });
  }

  async openCommandChannel(command: string, options: SandboxCommandChannelOptions): Promise<SandboxCommandChannel> {
    return openDockerCommandChannel(this.execArgs(command, { privileged: options.privileged, target: options.target, stdin: '' }), options);
  }

  async exec(command: string, opts?: ExecOpts): Promise<ExecResult> {
    const containerId = this.execContainer(opts);
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
        !(await isContainerAlive(containerId))
      ) {
        throw new Error(result.stderr.trim() || `docker exec failed (${result.exitCode})`);
      }
      // Container confirmed alive: the regex match was the user's own
      // command output, not transport failure — resolve normally below.
    } else if (
      !result.timedOut &&
      looksSignalKilled(result.exitCode) &&
      !(await isContainerAlive(containerId))
    ) {
      // Our own timeout SIGKILLs the docker CLI child directly (`timedOut`)
      // — that's a normal timeout outcome, not container death. Otherwise, a
      // signal-shaped exit code with no daemon error message on stderr is
      // ambiguous (see looksSignalKilled) — confirm via `docker inspect`
      // whether the container itself is still running before deciding.
      throw new Error(
        `No such container: ${containerId} is no longer running (exec exited ${result.exitCode})`,
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
    if (this.onDestroy) return this.onDestroy();
    // `docker rm -f` stops + removes; idempotent.
    for (const containerId of [this.browserContainerId, this.containerId]) {
      if (!containerId) continue;
      const removed = await execProcess("docker", ["rm", "-f", containerId], {});
      if (removed.exitCode !== 0 && !/No such (object|container)/i.test(removed.stderr))
        throw new Error(`Cannot remove the Docker sandbox. Check the daemon before retrying. ${removed.stderr.trim()}`);
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
    const containerId = this.execContainer(opts);
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
    // Under a cap, keep head + tail (drop the middle): the poll protocol
    // needs an append-only buffer, so only the head streams live and the
    // tail joins on at close (see CappedOutputBuffer).
    const buf = limit !== undefined ? new CappedOutputBuffer(limit) : undefined;
    const appendOutput = (chunk: string, isStderr: boolean) => {
      if (isStderr) {
        stderrTail = (stderrTail + chunk).slice(-4096);
      }
      if (!buf) {
        state.output += chunk;
        return;
      }
      buf.append(chunk);
      state.output = buf.headText;
      if (buf.truncated) state.truncated = true;
    };
    const onStdoutData = (chunk: string) => appendOutput(chunk, false);
    const onStderrData = (chunk: string) => appendOutput(chunk, true);
    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);

    let outputFinalized = false;
    const finalizeOutput = () => {
      if (!buf || outputFinalized) return;
      outputFinalized = true;
      child.stdout?.off("data", onStdoutData);
      child.stderr?.off("data", onStderrData);
      state.output += buf.appendix();
      if (buf.truncated) state.truncated = true;
    };

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
      finalizeOutput();
      resolveClosed();
      scheduleEviction();
    });
    child.on("close", (code, sig) => {
      const exitCode = code ?? (sig ? 128 : 1);
      finalizeOutput();
      void (async () => {
        try {
          // See the sync exec() comment: CONTAINER_DEATH_PATTERN alone is
          // only a candidate — confirm real death via isContainerAlive
          // before rejecting, unless it's a genuine daemon/CLI-level error.
          if (isDockerExecTransportFailure(exitCode, stderrTail)) {
            if (
              isGenuineDockerCliFailure(exitCode, stderrTail) ||
              !(await isContainerAlive(containerId))
            ) {
              state.status = "failed";
              state.transportError = new Error(stderrTail.trim() || `docker exec failed (${exitCode})`);
            } else {
              state.status = "done";
              state.exitCode = exitCode;
            }
          } else if (looksSignalKilled(exitCode) && !(await isContainerAlive(containerId))) {
            // Container-death mid-job-exec exits cleanly with a
            // signal-shaped code and no stderr message.
            state.status = "failed";
            state.transportError = new Error(
              `No such container: ${containerId} is no longer running (exec exited ${exitCode})`,
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
    if (state.truncated) result.truncated = true;

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

    let timedOut = false;
    const limit = opts.maxOutputBytes;
    // Under a cap, keep head + tail per stream and drop the middle — test
    // runners and builds print their summary last (see CappedOutputBuffer).
    const stdoutBuf = limit !== undefined ? new CappedOutputBuffer(limit) : undefined;
    const stderrBuf = limit !== undefined ? new CappedOutputBuffer(limit) : undefined;
    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    const onStdoutData = (chunk: string) => {
      if (stdoutBuf) stdoutBuf.append(chunk);
      else stdout += chunk;
    };
    const onStderrData = (chunk: string) => {
      if (stderrBuf) stderrBuf.append(chunk);
      else stderr += chunk;
    };
    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);

    const detachCapture = () => {
      child.stdout?.off("data", onStdoutData);
      child.stderr?.off("data", onStderrData);
    };

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
      detachCapture();
      rejectResult(err);
    });

    child.on("close", (code, sig) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      detachCapture();
      const exitCode = code ?? (sig ? 128 : 1);
      const stdoutResult = stdoutBuf ? stdoutBuf.value() : stdout;
      const stderrResult = stderrBuf ? stderrBuf.value() : stderr;
      const truncated = (stdoutBuf?.truncated ?? false) || (stderrBuf?.truncated ?? false);
      resolveResult({
        stdout: stdoutResult,
        stderr: stderrResult,
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
 * Docker-enabled sandboxes (`opts.docker`) instead get 0644 files in a 0755
 * dir: git runs as the `dockerd` workload user there, and the credential
 * helper must be able to read the mounted files. The trade: on a dev
 * machine the bind-mounted creds become readable by other local users of
 * the same host (the k8s provider's Secret mounts are already 0644, so this
 * only widens the docker/dev posture, not production).
 *
 * Throws if any key is not a plain filename (e.g. "../evil" or "a/b") to
 * prevent path-traversal writes outside the creds dir.
 *
 * Exported for unit testing. */
export async function writeCredsFiles(
  dir: string,
  files: Record<string, string>,
  opts?: { docker?: boolean },
): Promise<void> {
  assertPlainFilenames("writeCredsFiles", Object.keys(files));
  const dirMode = opts?.docker ? 0o755 : 0o700;
  const fileMode = opts?.docker ? 0o644 : 0o600;
  await fs.mkdir(dir, { recursive: true, mode: dirMode });
  // `mkdir` mode is masked by the process umask and ignored for an existing
  // dir — chmod explicitly so the mode is authoritative on every write.
  await fs.chmod(dir, dirMode);
  for (const [name, content] of Object.entries(files)) {
    // Write to a sibling temp file then rename so the container-side bind
    // mount always sees a fully written file (avoids partial-read races on
    // macOS Docker Desktop where the FUSE/VirtioFS layer reflects file writes
    // as they happen rather than after flush).
    const tmp = join(dir, `.${name}.tmp`);
    await fs.writeFile(tmp, content, { encoding: "utf8", mode: fileMode });
    await fs.rename(tmp, join(dir, name));
    // `writeFile`'s mode is masked by the process umask (a 0077 umask turns
    // the docker-case 0644 into 0600, and the credential helper running as
    // the workload user then cannot read the token). chmod explicitly, same
    // as the directory above.
    await fs.chmod(join(dir, name), fileMode);
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

export interface DockerSandboxProviderOptions {
  /** Durable inventory and private state. Keep this outside every working directory. */
  inventoryRoot?: string;
  /** Reviewed Docker seccomp JSON. The bundled profile is the default. */
  browserSeccompProfile?: string;
  browserEnabled?: boolean;
  /** Stock browser-capable image for Docker-enabled session companions. */
  browserImage?: string;
}
export class DockerSandboxProvider implements SandboxProvider {
  readonly backend = "docker";
  private sandboxes = new Map<string, DockerSandbox>();
  private readonly inventory: DockerInventory;
  private readonly browserSeccompProfile: string;
  private readonly browserEnabled: boolean;
  private readonly browserImage?: string;
  constructor(options: DockerSandboxProviderOptions = {}) {
    this.browserEnabled = options.browserEnabled === true;
    this.browserImage = options.browserImage;
    this.inventory = new DockerInventory(resolve(options.inventoryRoot ?? join(homedir(), ".valet", "docker-runtime")));
    this.browserSeccompProfile = options.browserSeccompProfile ?? fileURLToPath(new URL("../seccomp/browser.json", import.meta.url));
  }
  private async providerId(): Promise<string> {
    const result = await execProcess("docker", ["info", "--format", "{{.ID}}"], {});
    if (result.exitCode !== 0 || !result.stdout.trim()) throw new Error("Cannot identify the Docker daemon. Start the configured daemon before restoring sandbox ownership.");
    return result.stdout.trim();
  }
  private async saved(id: string): Promise<DockerInventoryRecord | undefined> {
    const value = await this.inventory.read(id);
    if (value) {
      const stateDir = join(this.inventory.root, "state", id);
      const expectedStateDir = value.workloadStateDir ? join(this.inventory.root, "browser-state", id) : stateDir;
      if (value.runtimeStateDir !== expectedStateDir ||
          (value.workloadStateDir !== undefined && (value.workloadStateDir !== stateDir || !value.browser?.enabled)) ||
          (value.credsHostDir !== undefined && value.credsHostDir !== join(this.inventory.root, "creds", id)))
        throw new Error("Docker inventory state paths differ from their owner. Inspect the saved inventory before retrying.");
    }
    return value;
  }
  private sandbox(value: DockerInventoryRecord): DockerSandbox {
    if (!value.containerId) throw new Error("Docker inventory has no container identity. Inspect the pending container before retrying.");
    const sandbox = new DockerSandbox(value.id, { containerId: value.containerId, workspace: value.workspace, containerWorkspace: CONTAINER_WORKSPACE, image: value.image, credsHostDir: value.credsHostDir, runtimeStateDir: value.runtimeStateDir, docker: value.docker, browser: value.browser?.enabled, browserContainerId: value.browserCompanion?.containerId, onDestroy: () => this.destroy(value.id) });
    this.sandboxes.set(value.id, sandbox);
    return sandbox;
  }
  private async inspectOwner(value: DockerInventoryRecord, browser = false): Promise<DockerContainerOwner | undefined> {
    const companion = browser ? value.browserCompanion : undefined;
    const identity = companion ? companion.containerId ?? companion.containerName : value.containerId ?? value.containerName;
    const inspection = await execProcess("docker", ["inspect", identity], {});
    if (inspection.exitCode !== 0) {
      if (/No such (object|container)/i.test(inspection.stderr)) return undefined;
      throw new Error(`Cannot inspect the Docker owner. Restore Docker connectivity before retrying. ${inspection.stderr.trim()}`);
    }
    const owner = parseDockerInspection(JSON.parse(inspection.stdout));
    if (browser) validateDockerBrowserOwner(value, owner); else validateDockerOwner(value, owner);
    return owner;
  }

  private async validateOwnerSet(value: DockerInventoryRecord, owners: string[]): Promise<void> {
    const result = await execProcess("docker", ["ps", "-aq", "--filter", `label=valet.dev/sandbox-id=${value.id}`, "--no-trunc"], {});
    if (result.exitCode !== 0 || result.stdout.trim().split(/\s+/).filter(Boolean).some(candidate => !owners.includes(candidate)))
      throw new Error("Multiple Docker containers claim this sandbox. Inspect their ownership before restoring the browser.");
  }

  private async inspectCleanupOwners(value: DockerInventoryRecord): Promise<{ workload?: DockerContainerOwner; browser?: DockerContainerOwner }> {
    const workload = await this.inspectOwner(value);
    // Explicit cleanup can resolve the crash window between Docker creation and inventory persistence.
    // Keep the record in creating state; this does not adopt an incomplete runtime.
    if (value.state === "creating" && workload) {
      value.containerId ??= workload.id;
      value.imageId ??= workload.imageId;
      if (value.browserCompanion) value.browserCompanion.networkOwnerId ??= workload.id;
    }
    const browser = value.browserCompanion ? await this.inspectOwner(value, true) : undefined;
    await this.validateOwnerSet(value, [workload?.id, browser?.id].filter((id): id is string => Boolean(id)));
    if (value.state === "creating") {
      if (value.browserCompanion && browser) {
        value.browserCompanion.containerId ??= browser.id;
        value.browserCompanion.imageId ??= browser.imageId;
      }
      await this.inventory.write(value);
    }
    return { workload, browser };
  }

  private async removeContainer(value: DockerInventoryRecord): Promise<void> {
    if (value.providerId !== await this.providerId()) throw new Error("Docker daemon differs from the saved owner. Select the original Docker context before deleting this sandbox.");
    const { workload, browser } = await this.inspectCleanupOwners(value);
    // Validate both roles before removing either owner. The network owner is removed last.
    if (browser) {
      const removed = await execProcess("docker", ["rm", "-f", browser.id], {});
      if (removed.exitCode !== 0) throw new Error(`Cannot remove the Docker browser companion. Check the daemon before retrying. ${removed.stderr.trim()}`);
    }
    if (!workload) return;
    if (value.browser?.enabled && !value.browserCompanion) {
      const identity = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
      const args = workload.running
        ? ["exec", "--user", "0", workload.id, "chown", "-Rh", identity, "/workspace"]
        : ["run", "--rm", "--network", "none", "--user", "0", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--entrypoint", "chown", "-v", `${value.workspace}:/workspace`, value.imageId ?? value.image, "-Rh", identity, "/workspace"];
      const restored = await execProcess("docker", args, {});
      if (restored.exitCode !== 0) throw new Error(`Cannot restore working-directory ownership. Restore Docker connectivity before deleting this sandbox. ${restored.stderr.trim()}`);
    }
    const removed = await execProcess("docker", ["rm", "-f", workload.id], {});
    if (removed.exitCode !== 0) throw new Error(`Cannot remove the Docker sandbox. Check the daemon before retrying. ${removed.stderr.trim()}`);
  }

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
      nestedKubernetes: false,
      browserAutomation: this.browserEnabled,
      browserViewer: this.browserEnabled,
    };
  }

  async list(): Promise<SandboxListing[]> {
    const owner = await this.providerId();
    return (await this.inventory.list()).filter(value => value.providerId === owner).map(value => ({ id: value.id, sessionId: value.sessionId, browserEnabled: value.browser?.enabled === true, createdAtMs: null }));
  }

  /** Reads retained audit. Stops an incomplete or orphaned browser owner without starting Chromium or replaying a cell. */
  async readBrowserAudit(id: string): Promise<RetainedBrowserAudit> {
    const value = await this.saved(id);
    if (!value?.browser?.enabled) return { entries: [], total: 0 };
    if (value.providerId !== await this.providerId()) throw new Error("Docker daemon differs from the saved owner. Select the original Docker context before reading its retained audit.");
    const { workload, browser } = await this.inspectCleanupOwners(value);
    const owner = value.browserCompanion ? browser : workload;
    if (owner?.running) {
      if (workload?.running && value.state !== "creating") throw new Error("The browser owner is still running. Flush its audit through the browser client before deleting this session.");
      // Workload loss and interrupted creation can leave a live browser outside the ready lifecycle.
      // Stop the verified owner before reading its retained journal.
      const stopped = await execProcess("docker", ["stop", "--time", "30", owner.id], { timeout: 35_000 });
      if (stopped.exitCode !== 0 || await isContainerAlive(owner.id))
        throw new Error(`Cannot stop the Docker browser owner. Restore Docker connectivity before exporting its audit. ${stopped.stderr.trim()}`);
    }
    await fs.access(value.runtimeStateDir);
    try { await fs.access(join(value.runtimeStateDir, "browser/journal.sqlite")); }
    catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return { entries: [], total: 0 }; throw error; }
    const result = await execProcess("docker", ["run", "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", `${process.getuid?.() || 1501}:${process.getgid?.() || 1501}`, "--env", "NODE_OPTIONS=", "--entrypoint", "/usr/bin/flock", "-v", `${value.runtimeStateDir}:/var/lib/valet:ro`, owner?.imageId ?? value.browserCompanion?.imageId ?? value.browserCompanion?.image ?? value.imageId ?? value.image, "--shared", "--nonblock", "/var/lib/valet/browser/owner.lock", "/usr/local/bin/node", "-e", READ_RETAINED_BROWSER_AUDIT], { timeout: 30_000, maxOutputBytes: 8 * 1024 * 1024 });
    if (result.exitCode !== 0 || result.truncated) throw new Error(`Cannot read the retained browser audit. Restore the runtime image and private state before deleting this session. ${result.stderr.trim()}`);
    return parseRetainedBrowserAudit(JSON.parse(result.stdout), value.sessionId);
  }

  async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    const dockerOpts = opts as DockerSandboxCreateOpts;
    if (!dockerOpts.workspace) throw new Error("A Docker working directory is required. Configure an absolute working-directory path.");
    const workspace = await fs.realpath(resolve(dockerOpts.workspace));
    if (!(await fs.stat(workspace)).isDirectory()) throw new Error("The Docker working directory is not a directory. Select an existing directory.");
    await fs.mkdir(this.inventory.root, { recursive: true, mode: 0o700 });
    const privateRoot = await fs.realpath(this.inventory.root);
    if (workspace === privateRoot || workspace.startsWith(privateRoot + "/") || privateRoot.startsWith(workspace + "/")) throw new Error("The working directory overlaps private Docker session state. Select a separate working directory before creating this sandbox.");
    const id = opts.sessionId ? `dsb-${createHash("sha256").update(opts.sessionId).digest("hex").slice(0, 32)}` : `dsb-${randomUUID()}`;
    const image = dockerOpts.image ?? DEFAULT_IMAGE;
    const providerId = await this.providerId();
    let existing = await this.saved(id);
    if (existing && (existing.sessionId !== opts.sessionId || existing.providerId !== providerId || existing.workspace !== workspace)) throw new Error("Docker sandbox ownership differs from the requested session. Restore the matching owner before retrying.");
    if (existing?.browser?.enabled && !opts.browser?.enabled) {
      throw new Error("This session has retained browser state. Re-enable browser isolation before replacing its Docker sandbox.");
    }
    const companion = opts.browser?.enabled === true && opts.docker === true;
    const browserUpgrade = companion && existing?.docker === true && !existing.browser?.enabled;
    if (opts.browser?.enabled) {
      if (!this.browserEnabled) throw new Error("Browser automation is disabled by this provider. Enable browser support before creating this sandbox.");
      if (opts.nestedKubernetes) throw new Error("The Docker provider does not support nested Kubernetes. Use the Kubernetes provider for this session.");
      if (companion && !this.browserImage) throw new Error("The browser companion image is missing. Configure the stock browser image before creating this sandbox.");
      await fs.access(this.browserSeccompProfile).catch(() => { throw new Error("The browser seccomp profile is missing. Install the reviewed profile before creating this sandbox."); });
    }
    if (existing && existing.state !== "released" && !browserUpgrade) {
      if (existing.image !== image || existing.docker !== Boolean(opts.docker) || Boolean(existing.browser?.enabled) !== Boolean(opts.browser?.enabled) || (existing.browserCompanion && existing.browserCompanion.image !== this.browserImage)) throw new Error("The existing Docker sandbox uses another runtime image or browser configuration. Release that execution environment before replacement.");
      return this.restore(id);
    }
    if (browserUpgrade && existing?.state === "creating") throw new Error("Docker creation is pending. Inspect and release the pending runtime before enabling its browser.");
    if (dockerOpts.pullIfMissing !== false) {
      await ensureImage(image);
      if (companion) await ensureImage(this.browserImage!);
    }
    if (browserUpgrade && existing?.state !== "released") {
      // A requested browser upgrade changes topology. Release the verified legacy owner before replacing it.
      await this.release(id);
      existing = await this.saved(id);
    }
    if (existing) await fs.access(existing.runtimeStateDir).catch(() => { throw new Error("Private Docker session state is missing. Restore the retained state directory before replacing this sandbox."); });
    // Legacy Docker-only state was workload-writable. Keep it for final deletion and reserve fresh private browser state.
    const workloadStateDir = browserUpgrade ? existing?.runtimeStateDir : existing?.workloadStateDir;
    const runtimeStateDir = browserUpgrade ? join(this.inventory.root, "browser-state", id) : existing?.runtimeStateDir ?? join(this.inventory.root, "state", id);
    if (!existing || browserUpgrade) await fs.mkdir(runtimeStateDir, { recursive: true, mode: 0o700 });
    const value: DockerInventoryRecord = { version: 1, id, sessionId: opts.sessionId ?? id, providerId, containerName: `${CONTAINER_PREFIX}${id}`, workspace, runtimeStateDir, ...(workloadStateDir ? { workloadStateDir } : {}), image, docker: Boolean(opts.docker), state: "creating", ...(opts.browser ? { browser: opts.browser } : {}), ...(companion ? { browserCompanion: { containerName: `${CONTAINER_PREFIX}${id}-browser`, image: this.browserImage! } } : {}), ...(opts.credsFiles && Object.keys(opts.credsFiles).length ? { credsHostDir: join(this.inventory.root, "creds", id) } : {}) };
    if (existing) await this.inventory.write(value);
    else if (!await this.inventory.reserve(value)) return this.restore(id);
    if (value.credsHostDir && opts.credsFiles) await writeCredsFiles(value.credsHostDir, opts.credsFiles, { docker: Boolean(opts.docker || opts.browser?.enabled) });
    const uid = process.getuid?.() || 1501;
    const gid = process.getgid?.() || 1501;
    const runArgs = buildDockerRunArgs({ containerName: value.containerName, image, workspaceHostPath: workspace, network: dockerOpts.network ?? "bridge", env: { ...(companion ? Object.fromEntries(Object.entries(dockerOpts.env ?? {}).filter(([key]) => !key.startsWith("VALET_BROWSER_"))) : dockerOpts.env), VALET_SESSION_ID: value.sessionId, ...(opts.browser?.enabled && !companion ? { VALET_BROWSER_UID: String(uid), VALET_BROWSER_GID: String(gid) } : {}) }, resources: opts.resources, profile: opts.profile, credsHostDir: value.credsHostDir, docker: opts.docker, runtimeStateDir: companion ? undefined : runtimeStateDir, browser: companion ? undefined : opts.browser, browserSeccompProfile: this.browserSeccompProfile, labels: dockerOwnerLabels(value) });
    const started = await execProcess("docker", runArgs, {});
    if (started.exitCode !== 0) {
      // Keep the reservation and state: a competing creator or transport loss can leave a live owner.
      throw new Error(`Docker sandbox creation failed. Inspect the reserved container before retrying. ${started.stderr.trim() || started.stdout.trim()}`);
    }
    value.containerId = started.stdout.trim();
    if (value.browserCompanion) value.browserCompanion.networkOwnerId = value.containerId;
    await this.inventory.write(value);
    const owner = await this.inspectOwner(value);
    if (!owner) throw new Error("Cannot record the new Docker owner. Restore Docker connectivity before retrying.");
    value.imageId = owner.imageId;
    await this.inventory.write(value);
    if (value.browserCompanion) {
      // Persist each role before starting the next one. A failed create remains reserved for explicit release.
      await verifyWorkspaceMount(value.containerId, workspace, image);
      const browserStarted = await execProcess("docker", buildBrowserCompanionArgs({ owner: value, seccompProfile: this.browserSeccompProfile, uid, gid, devPorts: dockerOpts.env?.VALET_BROWSER_DEV_PORTS }), {});
      if (browserStarted.exitCode !== 0) throw new Error(`Docker browser companion creation failed. Release the pending runtime before retrying. ${browserStarted.stderr.trim() || browserStarted.stdout.trim()}`);
      value.browserCompanion.containerId = browserStarted.stdout.trim();
      await this.inventory.write(value);
      const browserOwner = await this.inspectOwner(value, true);
      if (!browserOwner) throw new Error("Cannot record the Docker browser owner. Release the pending runtime before retrying.");
      value.browserCompanion.imageId = browserOwner.imageId;
      await this.inventory.write(value);
      await verifyBrowserPreflight(browserOwner.id);
      await this.validateOwnerSet(value, [owner.id, browserOwner.id]);
    } else {
      try { await verifyWorkspaceMount(value.containerId, workspace, image); if (opts.browser?.enabled) await verifyBrowserPreflight(value.containerId); }
      catch (error) { await this.removeContainer(value); value.state = "released"; await this.inventory.write(value); throw error; }
      await this.validateOwnerSet(value, [owner.id]);
    }
    value.state = "running";
    await this.inventory.write(value);
    return this.sandbox(value);
  }

  async restore(id: string): Promise<DockerSandbox> {
    const value = await this.saved(id);
    if (!value || value.state === "released") throw new Error(`Docker sandbox ${id} is unavailable. Restore the retained execution environment before retrying.`);
    if (value.browserCompanion && value.state === "creating") throw new Error("Docker browser creation is pending. Inspect and release the pending runtime before retrying.");
    if (value.browser?.enabled && value.docker && !value.browserCompanion) throw new Error("This Docker runtime has no isolated browser companion. Release it before creating a replacement with retained state.");
    if (value.providerId !== await this.providerId()) throw new Error("Docker daemon differs from the saved owner. Select the original Docker context before restoring this sandbox.");
    await fs.access(value.runtimeStateDir).catch(() => { throw new Error("Private Docker session state is missing. Restore its directory before adopting this sandbox."); });
    const owner = await this.inspectOwner(value);
    if (!owner) throw new Error("The recorded Docker container is missing. Inspect its inventory before replacing it.");
    if (!owner.running) throw new Error("The recorded Docker container is stopped. Release it before starting a replacement with the retained state.");
    const browserOwner = value.browserCompanion ? await this.inspectOwner(value, true) : undefined;
    if (value.browserCompanion && !browserOwner) throw new Error("The recorded Docker browser companion is missing. Release the runtime before creating a replacement.");
    if (browserOwner && !browserOwner.running) throw new Error("The recorded Docker browser companion is stopped. Release the runtime before creating a replacement.");
    await this.validateOwnerSet(value, [owner.id, ...(browserOwner ? [browserOwner.id] : [])]);
    if (value.browser?.enabled) await verifyBrowserPreflight(browserOwner?.id ?? owner.id);
    value.containerId = owner.id; value.imageId = owner.imageId; value.state = "running";
    await this.inventory.write(value);
    return this.sandbox(value);
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
   * Durable inventory restores the credential directory after an API restart. */
  async updateCreds(id: string, files: Record<string, string>): Promise<void> {
    const sb = this.sandboxes.get(id) ?? await this.restore(id);
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
    await writeCredsFiles(dir, files, { docker: Boolean(sb.docker || sb.browser) });
    await awaitCredsPropagation(sb, files, removed);
  }

  /** Stops one execution environment. The session owns the retained runtime state. */
  async release(id: string): Promise<void> {
    const value = await this.saved(id); if (!value) return;
    await this.removeContainer(value);
    value.state = "released"; await this.inventory.write(value);
    this.sandboxes.delete(id);
  }

  /** Final deletion. The host must export browser audit records before calling this method. */
  async destroy(id: string): Promise<void> {
    const value = await this.saved(id); if (!value) { this.sandboxes.delete(id); return; }
    await this.removeContainer(value);
    await fs.rm(value.runtimeStateDir, { recursive: true, force: true });
    if (value.workloadStateDir) await fs.rm(value.workloadStateDir, { recursive: true, force: true });
    if (value.credsHostDir) await fs.rm(value.credsHostDir, { recursive: true, force: true });
    await this.inventory.remove(id); this.sandboxes.delete(id);
  }

  async status(id: string): Promise<SandboxStatus> {
    if (!/^dsb-[a-zA-Z0-9-]+$/.test(id)) return { id, state: "released" };
    const value = await this.saved(id); if (!value || value.state === "released") return { id, state: "released" };
    if (value.browser?.enabled && value.docker) {
      if (!value.browserCompanion || value.state !== "running") return { id, state: "released" };
      if (value.providerId !== await this.providerId()) throw new Error("Docker daemon differs from the saved owner. Select the original Docker context before checking this sandbox.");
      const workload = await this.inspectOwner(value);
      const browser = await this.inspectOwner(value, true);
      if (!workload?.running || !browser?.running) return { id, state: "released" };
      await this.validateOwnerSet(value, [workload.id, browser.id]);
      return { id, state: "ready" };
    }
    const result = await execProcess("docker", ["inspect", "-f", "{{.State.Running}}", value.containerId ?? value.containerName], {});
    return result.exitCode === 0 && result.stdout.trim() === "true" ? { id, state: "ready" } : { id, state: "released" };
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
