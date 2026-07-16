/**
 * Job-mode exec over `pods/exec` (decision 5 / decision 9's execJob
 * contract). Each `pods/exec` call is a one-shot WebSocket session — unlike
 * sandbox-docker, which keeps a live `ChildProcess` around in a `Map` and
 * slices its accumulated in-memory buffer on each `pollJob` (see
 * `packages/sandbox-docker/src/sandbox.ts`'s `DockerJobState`), there is no
 * persistent Node-side handle to poll here: the command has to keep running
 * *inside the pod* across exec calls, so its state has to live there too.
 *
 * Protocol: `execJob` starts a detached process inside the pod (via
 * `setsid`, so it gets its own process group — the thing `cancelJob` later
 * signals as a unit) that writes combined stdout+stderr to
 * `/tmp/valet-jobs/{execId}.out` and, on completion, its exit code to
 * `/tmp/valet-jobs/{execId}.exit`. `pollJob` re-execs into the pod each call
 * to `tail -c` the `.out` file from a byte offset and check for `.exit`.
 * `cancelJob` sends `SIGKILL` to the negative (process-group) pid recorded
 * in `/tmp/valet-jobs/{execId}.pid`.
 *
 * Per the brief: the *shape* of "write output/exit to files, poll by
 * offset" is shared conceptually with the docker provider, but the actual
 * offset arithmetic is NOT byte-identical, so it is duplicated here rather
 * than factored into a shared helper. Docker's `pollJob` slices a full
 * in-memory string (`state.output.slice(offset)`, `nextOffset =
 * state.output.length`) it already holds in its entirety. This module never
 * holds the full output — each poll fetches only the *new* bytes via
 * `tail -c +N` and advances the offset by what actually came back
 * (`offset + byteLength(chunk)`), because re-fetching (and re-transferring
 * over the exec websocket) the whole file every poll would make long-running
 * jobs with verbose output increasingly expensive per poll. Different
 * algorithm, not just a different transport — hence the duplication instead
 * of extraction.
 */
import type { ExecJobHandle, ExecOpts, JobPoll } from "@valet/engine";
import { buildShellCommand, execInPod, JOBS_DIR, shQuote, type ExecDeps } from "./exec.js";

function jobOutPath(execId: string): string {
  return `${JOBS_DIR}/${execId}.out`;
}
function jobExitPath(execId: string): string {
  return `${JOBS_DIR}/${execId}.exit`;
}
function jobPidPath(execId: string): string {
  return `${JOBS_DIR}/${execId}.pid`;
}

/**
 * Builds the kickoff script. Structure (see module docblock for why the
 * grouping matters):
 *
 *   mkdir -p JOBS_DIR && : > OUT &&
 *   ( setsid sh -c 'echo $$ > PID; exec sh -c '"<inner, quoted>"'' \
 *       > OUT 2>&1 < /dev/null
 *     echo $? > EXIT
 *   ) &
 *   echo started
 *
 * `: > OUT` creates the (empty) output file synchronously, before this
 * kickoff command's own exec call returns — so by the time `execJob`
 * resolves, `pollJob` can already distinguish "job exists, no output yet"
 * from "unknown execId" by the `.out` file's mere presence.
 *
 * The parenthesized `( ... )` group — not the brief's literal `cmd1; cmd2 &`
 * — is what actually gets backgrounded as a unit: POSIX `&` only backgrounds
 * the list segment immediately before it, so without explicit grouping only
 * the trailing `echo $? > EXIT` would run detached while the (potentially
 * long-running) job itself ran synchronously in the foreground, defeating
 * "detached". `setsid` gives the inner `sh -c` its own session/process
 * group (pgid == its own pid, recorded via `echo $$` *before* the `exec`
 * replaces that shell with the real command, so the pid is stable across
 * the `exec`) — `cancelJob` kills `-pid` (the whole group) rather than a
 * single process, catching any children the job's own command spawns.
 */
export function jobKickoffCommand(execId: string, innerCommand: string): string {
  const outFile = jobOutPath(execId);
  const exitFile = jobExitPath(execId);
  const pidFile = jobPidPath(execId);

  const pidAndExec = `echo $$ > ${shQuote(pidFile)}; exec sh -c ${shQuote(innerCommand)}`;
  const wrapped =
    `setsid sh -c ${shQuote(pidAndExec)} > ${shQuote(outFile)} 2>&1 < /dev/null; ` + `echo $? > ${shQuote(exitFile)}`;

  return (
    `mkdir -p ${shQuote(JOBS_DIR)} && : > ${shQuote(outFile)} && ` + `( ${wrapped} ) & ` + `echo started`
  );
}

/**
 * Reads new output since `offset` (1-indexed for `tail -c +N`, so the
 * caller's 0-indexed byte offset needs `+1`) and, separately, whether the
 * job has finished. The two are deliberately split across *different exec
 * calls' stdio channels* — this poll script's own stdout carries the job's
 * output bytes verbatim (which could be arbitrary binary/text and must not
 * be intermixed with status text), while its own stderr carries a small,
 * unambiguous status marker (`"running"` or the exit code integer). This
 * works cleanly because the poll script's stdio is entirely separate from
 * the job's own captured `.out` file content — it's a fresh exec, not the
 * job process itself.
 */
export function pollCommand(execId: string, offset: number): string {
  const outFile = jobOutPath(execId);
  const exitFile = jobExitPath(execId);
  const tailFrom = offset + 1;
  return (
    // Absent .out file means this execId was never started here (or the
    // pod lost /tmp — recreated out from under a tracked job) — a distinct
    // "unknown" stderr marker so pollJobInPod can report the engine's
    // Map-miss-equivalent "failed" shape instead of misreading it as
    // "running" or trying to parse an empty exit code.
    `if [ ! -f ${shQuote(outFile)} ]; then echo unknown 1>&2; exit 0; fi; ` +
    `tail -c +${tailFrom} ${shQuote(outFile)}; ` +
    `if [ -f ${shQuote(exitFile)} ]; then cat ${shQuote(exitFile)} 1>&2; else echo running 1>&2; fi`
  );
}

/** Best-effort hard kill of the job's process group, followed by a short
 * poll for the `.exit` file to appear — so a `pollJob` immediately after
 * `cancelJob` reliably observes a terminal state instead of racing the
 * kickoff subshell's own post-kill `echo $? > EXIT` (see jobKickoffCommand's
 * docblock: that write happens in a *different* process than the one we
 * just killed, so it isn't instantaneous). */
export function cancelCommand(execId: string): string {
  const pidFile = jobPidPath(execId);
  const exitFile = jobExitPath(execId);
  return (
    `if [ -f ${shQuote(pidFile)} ]; then ` +
    `pid=$(cat ${shQuote(pidFile)}); ` +
    `kill -KILL -- -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; ` +
    `fi; ` +
    `for i in 1 2 3 4 5 6 7 8 9 10; do ` +
    `[ -f ${shQuote(exitFile)} ] && break; ` +
    `sleep 0.3; ` +
    `done`
  );
}

export async function execJobInPod(
  deps: ExecDeps,
  podName: string,
  execId: string,
  command: string,
  opts?: ExecOpts,
): Promise<ExecJobHandle> {
  const inner = buildShellCommand(command, opts);
  const kickoff = jobKickoffCommand(execId, inner);
  const result = await execInPod(deps, podName, kickoff);
  if (result.exitCode !== 0) {
    throw new Error(`execJob kickoff failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
  return { execId };
}

/** Pure parse of `pollCommand`'s stderr status marker. Exported for unit
 * testing without a cluster. */
export function parseJobStatus(statusText: string): { status: "running" | "done" | "failed"; exitCode?: number } {
  const trimmed = statusText.trim();
  if (trimmed === "unknown") return { status: "failed" };
  if (trimmed === "running") return { status: "running" };
  const exitCode = Number(trimmed);
  if (!Number.isFinite(exitCode)) {
    throw new Error(`pollJob: unexpected status marker ${JSON.stringify(statusText)}`);
  }
  return { status: "done", exitCode };
}

export async function pollJobInPod(deps: ExecDeps, podName: string, execId: string, offset: number): Promise<JobPoll> {
  const result = await execInPod(deps, podName, pollCommand(execId, offset));
  const { status, exitCode } = parseJobStatus(result.stderr);
  if (status === "failed") {
    return { status, output: "", nextOffset: offset };
  }
  const nextOffset = offset + Buffer.byteLength(result.stdout, "utf8");
  return { status, exitCode, output: result.stdout, nextOffset };
}

export async function cancelJobInPod(deps: ExecDeps, podName: string, execId: string): Promise<void> {
  await execInPod(deps, podName, cancelCommand(execId));
}
