import { Link } from "@tanstack/react-router";
import { Check, ListChecks, SquareArrowOutUpRight } from "lucide-react";
import type { HomeTaskItem } from "@valet/api/wire";
import { useHomeTasks } from "~/api/home";
import { Badge } from "~/components/primitives";
import { RunStateBadge } from "~/components/run-state-badge";
import { PlanProgress } from "~/components/session/thread-plan";
import { ToolBody } from "./tool-shell";
import { resultText, type ToolRenderer, type ToolRendererProps } from "./types";

interface StartedTask {
  id: string;
  threadId: string;
  title: string;
  workspace: { key: string; name: string };
}

/** The task a `start_task` or `message_task` result names, or undefined for an error result. */
export function startedTask(result: unknown): StartedTask | undefined {
  try {
    const parsed: unknown = JSON.parse(resultText(result));
    if (!parsed || typeof parsed !== "object" || !("task" in parsed)) return undefined;
    const task = (parsed as { task: unknown }).task;
    if (!task || typeof task !== "object") return undefined;
    const { id, threadId, title, workspace } = task as Record<string, unknown>;
    if (typeof id !== "string" || typeof threadId !== "string" || typeof title !== "string") return undefined;
    const ws = workspace && typeof workspace === "object" ? workspace as Record<string, unknown> : {};
    return { id, threadId, title, workspace: { key: typeof ws.key === "string" ? ws.key : "", name: typeof ws.name === "string" ? ws.name : "" } };
  } catch {
    return undefined;
  }
}

function argText(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** Where the task stands now, from Tasks: in progress, needs the person, or finished. */
function liveItem(threadId: string, tasks: ReturnType<typeof useHomeTasks>["data"]): HomeTaskItem | undefined {
  if (!tasks) return undefined;
  return [...tasks.needsYou, ...tasks.working, ...tasks.updates, ...tasks.finished].find(item => item.threadId === threadId);
}

/**
 * The card a started task leaves in the home conversation: its title, the
 * workspace it runs in, where it stands now, and a link into its thread.
 * It stays outside the collapsible tool card, so it reads as part of the
 * conversation rather than as tool output.
 */
function TaskCard({ result, status }: ToolRendererProps) {
  const task = status === "completed" ? startedTask(result) : undefined;
  const tasks = useHomeTasks(task !== undefined);
  if (!task) return null;
  const live = liveItem(task.threadId, tasks.data);
  return <Link to="/threads/$threadId" params={{ threadId: task.threadId }}
    className="my-1 flex min-w-0 items-center gap-3 rounded-lg border border-line bg-paper px-4 py-3 hover:bg-ink-wash max-sm:min-h-11">
    <ListChecks className="h-4 w-4 shrink-0 text-muted" aria-hidden />
    <span className="min-w-0 flex-1">
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-ink">{task.title}</span>
        {task.workspace.name && <Badge variant="neutral">{task.workspace.name}</Badge>}
        {live && (live.state === "working" || live.state === "needs_you" || live.state === "failed") && <RunStateBadge state={live.state} />}
        {live?.state === "done" && <span className="inline-flex items-center gap-1 text-xs text-muted"><Check aria-hidden className="h-3.5 w-3.5" />Finished</span>}
      </span>
      {live?.outputs?.[0] && <span className="mt-1 block truncate text-xs text-muted">Made: {live.outputs.map(output => output.title).join(", ")}</span>}
      {live?.plan && <span className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted">
        <PlanProgress done={live.plan.done} total={live.plan.total} label="Plan" />
        {live.plan.current && <span className="min-w-0 truncate">{live.plan.current}</span>}
      </span>}
    </span>
    <SquareArrowOutUpRight className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
  </Link>;
}

export const homeTaskRenderer: ToolRenderer = {
  matches: ["start_task", "message_task"],
  category: "thread",
  Icon: ListChecks,
  bare: true,
  formatTarget: (args, toolName) => toolName === "start_task" ? argText(args, "title") : argText(args, "thread_id"),
  formatSummary: (args, _result, status) => status === "completed" ? argText(args, "workspace") : undefined,
  Preview: TaskCard,
  Body: ({ args, error, result }) => <ToolBody>
    <pre className="whitespace-pre-wrap font-mono text-[12px] text-ink/85">{error ?? argText(args, "instructions") ?? argText(args, "text") ?? resultText(result)}</pre>
  </ToolBody>,
};

export const listTasksRenderer: ToolRenderer = {
  matches: "list_tasks",
  category: "read",
  Icon: ListChecks,
  formatTarget: () => "all workspaces",
  Body: ({ result, error }) => <ToolBody>
    <pre className="whitespace-pre-wrap font-mono text-[12px] text-ink/85">{error ?? resultText(result)}</pre>
  </ToolBody>,
};
