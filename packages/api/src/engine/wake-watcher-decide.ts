import type { LeaseReleaseCause, Wakeup, WakeupCause, WakeupLimits, WakeupPatch, WakeupStatus } from "@valet/engine";

/**
 * The outcome of one WakeWatcher probe against a due wakeup row. `poll`
 * covers `process` and `watch` when the sandbox exec succeeded;
 * `unavailable` covers a sandbox that is gone; `error` covers a probe that
 * failed for another reason and may succeed next tick; `none` is for
 * `timer`, which needs no exec at all.
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
  /** Set on a deadline or rate expiry. The watcher kills the process group before the CAS. */
  kill?: boolean;
}

/** Last N bytes the kernel keeps of a process or watch log tail. */
export const LOG_TAIL_BYTES = 4096;

/** Returns the last `LOG_TAIL_BYTES` bytes of `s`, trimmed by whole characters. */
export function tail(s: string): string {
  if (Buffer.byteLength(s) <= LOG_TAIL_BYTES) return s;
  let result = s.slice(-LOG_TAIL_BYTES);
  while (Buffer.byteLength(result) > LOG_TAIL_BYTES) {
    result = result.slice(1);
  }
  return result;
}

const JOBS_DIR = "/tmp/valet-jobs";

function logPath(row: Wakeup): string {
  return `${JOBS_DIR}/${row.execId}.out`;
}

function durationSeconds(now: number, row: Wakeup): string {
  return String(Math.round((now - row.createdAt) / 1000));
}

/** Builds the `process.exited` / `watch.exited` signal every terminal process/watch transition submits. */
function terminalSignal(now: number, row: Wakeup, cause: WakeupCause, exitCode: number | undefined, body: string): SignalDraft {
  const attributes: Record<string, string> = {
    wakeupId: row.id,
    kind: row.kind,
    reason: row.reason,
    cause,
    durationSeconds: durationSeconds(now, row),
    logPath: logPath(row),
  };
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

/** Splits new watch output into complete lines, holding back a trailing partial line. */
function splitWatchLines(output: string): { lines: string[]; consumedText: string; consumedBytes: number } {
  const parts = output.split("\n");
  // The last element is the trailing partial line (no terminating "\n"), or
  // "" when output ends with "\n". Either way it stays unconsumed.
  const partial = parts.pop() ?? "";
  // A provider can hold back up to 3 bytes of a split codepoint.
  if (parts.length === 0 && Buffer.byteLength(partial) > WATCH_READ_BYTES - 4) {
    // One line fills the whole bounded read. Holding it back would stall
    // the watch forever, so the slice becomes one event.
    return { lines: [partial], consumedText: partial, consumedBytes: Buffer.byteLength(partial) };
  }
  let lines = parts;
  if (lines.length > 200) {
    lines = lines.slice(0, 200);
  }
  const consumedText = lines.length === 0 ? "" : lines.join("\n") + "\n";
  return { lines, consumedText, consumedBytes: Buffer.byteLength(consumedText) };
}

function watchEventSignal(row: Wakeup, lines: string[], newEventCount: number): SignalDraft {
  return {
    signalType: "watch.event",
    body: lines.join("\n"),
    attributes: {
      wakeupId: row.id,
      kind: row.kind,
      reason: row.reason,
      lineCount: String(lines.length),
      eventCount: String(newEventCount),
    },
    dispatchId: `wakeup:${row.id}:event:${newEventCount}`,
  };
}

function timerFiredSignal(now: number, row: Wakeup): SignalDraft {
  if (row.prompt === undefined) {
    throw new Error(`timer wakeup ${row.id} has no prompt`);
  }
  return {
    signalType: "timer.fired",
    body: row.prompt,
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
 * Pure decision kernel for the WakeWatcher sweep (spec 2026-10-08, B5/B6).
 * Takes the current time, the due row, and a probe of the sandbox, and
 * returns the transition to apply, or `null` when nothing is due to
 * change. No I/O, no clock read: `now` is always passed in.
 */
export function decideWakeup(
  now: number,
  row: Wakeup,
  probe: WakeupProbe,
  limits: Pick<WakeupLimits, "watchMaxEventsPerHour">,
): WakeupDecision | null {
  if (row.kind === "timer") {
    if (row.fireAt === undefined || row.fireAt > now) return null;
    return {
      to: "done",
      cause: "fired",
      patch: { cause: "fired", endedAt: now },
      signals: [timerFiredSignal(now, row)],
    };
  }

  if (probe.kind === "unavailable") {
    return {
      to: "lost",
      cause: "sandbox_unavailable",
      patch: { cause: "sandbox_unavailable", endedAt: now },
      signals: [terminalSignal(now, row, "sandbox_unavailable", undefined, tail(row.logTail))],
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
      signals: [terminalSignal(now, row, "deadline", undefined, tail(row.logTail))],
      releaseLease: "deadline",
    };
  }

  if (probe.status === "done" || probe.status === "failed") {
    if (probe.exitCode !== undefined) {
      return {
        to: "done",
        cause: "exit",
        patch: { cause: "exit", exitCode: probe.exitCode, endedAt: now },
        signals: [terminalSignal(now, row, "exit", probe.exitCode, tail(row.logTail + probe.output))],
        releaseLease: "owner_ended",
      };
    }
    return {
      to: "lost",
      cause: "pid_missing",
      patch: { cause: "pid_missing", endedAt: now },
      signals: [terminalSignal(now, row, "pid_missing", undefined, tail(row.logTail + probe.output))],
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
      signals: [terminalSignal(now, row, "deadline", undefined, tail(row.logTail + probe.output))],
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

  // row.kind === "watch"
  const { lines, consumedText, consumedBytes } = splitWatchLines(probe.output);
  if (lines.length === 0) return null;
  const newEventCount = row.eventCount + lines.length;
  const newLogTail = tail(row.logTail + consumedText);
  const hours = Math.max(1, (now - row.createdAt) / 3_600_000);
  if (newEventCount > limits.watchMaxEventsPerHour * hours) {
    return {
      to: "expired",
      cause: "rate",
      kill: true,
      patch: {
        cause: "rate",
        endedAt: now,
        logOffset: row.logOffset + consumedBytes,
        logTail: newLogTail,
        eventCount: newEventCount,
      },
      signals: [
        terminalSignal(
          now,
          row,
          "rate",
          undefined,
          `watch rate limit exceeded: ${newEventCount} events this hour (limit ${limits.watchMaxEventsPerHour}/hour)`,
        ),
      ],
      releaseLease: "deadline",
    };
  }
  return {
    to: "running",
    patch: { logOffset: row.logOffset + consumedBytes, logTail: newLogTail, eventCount: newEventCount },
    signals: [watchEventSignal(row, lines, newEventCount)],
  };
}
