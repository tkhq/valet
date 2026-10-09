import { DEFAULT_WATCH_MIN_INTERVAL_MS } from "@valet/engine";
import type { LeaseReleaseCause, Wakeup, WakeupCause, WakeupLimits, WakeupPatch, WakeupStatus } from "@valet/engine";

/**
 * The outcome of one WakeWatcher probe against a due wakeup row. `poll`
 * covers `process` and `watch` when the sandbox exec succeeded;
 * `unavailable` covers a sandbox that is gone; `error` covers a probe that
 * failed for another reason and may succeed next tick; `none` is for
 * `timer` and for a `pending` process or watch, which need no exec.
 */
export type WakeupProbe =
  | { kind: "poll"; status: "running" | "done" | "failed"; exitCode?: number; output: string; nextOffset: number }
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
}

/** Inputs to `decideWakeup` besides the row and the probe. */
export interface DecideOptions extends Pick<WakeupLimits, "watchMaxEventsPerHour" | "watchMinIntervalMs"> {
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

/** The marker a capped job log ends with (fix wave 3, k8s M-B). */
export const LOG_CAPPED_MARKER = "[valet: log capped at ";

/** What the agent should do after each way a process can end without an exit code (fix wave 3, UX). */
const CAUSE_GUIDANCE: Partial<Record<WakeupCause, string>> = {
  pid_missing:
    "[valet: the process ended without an exit code. The container or the api restarted. Check /workspace for partial output, and tell the person before you run it again.]",
  sandbox_unavailable:
    "[valet: The sandbox stopped, so the process ended with it. Files outside /workspace are gone. Tell the person before you run it again.]",
  deadline:
    "[valet: the process reached its deadline and was stopped. Run it again with a larger deadline only if it was making progress.]",
};

const CAPPED_GUIDANCE =
  "[valet: The log hit its size cap, so this tail is not the end of the output. Write long output to a file in /workspace and read that file.]";

/** The terminal body: the log tail, then a line that names the next step. */
function terminalBody(logTail: string, cause: WakeupCause): string {
  const notes: string[] = [];
  if (logTail.includes(LOG_CAPPED_MARKER)) notes.push(CAPPED_GUIDANCE);
  const guidance = CAUSE_GUIDANCE[cause];
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

/** Returns the last `LOG_TAIL_BYTES` bytes of `s`, trimmed by whole characters, with NUL replaced. */
export function tail(s: string): string {
  const clean = withoutNul(s);
  if (Buffer.byteLength(clean) <= LOG_TAIL_BYTES) return clean;
  let result = clean.slice(-LOG_TAIL_BYTES);
  while (Buffer.byteLength(result) > LOG_TAIL_BYTES) {
    result = result.slice(1);
  }
  return result;
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
  if (lines.length > 200) {
    rest = lines.slice(200).join("\n") + "\n" + partial;
    lines = lines.slice(0, 200);
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
 * starts over only when it is more than `WATCH_RATE_WINDOW_MS` old, so a
 * watch with output on every 30-second tick reaches 121 ticks at the
 * 3600-second mark. `over` is true when the count exceeds the limit.
 */
function nextWindow(now: number, row: Wakeup, max: number): { windowStartAt: number; windowCount: number; over: boolean } {
  const fresh = row.windowStartAt === undefined || now - row.windowStartAt > WATCH_RATE_WINDOW_MS;
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
    if (!(probe.kind === "poll" && probe.status === "done" && probe.exitCode !== undefined)) {
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
      signals: [terminalSignal(now, row, "sandbox_unavailable", undefined, terminalBody(tail(row.logTail), "sandbox_unavailable"), opts)],
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
      signals: [terminalSignal(now, row, "deadline", undefined, terminalBody(tail(row.logTail), "deadline"), opts)],
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
      const { lines } = splitWatchLines(probe.output, readBytes, true);
      const all = [...bufferedLines(buffered), ...lines];
      if (all.length > 0) {
        const eventCount = row.eventCount + 1;
        signals.push(watchEventSignal(row, all, eventCount));
        patch.eventCount = eventCount;
        patch.watchBuffer = "";
        patch.lastEmitAt = now;
      }
    }
    const logTail = tail(row.logTail + probe.output);
    if (probe.exitCode !== undefined) {
      signals.push(terminalSignal(now, row, "exit", probe.exitCode, terminalBody(logTail, "exit"), opts));
      return {
        to: "done",
        cause: "exit",
        patch: { ...patch, cause: "exit", exitCode: probe.exitCode, endedAt: now },
        signals,
        releaseLease: "owner_ended",
      };
    }
    signals.push(terminalSignal(now, row, "pid_missing", undefined, terminalBody(logTail, "pid_missing"), opts));
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
      signals: [terminalSignal(now, row, "deadline", undefined, terminalBody(tail(row.logTail + probe.output), "deadline"), opts)],
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
  const window = hasNew ? nextWindow(now, row, opts.watchMaxEventsPerHour) : undefined;
  if (window?.over) {
    const body = tail(buffer || newLogTail);
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
  const eventCount = row.eventCount + 1;
  return {
    to: "running",
    patch: { ...read, ...windowPatch, eventCount, watchBuffer: "", lastEmitAt: now },
    signals: [watchEventSignal(row, bufferedLines(buffer), eventCount)],
  };
}
