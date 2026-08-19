import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
  ExecJobHandle,
  ExecOpts,
  ExecResult,
  JobPoll,
  Sandbox,
  SandboxCapabilities,
  SandboxCreateOpts,
  SandboxProvider,
  SandboxStatus,
} from "@valet/engine";

/** 5-minute backstop eviction for job entries nobody polls to completion
 * (spec decision 9). Primary eviction is on first poll observing terminal
 * status; this timer is just a leak guard. */
const JOB_EVICTION_BACKSTOP_MS = 5 * 60 * 1000;

interface LocalJobState {
  status: "running" | "done" | "failed";
  exitCode?: number;
  output: string;
  /** Set when the maxOutputBytes cap dropped bytes — pollJob reports it. */
  truncated?: boolean;
  child: ChildProcess;
  /** Resolves once the child has actually exited (close/error fired). */
  closed: Promise<void>;
  evictTimer?: NodeJS.Timeout;
}

/**
 * LocalSandbox is for development and testing. It runs FS ops via
 * node:fs/promises and shell commands via node:child_process.spawn against
 * the host machine — there is NO workspace isolation. The LLM running in
 * this sandbox can read, write, and execute anything the parent process
 * can. Use only with prompts and models you trust, in dev environments.
 *
 * The `workspace` directory is the default cwd for relative paths and for
 * shell commands without an explicit `cwd` override. It does not bound
 * filesystem access — absolute paths and `..` traversal both work.
 *
 * For production use, switch to a containerized sandbox (Docker, Modal).
 */
export class LocalSandbox implements Sandbox {
  readonly id: string;
  readonly workspace: string;
  private jobs = new Map<string, LocalJobState>();
  private nextJobId = 1;

  constructor(id: string, workspace: string) {
    this.id = id;
    this.workspace = workspace;
  }

  private resolvePath(p: string): string {
    return isAbsolute(p) ? p : resolve(this.workspace, p);
  }

  async readFile(path: string): Promise<string> {
    return fs.readFile(this.resolvePath(path), "utf8");
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const buf = await fs.readFile(this.resolvePath(path));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async writeFile(path: string, content: string): Promise<void> {
    // No pre-write mkdir: the PolicySandbox wrapper owns write-with-
    // parent-creation (attempt write, mkdir parent + retry once on
    // rejection) — see spec decision 3.
    await fs.writeFile(this.resolvePath(path), content, "utf8");
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    await fs.writeFile(this.resolvePath(path), data);
  }

  async readdir(path: string): Promise<string[]> {
    return fs.readdir(this.resolvePath(path));
  }

  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    const s = await fs.stat(this.resolvePath(path));
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
  }

  async mkdir(path: string): Promise<void> {
    await fs.mkdir(this.resolvePath(path), { recursive: true });
  }

  async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await fs.rm(this.resolvePath(path), {
      recursive: opts?.recursive ?? false,
      force: true,
    });
  }

  async exec(command: string, opts?: ExecOpts): Promise<ExecResult> {
    return execShell(command, {
      cwd: opts?.cwd ? this.resolvePath(opts.cwd) : this.workspace,
      env: opts?.env,
      timeout: opts?.timeout,
      signal: opts?.signal,
      stdin: opts?.stdin,
      maxOutputBytes: opts?.maxOutputBytes,
    });
  }

  async snapshot(): Promise<string> {
    return `${this.id}@${Date.now()}`;
  }

  async tunnels(): Promise<Record<string, string>> {
    return {};
  }

  async destroy(): Promise<void> {
    // No-op: we don't own the host filesystem.
  }

  /**
   * Job-mode exec (spec decision 9): spawn the same child-process path as
   * sync exec, but detached from the request — execJob returns as soon as
   * the child is spawned; stdout+stderr interleave into one capped buffer
   * that pollJob reads incrementally by offset.
   */
  async execJob(command: string, opts?: ExecOpts): Promise<ExecJobHandle> {
    const execId = `job-${this.nextJobId++}`;
    const cwd = opts?.cwd ? this.resolvePath(opts.cwd) : this.workspace;
    const env = { ...process.env, ...(opts?.env ?? {}) };
    const limit = opts?.maxOutputBytes;

    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let resolveClosed!: () => void;
    const closed = new Promise<void>((res) => {
      resolveClosed = res;
    });
    const state: LocalJobState = { status: "running", output: "", child, closed };
    this.jobs.set(execId, state);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const appendOutput = (chunk: string) => {
      if (limit && state.output.length >= limit) {
        state.truncated = true;
        return;
      }
      state.output += chunk;
      if (limit && state.output.length > limit) {
        state.output = state.output.slice(0, limit);
        state.truncated = true;
      }
    };
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);

    if (opts?.stdin !== undefined) child.stdin?.write(opts.stdin);
    child.stdin?.end();

    const scheduleEviction = () => {
      const t = setTimeout(() => this.jobs.delete(execId), JOB_EVICTION_BACKSTOP_MS);
      const unrefable = t as { unref?: () => void };
      if (typeof unrefable.unref === "function") unrefable.unref();
      state.evictTimer = t;
    };

    child.on("error", () => {
      state.status = "failed";
      resolveClosed();
      scheduleEviction();
    });
    child.on("close", (code, sig) => {
      state.status = "done";
      state.exitCode = code ?? (sig ? 128 + signalToInt(sig) : 1);
      resolveClosed();
      scheduleEviction();
    });

    return { execId };
  }

  async pollJob(execId: string, offset: number): Promise<JobPoll> {
    const state = this.jobs.get(execId);
    if (!state) return { status: "failed", output: "", nextOffset: offset };

    const output = state.output.slice(offset);
    const nextOffset = state.output.length;
    const result: JobPoll = { status: state.status, output, nextOffset };
    if (state.status === "done") result.exitCode = state.exitCode;
    if (state.truncated) result.truncated = true;

    if (state.status !== "running") {
      // Evict on first poll that observes a terminal status (decision 9);
      // the eviction timer is then redundant for this job.
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
}

interface ExecShellOpts {
  cwd: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  stdin?: string;
  maxOutputBytes?: number;
}

function execShell(command: string, opts: ExecShellOpts): Promise<ExecResult> {
  return new Promise((resolveResult, rejectResult) => {
    // Merge: caller-supplied env overrides parent process env. We pass the
    // parent env through so commands like `node`, `pnpm`, etc. resolve.
    const env = { ...process.env, ...(opts.env ?? {}) };

    const child = spawn(command, {
      cwd: opts.cwd,
      env,
      shell: true,
      // Stdin needs to be 'pipe' when we have data to feed; otherwise inherit
      // would attach to the parent terminal which we don't want.
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
      // unref so a stuck timer doesn't keep the process alive in tests
      const t = timer as { unref?: () => void };
      if (typeof t.unref === "function") t.unref();
    }

    const onAbort = () => {
      child.kill("SIGKILL");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      rejectResult(err);
    });

    child.on("close", (code, sig) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const exitCode = code ?? (sig ? 128 + signalToInt(sig) : 1);
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

function signalToInt(sig: NodeJS.Signals): number {
  // Approximate POSIX signal numbers; only the common ones we'll see.
  switch (sig) {
    case "SIGHUP":
      return 1;
    case "SIGINT":
      return 2;
    case "SIGTERM":
      return 15;
    case "SIGKILL":
      return 9;
    default:
      return 1;
  }
}

// ── Provider ──────────────────────────────────────────────────────

export interface LocalSandboxCreateOpts extends SandboxCreateOpts {
  /** Workspace directory for this sandbox. Required for the local provider. */
  workspace: string;
}

export class LocalSandboxProvider implements SandboxProvider {
  readonly backend = "local";
  private sandboxes = new Map<string, LocalSandbox>();
  private nextId = 1;

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: true,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      customImage: false,
      coldStartEstimateMs: 0,
    };
  }

  async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    const workspace = opts.workspace;
    if (!workspace) {
      throw new Error(
        "LocalSandboxProvider.create: opts.workspace is required (absolute path).",
      );
    }
    const abs = isAbsolute(workspace) ? workspace : resolve(workspace);
    // Verify the workspace exists and is a directory.
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) {
      throw new Error(`LocalSandboxProvider.create: workspace is not a directory: ${abs}`);
    }
    const id = `local-${this.nextId++}`;
    const sb = new LocalSandbox(id, abs);
    this.sandboxes.set(id, sb);
    return sb;
  }

  async restore(id: string): Promise<Sandbox> {
    const sb = this.sandboxes.get(id);
    if (!sb) throw new Error(`LocalSandbox not found: ${id}`);
    return sb;
  }

  async destroy(id: string): Promise<void> {
    const sb = this.sandboxes.get(id);
    if (sb) await sb.destroy?.();
    this.sandboxes.delete(id);
  }

  async status(id: string): Promise<SandboxStatus> {
    return this.sandboxes.has(id)
      ? { id, state: "ready", startedAt: Date.now() }
      : { id, state: "released" };
  }
}
