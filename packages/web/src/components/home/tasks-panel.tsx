import { useState } from "react";
import { Check, CheckCheck, CircleAlert, LoaderCircle } from "lucide-react";
import type { HomeTaskItem } from "@valet/api/wire";
import { useDismissHomeTask, useHomeTasks } from "~/api/home";
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
 * The person's tasks across their workspaces: approvals, threads waiting on
 * them, work in progress, and finished tasks they started from home. Only the
 * person marks a task done. Every row has a Mark done control that crosses it
 * out, whether it is done or no longer relevant; running work keeps running.
 * Done stays collapsed: it holds what Valet finished and the person has not
 * confirmed.
 */
export function TasksPanel({ className }: { className?: string }) {
  const tasks = useHomeTasks();
  const dismiss = useDismissHomeTask();
  const data = tasks.data;
  const empty = data && data.needsYou.length + data.working.length + data.finished.length === 0;
  const approvals = usePendingApprovalCount();
  const markDone = (item: HomeTaskItem) => dismiss.mutate({ sessionId: item.sessionId, threadId: item.threadId });
  const crossOut = (item: HomeTaskItem) => <Button size="iconSm" variant="ghost" aria-label={`Mark done: ${item.title}`} title="Mark done"
    onClick={() => markDone(item)}><Check aria-hidden className="h-4 w-4" /></Button>;
  return <div className={cn("space-y-7", className)}>
    {data && <TasksSummary needsYou={data.needsYou.length + approvals.count} working={data.working.length} finished={data.finished.length} />}
    <ApprovalsInbox />
    {tasks.isPending && <LoadingRow label="Loading tasks…" />}
    {tasks.isError && <ErrorRow>Could not load tasks. <button type="button" className="underline" onClick={() => void tasks.refetch()}>Retry</button></ErrorRow>}
    {data && data.needsYou.length > 0 && <Section title="Waiting on you" icon={<CircleAlert className="h-4 w-4 text-amber" />} items={data.needsYou} actions={crossOut} />}
    {data && data.working.length > 0 && <Section title="In progress" icon={<LoaderCircle className="h-4 w-4 text-moss" />} items={data.working} actions={crossOut} />}
    {data && data.finished.length > 0 && <Section title="Done" icon={<CheckCheck className="h-4 w-4 text-moss" />} items={data.finished} collapsible
      actions={item => <Button size="sm" variant="secondary" onClick={() => markDone(item)}>Mark done</Button>} />}
    {empty && <p className="text-sm text-muted">Nothing is in flight. Ask Valet for something in Chat.</p>}
    <UpdatesList />
  </div>;
}

/** Rows a section shows before "Show more": Tasks stays short enough to read at a glance. */
const SECTION_LIMIT = 5;

function Section({ title, icon, items, actions, collapsible = false }: {
  title: string; icon: React.ReactNode; items: HomeTaskItem[]; actions: (item: HomeTaskItem) => React.ReactNode;
  /** Starts closed behind a Show control. */
  collapsible?: boolean;
}) {
  const [shown, setShown] = useState(!collapsible);
  const [open, setOpen] = useState(false);
  const hidden = open ? 0 : Math.max(0, items.length - SECTION_LIMIT);
  const toggle = collapsible && <Button size="sm" variant="ghost" aria-expanded={shown} onClick={() => setShown(!shown)}>{shown ? "Hide" : "Show"}</Button>;
  if (!shown) return <WorkSection title={title} icon={icon} count={items.length} actions={toggle} bare>{null}</WorkSection>;
  return <WorkSection title={title} icon={icon} count={items.length} actions={toggle || undefined}>
    {(hidden ? items.slice(0, SECTION_LIMIT) : items).map(item => <TaskRow key={item.id} item={item} actions={actions(item)} />)}
    {hidden > 0 && <div className="px-4 py-2 sm:pl-5"><Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Show {hidden} more</Button></div>}
  </WorkSection>;
}
