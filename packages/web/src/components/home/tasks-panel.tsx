import { useState } from "react";
import { CheckCheck, CircleAlert, LoaderCircle, MessageSquare } from "lucide-react";
import type { HomeTaskItem } from "@valet/api/wire";
import { useHomeTasks, useMarkHomeTaskDone } from "~/api/home";
import { Button, ErrorRow, LoadingRow, WorkSection } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { ApprovalsInbox, UpdatesList, usePendingApprovalCount } from "./approvals-inbox";
import { TaskRow } from "./task-row";
import { TasksSummary } from "./tasks-summary";

/** How many things need the person: approvals plus threads that ask them something. */
export function useNeedsYouCount(): { count: number; partial: boolean } {
  const tasks = useHomeTasks();
  const approvals = usePendingApprovalCount();
  return { count: approvals.count + (tasks.data?.needsYou.length ?? 0), partial: approvals.partial };
}

/**
 * Everything in flight across the person's workspaces, sorted for action:
 * approvals, threads that need them, work in progress, replies they have
 * not answered, and finished tasks they started from home. Only the person
 * marks a home task done; Valet only reports that it finished.
 */
export function TasksPanel({ className }: { className?: string }) {
  const tasks = useHomeTasks();
  const markDone = useMarkHomeTaskDone();
  const data = tasks.data;
  const empty = data && data.needsYou.length + data.working.length + data.updates.length + data.finished.length === 0;
  const approvals = usePendingApprovalCount();
  return <div className={cn("space-y-7", className)}>
    {data && <TasksSummary needsYou={data.needsYou.length + approvals.count} working={data.working.length} finished={data.finished.length} />}
    <ApprovalsInbox />
    {tasks.isPending && <LoadingRow label="Loading tasks…" />}
    {tasks.isError && <ErrorRow>Could not load tasks. <button type="button" className="underline" onClick={() => void tasks.refetch()}>Retry</button></ErrorRow>}
    {data && data.needsYou.length > 0 && <Section title="Needs you" icon={<CircleAlert className="h-4 w-4 text-amber" />} items={data.needsYou} />}
    {data && data.working.length > 0 && <Section title="In progress" icon={<LoaderCircle className="h-4 w-4 text-moss" />} items={data.working} />}
    {data && data.updates.length > 0 && <Section title="Replies" icon={<MessageSquare className="h-4 w-4 text-muted" />} items={data.updates} />}
    {data && data.finished.length > 0 && <Section title="Finished" icon={<CheckCheck className="h-4 w-4 text-moss" />} items={data.finished}
      actions={item => item.homeTaskId && <Button size="sm" variant="secondary" disabled={markDone.isPending}
        onClick={() => item.homeTaskId && markDone.mutate(item.homeTaskId)}>Mark done</Button>} />}
    {empty && <p className="text-sm text-muted">Nothing is in flight. Ask Valet for something in Chat.</p>}
    <UpdatesList />
  </div>;
}

/** Rows a section shows before "Show more": Tasks stays short enough to read at a glance. */
const SECTION_LIMIT = 5;

function Section({ title, icon, items, actions }: {
  title: string; icon: React.ReactNode; items: HomeTaskItem[]; actions?: (item: HomeTaskItem) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const hidden = open ? 0 : Math.max(0, items.length - SECTION_LIMIT);
  return <WorkSection title={title} icon={icon} count={items.length}>
    {(hidden ? items.slice(0, SECTION_LIMIT) : items).map(item => <TaskRow key={item.id} item={item} actions={actions?.(item)} />)}
    {hidden > 0 && <div className="px-4 py-2 sm:pl-5"><Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Show {hidden} more</Button></div>}
  </WorkSection>;
}
