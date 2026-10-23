import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { NotificationSummary } from "@valet/api/wire";
import { useMarkAllNotificationsRead, useMarkNotificationRead, useNotifications, useNotificationDecisions } from "~/api/queries";
import { useWorkflowActionRequired } from "~/api/workflows";
import { Badge, LoadingRow, StatusDot, Time, textLinkClass } from "~/components/primitives";
import { WorkflowApprovalItem } from "~/components/workflows/workflow-approval-item";
import { DecisionGateCard } from "~/components/session/decision-gate-card";
import { cn } from "~/lib/cn";
import { listedKeys } from "./bulk-answers";
import { NeedsActionHeader, useBulkAnswerRun } from "./needs-action-header";

/** Unread updates, newest first, one row per title: a workflow that fails
 * every few minutes is one row with a count, not a list. Read updates leave
 * the list, so "Mark all read" clears it. */
export function groupUpdates(updates: readonly NotificationSummary[]): Array<{ latest: NotificationSummary; ids: string[] }> {
  const groups = new Map<string, { latest: NotificationSummary; ids: string[] }>();
  for (const n of updates) {
    if (n.readAt !== undefined) continue;
    const group = groups.get(n.title);
    if (!group) groups.set(n.title, { latest: n, ids: [n.id] });
    else {
      group.ids.push(n.id);
      if (n.createdAt > group.latest.createdAt) group.latest = n;
    }
  }
  return [...groups.values()].sort((a, b) => b.latest.createdAt - a.latest.createdAt);
}

/** How many approvals wait across every workspace, for the Tasks badge. */
export function usePendingApprovalCount(): { count: number; partial: boolean } {
  const workflows = useWorkflowActionRequired();
  const summary = useNotificationDecisions();
  return { count: (workflows.data?.count ?? 0) + (summary.data?.items.length ?? 0), partial: !!summary.data?.nextCursor };
}

/**
 * Every approval and question waiting on the person, across all workspaces:
 * thread decisions and workflow approvals, with "Approve all" and "Deny
 * all" for the ones a bulk answer may cover. Renders nothing when nothing
 * waits, so Tasks shows only what needs the person.
 */
export function ApprovalsInbox() {
  const workflows = useWorkflowActionRequired();
  const [decisionCursor, setDecisionCursor] = useState<string>();
  const summary = useNotificationDecisions();
  const page = useNotificationDecisions(decisionCursor, !!decisionCursor);
  const decisions = decisionCursor ? page : summary;
  const moreDecisions = decisions.data?.nextCursor;
  const partialCount = !!summary.data?.nextCursor;
  const pendingCount = (workflows.data?.count ?? 0) + (summary.data?.items.length ?? 0);
  const loading = workflows.isLoading || decisions.isLoading;
  const failed = workflows.isError || decisions.isError;
  // After a bulk run, refetch the lists it covered. An item still listed was
  // not answered, whatever its response said.
  const bulkRun = useBulkAnswerRun(async () => {
    const [w, d] = await Promise.all([workflows.refetch(), decisionCursor ? page.refetch() : summary.refetch()]);
    if (decisionCursor) void summary.refetch();
    if (w.isError || d.isError) return undefined;
    return listedKeys(w.data?.items ?? [], d.data?.items ?? []);
  });
  if (!loading && !failed && pendingCount === 0 && !moreDecisions && !decisionCursor && bulkRun.progress === null && !bulkRun.summary) return null;
  return (
    <section aria-label="Approvals" className="space-y-3">
      <NeedsActionHeader pendingCount={pendingCount} partialCount={partialCount} workflows={workflows.data?.items ?? []}
        decisions={decisions.data?.items ?? []} partial={!!moreDecisions || !!decisionCursor} run={bulkRun} />
      {loading && <LoadingRow label="Loading approvals…" className="py-0" />}
      {failed && <div role="alert" className="text-sm text-danger-500">Could not load all approvals. <button type="button" className={textLinkClass} onClick={() => { void workflows.refetch(); void decisions.refetch(); }}>Retry</button></div>}
      <ul className="space-y-3">{workflows.data?.items.map(item => <WorkflowApprovalItem key={item.id} item={item} />)}</ul>
      {decisionCursor && <button type="button" className={cn(textLinkClass, "text-sm")} onClick={() => setDecisionCursor(undefined)}>First approvals</button>}
      {moreDecisions && <button type="button" className={cn(textLinkClass, "text-sm")} onClick={() => setDecisionCursor(moreDecisions)}>Next approvals</button>}
      {decisions.data?.items.map(item => <article key={item.gate.id} className="min-w-0 rounded-lg border border-line bg-paper">
        <div className="flex min-w-0 items-start justify-between gap-3 px-4 pt-3">
          <span className="min-w-0 break-words text-xs text-muted [overflow-wrap:anywhere]">{item.title}</span>
          {item.canOpenThread !== false && <a className="inline-flex shrink-0 items-center gap-1 text-xs text-muted hover:text-ink hover:underline max-sm:min-h-11" href={`/threads/${encodeURIComponent(item.gate.threadId)}`}>
            Open thread <ArrowUpRight aria-hidden className="h-3 w-3" />
          </a>}
        </div>
        <DecisionGateCard sessionId={item.sessionId} gate={item.gate} placement="notification" />
      </article>)}
    </section>
  );
}

/** Unread notices (a failed workflow, a stuck turn), one row per title. */
export function UpdatesList() {
  const notifications = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();
  // Approval state comes from gates. Historical notification copies do not create another inbox item.
  const updates = groupUpdates((notifications.data?.notifications ?? []).filter(n => n.kind !== "approval"));
  async function openUpdate({ latest, ids }: { latest: NotificationSummary; ids: string[] }) {
    try { await Promise.all(ids.map(id => markRead.mutateAsync(id))); }
    finally { if (latest.href) window.location.assign(latest.href); }
  }
  if (!notifications.isError && updates.length === 0) return null;
  return (
    <section aria-label="Notices" className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg">Notices</h2>
        {updates.length > 0 && <button type="button" className={cn(textLinkClass, "text-xs max-sm:min-h-11")} onClick={() => markAllRead.mutate()}>Mark all read</button>}
      </div>
      {notifications.isError && <p role="alert" className="text-sm text-danger-500">Could not load notices. <button type="button" className={textLinkClass} onClick={() => void notifications.refetch()}>Retry</button></p>}
      {updates.map(group => <button type="button" key={group.latest.id} onClick={() => void openUpdate(group)} className="block w-full rounded-md p-2 text-left hover:bg-ink-wash max-sm:min-h-11">
        <span className="flex items-center gap-2"><StatusDot tone="info" size="sm" /><span className="min-w-0 truncate text-sm font-medium" title={group.latest.title}>{group.latest.title}</span>
          {group.ids.length > 1 && <Badge variant="neutral">{group.ids.length}</Badge>}</span>
        <Time ts={group.latest.createdAt} className="text-xs text-muted" />
      </button>)}
    </section>
  );
}
