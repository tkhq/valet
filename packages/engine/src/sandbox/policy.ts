import type {
  ExecJobHandle,
  ExecOpts,
  ExecResult,
  JobPoll,
  Sandbox,
} from "../types.js";
import { SandboxSupersededError, SandboxUnavailableError } from "../errors.js";
import { attrTruncate, withSpan } from "../tracing.js";
import { recordSandboxExec } from "../metrics.js";
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

  constructor(attachment: SandboxAttachment, opts?: PolicySandboxOptions) {
    this.attachment = attachment;
    this.readyTimeoutMs = opts?.readyTimeoutMs ?? SANDBOX_READY_TIMEOUT_MS;
  }

  get id(): string {
    return this.attachment.sandboxId ?? "";
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
        return handle;
      },
    );
  }

  async pollJob(execId: string, offset: number): Promise<JobPoll> {
    return this.dispatch((sb) => {
      if (!sb.pollJob) throw jobUnsupportedError();
      return sb.pollJob(execId, offset);
    });
  }

  async cancelJob(execId: string): Promise<void> {
    return this.dispatch((sb) => {
      if (!sb.cancelJob) throw jobUnsupportedError();
      return sb.cancelJob(execId);
    });
  }

  // ── internals ──────────────────────────────────────────────────────

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
