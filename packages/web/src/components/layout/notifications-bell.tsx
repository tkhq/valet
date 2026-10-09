import { useState } from "react";
import { Bell, X } from "lucide-react";
import type { NotificationSummary } from "@valet/api/wire";
import { useMarkAllNotificationsRead, useMarkNotificationRead, useNotifications, useNotificationDecisions } from "~/api/queries";
import { useWorkflowActionRequired } from "~/api/workflows";
import { Badge, Button, Popover, PopoverContent, PopoverTrigger, StatusDot } from "~/components/primitives";
import { WorkflowApprovalItem } from "~/components/workflows/workflow-approval-item";
import { DecisionGateCard } from "~/components/session/decision-gate-card";
import { relativeTime } from "~/lib/relative-time";
import { NeedsActionHeader } from "./needs-action-header";

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

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const notifications = useNotifications();
  const workflows = useWorkflowActionRequired();
  const [decisionCursor, setDecisionCursor] = useState<string>();
  const summary = useNotificationDecisions();
  const page = useNotificationDecisions(decisionCursor, open && !!decisionCursor);
  const decisions = decisionCursor ? page : summary;
  const moreDecisions = decisions.data?.nextCursor;
  const partialCount = !!summary.data?.nextCursor;
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();
  const pendingCount = (workflows.data?.count ?? 0) + (summary.data?.items.length ?? 0);
  // Approval state comes from gates. Historical notification copies do not create another inbox item.
  const updates = groupUpdates((notifications.data?.notifications ?? []).filter(n => n.kind !== "approval"));
  const unread = updates.length;
  const loading = workflows.isLoading || decisions.isLoading;
  const failed = workflows.isError || decisions.isError;
  function changeOpen(value: boolean) {
    setOpen(value);
    if (!value) setDecisionCursor(undefined);
    if (value) { void notifications.refetch(); void workflows.refetch(); void decisions.refetch(); }
  }
  async function openUpdate({ latest, ids }: { latest: NotificationSummary; ids: string[] }) {
    try { await Promise.all(ids.map(id => markRead.mutateAsync(id))); }
    finally { if (latest.href) window.location.assign(latest.href); }
  }
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="relative px-2" aria-label={pendingCount || partialCount ? `Notifications: ${pendingCount}${partialCount ? "+" : ""} pending approvals` : "Notifications"}>
          <Bell className={`h-4 w-4 ${pendingCount ? "text-warning-fg" : ""}`} aria-hidden />
          {pendingCount > 0 || partialCount ? <Badge variant="warning" className="absolute -right-1 -top-1 px-1 py-0 text-[10px]">{pendingCount}{partialCount ? "+" : ""}</Badge>
            : unread > 0 && <StatusDot tone="accent" size="sm" className="absolute right-1 top-1" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Notifications" className="w-[520px] max-h-[min(720px,calc(100dvh-6rem))] bg-paper p-0">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-paper px-4 py-3">
          <h2 className="font-semibold">Notifications</h2>
          <Button variant="ghost" size="sm" aria-label="Close notifications" onClick={() => changeOpen(false)}><X className="h-4 w-4" /></Button>
        </div>
        <section aria-label="Needs action" className="space-y-3 p-4">
          <NeedsActionHeader pendingCount={pendingCount} partialCount={partialCount} workflows={workflows.data?.items ?? []}
            decisions={decisions.data?.items ?? []} partial={!!moreDecisions || !!decisionCursor}
            onSettled={() => { void workflows.refetch(); void decisions.refetch(); }} />
          {loading && <p className="text-sm text-muted">Loading approvals…</p>}
          {failed && <div role="alert" className="text-sm text-danger-500">Could not load all approvals. <button className="underline" onClick={() => { void workflows.refetch(); void decisions.refetch(); }}>Retry</button></div>}
          {!loading && !failed && pendingCount === 0 && !moreDecisions && !decisionCursor && <p className="text-sm text-muted">You're all caught up. No decisions are waiting.</p>}
          <ul className="space-y-3">{workflows.data?.items.map(item => <WorkflowApprovalItem key={item.id} item={item} />)}</ul>
          {decisionCursor && <button className="text-sm underline" onClick={() => setDecisionCursor(undefined)}>First approvals</button>}
          {moreDecisions && <button className="text-sm underline" onClick={() => setDecisionCursor(moreDecisions)}>Next approvals</button>}
          {decisions.data?.items.map(item => <div key={item.gate.id} className="rounded-lg border border-line pb-3">
            <div className="px-3 pt-3 text-sm font-medium">{item.title}</div>
            <DecisionGateCard sessionId={item.sessionId} gate={item.gate} />
            {item.canOpenThread !== false && <a className="ml-3 mt-2 inline-block text-xs text-muted underline" href={`/threads/${encodeURIComponent(item.gate.threadId)}`}>Open thread</a>}
          </div>)}
        </section>
        <section aria-label="Updates" className="border-t border-line p-4 space-y-3">
          <div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Updates</h3>
            {unread > 0 && <button className="text-xs text-muted underline" onClick={() => markAllRead.mutate()}>Mark all read</button>}
          </div>
          {notifications.isError && <p role="alert" className="text-sm text-danger-500">Could not load updates. <button className="underline" onClick={() => void notifications.refetch()}>Retry</button></p>}
          {!notifications.isError && updates.length === 0 && <p className="text-sm text-muted">No new updates.</p>}
          {updates.map(group => <button key={group.latest.id} onClick={() => void openUpdate(group)} className="block w-full rounded-md p-2 text-left hover:bg-ink-wash">
            <span className="flex items-center gap-2"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500" /><span className="min-w-0 truncate text-sm font-medium">{group.latest.title}</span>
              {group.ids.length > 1 && <Badge variant="neutral">{group.ids.length}</Badge>}</span>
            <span className="text-xs text-muted">{relativeTime(group.latest.createdAt)}</span>
          </button>)}
        </section>
      </PopoverContent>
    </Popover>
  );
}
