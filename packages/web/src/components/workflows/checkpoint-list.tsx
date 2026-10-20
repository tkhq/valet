import { useState } from "react";
import { StepLogs } from "./step-logs";
import { Link } from "@tanstack/react-router";
import { RUN_STATUS_GLYPH, type NodeRunStatus } from "./editor/flow-node";
import { formatRunDuration, formatRunOutput } from "./run-detail-helpers";
import { humanize } from "./editor/steps-model";
import { CopyButton } from "~/components/session/tool-renderers/tool-shell";
import type { WorkflowModelChange, WorkflowStepCost } from "@valet/api/wire";
import { Badge, Button } from "~/components/primitives";
import { formatTokens, formatUsdPrecise } from "~/lib/format-usage";

export interface CheckpointLike {
  nodeId: string;
  iteration: number;
  status: string;
  error?: string | null;
  result?: unknown;
  sessionId?: string;
  childRunId?: string;
  threadId?: string;
  queueItemId?: string;
  /** For a running step, its latest intent write; otherwise when it finished. */
  createdAt?: number;
  /** When the step began. */
  startedAt?: number;
  /** Copied from an earlier run by a retry: it did not run again. */
  reused?: boolean;
}

/** The run's start and end (or now), for each step's timing bar. */
export interface RunTimeline {
  start: number;
  end: number;
}

/** When a step ran: a running step runs until `now`. Undefined for a step a
 * retry reused (its times belong to the earlier run) and for a step recorded
 * before start times were kept. */
export function stepSpan(checkpoint: CheckpointLike, now: number): { start: number; end: number } | undefined {
  if (checkpoint.createdAt === undefined || checkpoint.reused) return undefined;
  if (checkpoint.status === "intent") {
    const start = checkpoint.startedAt ?? checkpoint.createdAt;
    return { start, end: Math.max(now, start) };
  }
  if (checkpoint.startedAt === undefined) return undefined;
  return { start: checkpoint.startedAt, end: checkpoint.createdAt };
}

function toRunStatus(raw: string): NodeRunStatus {
  switch (raw) {
    case "completed": return "succeeded";
    case "failed": return "failed";
    case "skipped": return "skipped";
    case "intent": return "running";
    default: return "pending";
  }
}

const TEXT_COLOR: Record<NodeRunStatus, string> = {
  pending: "text-muted",
  running: "text-moss",
  succeeded: "text-moss",
  failed: "text-danger-500",
  skipped: "text-muted",
  waiting: "text-amber",
};

const BAR_COLOR: Record<NodeRunStatus, string> = {
  pending: "bg-muted",
  running: "bg-accent-500",
  succeeded: "bg-moss",
  failed: "bg-danger-500",
  skipped: "bg-muted",
  waiting: "bg-amber-500",
};

const LABEL: Record<NodeRunStatus, string> = {
  pending: "Pending",
  running: "Running",
  succeeded: "Completed",
  failed: "Failed",
  skipped: "Skipped",
  waiting: "Waiting",
};

/** A completed checkpoint can record a denied action. */
function deniedResult(result: unknown): { resolvedBy?: string } | null {
  if (typeof result !== "object" || result === null) return null;
  if (!("policyDenied" in result) || result.policyDenied !== true) return null;
  const resolvedBy = "resolvedBy" in result ? result.resolvedBy : undefined;
  return { resolvedBy: typeof resolvedBy === "string" ? resolvedBy : undefined };
}

/** Compact step rows. Expand once for complete output and agent logs. A step
 * that ran once per item shows one row with a summary; its items open below. */
export function CheckpointList({
  checkpoints,
  promotedNodeId,
  nodeStatuses,
  nodeOrder = [],
  stepCosts = [],
  modelChanges = [],
  onExplainFailure,
  timeline,
  now = Date.now(),
}: {
  checkpoints: CheckpointLike[];
  /** Shows "Explain this failure" on each failed step. */
  onExplainFailure?: (nodeId: string, iteration: number) => void;
  /** Model spend per step; a step with no model calls has none. */
  stepCosts?: WorkflowStepCost[];
  /** Steps whose models changed since the previous run with the same steps. */
  modelChanges?: WorkflowModelChange[];
  /** Keep output collapsed when the result panel already shows it. */
  promotedNodeId?: string;
  nodeStatuses?: Record<string, NodeRunStatus>;
  nodeOrder?: string[];
  /** Draws each step's timing bar against the whole run. */
  timeline?: RunTimeline;
  /** The current time, for steps still running. */
  now?: number;
}) {
  if (checkpoints.length === 0) {
    return <p className="text-sm text-muted">No steps have started yet.</p>;
  }
  const order = new Map(nodeOrder.map((id, index) => [id, index]));
  const costs = new Map(stepCosts.map((cost) => [`${cost.nodeId}:${cost.iteration}`, cost]));
  const changes = new Map(modelChanges.map((change) => [change.nodeId, change]));
  const sorted = [...checkpoints].sort((a, b) =>
    (order.get(a.nodeId) ?? nodeOrder.length) - (order.get(b.nodeId) ?? nodeOrder.length) ||
    a.nodeId.localeCompare(b.nodeId) || a.iteration - b.iteration,
  );
  const groups: CheckpointLike[][] = [];
  for (const cp of sorted) {
    const last = groups.at(-1);
    if (last?.[0]?.nodeId === cp.nodeId) last.push(cp);
    else groups.push([cp]);
  }
  const rowProps = (cp: CheckpointLike, index: number) => ({
    checkpoint: cp,
    cost: costs.get(`${cp.nodeId}:${cp.iteration}`),
    number: (order.get(cp.nodeId) ?? index) + 1,
    promoted: cp.nodeId === promotedNodeId,
    waiting: cp.status === "intent" && nodeStatuses?.[cp.nodeId] === "waiting",
    onExplainFailure,
    timeline,
    now,
  });
  return (
    <ol className="overflow-hidden rounded-lg border border-line divide-y divide-line">
      {groups.map((items, index) => items.length === 1 ? (
        <CheckpointRow key={`${items[0].nodeId}:${items[0].iteration}`} {...rowProps(items[0], index)} modelChange={changes.get(items[0].nodeId)} />
      ) : (
        <ItemGroup key={items[0].nodeId} items={items} rowProps={rowProps} index={index}
          modelChange={changes.get(items[0].nodeId)} costs={costs} timeline={timeline} now={now} />
      ))}
    </ol>
  );
}

type RowProps = Omit<Parameters<typeof CheckpointRow>[0], "modelChange">;

/** One row for a step that ran once per item: counts, spend, and time across
 * the items. It opens when an item failed or is still going. */
function ItemGroup({ items, rowProps, index, modelChange, costs, timeline, now }: {
  items: CheckpointLike[];
  rowProps: (cp: CheckpointLike, index: number) => RowProps;
  index: number;
  modelChange?: WorkflowModelChange;
  costs: Map<string, WorkflowStepCost>;
  timeline?: RunTimeline;
  now: number;
}) {
  const first = rowProps(items[0], index);
  const statuses = items.map((cp): NodeRunStatus => rowProps(cp, index).waiting ? "waiting" : toRunStatus(cp.status));
  const counts = new Map<NodeRunStatus, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  const overall: NodeRunStatus = counts.has("failed") ? "failed" : counts.has("waiting") ? "waiting"
    : counts.has("running") ? "running" : counts.has("pending") ? "pending"
    : counts.has("succeeded") ? "succeeded" : "skipped";
  const spans = items.flatMap((cp) => stepSpan(cp, now) ?? []);
  const span = spans.length > 0
    ? { start: Math.min(...spans.map((s) => s.start)), end: Math.max(...spans.map((s) => s.end)) }
    : undefined;
  const itemCosts = items.flatMap((cp) => costs.get(`${cp.nodeId}:${cp.iteration}`) ?? []);
  const models = [...new Set(itemCosts.flatMap((cost) => cost.models))];
  const total: WorkflowStepCost | undefined = itemCosts.length > 0 ? {
    nodeId: items[0].nodeId,
    iteration: 0,
    costUsd: itemCosts.reduce((sum, cost) => sum + cost.costUsd, 0),
    turns: itemCosts.reduce((sum, cost) => sum + cost.turns, 0),
    unpricedTurns: itemCosts.reduce((sum, cost) => sum + cost.unpricedTurns, 0),
    totalTokens: itemCosts.reduce((sum, cost) => sum + cost.totalTokens, 0),
    models,
  } : undefined;
  const reused = items.filter((cp) => cp.reused).length;
  const summary = [
    ...(["succeeded", "failed", "running", "waiting", "skipped", "pending"] as const)
      .flatMap((status) => counts.has(status) ? [`${counts.get(status)} ${LABEL[status].toLowerCase()}`] : []),
    ...(reused > 0 ? [`${reused} reused`] : []),
  ].join(" · ");
  const open = overall === "failed" || overall === "running" || overall === "waiting";
  return (
    <li className="min-w-0 bg-paper">
      <details className="group/items" open={open}>
        <summary className="flex min-h-11 cursor-pointer list-none items-baseline gap-3 px-4 py-3 hover:bg-ink-wash [&::-webkit-details-marker]:hidden">
          <span className="text-muted transition-transform group-open/items:rotate-90" aria-hidden>›</span>
          <span className="w-5 shrink-0 text-xs text-muted tabular-nums" aria-hidden>{first.number}</span>
          <span className={`shrink-0 text-sm ${TEXT_COLOR[overall]}`} aria-hidden>{RUN_STATUS_GLYPH[overall]}</span>
          <span className="min-w-0 flex-1">
            <span className="block break-words text-sm font-medium text-ink" title={items[0].nodeId}>{humanize(items[0].nodeId)}</span>
            <span className="block break-words text-xs text-muted">{items.length} items · {summary}{models.length > 0 ? ` · ${models.join(", ")}` : ""}</span>
            {modelChange && <ModelChangeBadge change={modelChange} />}
            {span && timeline && <TimingBar span={span} timeline={timeline} status={overall} />}
          </span>
          {span && <StepDuration span={span} running={overall === "running" || overall === "waiting"} />}
          {total && <StepCost cost={total} />}
          <span className={`text-xs ${overall === "succeeded" ? "sr-only sm:not-sr-only sm:shrink-0" : "shrink-0"} ${TEXT_COLOR[overall]}`}>{LABEL[overall]}</span>
        </summary>
        <ol className="divide-y divide-line border-t border-line">
          {items.map((cp) => <CheckpointRow key={`${cp.nodeId}:${cp.iteration}`} {...rowProps(cp, index)} item />)}
        </ol>
      </details>
    </li>
  );
}

function ModelChangeBadge({ change }: { change: WorkflowModelChange }) {
  return (
    <Badge variant="warning" className="mt-1 whitespace-normal break-words">
      {`Model changed since the last run: ${change.previous.join(", ")} → ${change.current.join(", ")}. The workflow was not edited.`}
    </Badge>
  );
}

/** Where the step sat in the run: a thin bar, offset by when it started. */
function TimingBar({ span, timeline, status }: { span: { start: number; end: number }; timeline: RunTimeline; status: NodeRunStatus }) {
  const total = Math.max(timeline.end - timeline.start, 1);
  const left = Math.min(Math.max((span.start - timeline.start) / total, 0), 1);
  const width = Math.min(Math.max((span.end - span.start) / total, 0), 1 - left);
  return (
    <span className="relative mt-1.5 block h-1 max-w-sm overflow-hidden rounded-full bg-ink-wash" aria-hidden>
      <span className={`absolute inset-y-0 rounded-full ${BAR_COLOR[status]}`}
        style={{ left: `${left * 100}%`, width: `max(${width * 100}%, 2px)` }} />
    </span>
  );
}

function StepDuration({ span, running }: { span: { start: number; end: number }; running: boolean }) {
  const text = formatRunDuration(span.start, span.end);
  if (!text) return null;
  return (
    <span className="shrink-0 text-xs tabular-nums text-muted" title={`Started ${new Date(span.start).toLocaleString()}`}>
      {running ? `${text} so far` : text}
    </span>
  );
}

function CheckpointRow({ checkpoint, cost, modelChange, number, promoted, waiting, onExplainFailure, timeline, now, item = false }: {
  checkpoint: CheckpointLike;
  cost?: WorkflowStepCost;
  modelChange?: WorkflowModelChange;
  number: number;
  promoted: boolean;
  waiting: boolean;
  onExplainFailure?: (nodeId: string, iteration: number) => void;
  timeline?: RunTimeline;
  now: number;
  /** A row inside a step's item list: named by its item number. */
  item?: boolean;
}) {
  const [showLogs, setShowLogs] = useState(false);
  const status = waiting ? "waiting" : toRunStatus(checkpoint.status);
  const denied = deniedResult(checkpoint.result);
  const output = formatRunOutput(checkpoint.result);
  const open = (status === "failed" && !promoted) || status === "running" || waiting || Boolean(denied);
  const span = stepSpan(checkpoint, now);

  return (
    <li className="min-w-0 bg-paper">
      <details className="group" open={open}>
        <summary className="flex min-h-11 cursor-pointer list-none items-baseline gap-3 px-4 py-3 hover:bg-ink-wash [&::-webkit-details-marker]:hidden">
          <span className="text-muted transition-transform group-open:rotate-90" aria-hidden>›</span>
          <span className="w-5 shrink-0 text-xs text-muted tabular-nums" aria-hidden>{item ? "" : number}</span>
          <span className={`shrink-0 text-sm ${TEXT_COLOR[status]}`} aria-hidden>{RUN_STATUS_GLYPH[status]}</span>
          <span className="min-w-0 flex-1">
            <span className="block break-words text-sm font-medium text-ink" title={checkpoint.nodeId}>
              {item ? `Item ${checkpoint.iteration + 1}` : humanize(checkpoint.nodeId)}
            </span>
            {cost && cost.models.length > 0 && <span className="block break-words text-xs text-muted">{cost.models.join(", ")}</span>}
            {modelChange && <ModelChangeBadge change={modelChange} />}
            {span && timeline && <TimingBar span={span} timeline={timeline} status={status} />}
          </span>
          {!item && checkpoint.iteration > 0 && <span className="shrink-0 text-xs text-muted">Item {checkpoint.iteration + 1}</span>}
          {checkpoint.reused && <span className="shrink-0 text-xs text-muted" title="This retry reused the step's result from the earlier run.">Reused</span>}
          {span && <StepDuration span={span} running={status === "running" || waiting} />}
          {cost && <StepCost cost={cost} />}
          {/* On a phone the ✓ alone says Completed, so that label gives the
              name its room. A denied step also shows ✓, so it and every
              other state keep their label. */}
          <span className={`text-xs ${status === "succeeded" && !denied ? "sr-only sm:not-sr-only sm:shrink-0" : "shrink-0"} ${TEXT_COLOR[status]}`}>{denied ? "Denied" : LABEL[status]}</span>
        </summary>
        <div className="min-w-0 space-y-3 border-t border-line px-4 py-3 sm:pl-16">
          {(checkpoint.threadId || checkpoint.sessionId || checkpoint.childRunId) && (
            <div className="flex flex-wrap gap-x-4 text-xs">
              {checkpoint.sessionId && checkpoint.threadId && checkpoint.queueItemId ? (
                <button type="button" aria-expanded={showLogs} onClick={() => setShowLogs(!showLogs)} className="inline-flex min-h-11 items-center text-accent hover:underline sm:min-h-0">
                  {showLogs ? "Hide agent logs" : "View agent logs"}
                </button>
              ) : (checkpoint.sessionId || checkpoint.threadId) && (
                <span className="text-muted">Scoped agent logs were not recorded for this step.</span>
              )}
              {checkpoint.childRunId && (
                <Link to="/workflows/runs/$runId" params={{ runId: checkpoint.childRunId }} className="inline-flex min-h-11 items-center text-accent hover:underline sm:min-h-0">
                  Open child run
                </Link>
              )}
            </div>
          )}
          {showLogs && checkpoint.sessionId && checkpoint.threadId && checkpoint.queueItemId && (
            <StepLogs key={`${checkpoint.sessionId}:${checkpoint.threadId}:${checkpoint.queueItemId}`}
              sessionId={checkpoint.sessionId} threadId={checkpoint.threadId} queueItemId={checkpoint.queueItemId}
              active={status === "running" || waiting} />
          )}
          {denied ? (
            <p className="break-words text-xs text-danger-500">Denied by {denied.resolvedBy ?? "policy"}</p>
          ) : output ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-medium text-muted">Result</h3>
                <CopyButton getText={() => output.text} label="Copy result" className="opacity-100" />
              </div>
              <pre className="max-h-96 overflow-auto rounded bg-[--bg] p-3 font-mono text-xs text-ink">{output.text}</pre>
            </>
          ) : (
            <p className="text-xs text-muted">{status === "running" || waiting ? "This step has not produced output yet." : "No output recorded for this step."}</p>
          )}
        </div>
      </details>
      {checkpoint.error != null && <p className="break-words px-4 pb-3 text-xs text-danger-500 sm:pl-16">{checkpoint.error}</p>}
      {status === "failed" && onExplainFailure && (
        <div className="px-4 pb-3 sm:pl-16">
          <Button size="sm" variant="secondary" onClick={() => onExplainFailure(checkpoint.nodeId, checkpoint.iteration)}>
            Explain this failure
          </Button>
        </div>
      )}
    </li>
  );
}

/** What the step's model calls cost. Unpriced calls make it a lower bound. */
function StepCost({ cost }: { cost: WorkflowStepCost }) {
  const unpriced = cost.unpricedTurns > 0;
  const detail = `${formatTokens(cost.totalTokens)} tokens over ${cost.turns} ${cost.turns === 1 ? "call" : "calls"}`
    + (unpriced ? ` · ${cost.unpricedTurns} unpriced` : "");
  return (
    <span className="shrink-0 text-xs tabular-nums text-muted" title={detail}>
      {formatUsdPrecise(cost.costUsd)}{unpriced ? "+" : ""}
      <span className="sr-only"> model spend, {detail}</span>
    </span>
  );
}
