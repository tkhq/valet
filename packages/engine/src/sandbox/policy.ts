import type {
  ExecJobHandle,
  ExecOpts,
  ExecResult,
  GatewayEndpoint,
  JobPoll,
  Sandbox,
  WorkspaceGrowth,
} from "../types.js";
import { SandboxSupersededError, SandboxUnavailableError } from "../errors.js";
import { attrTruncate, withSpan } from "../tracing.js";
import { recordSandboxExec, recordSandboxWorkspaceGrow } from "../metrics.js";
import type { SandboxAttachment } from "./attachment.js";

/** Default `CreateSessionOptions.sandboxReadyTimeoutMs` (spec decision 6). */
export const SANDBOX_READY_TIMEOUT_MS = 60_000;

/** Default `exec`/`execJob` output cap when the caller passes none (decision 3). */
const DEFAULT_MAX_OUTPUT_BYTES = 262_144;

/**
 * Transport-level failure signatures (decision 3). A rejection whose message
 * matches this degrades the attachment and triggers a background
 * re-provision; anything else (ENOENT, EISDIR, non-zero exit, ...) rethrows
 * untouched as a normal command/filesystem outcome.
 */
export const CONTAINER_DEATH_PATTERN = /No such container|is not running|Connection refused|socket hang up/i;

function isTransportError(err: unknown): boolean {
  return err instanceof Error && CONTAINER_DEATH_PATTERN.test(err.message);
}

/** posix-style dirname; used only to compute the parent for the wrapper's
 * write-then-mkdir-then-retry policy — not for real path resolution, which
 * stays provider-side (deliberate spec deviation, decision 3). */
function dirnameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx <= 0 ? "/" : path.slice(0, idx);
}

// ── In-run workspace-full recovery (workspace-fit spec, mid-run trigger) ──
// Workspace prep grows the volume when ITS git operations hit ENOSPC, but
// most fills happen during the run (`pnpm install` writes multiples of the
// clone's size). This hook closes that gap at the one choke point every
// agent command flows through: when an exec/job fails with ENOSPC-shaped
// output, confirm the workspace filesystem is actually (nearly) full via
// `df`, grow it once, and tell the agent to retry. The df confirmation is
// load-bearing: agent output can contain ENOSPC text for other reasons
// (test fixtures, other mounts), and a false grow both costs a one-way
// doubling and consumes the once-per-~6h EBS modification window.

/** ENOSPC-shaped command output. Mirrors workspace prep's pattern. */
const ENOSPC_OUTPUT_PATTERN = /no space left on device|enospc/i;

/** `df` use% at or past which the workspace counts as full. Covers block
 * exhaustion; the paired `df -Pi` read covers inode exhaustion (node_modules
 * on a small filesystem hits inodes first surprisingly often). */
const WORKSPACE_FULL_THRESHOLD_PCT = 95;

/** Minimum gap between grow attempts from THIS process. A burst of failing
 * commands is one fill event: the first attempt handles it (or is refused by
 * the provider's own cooldown); re-running df + grow per failure is noise. */
const GROW_ATTEMPT_SUPPRESS_MS = 60_000;

/** Largest NN% token in `df -P` / `df -Pi` output (0 when none parse).
 * Exported for direct unit coverage. */
export function maxDfUsePercent(dfOutput: string): number {
  let max = 0;
  for (const match of dfOutput.matchAll(/(?:^|\s)(\d{1,3})%(?:\s|$)/gm)) {
    const pct = Number(match[1]);
    if (pct > max) max = pct;
  }
  return max;
}

export interface PolicySandboxOptions {
  readyTimeoutMs?: number;
}

interface DispatchOptions {
  signal?: AbortSignal;
}

/**
 * `Sandbox`-shaped wrapper over a `SandboxAttachment` (spec decision 3).
 * Every operation: pre-dispatch abort check (exec-family only, since file
 * ops carry no signal) -> await readiness (bounded) -> dispatch tagged with
 * the current epoch -> post-completion supersession check (discard stale
 * results) -> on raw-op rejection, classify degradation and either rethrow
 * as-is (non-degrading) or report failure + rethrow as
 * `SandboxUnavailableError` (degrading).
 */
export class PolicySandbox implements Sandbox {
  private readonly attachment: SandboxAttachment;
  private readonly readyTimeoutMs: number;
  /** execJob handles that have been vended but not yet reached a terminal poll (spec decision 4). */
  private readonly pendingJobs = new Set<string>();

  constructor(attachment: SandboxAttachment, opts?: PolicySandboxOptions) {
    this.attachment = attachment;
    this.readyTimeoutMs = opts?.readyTimeoutMs ?? SANDBOX_READY_TIMEOUT_MS;
  }

  get id(): string {
    return this.attachment.sandboxId ?? "";
  }

  get resourceOverrides(): Sandbox["resourceOverrides"] {
    return this.attachment.current()?.resourceOverrides;
  }

  get adopted(): Sandbox["adopted"] {
    return this.attachment.current()?.adopted;
  }

  async readFile(path: string): Promise<string> {
    return this.dispatch((sb) => sb.readFile(path));
  }

  async readBinary(path: string): Promise<Uint8Array> {
    return this.dispatch((sb) => sb.readBinary(path));
  }

  async writeFile(path: string, content: string): Promise<void> {
    return this.dispatchWrite(path, (sb) => sb.writeFile(path, content));
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    return this.dispatchWrite(path, (sb) => sb.writeBinary(path, data));
  }

  async readdir(path: string): Promise<string[]> {
    return this.dispatch((sb) => sb.readdir(path));
  }

  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    return this.dispatch((sb) => sb.stat(path));
  }

  async mkdir(path: string): Promise<void> {
    return this.dispatch((sb) => sb.mkdir(path));
  }

  async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    return this.dispatch((sb) => sb.rm(path, opts));
  }

  async exec(command: string, opts?: ExecOpts): Promise<ExecResult> {
    if (opts?.signal?.aborted) throw this.abortError(opts.signal);
    const effectiveOpts: ExecOpts = { ...opts, maxOutputBytes: opts?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES };
    // Traced (distributed tracing): sandbox execs are the dominant tool-time
    // sink; each becomes one span (child of the running tool span). The span
    // covers ensureReady too, so a cold-attachment wait shows up here — with
    // the concurrent sandbox.provision span explaining it.
    return withSpan(
      "sandbox.exec",
      {
        "valet.sandbox.command": attrTruncate(command),
        ...(opts?.cwd !== undefined ? { "valet.sandbox.cwd": opts.cwd } : {}),
        ...(opts?.timeout !== undefined ? { "valet.sandbox.timeout_ms": opts.timeout } : {}),
      },
      async (span) => {
        const startedAt = Date.now();
        const result = await this.dispatch((sb) => sb.exec(command, effectiveOpts), {
          signal: opts?.signal,
        });
        recordSandboxExec(Date.now() - startedAt, false);
        span.setAttributes({
          "valet.sandbox.id": this.id,
          "valet.sandbox.exit_code": result.exitCode,
          "valet.sandbox.stdout_chars": result.stdout.length,
          "valet.sandbox.stderr_chars": result.stderr.length,
        });
        if (result.truncated) span.setAttribute("valet.sandbox.output_truncated", true);
        if (result.timedOut) span.setAttribute("valet.sandbox.timed_out", true);
        if (!result.timedOut && result.exitCode !== 0) {
          const note = await this.maybeGrowAfterEnospc(`${result.stderr}\n${result.stdout}`);
          if (note) {
            span.setAttribute("valet.sandbox.workspace_grow_note", true);
            return { ...result, stderr: [result.stderr.trimEnd(), note].filter(Boolean).join("\n") };
          }
        }
        return result;
      },
    );
  }

  async snapshot(): Promise<string> {
    return this.dispatch((sb) => {
      if (!sb.snapshot) throw new Error("sandbox does not support snapshot");
      return sb.snapshot();
    });
  }

  async tunnels(): Promise<Record<string, string>> {
    return this.dispatch(async (sb) => (sb.tunnels ? sb.tunnels() : {}));
  }

  async destroy(): Promise<void> {
    await this.attachment.destroy();
  }

  async execJob(command: string, opts?: ExecOpts): Promise<ExecJobHandle> {
    if (opts?.signal?.aborted) throw this.abortError(opts.signal);
    const effectiveOpts: ExecOpts = { ...opts, maxOutputBytes: opts?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES };
    // Job-mode kickoff only — the job's own runtime is polled, not awaited,
    // so this span measures dispatch latency, not the command's duration.
    return withSpan(
      "sandbox.exec_job",
      {
        "valet.sandbox.command": attrTruncate(command),
        ...(opts?.cwd !== undefined ? { "valet.sandbox.cwd": opts.cwd } : {}),
        ...(opts?.timeout !== undefined ? { "valet.sandbox.timeout_ms": opts.timeout } : {}),
      },
      async () => {
        const startedAt = Date.now();
        const handle = await this.dispatch((sb) => {
          if (!sb.execJob) throw jobUnsupportedError();
          return sb.execJob(command, effectiveOpts);
        }, { signal: opts?.signal });
        recordSandboxExec(Date.now() - startedAt, true);
        // Track as pending until a terminal poll or cancelJob clears it.
        this.pendingJobs.add(handle.execId);
        return handle;
      },
    );
  }

  async pollJob(execId: string, offset: number): Promise<JobPoll> {
    let poll: JobPoll;
    try {
      poll = await this.dispatch((sb) => {
        if (!sb.pollJob) throw jobUnsupportedError();
        return sb.pollJob(execId, offset);
      });
    } catch (err) {
      // A transport failure (SandboxUnavailableError) or epoch bump
      // (SandboxSupersededError) means the job will never reach a terminal
      // poll on this sandbox instance. Remove the entry so the pending-job
      // counter does not stall the reconcile window indefinitely.
      this.pendingJobs.delete(execId);
      throw err;
    }
    // Remove on terminal status — the job is no longer running.
    if (poll.status === "done" || poll.status === "failed") {
      this.pendingJobs.delete(execId);
    }
    // Best-effort: the terminal output slice may not contain the ENOSPC text
    // (it can land in an earlier polled slice), but a job that DIES on a full
    // disk usually says so in its last lines.
    if (poll.status === "done" && poll.exitCode !== undefined && poll.exitCode !== 0) {
      const note = await this.maybeGrowAfterEnospc(poll.output);
      if (note) return { ...poll, output: [poll.output.trimEnd(), note].filter(Boolean).join("\n") };
    }
    return poll;
  }

  async cancelJob(execId: string): Promise<void> {
    await this.dispatch((sb) => {
      if (!sb.cancelJob) throw jobUnsupportedError();
      return sb.cancelJob(execId);
    });
    // Cancellation is a terminal outcome — the job will not run further.
    this.pendingJobs.delete(execId);
  }

  /**
   * Number of exec jobs that have been vended but have not yet reached a
   * terminal poll status (`done` or `failed`) or been cancelled.
   * Used by the run-start reconcile window (spec decision 4) to gate whether
   * the sandbox is idle enough for convergence.
   */
  pendingJobCount(): number {
    return this.pendingJobs.size;
  }

  /** Forwarded so callers of the wrapped sandbox keep the raw contract:
   * absent gateway === null (never a thrown "unsupported"). */
  async gatewayEndpoint(): Promise<GatewayEndpoint | null> {
    return this.dispatch(async (sb) => (sb.gatewayEndpoint ? sb.gatewayEndpoint() : null));
  }

  /** Forwarded so the seam stays reachable through the wrapper; a backend
   * without a growable workspace reports a refusal, matching the provider
   * contract (`grown: false` + reason, never a throw). */
  async growWorkspace(): Promise<WorkspaceGrowth> {
    return this.dispatch(async (sb) =>
      sb.growWorkspace
        ? sb.growWorkspace()
        : { grown: false, reason: "this sandbox backend has no growable workspace" },
    );
  }

  // ── internals ──────────────────────────────────────────────────────

  /** Wall-clock of the last in-run grow attempt (0 = never). See
   * GROW_ATTEMPT_SUPPRESS_MS. */
  private lastGrowAttemptAt = 0;

  /**
   * In-run workspace-full recovery (see the module-level block above the
   * constants): called after a FAILED exec/terminal job poll with the
   * command's combined output. Returns an agent-facing note to append to the
   * result's stderr/output when the workspace was confirmed full — naming
   * what happened and what to do — or null when this failure is not a
   * workspace-full event (no ENOSPC text, df below threshold, suppressed,
   * or the sandbox has no grow seam). Never throws: a broken grow must not
   * turn a completed command result into an error.
   */
  private async maybeGrowAfterEnospc(outputText: string): Promise<string | null> {
    if (!ENOSPC_OUTPUT_PATTERN.test(outputText)) return null;
    const nowMs = Date.now();
    if (nowMs - this.lastGrowAttemptAt < GROW_ATTEMPT_SUPPRESS_MS) return null;
    this.lastGrowAttemptAt = nowMs;
    try {
      return await this.dispatch(async (sb) => {
        if (!sb.growWorkspace) return null;
        // Confirm the WORKSPACE filesystem is the full one. Default cwd is
        // the workspace root on every backend; -P for blocks, -Pi for
        // inodes (node_modules exhausts inodes on small filesystems).
        const df = await sb.exec("df -P . && df -Pi .");
        if (df.exitCode !== 0 || maxDfUsePercent(df.stdout) < WORKSPACE_FULL_THRESHOLD_PCT) return null;
        let growth: WorkspaceGrowth;
        try {
          growth = await sb.growWorkspace();
        } catch (err) {
          recordSandboxWorkspaceGrow("error");
          console.error(`sandbox ${this.id}: in-run workspace grow failed:`, err);
          return null;
        }
        recordSandboxWorkspaceGrow(growth.grown ? "grown" : growth.pending ? "pending" : "refused");
        if (growth.grown) {
          return `[valet] The workspace volume was full and has been grown (${growth.from} → ${growth.to}). Retry the command.`;
        }
        if (growth.pending) {
          return "[valet] The workspace volume is full; a resize was requested and should finish shortly. Retry the command in about a minute.";
        }
        return `[valet] The workspace volume is full and was not grown: ${growth.reason} Free disk space in the workspace (for example, remove build artifacts) before retrying.`;
      });
    } catch (err) {
      // ensureReady/dispatch-level failure (sandbox died mid-check) — the
      // original command result must still flow back untouched.
      console.error(`sandbox ${this.id}: in-run workspace-full check failed:`, err);
      return null;
    }
  }

  private abortError(signal: AbortSignal): Error {
    const reason = signal.reason;
    return reason instanceof Error ? reason : new Error("aborted");
  }

  /** Write-with-parent-creation (decision 3): attempt the raw write; on
   * rejection, mkdir the parent recursively and retry ONCE. The retry
   * happens inside the dispatched op so a single ensureReady/epoch capture
   * covers both attempts. */
  private dispatchWrite(path: string, op: (sandbox: Sandbox) => Promise<void>): Promise<void> {
    return this.dispatch(async (sandbox) => {
      try {
        await op(sandbox);
      } catch {
        await sandbox.mkdir(dirnameOf(path));
        await op(sandbox);
      }
    });
  }

  private async dispatch<T>(op: (sandbox: Sandbox) => Promise<T>, opts?: DispatchOptions): Promise<T> {
    if (opts?.signal?.aborted) throw this.abortError(opts.signal);

    const { sandbox, epoch } = await this.attachment.ensureReady({
      timeoutMs: this.readyTimeoutMs,
      signal: opts?.signal,
    });
    let result: T;
    try {
      result = await op(sandbox);
    } catch (err) {
      if (isTransportError(err)) {
        this.attachment.reportFailure(epoch, err);
        throw new SandboxUnavailableError(err);
      }
      throw err;
    }

    if (this.attachment.isSuperseded(epoch)) {
      throw new SandboxSupersededError(epoch);
    }
    return result;
  }
}

function jobUnsupportedError(): Error {
  return new Error("[job_unsupported] this sandbox does not support job-mode exec");
}

// Compile-time guard (shape-drift trap): PolicySandbox must forward EVERY
// Sandbox member, optional ones included. A wrapper that silently lacks a
// newly added optional method turns that feature into a no-op for every
// consumer of the wrapped sandbox, and every existing test still passes.
// Optional data can retain undefined; optional methods must be callable.
// `implements Sandbox` also checks the forwarded members' value types.
type SandboxMethodKeys = {
  [K in keyof Sandbox]-?: NonNullable<Sandbox[K]> extends (...args: never[]) => unknown ? K : never;
}[keyof Sandbox];
type PolicyForwardsAllSandboxMethods = PolicySandbox extends Required<Pick<Sandbox, SandboxMethodKeys>>
  ? Exclude<keyof Sandbox, keyof PolicySandbox> extends never ? true : never
  : never;
const policyForwardsAllSandboxMethods: PolicyForwardsAllSandboxMethods = true;
void policyForwardsAllSandboxMethods;
