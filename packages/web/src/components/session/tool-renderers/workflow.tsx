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
export function workflowRefsFrom(result: unknown): WorkflowRefs {
  const text = resultText(result);
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const obj = parsed as Record<string, unknown>;
  const refs: WorkflowRefs = {};
  if (typeof obj.workflowId === "string") refs.workflowId = obj.workflowId;
  if (typeof obj.runId === "string") refs.runId = obj.runId;
  return refs;
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
      {pending && <ApprovalCard runId={runId} nodeId={pending.nodeId} prompt={prompt} />}
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

function WorkflowToolBody({ args, result, status, error }: ToolRendererProps) {
  const refs = { ...workflowRefsFromArgs(args), ...workflowRefsFrom(result) };

  if (status === "running") {
    return <Skeleton label="Working on the workflow…" />;
  }
  if (refs.runId) return <RunBody runId={refs.runId} />;
  if (refs.workflowId) return <DefinitionBody workflowId={refs.workflowId} />;

  // No ids (e.g. list_workflows, or a failed call) → plain text body.
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
