import { DEFAULT_WATCH_MIN_INTERVAL_MS, EVENT_DELIVERED_MAX_KEYS, JOB_LOG_CAPPED_MARKER } from "@valet/engine";
import type { EventMatchDigest, LeaseReleaseCause, Wakeup, WakeupCause, WakeupLimits, WakeupPatch, WakeupStatus } from "@valet/engine";

/**
 * The outcome of one WakeWatcher probe against a due wakeup row. `poll`
 * covers `process` and `watch` when the sandbox exec succeeded;
 * `unavailable` covers a sandbox that is gone; `error` covers a probe that
 * failed for another reason and may succeed next tick; `none` is for
 * `timer` and for a `pending` process or watch, which need no exec.
 */
export type WakeupProbe =
  | {
      kind: "poll";
      status: "running" | "done" | "failed";
      exitCode?: number;
      output: string;
      nextOffset: number;
      /** The provider dropped log bytes at its cap but wrote no marker line (docker). */
      truncated?: boolean;
    }
  | { kind: "unavailable" }
  | { kind: "error" }
  | { kind: "none" };

/** A signal the watcher should submit, before it knows the thread to target. */
export interface SignalDraft {
  signalType: string;
  body: string;
  attributes: Record<string, string>;
  dispatchId: string;
}

/**
 * What `decideWakeup` wants done with a wakeup row: the status transition,
 * the store patch to apply with it, the signals to submit on success, and
 * whether a lease should be released or a process group killed.
 */
export interface WakeupDecision {
  to: WakeupStatus;
  cause?: WakeupCause;
  patch: WakeupPatch;
  signals: SignalDraft[];
  releaseLease?: LeaseReleaseCause;
  /** The watcher kills the process group after a successful CAS (spec B5, fix wave 2). */
  kill?: boolean;
  /** The row cannot be acted on as stored. The watcher counts it in `valet.wakeups.bad_rows`. */
  badRow?: true;
  /**
   * Event waiter, stream mode: the dedupe keys this decision delivers. After
   * a successful CAS and before delivery, the watcher removes them with
   * `removeEventMatches`, so a digest that arrived meanwhile stays buffered
   * (spec 2026-10-15, Part F step 3, INV-E7).
   */
  deliveredKeys?: string[];
}

/** Inputs to `decideWakeup` besides the row and the probe. */
export interface DecideOptions extends Pick<WakeupLimits, "watchMaxEventsPerHour" | "watchMinIntervalMs"> {
  /**
   * The WakeWatcher tick interval (ms). A rate window starts over only when
   * it is older than `WATCH_RATE_WINDOW_MS` plus one tick, so timer drift
   * cannot reset it one poll early (fix wave 4, data M1). Default 30 000.
   */
  tickMs?: number;
  /** `sandbox.leaseMaxHours`. The deadline text does not offer a larger deadline past it. */
  leaseMaxHours?: number;
  /**
   * The in-sandbox directory that holds job logs, for the `logPath`
   * attribute. Absent for a provider that writes no log file (docker), so
   * the attribute never names a file that does not exist.
   */
  logDir?: string;
}

/** Last N bytes the kernel keeps of a process or watch log tail. */
export const LOG_TAIL_BYTES = 4096;

/** The rolling window of the watch rate limit (spec B5). */
export const WATCH_RATE_WINDOW_MS = 3_600_000;

/** Default `DecideOptions.tickMs`: the WakeWatcher's default interval. */
export const DEFAULT_TICK_MS = 30_000;

const HOUR_MS = 3_600_000;

/**
 * How long a `pending` process or watch may stay pending before the
 * watcher probes it. The seam writes the row before the job starts, and a
 * start can include a cold sandbox provision: the kubernetes provider
 * waits up to 30 minutes for a scale-up, plus the image pull. Past this,
 * the watcher adopts a job it finds and ends the row when it finds none
 * (fix wave 3, UX M7).
 */
export const PENDING_START_GRACE_MS = 45 * 60_000;

/** Most bytes a watch buffers between emits; a fuller buffer goes out at once (fix wave 3, M1). */
export const WATCH_BUFFER_BYTES = 64 * 1024;

/** What the agent should do after each way a process can end without an exit code (fix wave 3, UX). */
const CAUSE_GUIDANCE: Partial<Record<WakeupCause, string>> = {
  pid_missing:
    "[valet: the process ended without an exit code. The container or the api restarted. Check /workspace for partial output, and tell the person before you run it again.]",
  sandbox_unavailable:
    "[valet: The sandbox stopped, so the process ended with it. Files outside /workspace are gone. Tell the person before you run it again.]",
};

/**
 * The deadline line. It names the knob of the row's kind, and it does not
 * offer a larger deadline when the deadline was already `leaseMaxHours`
 * (fix wave 4, UX N14).
 */
function deadlineGuidance(row: Wakeup, opts: DecideOptions): string {
  const hours = row.deadlineAt === undefined ? undefined : Math.round((row.deadlineAt - row.createdAt) / HOUR_MS);
  const atMax = opts.leaseMaxHours !== undefined && hours !== undefined && hours >= opts.leaseMaxHours;
  if (row.kind === "watch") {
    return atMax
      ? `[valet: the watch reached its max_hours and was stopped. ${opts.leaseMaxHours} hours is the longest allowed. Start a new watch only if you still need one.]`
      : "[valet: the watch reached its max_hours and was stopped. Start it again with a larger max_hours only if you still need it.]";
  }
  return atMax
    ? `[valet: the process reached its deadline and was stopped. ${opts.leaseMaxHours} hours is the longest allowed. Split the work into shorter steps that save progress in /workspace.]`
    : "[valet: the process reached its deadline and was stopped. Run it again with a larger deadline only if it was making progress.]";
}

const CAPPED_GUIDANCE =
  "[valet: The log hit its size cap, so this tail is not the end of the output. Write long output to a file in /workspace and read that file.]";

/**
 * The terminal body: the log tail, then a line that names the next step.
 * `capped` is true when the provider reported a cap drop with no marker
 * line (docker, fix wave 4 UX N5).
 */
function terminalBody(logTail: string, cause: WakeupCause, row: Wakeup, opts: DecideOptions, capped = false): string {
  const notes: string[] = [];
  if (capped || logTail.includes(JOB_LOG_CAPPED_MARKER)) notes.push(CAPPED_GUIDANCE);
  const guidance = cause === "deadline" ? deadlineGuidance(row, opts) : CAUSE_GUIDANCE[cause];
  if (guidance) notes.push(guidance);
  if (notes.length === 0) return logTail;
  const sep = logTail === "" || logTail.endsWith("\n") ? "" : "\n";
  return `${logTail}${sep}${notes.join("\n")}`;
}

/**
 * Postgres `text` rejects NUL, so one NUL byte in a log would fail every
 * later write of the row (fix wave 2, M4). Every stored or signalled log
 * text goes through this.
 */
function withoutNul(s: string): string {
  return s.includes("\u0000") ? s.replaceAll("\u0000", "�") : s;
}

/**
 * Returns the last `bytes` bytes of `s` (default `LOG_TAIL_BYTES`), trimmed
 * by whole characters, with NUL replaced. A cut tail starts after its first
 * newline, so a signal body never opens with a line fragment. A tail with
 * no earlier newline (one long line) keeps its last bytes.
 */
export function tail(s: string, bytes: number = LOG_TAIL_BYTES): string {
  const clean = withoutNul(s);
  if (Buffer.byteLength(clean) <= bytes) return clean;
  let result = clean.slice(-bytes);
  while (Buffer.byteLength(result) > bytes) {
    result = result.slice(1);
  }
  const firstBreak = result.indexOf("\n");
  return firstBreak >= 0 && firstBreak < result.length - 1 ? result.slice(firstBreak + 1) : result;
}

/**
 * The output a terminal body shows. A watch with unsent lines shows them,
 * plus `extra`, up to `WATCH_BUFFER_BYTES`: those lines reached no
 * `watch.event` (fix wave 4, data N2). Otherwise the last 4 KB of the log.
 */
function unsentOrTail(row: Wakeup, extra: string): string {
  const buffered = row.kind === "watch" ? (row.watchBuffer ?? "") : "";
  if (buffered !== "") return tail(`${buffered}${extra}`, WATCH_BUFFER_BYTES);
  return tail(row.logTail + extra);
}

function durationSeconds(now: number, row: Wakeup): string {
  return String(Math.round((now - row.createdAt) / 1000));
}

/** Builds the `process.exited` / `watch.exited` signal every terminal process/watch transition submits. */
function terminalSignal(
  now: number,
  row: Wakeup,
  cause: WakeupCause,
  exitCode: number | undefined,
  body: string,
  opts: DecideOptions,
): SignalDraft {
  const attributes: Record<string, string> = {
    wakeupId: row.id,
    kind: row.kind,
    reason: row.reason,
    cause,
    durationSeconds: durationSeconds(now, row),
  };
  if (opts.logDir !== undefined && row.execId !== undefined) attributes.logPath = `${opts.logDir}/${row.execId}.out`;
  if (exitCode !== undefined) attributes.exitCode = String(exitCode);
  return {
    signalType: `${row.kind}.exited`,
    body,
    attributes,
    dispatchId: `wakeup:${row.id}:terminal`,
  };
}

/**
 * Most bytes the WakeWatcher reads from a `watch` log per tick (spec B4).
 * The watcher passes it as the `pollJob` bound.
 */
export const WATCH_READ_BYTES = 64 * 1024;

/**
 * Splits new watch output into complete lines, holding back a trailing
 * partial line unless `final` (the process ended, so the partial line is
 * complete). `consumedBytes` counts in the provider's offset units:
 * `nextOffset - offset` minus what stays unconsumed, so a replacement
 * character that stands for one invalid input byte never moves the offset
 * past unread bytes (fix wave 2, L4).
 */
function splitWatchLines(
  output: string,
  readBytes: number,
  final: boolean,
  maxLines = 200,
): { lines: string[]; consumedText: string; consumedBytes: number } {
  const parts = output.split("\n");
  // The last element is the trailing partial line (no terminating "\n"), or
  // "" when output ends with "\n".
  let partial = parts.pop() ?? "";
  // A provider can hold back up to 3 bytes of a split codepoint.
  if (parts.length === 0 && Buffer.byteLength(partial) > WATCH_READ_BYTES - 4) {
    // One line fills the whole bounded read. Holding it back would stall
    // the watch forever, so the slice becomes one event.
    return { lines: [withoutNul(partial)], consumedText: partial, consumedBytes: readBytes };
  }
  if (final && partial !== "") {
    parts.push(partial);
    partial = "";
  }
  let lines = parts;
  let rest = partial;
  if (lines.length > maxLines) {
    rest = lines.slice(maxLines).join("\n") + "\n" + partial;
    lines = lines.slice(0, maxLines);
  }
  const consumedText = lines.length === 0 ? "" : lines.join("\n") + (final && rest === "" && !output.endsWith("\n") ? "" : "\n");
  const consumedBytes = Math.max(0, readBytes - Buffer.byteLength(rest));
  return { lines: lines.map(withoutNul), consumedText, consumedBytes };
}

function watchEventSignal(row: Wakeup, lines: string[], eventCount: number): SignalDraft {
  return {
    signalType: "watch.event",
    body: lines.join("\n"),
    attributes: {
      wakeupId: row.id,
      kind: row.kind,
      reason: row.reason,
      lineCount: String(lines.length),
      eventCount: String(eventCount),
    },
    dispatchId: `wakeup:${row.id}:event:${eventCount}`,
  };
}

function timerFiredSignal(now: number, row: Wakeup, prompt: string): SignalDraft {
  return {
    signalType: "timer.fired",
    body: prompt,
    attributes: {
      wakeupId: row.id,
      kind: row.kind,
      reason: row.reason,
      scheduledAt: new Date(row.fireAt ?? now).toISOString(),
      firedAt: new Date(now).toISOString(),
    },
    dispatchId: `wakeup:${row.id}:terminal`,
  };
}

/**
 * The rate window after one more poll tick with new output at `now`. The
 * window counts output ticks, not emitted signals: emits are coalesced, so
 * a signal count could never reach the limit (fix wave 3, M1). A window
 * starts over only when it is more than `WATCH_RATE_WINDOW_MS` plus one
 * tick old. A late timer makes each tick land a little after the last, so
 * a window of exactly one hour started over one poll before the 121st and
 * the limit never tripped (fix wave 4, data M1). `over` is true when the
 * count exceeds the limit. An event waiter counts each `event.matched`
 * signal once, however many digests it lists.
 */
function nextWindow(
  now: number,
  row: Wakeup,
  max: number,
  tickMs: number,
): { windowStartAt: number; windowCount: number; over: boolean } {
  const fresh = row.windowStartAt === undefined || now - row.windowStartAt > WATCH_RATE_WINDOW_MS + tickMs;
  const windowStartAt = fresh || row.windowStartAt === undefined ? now : row.windowStartAt;
  const windowCount = (fresh ? 0 : (row.windowCount ?? 0)) + 1;
  return { windowStartAt, windowCount, over: windowCount > max };
}

/**
 * Pure decision kernel for the WakeWatcher sweep (spec 2026-10-08, B5/B6).
 * Takes the current time, the due row, and a probe of the sandbox, and
 * returns the transition to apply, or `null` when nothing is due to
 * change. No I/O, no clock read: `now` is always passed in.
 */
export function decideWakeup(now: number, row: Wakeup, probe: WakeupProbe, opts: DecideOptions): WakeupDecision | null {
  if (row.kind === "timer") {
    if (row.fireAt === undefined || row.fireAt > now) return null;
    // A timer with no prompt has nothing to deliver. Ending it keeps it
    // from failing every tick unseen (fix wave 3, data L6).
    if (row.prompt === undefined) return { to: "lost", patch: { endedAt: now }, signals: [], badRow: true };
    return {
      to: "done",
      cause: "fired",
      patch: { cause: "fired", endedAt: now },
      signals: [timerFiredSignal(now, row, row.prompt)],
    };
  }

  // A pending process or watch is a start the seam has not confirmed. Past
  // the grace window the watcher probes it: a job it finds is adopted, so a
  // seam that lost its running write never makes the agent run the command
  // twice (fix wave 3, concurrency L6 and P9). With no job found, the start
  // was cut short: end the row and kill the requested id in case it ran.
  if (row.status === "pending") {
    if (now - row.createdAt < PENDING_START_GRACE_MS) return null;
    if (probe.kind === "poll" && probe.status === "running") return { to: "running", patch: {}, signals: [] };
    // A failed probe says nothing about the job, so the row waits for its
    // deadline as a running row does. A kill here could stop a job the
    // seam started (fix wave 4, concurrency N4).
    if (probe.kind !== "error" && !(probe.kind === "poll" && probe.status === "done" && probe.exitCode !== undefined)) {
      return {
        to: "lost",
        cause: "pid_missing",
        kill: true,
        patch: { cause: "pid_missing", endedAt: now },
        signals: [
          terminalSignal(
            now,
            row,
            "pid_missing",
            undefined,
            `This background ${row.kind} never finished starting, so its result is unknown. Check whether it ran before you start it again.`,
            opts,
          ),
        ],
        releaseLease: "owner_ended",
      };
    }
  }

  if (probe.kind === "unavailable") {
    return {
      to: "lost",
      cause: "sandbox_unavailable",
      patch: { cause: "sandbox_unavailable", endedAt: now },
      signals: [
        terminalSignal(now, row, "sandbox_unavailable", undefined, terminalBody(unsentOrTail(row, ""), "sandbox_unavailable", row, opts), opts),
      ],
      releaseLease: "owner_ended",
    };
  }

  if (probe.kind === "none") return null;

  // A failed probe says nothing about the process, but the deadline still
  // holds: past it the row expires, so a probe that always fails cannot
  // keep the row and its lease alive forever (spec C6).
  if (probe.kind === "error") {
    if (row.deadlineAt === undefined || row.deadlineAt > now) return null;
    return {
      to: "expired",
      cause: "deadline",
      kill: true,
      patch: { cause: "deadline", endedAt: now },
      signals: [terminalSignal(now, row, "deadline", undefined, terminalBody(unsentOrTail(row, ""), "deadline", row, opts), opts)],
      releaseLease: "deadline",
    };
  }

  const readBytes = Math.max(0, probe.nextOffset - row.logOffset);
  const buffered = row.watchBuffer ?? "";

  if (probe.status === "done" || probe.status === "failed") {
    // A watch's buffered and last lines become a last watch.event before
    // watch.exited (fix wave 2, L6). The rate limit does not apply at exit.
    const signals: SignalDraft[] = [];
    const patch: WakeupPatch = {};
    if (row.kind === "watch") {
      // No line cap at exit: the row ends here, so every remaining line
      // must go out now; chunkLines bounds each event (PR review, finding 4).
      const { lines } = splitWatchLines(probe.output, readBytes, true, Number.POSITIVE_INFINITY);
      const all = [...bufferedLines(buffered), ...lines];
      if (all.length > 0) {
        // Each event stays within WATCH_BUFFER_BYTES (fix wave 4, data N8).
        let eventCount = row.eventCount;
        for (const chunk of chunkLines(all)) {
          eventCount += 1;
          signals.push(watchEventSignal(row, chunk, eventCount));
        }
        patch.eventCount = eventCount;
        patch.watchBuffer = "";
        patch.lastEmitAt = now;
      }
    }
    const logTail = tail(row.logTail + probe.output);
    if (probe.exitCode !== undefined) {
      signals.push(terminalSignal(now, row, "exit", probe.exitCode, terminalBody(logTail, "exit", row, opts, probe.truncated), opts));
      return {
        to: "done",
        cause: "exit",
        patch: { ...patch, cause: "exit", exitCode: probe.exitCode, endedAt: now },
        signals,
        releaseLease: "owner_ended",
      };
    }
    signals.push(
      terminalSignal(now, row, "pid_missing", undefined, terminalBody(logTail, "pid_missing", row, opts, probe.truncated), opts),
    );
    return {
      to: "lost",
      cause: "pid_missing",
      patch: { ...patch, cause: "pid_missing", endedAt: now },
      signals,
      releaseLease: "owner_ended",
    };
  }

  // probe.status === "running"
  if (row.deadlineAt !== undefined && row.deadlineAt <= now) {
    return {
      to: "expired",
      cause: "deadline",
      kill: true,
      patch: { cause: "deadline", endedAt: now },
      signals: [
        terminalSignal(
          now,
          row,
          "deadline",
          undefined,
          terminalBody(unsentOrTail(row, probe.output), "deadline", row, opts, probe.truncated),
          opts,
        ),
      ],
      releaseLease: "deadline",
    };
  }

  if (row.kind === "process") {
    if (probe.output === "") return null;
    return {
      to: "running",
      patch: { logOffset: probe.nextOffset, logTail: tail(row.logTail + probe.output) },
      signals: [],
    };
  }

  return decideWatchTick(now, row, probe.output, readBytes, buffered, opts);
}

/** The complete lines of a watch buffer ("" holds none). */
function bufferedLines(buffer: string): string[] {
  if (buffer === "") return [];
  return (buffer.endsWith("\n") ? buffer.slice(0, -1) : buffer).split("\n");
}

/**
 * Splits lines into groups whose text, one newline per line, fits in
 * `WATCH_BUFFER_BYTES`. A group always holds at least one line, so a line
 * longer than the cap still goes out (fix wave 4, data N8).
 */
function chunkLines(lines: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1;
    if (current.length > 0 && bytes + size > WATCH_BUFFER_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(line);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * One running watch tick (fix wave 3, M1). New complete lines join the
 * buffer, and each tick with new lines counts toward the rate window. The
 * buffer goes out as one `watch.event` when the watch has not emitted yet,
 * when `watchMinIntervalMs` passed since the last emit, or when it holds
 * `WATCH_BUFFER_BYTES`. So a chatty watch costs at most one turn per
 * interval, and a quiet one still reports its first line at once.
 */
function decideWatchTick(
  now: number,
  row: Wakeup,
  output: string,
  readBytes: number,
  buffered: string,
  opts: DecideOptions,
): WakeupDecision | null {
  const { lines, consumedText, consumedBytes } = splitWatchLines(output, readBytes, false);
  const hasNew = lines.length > 0;
  const buffer = hasNew ? `${buffered}${lines.join("\n")}\n` : buffered;
  const newLogTail = hasNew ? tail(row.logTail + consumedText) : row.logTail;
  const read: WakeupPatch = hasNew ? { logOffset: row.logOffset + consumedBytes, logTail: newLogTail } : {};
  const window = hasNew ? nextWindow(now, row, opts.watchMaxEventsPerHour, opts.tickMs ?? DEFAULT_TICK_MS) : undefined;
  if (window?.over) {
    // Up to WATCH_BUFFER_BYTES of the unsent lines, not a 4 KB tail (fix wave 4, data N2).
    const body = buffer === "" ? tail(newLogTail) : tail(buffer, WATCH_BUFFER_BYTES);
    const sep = body === "" || body.endsWith("\n") ? "" : "\n";
    return {
      to: "expired",
      cause: "rate",
      kill: true,
      patch: { ...read, cause: "rate", endedAt: now, watchBuffer: "" },
      signals: [
        terminalSignal(
          now,
          row,
          "rate",
          undefined,
          `${body}${sep}[watch stopped: its command printed new lines in more than ${opts.watchMaxEventsPerHour} polls within one hour (sandbox.watchMaxEventsPerHour). Print only the lines you will act on, for example through grep, and start the watch again.]`,
          opts,
        ),
      ],
      releaseLease: "deadline",
    };
  }
  const windowPatch: WakeupPatch = window ? { windowStartAt: window.windowStartAt, windowCount: window.windowCount } : {};
  if (buffer === "") return null;
  const minInterval = opts.watchMinIntervalMs ?? DEFAULT_WATCH_MIN_INTERVAL_MS;
  const due =
    row.lastEmitAt === undefined || now - row.lastEmitAt >= minInterval || Buffer.byteLength(buffer) >= WATCH_BUFFER_BYTES;
  if (!due) {
    if (!hasNew) return null;
    return { to: "running", patch: { ...read, ...windowPatch, watchBuffer: buffer }, signals: [] };
  }
  // One event of at most WATCH_BUFFER_BYTES. The rest stays buffered and
  // is due again at once while it still fills the buffer (fix wave 4, data N8).
  const [first = [], ...rest] = chunkLines(bufferedLines(buffer));
  const remaining = rest.flat();
  const eventCount = row.eventCount + 1;
  return {
    to: "running",
    patch: {
      ...read,
      ...windowPatch,
      eventCount,
      watchBuffer: remaining.length === 0 ? "" : `${remaining.join("\n")}\n`,
      lastEmitAt: now,
    },
    signals: [watchEventSignal(row, first, eventCount)],
  };
}

/** The line that opens a digest's block: key, status, and actor. */
export function digestHeader(d: EventMatchDigest): string {
  const parts = [d.key];
  if (d.status !== undefined) parts.push(d.status);
  if (d.actor !== undefined) parts.push(`by ${d.actor}`);
  return parts.join(" · ");
}

/**
 * Most bytes of one stream `event.matched` signal: its body plus its
 * `digests` attribute, which the model also reads (spec Part F). Digests
 * past it stay buffered for the next signal.
 */
export const EVENT_SIGNAL_MAX_BYTES = 64 * 1024;

/**
 * One digest's block (spec Part F): header, summary, URL, then the text.
 * Every text line starts with `> `, so a message cannot make a line that
 * reads as a header of another digest.
 */
export function digestBlock(d: EventMatchDigest): string {
  const lines = [digestHeader(d), d.summary];
  if (d.url !== undefined) lines.push(d.url);
  if (d.text !== undefined && d.text !== "") lines.push(...d.text.split("\n").map((line) => `> ${line}`));
  return lines.join("\n");
}

/** One entry of the `digests` signal attribute: the digest without its text. */
export interface EventDigestEntry {
  head_sha?: string;
  key: string;
  status?: string;
  actor?: string;
  summary: string;
  url?: string;
}

function digestEntry(d: EventMatchDigest): EventDigestEntry {
  return {
    key: d.key,
    ...(d.head_sha !== undefined ? { head_sha: d.head_sha } : {}),
    ...(d.status !== undefined ? { status: d.status } : {}),
    ...(d.actor !== undefined ? { actor: d.actor } : {}),
    summary: d.summary,
    ...(d.url !== undefined ? { url: d.url } : {}),
  };
}

function bytes(s: string): number {
  return Buffer.byteLength(s);
}

function eventAttributes(row: Wakeup): Record<string, string> {
  return { wakeupId: row.id, kind: row.kind, subject: row.subjects?.[0] ?? "" };
}

/** The `Also matched` section that follows the blocks, or "" with no lines. */
function alsoMatched(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `\n\nAlso matched:\n${lines.join("\n")}`;
}

/**
 * The layout of a stream signal within `maxBytes` (spec Part F step 3).
 * `full` digests go out as blocks, in buffer order, while the body and
 * the `digests` attribute fit. With `overflow`, every other digest goes
 * out as one header line under `Also matched` (the deadline flush), and
 * the header lines count toward the cap too. Without it, the other
 * digests stay buffered. At least one digest goes out as a block unless
 * `overflow` is set.
 */
export function layoutStreamSignal(
  digests: readonly EventMatchDigest[],
  overflow: boolean,
  maxBytes: number = EVENT_SIGNAL_MAX_BYTES,
): { full: EventMatchDigest[]; headers: string[] } {
  const headers = digests.map(digestHeader);
  // Bytes of the header lines from index i to the end, for the overflow layout.
  const headerBytesFrom: number[] = new Array<number>(digests.length + 1).fill(0);
  for (let i = digests.length - 1; i >= 0; i--) headerBytesFrom[i] = headerBytesFrom[i + 1]! + bytes(headers[i]!) + 1;
  const section = (from: number): number => (overflow && from < digests.length ? bytes("\n\nAlso matched:") + headerBytesFrom[from]! : 0);
  let blockBytes = 0;
  let entryBytes = 2;
  let count = 0;
  for (const d of digests) {
    const nextBlock = blockBytes + bytes(digestBlock(d)) + (count > 0 ? 2 : 0);
    const nextEntries = entryBytes + bytes(JSON.stringify(digestEntry(d))) + (count > 0 ? 1 : 0);
    if (nextBlock + nextEntries + section(count + 1) > maxBytes && (count > 0 || overflow)) break;
    blockBytes = nextBlock;
    entryBytes = nextEntries;
    count++;
  }
  if (!overflow) return { full: digests.slice(0, count), headers: [] };
  // Header lines past the cap are counted, not listed.
  const rest = headers.slice(count);
  let used = blockBytes + (count > 0 ? entryBytes : 0) + bytes("\n\nAlso matched:");
  const listed: string[] = [];
  for (const [index, line] of rest.entries()) {
    const tailLine = `and ${rest.length - index} more.`;
    if (used + bytes(line) + 1 + bytes(tailLine) + 1 > maxBytes && index < rest.length - 1) {
      listed.push(tailLine);
      break;
    }
    listed.push(line);
    used += bytes(line) + 1;
  }
  return { full: digests.slice(0, count), headers: listed };
}

/**
 * The `event.matched` signal (spec Part F). Stream mode lists one block per
 * digest in `digests`, then `overflow` header lines under `Also matched`.
 * Once mode (`terminal`) shows the first digest in full and lists the
 * others, one line each, under `Also matched`. The `digests` attribute
 * lists the digests shown as blocks, without their text, for the web card.
 * `matchCount` counts every digest the signal names.
 */
export function eventMatchedSignal(
  row: Wakeup,
  digests: EventMatchDigest[],
  n: number,
  terminal: boolean,
  overflow: { lines: string[]; count: number } = { lines: [], count: 0 },
): SignalDraft {
  let body: string;
  let shown: EventMatchDigest[];
  let matchCount: number;
  if (terminal) {
    const [first, ...rest] = digests;
    shown = first ? [first] : [];
    body = (first ? digestBlock(first) : "") + alsoMatched(rest.map((d) => `${digestHeader(d)} · ${d.summary}`));
    matchCount = digests.length;
  } else {
    shown = digests;
    body = digests.map(digestBlock).join("\n\n") + alsoMatched(overflow.lines);
    if (digests.length === 0) body = body.replace(/^\n\n/, "");
    matchCount = digests.length + overflow.count;
  }
  return {
    signalType: "event.matched",
    body,
    attributes: {
      ...eventAttributes(row),
      matchCount: String(matchCount),
      digests: JSON.stringify(shown.map(digestEntry)),
    },
    dispatchId: terminal ? `wakeup:${row.id}:terminal` : `wakeup:${row.id}:event:${n}`,
  };
}

/**
 * The `event.ended` signal (spec F1). For `deadline`, `count` is the number
 * of `event.matched` signals the waiter delivered over its life: with none,
 * the body is the F1 text; otherwise it names the signal count. For `rate`,
 * `count` is the signal count in the rate window. For `delivered`, a claim
 * redirect delivered the matching event to the thread as a message (spec
 * 2026-10-16: delivery threads and claims, Part C step 5), and `hours` and
 * `count` are unused.
 */
export function eventEndedSignal(row: Wakeup, cause: "deadline" | "rate" | "delivered" | "output_cap", hours: number, count: number): SignalDraft {
  let body: string;
  if (cause === "output_cap") {
    body = `The wait reached its ${EVENT_DELIVERED_MAX_KEYS}-output limit. Re-arm a new wait to keep watching.`;
  } else if (cause === "delivered") {
    body = "The matching event arrived in this thread as a message. The wait ended.";
  } else if (cause === "rate") {
    body = `Ended after ${count} events in an hour. Narrow the clauses, then wait again.`;
  } else if (count === 0) {
    body = `No matching event arrived within ${hours} hours. Check the subject's state before you wait again.`;
  } else {
    body = `The wait reached its ${hours}-hour deadline after ${count} event ${count === 1 ? "signal" : "signals"}. Arm a new wait to keep watching.`;
  }
  return {
    signalType: "event.ended",
    body,
    attributes: { ...eventAttributes(row), cause },
    dispatchId: `wakeup:${row.id}:terminal`,
  };
}

/**
 * Pure end decision for a once-mode event waiter that a claim redirect
 * delivered to (spec 2026-10-16: delivery threads and claims, Part C step
 * 5). The delivery counts as the waiter's match: the row ends as
 * `done/fired` with one terminal signal (INV-E5). With no ready digest,
 * that signal is `event.ended` with cause `delivered`. A digest that arrived
 * meanwhile goes out in the terminal `event.matched` signal instead. Null
 * for any other row.
 */
export function decideDeliveredWaiter(now: number, row: Wakeup): WakeupDecision | null {
  if (row.kind !== "event" || row.status !== "running" || row.eventMatch?.once !== true) return null;
  const ready = (row.eventBuffer ?? []).filter((d) => d.derive === undefined);
  return {
    to: "done",
    cause: "fired",
    patch: { cause: "fired", endedAt: now, eventBuffer: [] },
    signals: [ready.length > 0 ? eventMatchedSignal(row, ready, row.eventCount + 1, true) : eventEndedSignal(row, "delivered", 0, 0)],
  };
}

/**
 * Pure delivery decision for a running event waiter (spec 2026-10-15, Part
 * F and F1). The watcher resolves digests marked `derive` before it calls
 * this, so a digest that still carries `derive` is never delivered here.
 *
 * - Once mode: the first deliverable digest ends the row as `done/fired`.
 * - Stream mode: the deliverable digests go out in one signal, in buffer
 *   order, up to `EVENT_SIGNAL_MAX_BYTES`; the rest stay buffered. The first
 *   signal goes out at once; later ones wait for `eventMatch.minIntervalMs`,
 *   else `watchMinIntervalMs`. Each signal counts once toward
 *   `watchMaxEventsPerHour` through the watch rate window, however many
 *   digests it lists; past it the row ends as `done/rate`.
 * - Past `deadlineAt`, the row ends as `expired/deadline`. Stream mode first
 *   flushes the matches it still holds in one last signal, which skips the
 *   min interval and counts once in the window. Digests past the size cap
 *   appear there as header lines only.
 */
export function decideEventWaiter(now: number, row: Wakeup, opts: DecideOptions): WakeupDecision | null {
  if (row.kind !== "event" || row.status !== "running") return null;
  const match = row.eventMatch;
  if (match === undefined) return { to: "lost", patch: { endedAt: now }, signals: [], badRow: true };
  if ((row.eventSeen?.length ?? 0) >= EVENT_DELIVERED_MAX_KEYS) {
    return { to: "done", cause: "output_cap", patch: { cause: "output_cap", endedAt: now, eventBuffer: [] },
      signals: [eventEndedSignal(row, "output_cap", 0, 0)] };
  }
  const ready = (row.eventBuffer ?? []).filter((d) => d.derive === undefined);
  const pastDeadline = row.deadlineAt !== undefined && row.deadlineAt <= now;

  if (match.once && ready.length > 0) {
    return {
      to: "done",
      cause: "fired",
      // A terminal CAS may clear the buffer: appends to an ended row are refused.
      patch: { cause: "fired", endedAt: now, eventBuffer: [] },
      signals: [eventMatchedSignal(row, ready, row.eventCount + 1, true)],
    };
  }

  if (pastDeadline) {
    const hours = row.deadlineAt === undefined ? 0 : Math.round((row.deadlineAt - row.createdAt) / HOUR_MS);
    const signals: SignalDraft[] = [];
    const patch: WakeupPatch = { cause: "deadline", endedAt: now, eventBuffer: [] };
    let delivered = row.eventCount;
    if (ready.length > 0) {
      delivered += 1;
      const window = nextWindow(now, row, opts.watchMaxEventsPerHour, opts.tickMs ?? DEFAULT_TICK_MS);
      // The last flush names every digest: blocks within the cap, then one
      // header line each for the rest.
      const layout = layoutStreamSignal(ready, true);
      const overflowCount = ready.length - layout.full.length;
      signals.push(eventMatchedSignal(row, layout.full, delivered, false, { lines: layout.headers, count: overflowCount }));
      Object.assign(patch, { eventCount: delivered, lastEmitAt: now, windowStartAt: window.windowStartAt, windowCount: window.windowCount });
    }
    signals.push(eventEndedSignal(row, "deadline", hours, delivered));
    return { to: "expired", cause: "deadline", patch, signals };
  }

  if (ready.length === 0) return null;

  const minInterval = match.minIntervalMs ?? opts.watchMinIntervalMs ?? DEFAULT_WATCH_MIN_INTERVAL_MS;
  if (row.lastEmitAt !== undefined && now - row.lastEmitAt < minInterval) return null;

  const window = nextWindow(now, row, opts.watchMaxEventsPerHour, opts.tickMs ?? DEFAULT_TICK_MS);
  if (window.over) {
    return {
      to: "done",
      cause: "rate",
      patch: { cause: "rate", endedAt: now, eventBuffer: [] },
      signals: [eventEndedSignal(row, "rate", 0, window.windowCount)],
    };
  }
  const eventCount = row.eventCount + 1;
  // Within the size cap. The digests that do not fit stay buffered.
  const { full } = layoutStreamSignal(ready, false);
  return {
    to: "running",
    patch: { eventCount, lastEmitAt: now, windowStartAt: window.windowStartAt, windowCount: window.windowCount },
    signals: [eventMatchedSignal(row, full, eventCount, false)],
    deliveredKeys: full.map((d) => d.dedupeKey),
  };
}
