import { Link } from "@tanstack/react-router";
import { CircleAlert, History } from "lucide-react";
import { useHomeTasks } from "~/api/home";
import { Button } from "~/components/primitives";
import { HomeEmptyState } from "./home-empty-state";
import { usePendingApprovalCount } from "./approvals-inbox";
import { TaskSection } from "./tasks-panel";
import { TasksSummary } from "./tasks-summary";

/** Rows "Recent work" shows; Tasks has the rest. */
const RECENT = 5;

/**
 * Desktop Home while it is idle: a greeting with starters, what is waiting on
 * the person, and recent work. It covers the transcript until the person
 * types, picks a starter, or a turn runs; "Show conversation" opens the
 * transcript at any time.
 */
export function HomeLanding({ sessionId, threadId, onShowConversation }: {
  sessionId: string; threadId: string; onShowConversation: () => void;
}) {
  const tasks = useHomeTasks();
  const approvals = usePendingApprovalCount();
  const data = tasks.data;
  const recent = data ? [...data.working, ...data.updates, ...data.finished].slice(0, RECENT) : [];
  return <div className="mx-auto w-full max-w-2xl space-y-7 px-6 pb-10">
    <HomeEmptyState sessionId={sessionId} threadId={threadId} title={greeting(new Date())} onPick={onShowConversation} />
    {data && <TasksSummary needsYou={data.needsYou.length + approvals.count} working={data.working.length} finished={data.finished.length} />}
    {data && data.needsYou.length > 0 && <TaskSection title="Waiting on you" icon={<CircleAlert className="h-4 w-4 text-amber" />} items={data.needsYou} />}
    {recent.length > 0 && <TaskSection title="Recent work" icon={<History className="h-4 w-4 text-muted" />} items={recent} />}
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <Button size="sm" variant="secondary" onClick={onShowConversation}>Show conversation</Button>
      <Link to="/overview" className="text-muted hover:text-ink hover:underline">Workspace overview</Link>
    </div>
  </div>;
}

export function greeting(now: Date): string {
  const hour = now.getHours();
  return hour < 5 ? "Working late?" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}
