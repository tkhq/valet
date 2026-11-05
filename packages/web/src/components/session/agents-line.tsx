import { useNavigate } from "@tanstack/react-router";
import { Bot } from "lucide-react";
import type { ChildWorkSummary } from "@valet/api/wire";
import { TraceLine, TraceList, TraceStep } from "~/components/primitives";

/** Steps one agents line lists; the sidebar holds the rest. */
const SHOWN = 8;

/** Pure: the children one thread started, running ones first. */
export function threadChildren(children: readonly ChildWorkSummary[], threadId: string | undefined): ChildWorkSummary[] {
  if (!threadId) return [];
  const mine = children.filter(child => child.parentThreadId === threadId);
  return [...mine.filter(child => child.status === "running"), ...mine.filter(child => child.status !== "running")];
}

/**
 * The agents this thread started, as one line while any of them runs:
 * "2 agents working · Review retry coverage" (after the shadcn/ui Subagent
 * pattern). It opens to one step per agent, and a step opens that agent.
 * The line goes away once they all finish; each finished agent reports in
 * the thread.
 */
export function AgentsLine({ children, threadId, onOpenChild }: {
  children: readonly ChildWorkSummary[];
  threadId?: string;
  onOpenChild?: (childSessionId: string) => void;
}) {
  const navigate = useNavigate();
  const listed = threadChildren(children, threadId);
  const running = listed.filter(child => child.status === "running");
  if (running.length === 0) return null;
  const open = (id: string) => onOpenChild ? onOpenChild(id) : void navigate({ to: "/sessions/$sessionId", params: { sessionId: id } });
  // Pad the row, then center the column, as message rows do; padding inside
  // the column would push the line right of the messages on wide screens.
  return <div className="min-w-0 px-5 sm:px-8"><div className="mx-auto w-full min-w-0 max-w-3xl">
    <TraceLine icon={<Bot />} status="running" label="Show the agents"
      title={`${running.length === 1 ? "1 agent" : `${running.length} agents`} working · ${running[0]!.title}`}>
      <TraceList>
        {listed.slice(0, SHOWN).map(child => <TraceStep key={child.sessionId} icon={<Bot />} title={child.title}
          status={child.status === "running" ? "running" : child.outcome === "failed" ? "error" : "done"}
          detail={child.status === "running" ? "Working" : child.outcome && child.outcome !== "completed" ? child.outcome : "Done"}
          label={`Open ${child.title}`} onSelect={() => open(child.sessionId)} />)}
      </TraceList>
    </TraceLine>
  </div></div>;
}
