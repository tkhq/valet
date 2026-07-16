/**
 * Exec engine over `pods/exec` (decision 5's exec/file-ops/job-mode bullet).
 *
 * Talks to `@kubernetes/client-node`'s `Exec` class, which is WebSocket-based
 * (`GET .../pods/{pod}/exec` upgraded to the Kubernetes exec sub-protocol —
 * separate stdout/stderr/stdin/status channels multiplexed over one socket).
 * Unlike `docker exec` (a CLI subprocess with a plain exit code on `close`),
 * the k8s exec protocol reports the command's exit status out-of-band via a
 * `V1Status` delivered on a dedicated "status" channel — success is
 * `status: "Success"`, a non-zero exit is `status: "Failure"`,
 * `reason: "NonZeroExitCode"`, with the actual code in
 * `details.causes[].reason === "ExitCode"`. `exitCodeFromStatus` is the pure
 * translation of that shape into the plain integer the engine's `ExecResult`
 * contract expects (mirrors `packages/sandbox-docker/src/sandbox.ts`'s
 * close-code handling, just sourced from a different transport).
 *
 * `execInPod` is generic over `podName` — callers (files.ts, jobs.ts, and
 * the eventual Task 5 `Sandbox` implementation) re-resolve the pod name per
 * call via `lifecycle.ts`'s `resolvePodName`, since the controller can mint
 * a fresh pod object (same name, new uid) out from under a long-lived
 * exec-based provider (see lifecycle.ts's restartPolicy docblock).
 */
import { PassThrough, Readable } from "node:stream";
import type { Readable as ReadableStream, Writable as WritableStream } from "node:stream";
import type * as k8s from "@kubernetes/client-node";
import type { ExecOpts, ExecResult } from "@valet/engine";

/** Directory the job-mode protocol (jobs.ts) writes its `{execId}.{out,exit,pid}`
 * files into. Exported here (rather than jobs.ts) since exec.ts's quoting
 * helpers are what construct paths inside it. */
export const JOBS_DIR = "/tmp/valet-jobs";

// ── Shell quoting / framing (pure — unit tested without a cluster) ─────

/**
 * POSIX single-quote escaping: wraps `value` in single quotes, replacing any
 * embedded `'` with the standard `'\''` (close-quote, escaped literal quote,
 * reopen-quote) sequence. Safe to apply repeatedly for nested `sh -c '...'`
 * layers (jobs.ts's kickoff script nests two levels) — each application only
 * cares about the raw bytes of its input, never about what shell syntax they
 * happen to represent.
 */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `^[A-Za-z_][A-Za-z0-9_]*$` — POSIX shell env-var name grammar. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Builds the final `sh -c` payload for a command, folding in `opts.env` and
 * `opts.cwd`. The k8s exec API has no native env/workdir parameters (unlike
 * `docker exec --env`/`--workdir`) — both are synthesized as shell prefixes
 * ahead of the caller's command, matching the sandbox-docker provider's
 * *effect* (per-request env that doesn't leak to the next exec, `cwd`
 * scoped to just this command) even though the docker provider gets there
 * via CLI flags instead of shell syntax.
 */
export function buildShellCommand(command: string, opts?: ExecOpts): string {
  const parts: string[] = [];
  if (opts?.env) {
    for (const [name, value] of Object.entries(opts.env)) {
      if (!ENV_NAME_RE.test(name)) {
        throw new Error(`buildShellCommand: invalid env var name ${JSON.stringify(name)}`);
      }
      parts.push(`export ${name}=${shQuote(value)};`);
    }
  }
  if (opts?.cwd) {
    parts.push(`cd ${shQuote(opts.cwd)} &&`);
  }
  parts.push(command);
  return parts.join(" ");
}

/** Narrow shape of the fields this module reads off `k8s.V1Status` — real
 * `V1Status` is a properly-typed core API model (unlike the CRD-schemaless
 * `CustomObjectsApi` responses lifecycle.ts has to validate), so no runtime
 * narrowing is needed beyond optional-field access. */
export interface ExecStatus {
  status?: string;
  reason?: string;
  message?: string;
  details?: {
    causes?: Array<{ reason?: string; message?: string }>;
  };
}

/**
 * Pure translation of the k8s exec status channel into a plain exit code.
 * `status: "Success"` → 0. A `Failure` with an `ExitCode` cause → that
 * code, parsed. Any other `Failure` shape (no `ExitCode` cause — e.g. the
 * command itself couldn't be started) → 1, matching Node's own convention
 * for "process didn't report a code" (see sandbox-docker's `code ?? (sig ?
 * 128 : 1)`).
 */
export function exitCodeFromStatus(status: ExecStatus): number {
  if (status.status === "Success") return 0;
  const cause = status.details?.causes?.find((c) => c.reason === "ExitCode");
  if (cause?.message !== undefined) {
    const parsed = Number(cause.message);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 1;
}

// ── Narrow client interface (real k8s.Exec adapts to this; tests fake it) ──

/** Just enough of the WebSocket client-node's `Exec.exec` resolves to for
 * this module to force-close it on timeout/abort. Real `isomorphic-ws`
 * sockets satisfy this structurally — `close(code?, reason?): void` is
 * assignable to `close(): void` (fewer required params), no cast needed. */
export interface PodExecSocket {
  close(): void;
}

/** The subset of `@kubernetes/client-node`'s `Exec` class this module
 * drives — interface-extraction so `test/exec-framing.test.ts` can fake the
 * WebSocket transport without a real cluster (same pattern as lifecycle.ts's
 * `SandboxCustomObjectsApi`/`SandboxPodsApi`). */
export interface PodExecApi {
  exec(
    namespace: string,
    podName: string,
    containerName: string,
    command: string[],
    stdout: WritableStream | null,
    stderr: WritableStream | null,
    stdin: ReadableStream | null,
    tty: boolean,
    statusCallback?: (status: ExecStatus) => void,
  ): Promise<PodExecSocket>;
}

/** Wraps a real `k8s.Exec` instance. No casts: `k8s.Exec.exec`'s real
 * signature already matches `PodExecApi.exec` structurally (its `V1Status`
 * callback param is a supertype of our `ExecStatus`, and its `WebSocket`
 * return type is a supertype of `PodExecSocket`). */
export function podExecApiAdapter(exec: k8s.Exec): PodExecApi {
  return {
    exec: (namespace, podName, containerName, command, stdout, stderr, stdin, tty, statusCallback) =>
      exec.exec(namespace, podName, containerName, command, stdout, stderr, stdin, tty, statusCallback),
  };
}

export interface ExecDeps {
  api: PodExecApi;
  namespace: string;
  /** Name of the container within the pod to exec into — always
   * `SANDBOX_CONTAINER_NAME` (manifest.ts) for sandboxes this package
   * provisions itself, but left as a parameter so tests / future callers
   * aren't hard-wired to that constant. */
  containerName: string;
}

/** Caps how long a forcibly-closed (timeout/abort) socket capture is given
 * to flush already-buffered chunks before we give up and return what we
 * have. Generous relative to expected chunk sizes; only matters on a slow
 * transport. */
const FLUSH_GRACE_MS = 50;

/**
 * Executes `command` inside `podName`'s `deps.containerName` container via
 * `pods/exec`, capturing stdout/stderr separately and translating the
 * status-channel exit report into `ExecResult.exitCode`.
 *
 * Timeout/abort: the k8s exec transport gives us no way to signal the
 * *remote* process to die (no `SIGKILL`-a-PID primitive over this API) —
 * closing the WebSocket only tears down our end of the multiplexed
 * connection. This mirrors what closing a `docker exec -i` stream does to a
 * background-orphaned remote process: the command may keep running
 * server-side after we stop watching it. Job-mode (jobs.ts) is the
 * long-running-command path that actually manages remote process lifetime
 * (via `setsid` + process-group `kill`); a sync `exec()` timeout is a
 * best-effort "stop waiting", not a guaranteed remote kill — same posture
 * sandbox-docker's own `signal`-abort case documents ("best-effort abort").
 */
export async function execInPod(
  deps: ExecDeps,
  podName: string,
  command: string,
  opts?: ExecOpts,
): Promise<ExecResult> {
  const shellCommand = buildShellCommand(command, opts);

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutLen = 0;
  let stderrLen = 0;
  let truncated = false;
  const limit = opts?.maxOutputBytes;

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (chunk: Buffer) => {
    if (limit !== undefined && stdoutLen >= limit) {
      truncated = true;
      return;
    }
    const remaining = limit !== undefined ? limit - stdoutLen : chunk.length;
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    stdoutChunks.push(slice);
    stdoutLen += slice.length;
    if (limit !== undefined && stdoutLen >= limit) truncated = true;
  });
  stderr.on("data", (chunk: Buffer) => {
    if (limit !== undefined && stderrLen >= limit) return;
    const remaining = limit !== undefined ? limit - stderrLen : chunk.length;
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    stderrChunks.push(slice);
    stderrLen += slice.length;
  });

  const stdin = opts?.stdin !== undefined ? Readable.from(Buffer.from(opts.stdin, "utf8")) : null;

  let resolveStatus!: (status: ExecStatus) => void;
  const statusPromise = new Promise<ExecStatus>((resolve) => {
    resolveStatus = resolve;
  });

  const socket = await deps.api.exec(
    deps.namespace,
    podName,
    deps.containerName,
    ["/bin/sh", "-c", shellCommand],
    stdout,
    stderr,
    stdin,
    false,
    (status) => resolveStatus(status),
  );

  const raced: Array<Promise<{ kind: "status"; status: ExecStatus } | { kind: "timeout" } | { kind: "abort" }>> = [
    statusPromise.then((status) => ({ kind: "status" as const, status })),
  ];

  let timer: NodeJS.Timeout | undefined;
  if (opts?.timeout !== undefined && opts.timeout > 0) {
    raced.push(
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), opts.timeout);
      }),
    );
  }

  let abortResolve: (() => void) | undefined;
  const signal = opts?.signal;
  if (signal) {
    raced.push(
      new Promise((resolve) => {
        abortResolve = () => resolve({ kind: "abort" });
        if (signal.aborted) abortResolve();
        else signal.addEventListener("abort", abortResolve, { once: true });
      }),
    );
  }

  const winner = await Promise.race(raced);
  if (timer) clearTimeout(timer);
  if (signal && abortResolve) signal.removeEventListener("abort", abortResolve);

  if (winner.kind !== "status") {
    try {
      socket.close();
    } catch {
      // best-effort
    }
    // Give already-in-flight frames a brief moment to land in our buffers
    // before we read them out below.
    await new Promise((resolve) => setTimeout(resolve, FLUSH_GRACE_MS));
  }

  const exitCode = winner.kind === "status" ? exitCodeFromStatus(winner.status) : 124;

  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    exitCode,
    timedOut: winner.kind === "timeout" ? true : undefined,
    truncated: truncated ? true : undefined,
  };
}
