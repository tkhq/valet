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
 * `tail -c +N` and advances the offset by what actually came back. Different
 * algorithm, not just a different transport — hence the duplication instead
 * of extraction.
 *
 * Byte fidelity across poll boundaries: `pollCommand` pipes its `tail -c +N`
 * output through `base64 -w0` (same device as files.ts's `readBinaryCommand`
 * — see that module's docblock for the GNU/BusyBox `-w0` portability note)
 * instead of shipping raw bytes over the exec stdout channel. This matters
 * because `execInPod` decodes that channel as UTF-8 into a JS `string`
 * (`Buffer.concat(stdoutChunks).toString("utf8")`) — if a byte-range fetch
 * happened to split a multi-byte UTF-8 codepoint (e.g. a 4-byte emoji cut
 * after 2 bytes), that per-call decode would mangle the trailing partial
 * bytes into U+FFFD *and* `Buffer.byteLength` of the mangled string would no
 * longer equal the raw bytes actually consumed from the file — silently
 * dropping/misaligning a byte on every such boundary, permanently, since
 * this module has no persistent per-execId decoder state to carry it
 * forward (unlike docker's `child.stdout.setEncoding("utf8")`, whose
 * `Readable` holds a stateful `StringDecoder` across the whole child
 * process's lifetime — see `pollJobInPod`'s docblock for how this module
 * gets the equivalent effect statelessly). Base64 sidesteps the problem
 * entirely: the wire-transferred text is pure ASCII, so `execInPod`'s own
 * UTF-8 decode can never corrupt it, and `pollJobInPod` decodes the
 * `base64`-recovered raw bytes back to UTF-8 itself, in raw-byte offset
 * space, with the actual holdback logic described below.
 *
 * `maxOutputBytes` (decision 9's cap, matching `sandbox-docker`'s
 * `DockerJobState.output` growth cap — see that module's `execJob`): capped
 * here at the KICKOFF, not the poll. `jobKickoffCommand`, when given a
 * limit, pipes the job's combined stdout+stderr through `head -c LIMIT`
 * before it ever reaches `.out`, so the file itself never grows past the
 * cap — this is what actually bounds `.out` on the pod's (small, ephemeral)
 * filesystem, and it transitively bounds every `pollCommand`'s `tail -c`
 * fetch too (it can never read more than LIMIT bytes total across the
 * job's lifetime, since the file never holds more than that). A plain
 * `head -c LIMIT > OUT` would SIGPIPE-kill the job's process the moment it
 * writes past the cap (the reader side of its stdout pipe would vanish
 * once `head` exits) — instead the capping filter is `head -c LIMIT > OUT;
 * cat > /dev/null`, so once `head` has captured the first LIMIT bytes, the
 * trailing `cat` keeps draining (and discarding) the rest of the pipe for
 * the job's full natural lifetime. That matches docker's own posture:
 * capping stops accumulation, it does not kill the process early.
 *
 * The exit-code capture has to move as a result: a POSIX-sh pipeline's own
 * exit status is the LAST command's (the capping filter's `cat`), not the
 * job's. Rather than a plain shell pipeline, the capped branch connects the
 * job to the capping filter through a named pipe (`mkfifo`): the filter
 * reads from the fifo as an ordinary background job in the OUTER script's
 * process group, while the job itself (under `setsid`, in its OWN process
 * group) writes to the fifo. That keeps the capping filter OUTSIDE the
 * process group `cancelJob` kills, and — critically — keeps `setsid`'s own
 * parent process (which isn't part of the killed group either; see
 * `jobKickoffCommand`'s docblock) free to run `; echo $? > EXIT` right after
 * `setsid` returns, exactly like the uncapped branch. This is what makes
 * `EXIT` appear promptly on `cancelJob` for capped jobs too — piping the
 * job directly into the filter (the pre-fix shape) put that write inside
 * the killed group, so cancelling a capped job used to spin `cancelJob`'s
 * full poll-for-EXIT budget every time (the write never happened until the
 * whole group death was somehow otherwise observed, which for SIGKILL never
 * comes). See `jobKickoffCommand`'s capped branch for the fifo wiring.
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
function jobFifoPath(execId: string): string {
  return `${JOBS_DIR}/${execId}.fifo`;
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
 *   i=0; while [ ! -f PID ] && [ ! -f EXIT ] && [ "$i" -lt 500 ]; do
 *     sleep 0.01; i=$((i+1))
 *   done
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
 *
 * The `while [ ! -f PID ] ...` loop closes the cancelJob-before-pidfile
 * race: `echo $$ > PID` happens inside the backgrounded subshell, so
 * without this wait, this kickoff command's own `echo started` (and thus
 * `execJobInPod`'s resolved promise) could return to the caller *before*
 * the pid file exists. A caller that calls `cancelJob` immediately after
 * `execJob` resolves would then find no `.pid` file, silently no-op, and
 * leak the running job. The loop makes `execJobInPod`'s single exec call
 * block (bounded: 500 * 10ms = 5s) until the pid file is actually there —
 * so by the time `execJob` returns, `cancelJob` is guaranteed to work
 * immediately, with zero extra delay needed by the caller. It also bails
 * out early if `EXIT` appears first (the subshell's own trailing
 * `echo $? > EXIT` still runs even when e.g. `setsid` itself failed to
 * exec, which would otherwise never write `PID` and hang this loop for the
 * full 5s on every such failure).
 *
 * `maxOutputBytes`, when provided, switches to the capped branch (see the
 * module docblock's "maxOutputBytes" section): the job's stdout+stderr are
 * connected to `head -c LIMIT > OUT; cat > /dev/null` through a `mkfifo`
 * named pipe rather than a plain shell pipeline, specifically so the
 * capping filter lands OUTSIDE `setsid`'s process group. That preserves the
 * uncapped branch's `exec`-tail-call shape for the job itself (`echo $$ >
 * PID; exec sh -c innerCommand`) and lets both branches share the identical
 * `setsid ...; echo $? > EXIT` outer sequencing — the exit code always comes
 * from `setsid`'s own wait() status (the job's real exit code on normal
 * completion, or its signal-death status if `cancelJob` kills the group),
 * written by a process `cancelJob`'s group-kill never touches, so `EXIT`
 * appears promptly on cancel in both branches. `wait "$filterpid"` after the
 * `EXIT` write just ensures `OUT` is fully flushed before this whole
 * kickoff script exits — it runs after `EXIT` is already visible, so it
 * doesn't reintroduce cancel latency.
 */
export function jobKickoffCommand(execId: string, innerCommand: string, maxOutputBytes?: number): string {
  const outFile = jobOutPath(execId);
  const exitFile = jobExitPath(execId);
  const pidFile = jobPidPath(execId);

  const waitForPid =
    `i=0; while [ ! -f ${shQuote(pidFile)} ] && [ ! -f ${shQuote(exitFile)} ] && [ "$i" -lt 500 ]; do ` +
    `sleep 0.01; i=$((i+1)); done`;

  // Common to both branches: record the pid (== pgid, thanks to setsid,
  // recorded before `exec` replaces this shell so it survives the exec)
  // and then exec straight into the job so `setsid`'s own wait() reflects
  // the job's real exit status (or its signal-death status if cancelJob
  // kills the group) — see this function's docblock for why that outer
  // `setsid ...; echo $? > EXIT` sequencing (not a write from *inside* the
  // killed group) is what makes EXIT appear promptly on cancel in BOTH
  // branches.
  const pidAndExec = `echo $$ > ${shQuote(pidFile)}; exec sh -c ${shQuote(innerCommand)}`;
  const innerSetsid = `setsid sh -c ${shQuote(pidAndExec)} < /dev/null`;

  let wrapped: string;
  if (maxOutputBytes === undefined) {
    wrapped = `${innerSetsid} > ${shQuote(outFile)} 2>&1; echo $? > ${shQuote(exitFile)}`;
  } else {
    const limit = Math.max(0, Math.floor(maxOutputBytes));
    const fifo = jobFifoPath(execId);
    const cappingFilter = `head -c ${limit} > ${shQuote(outFile)}; cat > /dev/null`;
    // The capping filter has to run as a SEPARATE process from the job
    // (see module docblock's "maxOutputBytes" section for why a plain
    // `head -c LIMIT` alone would SIGPIPE-kill the job early) — but piping
    // the job's stdout directly into it (the pre-fix shape) put the exit-
    // code capture *inside* the setsid'd group, which cancelJob's group
    // kill blows away before it can run (DEFECT 2). A FIFO decouples the
    // two: the capping filter reads from `fifo` as an ordinary background
    // job in the OUTER script's process group (not part of the killed
    // group), while the job itself writes to `fifo` from inside the
    // killed group. `wait $filterpid` after the EXIT write (not before —
    // ordering matters) just makes sure OUT is fully flushed before this
    // whole kickoff script exits; it doesn't delay EXIT's visibility to a
    // concurrent pollJob/cancelJob.
    // `mkfifo` MUST be its own fully-synchronous statement, terminated by
    // `;` — NOT chained with `&&` into the same list as the backgrounded
    // reader below. `A && B & C` backgrounds the WHOLE `A && B` list (POSIX
    // `&`/`;` are both list separators with `&&`/`||` binding tighter), so
    // `mkfifo fifo && ( cappingFilter ) < fifo &` would background the
    // `mkfifo` call itself alongside the reader, racing it against
    // `innerSetsid`'s `> fifo` open below: if that redirect's `open(2)`
    // wins the race, it creates `fifo` as an ordinary O_CREAT file (redirect
    // opens don't care about existing file type), and the not-yet-run
    // backgrounded `mkfifo` then fails ("File exists") against that plain
    // file — silently breaking the whole fifo handshake (reader and writer
    // each get their own independent view of a regular file instead of a
    // shared pipe). Sequencing `mkfifo` synchronously before anything
    // touches the path closes that race.
    wrapped =
      `rm -f ${shQuote(fifo)}; mkfifo ${shQuote(fifo)}; ` +
      `( ${cappingFilter} ) < ${shQuote(fifo)} & filterpid=$!; ` +
      `${innerSetsid} > ${shQuote(fifo)} 2>&1; ` +
      `echo $? > ${shQuote(exitFile)}; ` +
      `wait "$filterpid"; ` +
      `rm -f ${shQuote(fifo)}`;
  }

  return (
    `mkdir -p ${shQuote(JOBS_DIR)} && : > ${shQuote(outFile)} && ` +
    `( ${wrapped} ) & ` +
    `${waitForPid}; ` +
    `echo started`
  );
}

/**
 * Reads new output since `offset` (1-indexed for `tail -c +N`, so the
 * caller's 0-indexed byte offset needs `+1`) and, separately, whether the
 * job has finished. The two are deliberately split across *different exec
 * calls' stdio channels* — this poll script's own stdout carries the job's
 * output bytes (base64-encoded, see module docblock's "byte fidelity"
 * section — the raw bytes could be arbitrary binary/text and must not be
 * intermixed with status text or mangled by `execInPod`'s own UTF-8
 * decode), while its own stderr carries a small, unambiguous status marker
 * (`"running"` or the exit code integer). This works cleanly because the
 * poll script's stdio is entirely separate from the job's own captured
 * `.out` file content — it's a fresh exec, not the job process itself.
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
    `tail -c +${tailFrom} ${shQuote(outFile)} | base64 -w0; ` +
    `if [ -f ${shQuote(exitFile)} ]; then cat ${shQuote(exitFile)} 1>&2; else echo running 1>&2; fi`
  );
}

/** Best-effort hard kill of the job's process group, followed by a short
 * poll for the `.exit` file to appear — so a `pollJob` immediately after
 * `cancelJob` reliably observes a terminal state instead of racing the
 * kickoff subshell's own post-kill `echo $? > EXIT` (see jobKickoffCommand's
 * docblock: that write happens in a *different* process than the one we
 * just killed, so it isn't instantaneous).
 *
 * The group-kill itself deliberately omits `--` before the negative pgid:
 * `kill -KILL -- -"$pid"` reads like the portable/safe form (`--` ends
 * option parsing so a pid that happens to look like a flag can't be
 * misread), but dash's `kill` builtin — the actual `/bin/sh` on the
 * Debian-slim sandbox image — rejects `--` outright ("Illegal number: -",
 * exit 2), which fell through to the `kill -KILL "$pid"` fallback and
 * killed only the setsid leader, orphaning the job's real child process
 * (verified in-container: e.g. a `sleep 30` child kept running past
 * cancelJob, until pod teardown). Dropping `--` (`kill -KILL -"$pid"`) is
 * accepted by dash's builtin, BusyBox's `kill`, AND GNU/util-linux `kill`
 * alike, and actually reaps the whole process group in all three — the
 * `-"$pid"` argument is unambiguous (a negative number, not a flag) even
 * without `--` in every shell tested. */
export function cancelCommand(execId: string): string {
  const pidFile = jobPidPath(execId);
  const exitFile = jobExitPath(execId);
  return (
    `if [ -f ${shQuote(pidFile)} ]; then ` +
    `pid=$(cat ${shQuote(pidFile)}); ` +
    `kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; ` +
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
  const kickoff = jobKickoffCommand(execId, inner, opts?.maxOutputBytes);
  // Only `privileged` is forwarded — env/cwd are already folded into
  // `inner`, and re-passing them would wrongly apply to the kickoff script
  // itself. Forwarding matters in docker-enabled sandboxes: execInPod runs
  // the whole kickoff (and thus the detached job) as the dockerd workload
  // user unless the caller asked for root.
  const result = await execInPod(deps, podName, kickoff, opts?.privileged ? { privileged: true } : undefined);
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

/**
 * Length, in bytes, of a UTF-8 sequence starting with `leadByte` — 0 for a
 * byte that can't legally start a sequence (a continuation byte or an
 * invalid 0xF8-0xFF marker). Pure; exported for unit testing.
 */
export function utf8SequenceLength(leadByte: number): number {
  if ((leadByte & 0x80) === 0x00) return 1; // 0xxxxxxx
  if ((leadByte & 0xe0) === 0xc0) return 2; // 110xxxxx
  if ((leadByte & 0xf0) === 0xe0) return 3; // 1110xxxx
  if ((leadByte & 0xf8) === 0xf0) return 4; // 11110xxx
  return 0; // continuation byte (10xxxxxx) or invalid lead byte
}

/**
 * How many trailing bytes of `buf` form an INCOMPLETE UTF-8 multi-byte
 * sequence — i.e. a lead byte whose declared sequence length extends past
 * the end of the buffer. Scans back at most 3 bytes (the longest possible
 * incomplete tail: a 4-byte sequence missing only its last byte). Returns 0
 * when the tail is plain ASCII, a complete multi-byte sequence, or bytes
 * that aren't valid UTF-8 at all — this function's only job is to avoid
 * *manufacturing* a corrupted codepoint at a poll boundary, not to detect
 * binary data in general (see `pollJobInPod`'s docblock for why that's out
 * of scope). Pure; exported for unit testing.
 */
export function incompleteUtf8TailLength(buf: Buffer): number {
  const len = buf.length;
  const maxBack = Math.min(3, len);
  for (let back = 1; back <= maxBack; back++) {
    const byte = buf[len - back];
    if ((byte & 0xc0) === 0x80) continue; // still inside a continuation run — keep scanning back
    const seqLen = utf8SequenceLength(byte);
    return seqLen > back ? back : 0;
  }
  return 0;
}

/**
 * Splits `buf` (raw bytes fetched this poll) into the prefix that's safe to
 * decode right now and the number of bytes actually delivered by that
 * decode. Holding back an incomplete trailing codepoint — instead of
 * decoding the whole buffer and letting `Buffer#toString("utf8")` silently
 * replace it with U+FFFD — is what keeps `pollJobInPod`'s `nextOffset`
 * exactly in sync with the bytes it actually handed to the caller: the next
 * poll re-fetches starting at `nextOffset`, which includes the held-back
 * tail, so a codepoint split across two polls (e.g. a 4-byte emoji fetched
 * 2+2) reassembles losslessly instead of being corrupted twice (once per
 * fragment) and silently under/over-counted in the offset. Pure; exported
 * for unit testing.
 */
export function decodeUtf8HoldingTail(buf: Buffer): { text: string; deliveredBytes: number } {
  const heldBack = incompleteUtf8TailLength(buf);
  const deliveredBytes = buf.length - heldBack;
  return { text: buf.subarray(0, deliveredBytes).toString("utf8"), deliveredBytes };
}

/**
 * `JobPoll.output` is a `string` (the engine's contract, matching docker's
 * `pollJob`) — there is no lossless representation of arbitrary binary job
 * output in that contract, on either provider. Docker's `pollJob` gets
 * *valid* multi-byte UTF-8 output right across chunk boundaries by holding
 * a stateful `StringDecoder` on `child.stdout`/`child.stderr` for the whole
 * process lifetime (`setEncoding("utf8")`), but genuinely non-UTF-8 bytes
 * still decode lossy (replaced with U+FFFD) there too. This module has no
 * persistent per-execId decoder to hold state across the stateless
 * `pollCommand` exec calls, so it gets the equivalent *valid-UTF-8* fidelity
 * a different way — `decodeUtf8HoldingTail` holds back an incomplete
 * trailing codepoint at each poll boundary and includes it in the next
 * poll's byte range instead of decoding it prematurely. This closes the gap
 * for split-but-valid UTF-8; it does NOT make arbitrary binary output
 * lossless — a job that emits genuinely non-UTF-8 bytes (not merely a
 * boundary artifact) will still see them come back as U+FFFD replacement
 * characters, same limitation as the docker provider, only reachable here
 * if the job's raw output itself isn't valid UTF-8 (a poll-boundary split of
 * *valid* UTF-8 is exactly what this function fixes and is no longer a
 * source of corruption).
 */
export async function pollJobInPod(deps: ExecDeps, podName: string, execId: string, offset: number): Promise<JobPoll> {
  const result = await execInPod(deps, podName, pollCommand(execId, offset));
  const { status, exitCode } = parseJobStatus(result.stderr);
  if (status === "failed") {
    return { status, output: "", nextOffset: offset };
  }
  const fetched = Buffer.from(result.stdout.trim(), "base64");
  const { text, deliveredBytes } = decodeUtf8HoldingTail(fetched);
  const nextOffset = offset + deliveredBytes;
  return { status, exitCode, output: text, nextOffset };
}

export async function cancelJobInPod(deps: ExecDeps, podName: string, execId: string): Promise<void> {
  await execInPod(deps, podName, cancelCommand(execId));
}
