import { Type } from "typebox";
import { defineTool } from "./define.js";
import {
  WAKEUPS_UNAVAILABLE,
  validateHold,
  validateWakeAt,
  validateWatch,
  wakeupsLimitRefusal,
} from "../wakeups/validate.js";
import type { Lease, Wakeup, WakeupsSeam } from "../wakeups/types.js";
import type { ToolContext, ToolResult } from "../types.js";

/**
 * Background-work tools (spec 2026-10-08: sandbox scratch, wakeups, and
 * leases). Each tool degrades to `WAKEUPS_UNAVAILABLE` when the host wires
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

function wakeupLine(w: Wakeup): string {
  const base = `${w.id} ${w.kind} ${w.status} "${w.reason}"`;
  if (w.kind === "timer") {
    const iso = isoOrUndefined(w.fireAt);
    return iso ? `${base} fires ${iso}` : base;
  }
  const iso = isoOrUndefined(w.deadlineAt);
  return iso ? `${base} deadline ${iso}` : base;
}

function leaseLine(l: Lease): string {
  return `${l.id} hold "${l.reason}" deadline ${new Date(l.deadlineAt).toISOString()}`;
}

/** How to read a running job's latest output, for the start result texts (fix wave 2, H5). */
function readHint(id: string): string {
  return `Read its log with process_read; process_read { id: "${id}", tail: true } shows the latest output.`;
}

export const watchTool = defineTool({
  name: "watch",
  description:
    "Run a command in the background and receive its new stdout lines as " +
    "`watch.event` signals, at most one per poll. The sandbox stays awake " +
    "until the command exits or `max_hours` passes. Use it to follow a log " +
    "or poll an external system. Keep the command's output to the lines you " +
    "would act on: a watch that emits more signals per hour than the deploy " +
    "limit is stopped.",
  parameters: Type.Object({
    command: Type.String(),
    reason: Type.String(),
    max_hours: Type.Number(),
  }),
  execute: async (args, ctx) => {
    const seam = ctx.wakeups;
    if (!seam) return { text: WAKEUPS_UNAVAILABLE };
    const validation = validateWatch(args, seam.limits);
    if (!validation.ok) return { text: validation.text };
    const limitRefusal = await assertUnderLimit(seam, ctx.threadId);
    if (limitRefusal) return { text: limitRefusal };
    const { wakeup } = await seam.create(ctx.threadId, {
      kind: "watch",
      command: args.command,
      reason: validation.value.reason,
      maxHours: validation.value.maxHours,
      ...originOf(ctx),
    });
    return {
      text:
        `started watch ${wakeup.id} (max ${validation.value.maxHours}h). ` +
        "You will receive watch.event signals and a watch.exited signal when it stops. " +
        readHint(wakeup.id),
    };
  },
});

export const wakeAtTool = defineTool({
  name: "wake_at",
  description:
    "Pause this thread and wake it later with `prompt` as the input. Give " +
    "`at` (ISO 8601) or `after_seconds` (60 to the deploy max). The sandbox " +
    "may hibernate while you wait; this costs nothing. Use it instead of `sleep`.",
  parameters: Type.Object({
    at: Type.Optional(Type.String()),
    after_seconds: Type.Optional(Type.Integer()),
    prompt: Type.String(),
  }),
  execute: async (args, ctx) => {
    const seam = ctx.wakeups;
    if (!seam) return { text: WAKEUPS_UNAVAILABLE };
    const validation = validateWakeAt(args, Date.now(), seam.limits);
    if (!validation.ok) return { text: validation.text };
    const limitRefusal = await assertUnderLimit(seam, ctx.threadId);
    if (limitRefusal) return { text: limitRefusal };
    const { wakeup } = await seam.create(ctx.threadId, {
      kind: "timer",
      prompt: validation.value.prompt,
      fireAt: validation.value.fireAt,
      ...originOf(ctx),
    });
    const fireAt = wakeup.fireAt ?? validation.value.fireAt;
    return { text: `scheduled wakeup ${wakeup.id} at ${new Date(fireAt).toISOString()}` };
  },
});

export const holdSandboxTool = defineTool({
  name: "hold_sandbox",
  description:
    "Keep this sandbox running for `hours` even when idle, for example " +
    "while a person works in the terminal. Give a `reason`; it shows in " +
    "`wakeup_list` and in the `lease.expired` signal. A background `bash` " +
    "already holds the sandbox, so do not add a hold for it.",
  parameters: Type.Object({
    hours: Type.Number(),
    reason: Type.String(),
  }),
  execute: async (args, ctx) => {
    const seam = ctx.wakeups;
    if (!seam) return { text: WAKEUPS_UNAVAILABLE };
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
    if (!seam) return { text: WAKEUPS_UNAVAILABLE };
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
    return { text: `${body}\n[nextOffset ${result.nextOffset}]${eofSuffix}` };
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
    if (!seam) return { text: WAKEUPS_UNAVAILABLE };
    const { wakeups, leases, otherThreads } = await seam.list(ctx.threadId);
    const lines = [...wakeups.map(wakeupLine), ...leases.filter((l) => l.ownerKind === "hold").map(leaseLine)];
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
    if (!seam) return { text: WAKEUPS_UNAVAILABLE };
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
  if (!seam) return { text: WAKEUPS_UNAVAILABLE };
  const limitRefusal = await assertUnderLimit(seam, ctx.threadId);
  if (limitRefusal) return { text: limitRefusal };
  const { wakeup } = await seam.create(ctx.threadId, {
    kind: "process",
    command,
    reason: value.reason,
    deadlineHours: value.deadlineHours,
    ...originOf(ctx),
  });
  const deadlineIso = isoOrUndefined(wakeup.deadlineAt) ?? "unknown";
  return {
    text:
      `started sandbox process ${wakeup.id} (deadline ${deadlineIso}). ` +
      "You will receive a process.exited signal. " +
      readHint(wakeup.id),
  };
}
