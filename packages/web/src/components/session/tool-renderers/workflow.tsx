/**
 * Chat renderer for workflow tool calls (spec:
 * docs/specs/2026-07-31-workflow-chat-rendering-design.md). Workflow actions
 * reach the LLM through the plugin catalog, so on the wire they are
 * `call_tool` invocations with `args.tool_id = "workflows.*"` — this
 * renderer claims exactly that subset via the args-aware `matches` form.
 *
 * The Body fetches CURRENT state by id (never trusts the persisted result
 * blob beyond extracting ids): definitions via `useWorkflow`, runs via
 * `useRunDetail` (which already polls until settled). A parked run's
 * approval gate renders the same `ApprovalCard` the run detail page uses —
 * gated on the run actually being parked, so cards on settled runs never
 * show live buttons.
 */
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Workflow } from "lucide-react";
import { useRunDetail, useWorkflow } from "~/api/workflows";
import { ApprovalCard } from "~/components/workflows/approval-card";
import {
  findApprovalPrompt,
  findPendingApproval,
  statusByNodeId,
} from "~/components/workflows/run-detail-helpers";
import { WorkflowPreview } from "~/components/workflows/preview";
import { isWorkflowDefinitionShape } from "~/components/workflows/editor-model";
import { relativeTime } from "~/lib/relative-time";
import { resultText, type ToolRenderer, type ToolRendererProps } from "./types";
import { ToolBody } from "./tool-shell";

const WORKFLOW_TOOL_PREFIX = "workflows.";

interface CallToolArgs {
  tool_id?: unknown;
  params?: unknown;
}

function callToolArgs(args: unknown): CallToolArgs {
  return typeof args === "object" && args !== null ? (args as CallToolArgs) : {};
}

export function isWorkflowCallTool(toolName: string, args?: unknown): boolean {
  if (toolName !== "call_tool") return false;
  const toolId = callToolArgs(args).tool_id;
  return typeof toolId === "string" && toolId.startsWith(WORKFLOW_TOOL_PREFIX);
}

export interface WorkflowRefs {
  workflowId?: string;
  runId?: string;
}

/**
 * Ids out of a persisted `call_tool` result. Success results are
 * `{ text: JSON.stringify(PluginActionResult.data) }` (see the engine's
 * `actionResultToToolResult`), so parse the text and pull the id fields the
 * workflows actions always include. Failure/running/malformed → `{}`.
 */
/** Parse a persisted `call_tool` result's JSON payload, or null. */
export function parsedResultData(result: unknown): Record<string, unknown> | null {
  const text = resultText(result);
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function workflowRefsFrom(result: unknown): WorkflowRefs {
  const obj = parsedResultData(result);
  if (!obj) return {};
  const refs: WorkflowRefs = {};
  if (typeof obj.workflowId === "string") refs.workflowId = obj.workflowId;
  if (typeof obj.runId === "string") refs.runId = obj.runId;
  return refs;
}

export interface WorkflowListEntry {
  workflowId: string;
  name: string;
  updatedAt?: number;
}

/** Rows out of a `workflows.list_workflows` result, or null when the
 * result isn't that shape (failure text, other tools). */
export function workflowListFrom(result: unknown): WorkflowListEntry[] | null {
  const obj = parsedResultData(result);
  if (!obj || !Array.isArray(obj.workflows)) return null;
  const rows: WorkflowListEntry[] = [];
  for (const entry of obj.workflows) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.workflowId !== "string" || typeof e.name !== "string") continue;
    rows.push({
      workflowId: e.workflowId,
      name: e.name,
      ...(typeof e.updatedAt === "number" ? { updatedAt: e.updatedAt } : {}),
    });
  }
  return rows;
}

/**
 * Lint bullets out of a failed save/patch result. The api's
 * `formatLintErrors` emits `workflow definition failed validation (fix
 * these and retry):\n- …\n- …` (possibly behind a `workflows.x failed: `
 * prefix); returns the bullet list, or null when the text isn't that shape.
 */
export function parseLintErrors(text: string | undefined): string[] | null {
  if (!text) return null;
  const marker = "failed validation (fix these and retry):";
  const at = text.indexOf(marker);
  if (at === -1) return null;
  const bullets = text
    .slice(at + marker.length)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => (line.startsWith("- ") ? line.slice(2) : line));
  return bullets.length > 0 ? bullets : null;
}

/** The definition the agent TRIED to save, from the call's own params —
 * a failed save still deserves its DAG rendered next to the lint errors. */
export function attemptedDefinition(args: unknown): unknown {
  const params = callToolArgs(args).params;
  if (typeof params !== "object" || params === null) return null;
  return (params as Record<string, unknown>).definition ?? null;
}

/** Fallback refs from the call's own params, so an in-flight or failed call
 * can still point at the workflow it targeted. */
export function workflowRefsFromArgs(args: unknown): WorkflowRefs {
  const params = callToolArgs(args).params;
  if (typeof params !== "object" || params === null) return {};
  const p = params as Record<string, unknown>;
  const refs: WorkflowRefs = {};
  if (typeof p.workflow_id === "string") refs.workflowId = p.workflow_id;
  if (typeof p.run_id === "string") refs.runId = p.run_id;
  return refs;
}

function toolIdSuffix(args: unknown): string | undefined {
  const toolId = callToolArgs(args).tool_id;
  if (typeof toolId !== "string") return undefined;
  return toolId.startsWith(WORKFLOW_TOOL_PREFIX)
    ? toolId.slice(WORKFLOW_TOOL_PREFIX.length)
    : toolId;
}

function RunBody({ runId }: { runId: string }) {
  const { data, isLoading, error } = useRunDetail(runId);
  if (isLoading) return <Skeleton label="Loading run…" />;
  if (error || !data) return <Missing what="run" />;

  const { run, checkpoints } = data;
  const { status, badges } = statusByNodeId(run, checkpoints);
  const pending = run.status === "parked" ? findPendingApproval(run.waitingOn) : undefined;
  const prompt = pending ? findApprovalPrompt(run.definition, pending.nodeId) : undefined;
  const definition = run.definition;

  return (
    <div className="space-y-2 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted">run</span>
          <span className="font-mono text-ink truncate max-w-[220px]">{runId}</span>
          <StatusPill status={run.status} outcome={run.outcome ?? undefined} />
        </div>
        <Link
          to="/workflows/runs/$runId"
          params={{ runId }}
          className="inline-flex items-center gap-1 text-xs font-medium text-moss hover:text-moss/80 hover:underline"
        >
          Open run <ArrowUpRight size={12} />
        </Link>
      </div>
      {isWorkflowDefinitionShape(definition) && (
        <WorkflowPreview definition={definition} statusByNodeId={status} badgeByNodeId={badges} />
      )}
      <RunFailures checkpoints={checkpoints} />
      {pending && <ApprovalCard runId={runId} nodeId={pending.nodeId} prompt={prompt} />}
    </div>
  );
}

/** Latest failed checkpoint per node, so a failed run SHOWS its error
 * instead of just a red ring on the canvas. */
export function latestFailures(
  checkpoints: { nodeId: string; status: string; error?: string; createdAt: number }[],
): { nodeId: string; error: string }[] {
  const byNode = new Map<string, { error: string; createdAt: number }>();
  for (const cp of checkpoints) {
    if (cp.status !== "failed" || !cp.error) continue;
    const prev = byNode.get(cp.nodeId);
    if (!prev || cp.createdAt >= prev.createdAt) {
      byNode.set(cp.nodeId, { error: cp.error, createdAt: cp.createdAt });
    }
  }
  return [...byNode.entries()].map(([nodeId, v]) => ({ nodeId, error: v.error }));
}

function RunFailures({
  checkpoints,
}: {
  checkpoints: { nodeId: string; status: string; error?: string; createdAt: number }[];
}) {
  const failures = latestFailures(checkpoints);
  if (failures.length === 0) return null;
  return (
    <div className="rounded-md border border-rose-200 bg-rose-50/70 px-3 py-2 dark:border-rose-900/60 dark:bg-rose-950/40">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-danger-500">
        {failures.length === 1 ? "Node failure" : `${failures.length} node failures`}
      </div>
      <ul className="space-y-1.5">
        {failures.map((f) => (
          <li key={f.nodeId} className="text-xs leading-snug">
            <span className="font-mono text-ink">{f.nodeId}</span>
            <span className="text-muted"> — </span>
            <span className="whitespace-pre-wrap break-words text-danger-500">{f.error}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Rich body for a failed save/patch: the DAG the agent attempted (when it
 * parses) above the structured lint list — not a wall of raw text. */
function LintErrorsBody({ errors, attempted }: { errors: string[]; attempted: unknown }) {
  return (
    <div className="space-y-2 px-3 py-2">
      {isWorkflowDefinitionShape(attempted) && <WorkflowPreview definition={attempted} />}
      <div className="rounded-md border border-rose-200 bg-rose-50/70 px-3 py-2 dark:border-rose-900/60 dark:bg-rose-950/40">
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-danger-500">
          Validation failed — {errors.length} issue{errors.length === 1 ? "" : "s"}, nothing saved
        </div>
        <ul className="list-disc space-y-1 pl-4">
          {errors.map((e, i) => (
            <li key={i} className="text-xs leading-snug text-ink">
              {e}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function StatusPill({ status, outcome }: { status: string; outcome?: string }) {
  const label = outcome ?? status;
  const tone =
    outcome === "completed"
      ? "bg-moss-wash text-moss"
      : outcome === "failed"
        ? "bg-danger-500/10 text-danger-500"
        : status === "parked"
          ? "bg-amber/10 text-amber"
          : status === "running"
            ? "bg-moss-wash text-moss"
            : "bg-neutral-500/10 text-muted";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${tone}`}>
      {label}
    </span>
  );
}

function DefinitionBody({ workflowId }: { workflowId: string }) {
  const { data, isLoading, error } = useWorkflow(workflowId);
  if (isLoading) return <Skeleton label="Loading workflow…" />;
  if (error || !data) return <Missing what="workflow" />;

  const definition = data.definition;
  return (
    <div className="space-y-2 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs min-w-0">
          <span className="font-medium text-ink truncate">{data.name}</span>
          <span className="text-muted whitespace-nowrap">
            updated {new Date(data.updatedAt).toLocaleString()}
          </span>
        </div>
        <Link
          to="/workflows/$workflowId"
          params={{ workflowId }}
          className="inline-flex items-center gap-1 text-xs font-medium text-moss hover:text-moss/80 hover:underline"
        >
          Open <ArrowUpRight size={12} />
        </Link>
      </div>
      {isWorkflowDefinitionShape(definition) ? (
        <WorkflowPreview definition={definition} />
      ) : (
        <div className="text-xs text-muted">Definition is not a dag/v1 workflow.</div>
      )}
    </div>
  );
}

function Skeleton({ label }: { label: string }) {
  return (
    <div className="m-3 flex h-24 animate-pulse items-center justify-center rounded-md border border-line bg-paper text-xs text-muted">
      {label}
    </div>
  );
}

function Missing({ what }: { what: "workflow" | "run" }) {
  return (
    <div className="m-3 rounded-md border border-line bg-paper px-3 py-2 text-xs text-muted">
      This {what} no longer exists.
    </div>
  );
}

function WorkflowListBody({ rows }: { rows: WorkflowListEntry[] }) {
  if (rows.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-muted">
        No workflows yet — save one to get started.
      </div>
    );
  }
  return (
    <div className="px-3 py-2">
      <ul className="divide-y divide-line/60 rounded-md border border-line">
        {rows.map((w) => (
          <li key={w.workflowId}>
            <Link
              to="/workflows/$workflowId"
              params={{ workflowId: w.workflowId }}
              className="flex items-center gap-3 px-3 py-1.5 hover:bg-ink-wash/60 transition-colors"
            >
              <span className="flex-1 truncate text-sm text-ink">{w.name}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted/70">{w.workflowId}</span>
              {w.updatedAt !== undefined && (
                <span className="shrink-0 text-xs text-muted">{relativeTime(w.updatedAt)}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function WorkflowToolBody({ args, result, status, error }: ToolRendererProps) {
  const refs = { ...workflowRefsFromArgs(args), ...workflowRefsFrom(result) };

  if (status === "running") {
    return <Skeleton label="Working on the workflow…" />;
  }

  // list_workflows → compact linked table, not raw JSON.
  if (toolIdSuffix(args) === "list_workflows") {
    const rows = workflowListFrom(result);
    if (rows) return <WorkflowListBody rows={rows} />;
  }

  // A save/patch rejected by the linter → attempted DAG + structured list.
  const lintErrors = parseLintErrors(error ?? resultText(result));
  if (lintErrors) {
    return <LintErrorsBody errors={lintErrors} attempted={attemptedDefinition(args)} />;
  }

  if (refs.runId) return <RunBody runId={refs.runId} />;
  if (refs.workflowId) return <DefinitionBody workflowId={refs.workflowId} />;

  // No ids (e.g. a failed call) → plain text body.
  return <ToolBody>{error ?? resultText(result)}</ToolBody>;
}

export const workflowRenderer: ToolRenderer = {
  matches: isWorkflowCallTool,
  category: "write",
  Icon: Workflow,
  formatTarget: (args) => toolIdSuffix(args),
  formatSummary: (args, result) => {
    const refs = { ...workflowRefsFromArgs(args), ...workflowRefsFrom(result) };
    return refs.runId ?? refs.workflowId;
  },
  Body: WorkflowToolBody,
};
