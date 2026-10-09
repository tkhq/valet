import { Type } from "typebox";
import { defineTool } from "./define.js";
import {
  validateHold,
  validateWakeAt,
  validateWatch,
  wakeupsLimitRefusal,
  wakeupsUnavailable,
} from "../wakeups/validate.js";
import { DEFAULT_WATCH_MIN_INTERVAL_MS, JOB_LOG_CAPPED_MARKER } from "../wakeups/types.js";
import type { Lease, Wakeup, WakeupsSeam } from "../wakeups/types.js";
import type { ToolContext, ToolResult } from "../types.js";

/**
 * Background-work tools (spec 2026-10-08: sandbox scratch, wakeups, and
 * leases). Each tool degrades to `wakeupsUnavailable(tool)` when the host wires
 * no `ToolContext.wakeups` seam, and defers all argument validation to the
 * pure validators in `../wakeups/validate.js` (Task 5).
 */

/**
 * Refuse a new wakeup or lease once this thread already holds
 * `limits.perSession` active ones (fix wave 2, M14: the cap counts per
 * thread, so one thread or member cannot block another). "Active" = a
 * non-terminal wakeup (pending or running) or a hold lease. A process or
 * watch lease belongs to its wakeup, so it is not counted twice.
 */
async function assertUnderLimit(seam: WakeupsSeam, threadId: string): Promise<string | null> {
  const { wakeups, leases } = await seam.list(threadId);
  const nonTerminal = wakeups.filter((w) => w.status === "pending" || w.status === "running").length;
  const n = nonTerminal + leases.filter((l) => l.ownerKind === "hold").length;
  return n >= seam.limits.perSession ? wakeupsLimitRefusal(n, seam.limits.perSession) : null;
}

/** The calling turn's channel origin, when it has one. */
function originOf(ctx: ToolContext): { origin?: NonNullable<ToolContext["origin"]> } {
  return ctx.origin !== undefined ? { origin: ctx.origin } : {};
}

function isoOrUndefined(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** A duration as `2h 5m`, `3d 4h`, or `45s`. */
function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** One `wakeup_list` row. The reason is JSON-quoted, so a quote in it cannot break the line (fix wave 3, UX L4). */
function wakeupLine(w: Wakeup, now: number): string {
  const base = `${w.id} ${w.kind} ${w.status} ${JSON.stringify(w.reason)}`;
  const started = `started ${elapsedText(now - w.createdAt)} ago`;
  if (w.kind === "timer") {
    const iso = isoOrUndefined(w.fireAt);
    return iso ? `${base} fires ${iso}, ${started}` : `${base}, ${started}`;
  }
  const iso = isoOrUndefined(w.deadlineAt);
  return iso ? `${base} deadline ${iso}, ${started}` : `${base}, ${started}`;
}

function leaseLine(l: Lease, now: number): string {
  return `${l.id} hold ${JSON.stringify(l.reason)} deadline ${new Date(l.deadlineAt).toISOString()}, started ${elapsedText(now - l.createdAt)} ago`;
}

/**
 * The end of every start text: how to read the log, and to end the turn.
 * A model told only how to check progress loops on process_read (fix wave
 * 3, UX prompts 1 and 6).
 */
function afterStart(id: string, signal: string): string {
  return (
    `End your turn now with a one-line status; the ${signal} signal starts your next turn. ` +
    `To check progress when someone asks, call process_read { id: "${id}", tail: true }.`
  );
}

/** A seam refusal that names its tool, for the model; any other error is a crash. */
function refusalText(err: unknown, prefix: string): string | null {
  return err instanceof Error && err.message.startsWith(prefix) ? err.message : null;
}

export const watchTool = defineTool({
  name: "watch",
  description:
    "Run a command in the background and receive its new output lines " +
    "(stdout and stderr together) as `watch.event` signals. The watcher " +
    "polls about every 30 seconds and sends at most one signal per interval " +
    "the result names, with the lines in between collected into it. Each " +
    "signal starts a full turn, so print only the lines you will act on, " +
    "for example through grep. A watch whose command prints new lines in " +
    "nearly every poll for an hour is stopped. The sandbox stays awake until " +
    "the command exits or `max_hours` passes; then it is killed.",
  parameters: Type.Object({
    command: Type.String(),
    reason: Type.String(),
    max_hours: Type.Number(),
  }),
  execute: async (args, ctx) => {
    const seam = ctx.wakeups;
    if (!seam) return { text: wakeupsUnavailable("watch") };
    const validation = validateWatch(args, seam.limits);
    if (!validation.ok) return { text: validation.text };
    const limitRefusal = await assertUnderLimit(seam, ctx.threadId);
    if (limitRefusal) return { text: limitRefusal };
    let wakeup: Wakeup;
    try {
      ({ wakeup } = await seam.create(ctx.threadId, {
        kind: "watch",
        command: args.command,
        reason: validation.value.reason,
        maxHours: validation.value.maxHours,
        ...originOf(ctx),
      }));
    } catch (err) {
      const text = refusalText(err, "[bash_background]");
      if (text) return { text };
      throw err;
    }
    const intervalSeconds = Math.round((seam.limits.watchMinIntervalMs ?? DEFAULT_WATCH_MIN_INTERVAL_MS) / 1000);
    return {
      text:
        `started watch ${wakeup.id} (max ${validation.value.maxHours}h). ` +
        `You will receive at most one watch.event every ${intervalSeconds} seconds, and a watch.exited signal when it stops. ` +
        afterStart(wakeup.id, "next watch"),
    };
  },
});

export const wakeAtTool = defineTool({
  name: "wake_at",
  description:
    "Schedule a new turn on this thread with `prompt` as its input. Give " +
    "`at` (ISO 8601 with Z or an offset) or `after_seconds` (60 to the " +
    "deploy max). The call returns at once; end your turn after it. The new " +
    "turn starts within about a minute of the time. The sandbox may " +
    "hibernate while you wait. Use it instead of `sleep`.",
  parameters: Type.Object({
    at: Type.Optional(Type.String()),
    after_seconds: Type.Optional(Type.Integer()),
    prompt: Type.String(),
  }),
  execute: async (args, ctx) => {
    const seam = ctx.wakeups;
    if (!seam) return { text: wakeupsUnavailable("wake_at") };
    const validation = validateWakeAt(args, Date.now(), seam.limits);
    if (!validation.ok) return { text: validation.text };
    const limitRefusal = await assertUnderLimit(seam, ctx.threadId);
    if (limitRefusal) return { text: limitRefusal };
    let wakeup: Wakeup;
    try {
      ({ wakeup } = await seam.create(ctx.threadId, {
        kind: "timer",
        prompt: validation.value.prompt,
        fireAt: validation.value.fireAt,
        ...originOf(ctx),
      }));
    } catch (err) {
      const text = refusalText(err, "[wake_at]");
      if (text) return { text };
      throw err;
    }
    const fireAt = wakeup.fireAt ?? validation.value.fireAt;
    return { text: `scheduled wakeup ${wakeup.id} at ${new Date(fireAt).toISOString()}` };
  },
});

export const holdSandboxTool = defineTool({
  name: "hold_sandbox",
  description:
    "Keep this sandbox running for `hours` (until the deadline, then it is " +
    "released) even when idle, for example " +
    "while a person works in the terminal. Give a `reason`; it shows in " +
    "`wakeup_list` and in the `lease.expired` signal. A background `bash` " +
    "already holds the sandbox, so do not add a hold for it.",
  parameters: Type.Object({
    hours: Type.Number(),
    reason: Type.String(),
  }),
  execute: async (args, ctx) => {
    const seam = ctx.wakeups;
    if (!seam) return { text: wakeupsUnavailable("hold_sandbox") };
    const validation = validateHold(args, seam.limits);
    if (!validation.ok) return { text: validation.text };
    const limitRefusal = await assertUnderLimit(seam, ctx.threadId);
    if (limitRefusal) return { text: limitRefusal };
    let lease: Lease;
    try {
      lease = await seam.hold({
        hours: validation.value.hours,
        reason: validation.value.reason,
        threadId: ctx.threadId,
        ...originOf(ctx),
      });
    } catch (err) {
      // A refusal the seam names for the model (no sandbox), not a crash.
      if (err instanceof Error && err.message.startsWith("[hold_sandbox]")) return { text: err.message };
      throw err;
    }
    return { text: `holding sandbox until ${new Date(lease.deadlineAt).toISOString()} (lease ${lease.id})` };
  },
});

export const processReadTool = defineTool({
  name: "process_read",
  concurrencySafe: true,
  description:
    "Read a slice of a background process's or watch's log by byte `offset` " +
    "(default 0) and `bytes` (default 4096, max 65536). Set `tail: true` to " +
    "read the last `bytes` instead; use it to check progress. The result " +
    "ends with `[nextOffset N]`, and `[eof]` when the process has exited and " +
    "no bytes remain.",
  parameters: Type.Object({
    id: Type.String(),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 65536 })),
    tail: Type.Optional(Type.Boolean()),
  }),
  execute: async (args, ctx) => {
    const seam = ctx.wakeups;
    if (!seam) return { text: wakeupsUnavailable("process_read") };
    let result;
    try {
      result = await seam.readLog(args.id, args.offset ?? 0, args.bytes ?? 4096, args.tail ? { tail: true } : undefined);
    } catch (err) {
      // A refusal the seam names for the model (unknown id, a timer with no
      // log, no job-mode support, a stopped sandbox), not a crash. Any other
      // error propagates.
      if (err instanceof Error && err.message.startsWith("[process_read]")) {
        return { text: err.message };
      }
      throw err;
    }
    const body = result.text.length > 0 ? result.text : "(no new output)";
    const eofSuffix = result.eof ? " [eof]" : "";
    // The log keeps its first bytes up to the cap, so a tail read stops
    // moving once the cap hits. Say so (fix wave 3, k8s M-B).
    const capped = result.text.includes(JOB_LOG_CAPPED_MARKER)
      ? "\n[log capped: output after the cap was dropped. The process.exited signal reports the exit code.]"
      : "";
    return { text: `${body}\n[nextOffset ${result.nextOffset}]${eofSuffix}${capped}` };
  },
});

export const wakeupListTool = defineTool({
  name: "wakeup_list",
  concurrencySafe: true,
  description:
    "List this thread's active background processes, watches, timers, and holds with their ids and deadlines. " +
    "Work that other threads of this session started shows as one count.",
  parameters: Type.Object({}),
  execute: async (_args, ctx) => {
    const seam = ctx.wakeups;
    if (!seam) return { text: wakeupsUnavailable("wakeup_list") };
    const { wakeups, leases, otherThreads } = await seam.list(ctx.threadId);
    const now = Date.now();
    const lines = [
      ...wakeups.map((w) => wakeupLine(w, now)),
      ...leases.filter((l) => l.ownerKind === "hold").map((l) => leaseLine(l, now)),
    ];
    if (lines.length === 0) lines.push("(no active wakeups or holds in this thread)");
    if (otherThreads > 0) lines.push(`${otherThreads} more in other threads of this session.`);
    return { text: lines.join("\n") };
  },
});

export const wakeupCancelTool = defineTool({
  name: "wakeup_cancel",
  description:
    "Cancel a background process, watch, timer, or hold by id. A process " +
    "or watch is killed and its lease released.",
  parameters: Type.Object({ id: Type.String() }),
  execute: async (args, ctx) => {
    const seam = ctx.wakeups;
    if (!seam) return { text: wakeupsUnavailable("wakeup_cancel") };
    const result = await seam.cancel(args.id);
    if (!result) {
      return { text: `[wakeup_cancel] ${args.id} is not an active wakeup or lease. Call wakeup_list to see active ids.` };
    }
    if (result.kind === "refused") return { text: result.text };
    return { text: `cancelled ${args.id}` };
  },
});

/**
 * Shared by `bash`'s `background: true` extension (Task 7): creates a
 * "process" wakeup for a detached command and reports it the same way the
 * other create tools do. Not itself a `ToolDef` — `bash` calls it after its
 * own argument validation (`validateBackground`).
 */
export async function startBackgroundProcess(
  ctx: ToolContext,
  command: string,
  value: { deadlineHours: number; reason: string },
): Promise<ToolResult> {
  const seam = ctx.wakeups;
  if (!seam) return { text: wakeupsUnavailable("bash") };
  const limitRefusal = await assertUnderLimit(seam, ctx.threadId);
  if (limitRefusal) return { text: limitRefusal };
  let wakeup: Wakeup;
  try {
    ({ wakeup } = await seam.create(ctx.threadId, {
      kind: "process",
      command,
      reason: value.reason,
      deadlineHours: value.deadlineHours,
      ...originOf(ctx),
    }));
  } catch (err) {
    // A start the seam refused or stopped is a result the model acts on,
    // not a crash (fix wave 3, UX L9).
    const text = refusalText(err, "[bash_background]");
    if (text) return { text };
    throw err;
  }
  const deadlineIso = isoOrUndefined(wakeup.deadlineAt) ?? "unknown";
  return {
    text:
      `started sandbox process ${wakeup.id} (deadline ${deadlineIso}; it is killed then). ` +
      "You will receive a process.exited signal when it ends. " +
      afterStart(wakeup.id, "process.exited"),
  };
}
