/**
 * Pure helpers for `/workflows/runs/$runId` (engine v2 Phase 5 decision 19).
 * Extracted from the route component so the "which wait condition is a
 * pending approval" and "what prompt does this node show" logic is testable
 * without rendering React — `RunWaitCondition`/`WorkflowNode` cross the wire
 * as `unknown` (see `GetWorkflowRunResponse.run.waitingOn`/`definition` in
 * `packages/api/src/wire/types.ts`), so these narrow at runtime rather than
 * casting.
 */

export interface PendingApproval {
  nodeId: string;
  signalType: string;
}

/**
 * A parked run's `waitingOn` entry for an approval node is
 * `{ kind: 'signal', nodeId, signalType: 'approval:{nodeId}' }`
 * (`packages/workflow/src/store.ts` `RunWaitCondition`, `nodes/approval.ts`).
 * Returns the first one found, or `undefined` if the run isn't parked on an
 * approval (e.g. parked on a timer/submission instead).
 */
export function findPendingApproval(waitingOn: unknown[]): PendingApproval | undefined {
  for (const w of waitingOn) {
    if (typeof w !== "object" || w === null) continue;
    const obj = w as Record<string, unknown>;
    if (
      obj.kind === "signal" &&
      typeof obj.nodeId === "string" &&
      typeof obj.signalType === "string" &&
      obj.signalType.startsWith("approval:")
    ) {
      return { nodeId: obj.nodeId, signalType: obj.signalType };
    }
  }
  return undefined;
}

/**
 * The run's `definition` is the snapshot the run was started against
 * (`WorkflowRun.definition` — a `dag/v1` `WorkflowDefinition`). Looks up an
 * `approval` node's `prompt` field by id for display; returns `undefined` if
 * the definition doesn't parse as expected or the node isn't an approval.
 */
export function findApprovalPrompt(definition: unknown, nodeId: string): string | undefined {
  if (typeof definition !== "object" || definition === null) return undefined;
  const nodes = (definition as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return undefined;
  for (const n of nodes) {
    if (typeof n !== "object" || n === null) continue;
    const obj = n as Record<string, unknown>;
    if (obj.id === nodeId && obj.type === "approval" && typeof obj.prompt === "string") {
      return obj.prompt;
    }
  }
  return undefined;
}

// ─── run → canvas status mapping ─────────────────────────────────────────────

import type { NodeRunStatus } from "./editor/flow-node";

export interface RunCheckpointLike {
  nodeId: string;
  iteration: number;
  status: string;
}

export interface RunLike {
  status: string;
  waitingOn?: unknown;
}

export interface RunNodeStatuses {
  status: Record<string, NodeRunStatus>;
  /** Per-node progress badge for multi-iteration (foreach body) nodes, e.g. "3/12". */
  badges: Record<string, string>;
}

/**
 * Collapses a run's checkpoints (+ park state) into per-node canvas
 * statuses. Multi-iteration nodes (foreach bodies) aggregate: any failed →
 * failed, any in-flight → running, else succeeded/skipped; they also get a
 * "done/total" badge. Nodes the run is parked on (`waitingOn` entries with a
 * `nodeId`) show as `waiting`. Nodes with no checkpoint stay undecorated
 * (pending) — the preview renders them as plain cards.
 */
export function statusByNodeId(run: RunLike, checkpoints: RunCheckpointLike[]): RunNodeStatuses {
  const byNode = new Map<string, RunCheckpointLike[]>();
  for (const cp of checkpoints) {
    const list = byNode.get(cp.nodeId);
    if (list) list.push(cp);
    else byNode.set(cp.nodeId, [cp]);
  }

  const status: Record<string, NodeRunStatus> = {};
  const badges: Record<string, string> = {};

  for (const [nodeId, cps] of byNode) {
    const total = cps.length;
    const done = cps.filter((c) => c.status === "completed").length;
    if (cps.some((c) => c.status === "failed")) status[nodeId] = "failed";
    else if (cps.some((c) => c.status === "intent")) status[nodeId] = "running";
    else if (cps.every((c) => c.status === "skipped")) status[nodeId] = "skipped";
    else status[nodeId] = "succeeded";
    if (total > 1) badges[nodeId] = `${done}/${total}`;
  }

  if (run.status === "parked" && Array.isArray(run.waitingOn)) {
    for (const w of run.waitingOn) {
      if (typeof w !== "object" || w === null) continue;
      const nodeId = (w as Record<string, unknown>).nodeId;
      if (typeof nodeId === "string") status[nodeId] = "waiting";
    }
  }

  return { status, badges };
}

// ─── pending-gate helpers ─────────────────────────────────────────────────────

import type { WorkflowPendingGate } from "@valet/api/wire";

/**
 * Re-export so consumers importing from this module can use the wire type
 * without a second import path.
 */
export type { WorkflowPendingGate };
export type PendingGateLike = WorkflowPendingGate;

/**
 * Returns true only when the run is parked AND at least one pending gate
 * exists (meaning human action is required before the run can continue).
 */
export function runNeedsApproval(
  run: { status: string },
  pendingGates: WorkflowPendingGate[] | undefined,
): boolean {
  return run.status === "parked" && Array.isArray(pendingGates) && pendingGates.length > 0;
}

/** Truncated JSON preview for a checkpoint's `result`, mono-block friendly. */
export function jsonPreview(value: unknown, max = 400): string {
  if (value === undefined) return "";
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

// ─── settled-run result ──────────────────────────────────────────────────────

import type { WorkflowRunOutcome } from "@valet/api/wire";

/**
 * One template path that did not resolve during the run. A path that misses
 * renders as empty instead of failing, so the run reports success with the
 * wrong output. Naming the path is the only way a reader can tell.
 */
export interface RunResultDiagnostic {
  /** The template path, e.g. `trigger.data.owner`. */
  path: string;
  /** The node that held the path, when the record names it. */
  nodeId?: string;
  /** The node field that held the template, e.g. `prompt`. */
  field?: string;
  /** The producer's one-line explanation of the miss. */
  detail?: string;
  /** A path that does resolve. This is the correction the author must make. */
  suggestion?: string;
}

export interface RunResultCheckpointLike {
  nodeId: string;
  iteration: number;
  status: string;
  result?: unknown;
  error?: string;
  createdAt?: number;
}

export interface RunResultRunLike {
  status: string;
  outcome?: string;
  definition?: unknown;
  /**
   * Template resolution diagnostics on the run record. The field is optional
   * and typed `unknown` on purpose: the producer writes it, this module only
   * narrows it, and an older run has neither field.
   */
  templateDiagnostics?: unknown;
  diagnostics?: unknown;
}

/** What a settled run concluded, ready to render. */
export interface RunResult {
  outcome: WorkflowRunOutcome;
  /** The stop node's rendered message, or the failure reason. */
  message?: string;
  /** The stop node's rendered output. */
  output?: unknown;
  /** The node the message and output came from. */
  nodeId?: string;
  diagnostics: RunResultDiagnostic[];
}

function isRunOutcome(value: unknown): value is WorkflowRunOutcome {
  return value === "completed" || value === "failed" || value === "cancelled";
}

/** Ids of every `stop` node in the run's definition snapshot. */
function stopNodeIds(definition: unknown): Set<string> {
  const ids = new Set<string>();
  if (typeof definition !== "object" || definition === null) return ids;
  const nodes = (definition as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return ids;
  for (const n of nodes) {
    if (typeof n !== "object" || n === null) continue;
    const obj = n as Record<string, unknown>;
    if (obj.type === "stop" && typeof obj.id === "string") ids.add(obj.id);
  }
  return ids;
}

/** The `stop` executor's `StopResult` body (`packages/workflow/src/nodes/stop.ts`). */
function stopResultBody(result: unknown): { message?: string; output?: unknown } {
  if (typeof result !== "object" || result === null) return {};
  const obj = result as Record<string, unknown>;
  const message = typeof obj.message === "string" && obj.message !== "" ? obj.message : undefined;
  return { message, output: obj.output };
}

/**
 * The store returns checkpoints unordered, so "the last one" has to be
 * chosen by timestamp. A checkpoint written before `createdAt` existed
 * sorts as 0 and loses to any timestamped row, which is the correct
 * outcome for it.
 */
function newest<T extends { createdAt?: number }>(rows: T[]): T | undefined {
  let best: T | undefined;
  for (const row of rows) {
    if (!best || (row.createdAt ?? 0) >= (best.createdAt ?? 0)) best = row;
  }
  return best;
}

/** The failure a reader must see first: the earliest node that failed. */
function firstFailed(rows: RunResultCheckpointLike[]): RunResultCheckpointLike | undefined {
  let best: RunResultCheckpointLike | undefined;
  for (const row of rows) {
    if (row.status !== "failed") continue;
    if (!best || (row.createdAt ?? 0) < (best.createdAt ?? 0)) best = row;
  }
  return best;
}

/**
 * Field names a diagnostics producer may use. The producer of these records
 * is a different subsystem, so this module accepts each plausible name
 * rather than breaking when one is chosen.
 */
const DIAGNOSTIC_FIELDS = ["templateDiagnostics", "diagnostics", "unresolvedPaths"] as const;
const PATH_FIELDS = ["path", "expression", "template"] as const;
const DETAIL_FIELDS = ["detail", "message", "reason"] as const;

function firstString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function toDiagnostic(entry: unknown): RunResultDiagnostic | undefined {
  if (typeof entry === "string") return entry === "" ? undefined : { path: entry };
  if (typeof entry !== "object" || entry === null) return undefined;
  const obj = entry as Record<string, unknown>;
  const path = firstString(obj, PATH_FIELDS);
  if (path === undefined) return undefined;
  return {
    path,
    nodeId: typeof obj.nodeId === "string" ? obj.nodeId : undefined,
    field: typeof obj.field === "string" ? obj.field : undefined,
    detail: firstString(obj, DETAIL_FIELDS),
    suggestion: typeof obj.suggestion === "string" ? obj.suggestion : undefined,
  };
}

/**
 * Reads template diagnostics off any record that may carry them. Every field
 * is optional: a run recorded before diagnostics existed yields an empty
 * list, and so does a run with no unresolved path.
 */
export function readTemplateDiagnostics(source: unknown): RunResultDiagnostic[] {
  if (typeof source !== "object" || source === null) return [];
  const obj = source as Record<string, unknown>;
  const out: RunResultDiagnostic[] = [];
  for (const field of DIAGNOSTIC_FIELDS) {
    const value = obj[field];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const diagnostic = toDiagnostic(entry);
      if (diagnostic) out.push(diagnostic);
    }
  }
  return out;
}

function dedupe(diagnostics: RunResultDiagnostic[]): RunResultDiagnostic[] {
  const seen = new Set<string>();
  const out: RunResultDiagnostic[] = [];
  for (const d of diagnostics) {
    const key = `${d.nodeId ?? ""} ${d.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/**
 * Collapses a settled run into the answer the reader came for: the stop
 * node's message and output, or — when the run failed before any stop node
 * — the reason the first failing node recorded.
 *
 * The run row has no result column, so the result lives in the stop node's
 * checkpoint (`StopResult`). Returns `undefined` while the run is still in
 * flight or when it settled without a known outcome, because there is no
 * settled answer to show yet.
 */
export function deriveRunResult(
  run: RunResultRunLike,
  checkpoints: RunResultCheckpointLike[],
): RunResult | undefined {
  if (run.status !== "settled") return undefined;
  if (!isRunOutcome(run.outcome)) return undefined;
  const outcome = run.outcome;

  const stopIds = stopNodeIds(run.definition);
  const stopCheckpoint = newest(
    checkpoints.filter((c) => stopIds.has(c.nodeId) && c.status !== "intent"),
  );

  let nodeId: string | undefined;
  let message: string | undefined;
  let output: unknown;
  let source: RunResultCheckpointLike | undefined;

  if (stopCheckpoint) {
    source = stopCheckpoint;
    nodeId = stopCheckpoint.nodeId;
    const body = stopResultBody(stopCheckpoint.result);
    message = body.message ?? (stopCheckpoint.error || undefined);
    output = body.output;
  }

  // A run can fail before it reaches a stop node. Then the failing node's
  // error is the reason, and it gets the same prominence.
  if (message === undefined && outcome === "failed") {
    const failed = firstFailed(checkpoints);
    if (failed) {
      source = failed;
      nodeId = failed.nodeId;
      message = failed.error || undefined;
    }
  }

  const diagnostics = dedupe([
    ...readTemplateDiagnostics(run),
    ...readTemplateDiagnostics(source?.result),
  ]);

  return { outcome, message, output, nodeId, diagnostics };
}

/**
 * List rows show at most one line, and a stop message is prose that may
 * carry newlines. Collapsing whitespace keeps the line honest; the cap
 * bounds the DOM node, because CSS truncation hides overflow but still
 * renders it.
 */
const RESULT_SNIPPET_MAX = 280;

/**
 * One-line preview of a settled run's result for list rows: the stop
 * node's message, or — when the workflow produced a plain-string output
 * with no message — that output. Structured output is not flattened here;
 * JSON squeezed onto one line reads as noise, and the detail page already
 * renders it properly.
 */
export function runResultSnippet(result: RunResult): string | undefined {
  const text =
    result.message ?? (typeof result.output === "string" ? result.output : undefined);
  if (text === undefined) return undefined;
  const oneLine = text
    // Bash steps color their output; ANSI escapes and stray control bytes
    // render as garbage in a one-line snippet. The detail page shows the
    // text verbatim, so nothing is lost by scrubbing here.
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (oneLine === "") return undefined;
  return oneLine.length <= RESULT_SNIPPET_MAX
    ? oneLine
    : `${oneLine.slice(0, RESULT_SNIPPET_MAX)}…`;
}

/** How a settled run's `output` should be displayed. */
export interface RunOutputDisplay {
  /** `json` renders through `CodeBlock`; `text` renders as prose. */
  kind: "json" | "text";
  text: string;
}

/**
 * Chooses the display form for a stop node's `output`. A string output is
 * already prose and gains nothing from quotes and syntax coloring. Anything
 * else is structured data and reads better as JSON.
 */
export function formatRunOutput(output: unknown): RunOutputDisplay | undefined {
  if (output === undefined || output === null) return undefined;
  if (typeof output === "string") {
    return output === "" ? undefined : { kind: "text", text: output };
  }
  try {
    return { kind: "json", text: JSON.stringify(output, null, 2) };
  } catch {
    // A cyclic or non-serializable value still tells the reader more than
    // an empty panel does.
    return { kind: "text", text: String(output) };
  }
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * How long a run took, from its first to its last update. Returns
 * `undefined` when the timestamps cannot give an answer, so the caller
 * shows nothing instead of "NaN".
 */
export function formatRunDuration(startedAt: number, endedAt: number): string | undefined {
  const ms = endedAt - startedAt;
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < SECOND_MS) return `${Math.round(ms)}ms`;
  if (ms < MINUTE_MS) return `${(ms / SECOND_MS).toFixed(1)}s`;
  if (ms < HOUR_MS) {
    const minutes = Math.floor(ms / MINUTE_MS);
    const seconds = Math.floor((ms % MINUTE_MS) / SECOND_MS);
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(ms / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}
