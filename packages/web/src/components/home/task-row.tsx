import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { HomeTaskItem } from "@valet/api/wire";
import { Badge, WorkRow } from "~/components/primitives";
import { RunStateBadge } from "~/components/run-state-badge";
import { PlanProgress } from "~/components/session/thread-plan";
import { stripMarkdown } from "~/lib/strip-markdown";
import { OutputCards } from "./output-card";

/** One thread in Tasks: its title, the workspace it lives in, its state,
 * plan progress when it has a plan, and what Valet said or asked last. */
export function TaskRow({ item, actions }: { item: HomeTaskItem; actions?: ReactNode }) {
  const detail = item.plan
    ? <span className="inline-flex min-w-0 max-w-full items-center gap-2"><PlanProgress done={item.plan.done} total={item.plan.total} label="Plan" />
      {item.plan.current && <span className="min-w-0 truncate">{item.plan.current}</span>}</span>
    : item.detail ? stripMarkdown(item.detail) : undefined;
  return <WorkRow
    title={<Link to="/threads/$threadId" params={{ threadId: item.threadId }}>{item.title}</Link>}
    badge={<>
      <Badge variant="neutral">{item.workspace.name}</Badge>
      {item.state === "needs_you" || item.state === "failed" || item.state === "working" ? <RunStateBadge state={item.state} /> : null}
    </>}
    time={item.updatedAt}
    detail={(detail || item.outputs?.length) && <>
      {detail && <>{item.question ? <span className="font-medium text-ink">Valet asks: </span> : null}{detail}</>}
      <OutputCards outputs={item.outputs} className="mt-2" />
    </>}
    actions={actions}
  />;
}
