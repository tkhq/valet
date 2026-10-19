import { Link } from "@tanstack/react-router";
import { ClipboardCheck } from "lucide-react";
import type { ReactNode } from "react";
import { resultText, structuredResult, type ToolRenderer, type ToolRendererProps } from "./types";
import { ToolBody } from "./tool-shell";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
type Row = readonly [string, ReactNode];

/** A proposal's facts as a term list. Each term appears once, so the term keys its row. */
function ProposalSummary({ when, scope, result, destination, workflowId, follow, audience }: {
  when: ReactNode;
  scope: ReactNode;
  result: ReactNode;
  destination: ReactNode;
  workflowId?: string;
  follow?: boolean;
  audience?: string;
}) {
  const rows: Row[] = [
    ["When", when], ["Scope", scope], ["Result", result], ["Destination", destination],
    ...(follow !== undefined ? [["Replies", follow ? "Also deliver later replies from the source thread" : "Act only on events that match these filters"] as const] : []),
    ...(audience ? [["Audience", audience === "team" ? "Team members" : "Anyone in the organization"] as const] : []),
    ["Permissions", workflowId
      ? <span><a className="text-moss underline" href={`/workflows/${encodeURIComponent(workflowId)}`} target="_blank" rel="noreferrer">Review workflow permissions</a>. Turning it on grants no new access. Valet checks dynamic actions when they run.</span>
      : "Uses this workspace's existing access. Turning it on grants nothing new."],
  ];
  return <dl aria-label="Summary" className="divide-y divide-line rounded-lg border border-line px-3">
    {rows.map(([label, value]) => <div key={label} className="grid gap-1 py-3 text-sm sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-muted">{label}</dt><dd className="min-w-0 break-words">{value || "Not configured"}</dd>
    </div>)}
  </dl>;
}

const ids = ["events.propose_subscription", "workflows.propose_trigger", "workflows.propose_schedule"];
function ProposalBody({ result }: ToolRendererProps) {
  const data = record(structuredResult(result));
  const proposal = record(data?.proposal) ?? record(record(data?.data)?.proposal);
  if (!proposal || typeof proposal.id !== "string" || (proposal.kind !== "subscription" && proposal.kind !== "schedule")) return <ToolBody>{resultText(result)}</ToolBody>;
  const config = record(proposal.config);
  const target = record(config?.target);
  const keys = Array.isArray(config?.eventKeys) ? config.eventKeys.filter((key): key is string => typeof key === "string") : [];
  const filters = Array.isArray(config?.filters) ? config.filters.flatMap(filter => {
    const row = record(filter);
    return row && typeof row.field === "string" ? [`${row.field} ${String(row.op ?? "eq")}: ${String(row.label ?? row.value)}`] : [];
  }) : [];
  const schedule = proposal.kind === "schedule";
  const workflowId = typeof config?.workflowId === "string" ? config.workflowId : typeof target?.workflowId === "string" ? target.workflowId : undefined;
  return <div className="space-y-3 p-3">
    <ProposalSummary follow={typeof target?.follow === "boolean" ? target.follow : undefined} audience={typeof config?.audience === "string" ? config.audience : undefined} workflowId={workflowId} when={schedule ? `${String(config?.cron ?? "")} (${String(config?.timezone ?? "")})` : keys.join(", ")}
      scope={filters.join("; ") || "Selected workspace"}
      result={String(target?.userPromptTemplate ?? config?.prompt ?? (workflowId ? "Run workflow" : "Send matching events to the assistant"))}
      destination={workflowId ?? "Workspace assistant"} />
    <p className="text-xs text-muted">Open the saved configuration to review its current settings. This preview does not grant permissions.</p>
    {schedule ? <Link className="text-sm text-moss underline" to="/presence/routines/$id" params={{ id: proposal.id }}>Review routine</Link>
      : <Link className="text-sm text-moss underline" to="/presence/rules/$id" params={{ id: proposal.id }}>Review</Link>}
  </div>;
}
export const automationProposalRenderer: ToolRenderer = {
  matches: (name, args) => ids.some(id => name === id.replace(".", "__") || (name === "call_tool" && record(args)?.tool_id === id)),
  category: "write", Icon: ClipboardCheck,
  formatTarget: () => "Proposal",
  Body: ProposalBody,
};
