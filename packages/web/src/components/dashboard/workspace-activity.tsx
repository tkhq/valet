import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { FileText, GitPullRequest, MessageSquare, ArrowUpRight, CircleAlert, LoaderCircle, CheckCheck } from "lucide-react";
import type { ArtifactListItem, GlobalWorkflowRunSummary, SessionSummary, WaitingThread, WorkspaceOutcome, WorkspaceActiveWorkItem } from "@valet/api/wire";
import type { OwnerFilter } from "~/api/client";
import { useCatchUpWork, useWorkspaceOutcomes, useWorkspaceActiveWork, useWaitingThreads, useFinishWaitingThread } from "~/api/catch-up";
import { useArtifacts } from "~/api/artifacts";
import { useWorkflows, useWorkflowActionRequired } from "~/api/workflows";
import { relativeTime } from "~/lib/relative-time";
import { Badge, Button, ErrorRow, LoadingRow } from "~/components/primitives";
import { RunStateBadge } from "~/components/run-state-badge";

export function WorkspaceActivity({ owner }: { owner: OwnerFilter }) {
  return <ScopedCatchUp key={`${owner.ownerType}:${owner.ownerId}`} owner={owner} />;
}

export function safeResultUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch { return undefined; }
}

export function runCategory(run: GlobalWorkflowRunSummary): "attention" | "progress" | "result" {
  if (run.needsApproval || run.outcome === "failed") return "attention";
  return run.status === "settled" ? "result" : "progress";
}

type ResultItem = {
  id: string; title: string; kind: string; time: number;
  sessionId?: string; threadId?: string; runId?: string; token?: string; url?: string;
};

export function groupResults(items: ResultItem[]): ResultItem[][] {
  const groups = new Map<string, ResultItem[]>();
  for (const item of [...items].sort((a, b) => b.time - a.time)) {
    const key = item.runId ? `run:${item.runId}` : item.sessionId ? `session:${item.sessionId}` : item.id;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()];
}

function outcomeResult(row: WorkspaceOutcome): ResultItem {
  return { id: `outcome:${row.id}`, title: row.title, kind: row.kind, time: row.occurredAt,
    sessionId: row.sessionId, threadId: row.threadId, runId: row.workflowRunId, url: safeResultUrl(row.url) };
}
function artifactResult(row: ArtifactListItem): ResultItem {
  return { id: `artifact:${row.id}`, title: row.title || row.path, kind: "artifact", time: row.updatedAt,
    sessionId: row.sourceSessionId ?? undefined, threadId: row.sourceThreadId ?? undefined, token: row.token };
}

function ScopedCatchUp({ owner }: { owner: OwnerFilter }) {
  const work = useCatchUpWork(owner);
  const activeWork = useWorkspaceActiveWork(owner);
  const waitingQ = useWaitingThreads(owner);
  const outcomes = useWorkspaceOutcomes(owner);
  const [artifactCursor, setArtifactCursor] = useState<string>();
  const artifacts = useArtifacts(owner, { limit: 25, cursor: artifactCursor, refetchInterval: 10_000 });
  const workflows = useWorkflows(owner, { refetchInterval: 10_000 });
  const gates = useWorkflowActionRequired();
  const sessions = work.error ? [] : work.data?.pages.flatMap(page => page.sessions) ?? [];
  const runs: GlobalWorkflowRunSummary[] = workflows.error ? [] : (workflows.data?.workflows ?? []).flatMap((workflow) => workflow.latestRun ? [{ ...workflow.latestRun, workflowName: workflow.name, needsApproval: !gates.error && Boolean(gates.data?.items.some((gate) => gate.runId === workflow.latestRun?.runId && gate.owner.type === owner.ownerType && gate.owner.id === owner.ownerId)) }] : []);
  const queueItems = activeWork.error ? [] : activeWork.data?.pages.flatMap(page => page.items) ?? [];
  const statePriority = { needs_you: 3, working: 2, failed: 1 };
  const activeThreadMap = new Map<string, WorkspaceActiveWorkItem>();
  for (const row of queueItems) {
    const key = `${row.sessionId}:${row.threadId}`;
    const existing = activeThreadMap.get(key);
    if (!existing || statePriority[row.state] > statePriority[existing.state] || (row.state === existing.state && row.updatedAt > existing.updatedAt)) activeThreadMap.set(key, row);
  }
  const activeThreads = [...activeThreadMap.values()];
  const needsYou = activeThreads.filter(row => row.state === "needs_you" || row.state === "failed");
  // Threads waiting on a reply, unless active work already lists the thread.
  const waiting = (waitingQ.data?.threads ?? []).filter(row => !activeThreadMap.has(`${row.sessionId}:${row.threadId}`));
  // A question needs an answer. A plain reply only needs a look, so it waits in a quieter list.
  const questions = waiting.filter(row => row.question);
  const replies = waiting.filter(row => !row.question);
  const finish = useFinishWaitingThread(owner);
  const inProgress = activeThreads.filter(row => row.state === "working");
  const attentionRuns = runs.filter(row => runCategory(row) === "attention");
  const progressRuns = runs.filter(row => runCategory(row) === "progress");
  const resultItems: ResultItem[] = [
    ...(outcomes.error ? [] : outcomes.data?.pages.flatMap(page => page.items).map(outcomeResult) ?? []),
    ...(artifacts.error ? [] : artifacts.data?.artifacts.filter(row => !row.revoked).map(artifactResult) ?? []),

  ];
  const otherWork = sessions.filter(row => !activeThreads.some(item => item.sessionId === row.id) && !resultItems.some(item => item.sessionId === row.id));
  const loading = activeWork.isPending || workflows.isPending || gates.isPending;
  const errors = [
    { label: "work", query: work }, { label: "active work", query: activeWork }, { label: "threads waiting on you", query: waitingQ }, { label: "results", query: outcomes }, { label: "artifacts", query: artifacts },
    { label: "workflows", query: workflows }, { label: "approval details", query: gates },
  ].filter(entry => entry.query.error);
  const incomplete = !activeWork.error && activeWork.hasNextPage;
  return <div className="space-y-7">
    {errors.map(({ label, query }) => <ErrorRow key={label}>Could not load {label}. <button className="underline" onClick={() => void query.refetch()}>Retry</button></ErrorRow>)}
    {loading && <LoadingRow label="Loading work…" />}
    {incomplete && <p className="text-xs text-muted">More active work is available. Use the paging controls below to see it.</p>}
    {(needsYou.length + attentionRuns.length + questions.length > 0) && <Section title="Needs attention" icon={<CircleAlert className="h-4 w-4 text-amber" />} count={needsYou.length + attentionRuns.length + questions.length}>
      {needsYou.map(row => <ActiveRow key={row.id} row={row} />)}
      {questions.map(row => <WaitingRow key={`${row.sessionId}:${row.threadId}`} row={row} onDone={() => finish.mutate(row)} />)}
      {attentionRuns.map(row => <RunRow key={row.runId} row={row} prompt={gates.error ? undefined : gates.data?.items.find(item => item.runId === row.runId && item.owner.type === owner.ownerType && item.owner.id === owner.ownerId)?.gate.prompt} />)}
    </Section>}
    {replies.length > 0 && <Section title="Unanswered replies" icon={<MessageSquare className="h-4 w-4 text-muted" />} count={replies.length}>
      {replies.map(row => <WaitingRow key={`${row.sessionId}:${row.threadId}`} row={row} onDone={() => finish.mutate(row)} />)}
    </Section>}
    {(inProgress.length + progressRuns.length > 0) && <Section title="In progress" icon={<LoaderCircle className="h-4 w-4 text-moss" />} count={inProgress.length + progressRuns.length}>
      {inProgress.map(row => <ActiveRow key={row.id} row={row} />)}
      {progressRuns.map(row => <RunRow key={row.runId} row={row} />)}
    </Section>}
    {!activeWork.error && activeWork.hasNextPage && <Button variant="secondary" size="sm" disabled={activeWork.isFetchingNextPage} onClick={() => void activeWork.fetchNextPage()}>Load more active work</Button>}
    {(resultItems.length > 0 || outcomes.isPending || artifacts.isPending) && <Section title="Recent results" icon={<CheckCheck className="h-4 w-4 text-moss" />} count={resultItems.length}>
      {(outcomes.isPending || artifacts.isPending) && <LoadingRow label="Loading results…" />}
      {groupResults(resultItems).map(group => {
        const first = group[0]!;
        const session = sessions.find(row => row.id === first.sessionId);
        return <div key={first.id} className="px-4 py-4">
          {session && <div className="mb-3 flex flex-wrap items-center gap-2"><Link to="/sessions/$sessionId" params={{ sessionId: session.id }} className="text-sm font-medium hover:underline">{session.title || "Untitled work"}</Link><RunStateBadge state={session.runState} /></div>}
          <ul className="space-y-3">{group.map(item => <ResultRow key={item.id} item={item} />)}</ul>
        </div>;
      })}
    </Section>}
    <div className="flex flex-wrap gap-3">
      {!outcomes.error && outcomes.hasNextPage && <Button size="sm" variant="secondary" disabled={outcomes.isFetchingNextPage} onClick={() => void outcomes.fetchNextPage()}>Load more results</Button>}
      {!artifacts.error && <PageControls cursor={artifactCursor} next={artifacts.data?.nextCursor} onPage={setArtifactCursor} label="artifacts" />}
    </div>
    {(otherWork.length > 0 || work.hasNextPage) && <details><summary className="cursor-pointer text-sm text-muted">Recent work · {otherWork.length} loaded</summary><div className="mt-3"><Section title="Recent work" count={otherWork.length}><p className="px-4 py-3 text-xs text-muted">Idle and sleeping work may still have unfinished tasks. Open the conversation to check.</p>{otherWork.map(row => <SessionRow key={row.id} row={row} />)}</Section>    {!work.error && work.hasNextPage && <Button variant="secondary" size="sm" disabled={work.isFetchingNextPage} onClick={() => void work.fetchNextPage()}>Load more work</Button>}
</div></details>}
  </div>;
}

function Section({ title, count, icon, children }: { title: string; count: number; icon?: ReactNode; children: ReactNode }) {
  return <section aria-label={title}><div className="mb-3 flex items-center gap-2">{icon}<h2 className="font-display text-lg">{title}</h2><span className="text-xs text-muted">{count}</span></div><div className="divide-y divide-line rounded-lg border border-line bg-paper">{children}</div></section>;
}
function ActiveRow({ row }: { row: WorkspaceActiveWorkItem }) {
  return <div className="flex flex-wrap items-center gap-3 px-4 py-3"><Link to="/threads/$threadId" params={{ threadId: row.threadId }} className="min-w-0 flex-1 break-words text-sm font-medium hover:underline">{row.title || "Untitled thread"}</Link><RunStateBadge state={row.state} /><span className="text-xs text-muted">{relativeTime(row.updatedAt)}</span></div>;
}
function WaitingRow({ row, onDone }: { row: WaitingThread; onDone: () => void }) {
  const detail = row.question ?? row.preview;
  return <div className="flex items-start gap-3 px-4 py-3">
    <span className="mt-1.5 h-2 w-2 shrink-0">{row.unread && <span role="img" aria-label="Unread" className="block h-2 w-2 rounded-full bg-blue-500" />}</span>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <Link to="/threads/$threadId" params={{ threadId: row.threadId }} className="min-w-0 break-words text-sm font-medium hover:underline">{row.title}</Link>
        <span className="text-xs text-muted">{relativeTime(row.lastAgentActivityAt)}</span>
      </div>
      {detail && <p className="mt-0.5 break-words text-sm text-muted">{row.question ? <span className="font-medium text-ink">Valet asks: </span> : null}{detail}</p>}
    </div>
    <div className="flex shrink-0 items-center gap-2">
      <Link to="/threads/$threadId" params={{ threadId: row.threadId }} className="rounded-md border border-line px-2 py-1 text-xs font-medium text-ink hover:bg-ink-wash">Reply</Link>
      <button type="button" onClick={onDone} title="Archive this thread. It leaves this list and the sidebar." aria-label={`Done with ${row.title}`}
        className="rounded-md px-2 py-1 text-xs text-muted hover:bg-ink-wash hover:text-ink">Done</button>
    </div>
  </div>;
}

function SessionRow({ row }: { row: SessionSummary }) {
  return <div className="flex flex-wrap items-center gap-3 px-4 py-3"><Link to="/sessions/$sessionId" params={{ sessionId: row.id }} className="min-w-0 flex-1 break-words text-sm font-medium hover:underline">{row.title || "Untitled work"}</Link><RunStateBadge state={row.runState} /><span className="text-xs text-muted">{relativeTime(row.lastActivityAt)}</span></div>;
}
function RunRow({ row, prompt }: { row: GlobalWorkflowRunSummary; prompt?: string }) {
  const label = row.needsApproval ? "Approval needed" : row.outcome === "failed" ? "Failed" : row.status === "parked" ? "Waiting" : row.status === "pending" ? "Queued" : row.status === "terminalizing" ? "Finishing" : "Running";
  return <div className="px-4 py-3"><div className="flex flex-wrap items-center gap-3"><Link to="/workflows/runs/$runId" params={{ runId: row.runId }} className="min-w-0 flex-1 break-words text-sm font-medium hover:underline">{row.workflowName}</Link><Badge variant={runCategory(row) === "attention" ? "warning" : "neutral"}>{label}</Badge><span className="text-xs text-muted">{relativeTime(row.updatedAt)}</span></div>{prompt && <p className="mt-2 text-sm text-muted">{prompt}</p>}</div>;
}
function ResultRow({ item }: { item: ResultItem }) {
  const Icon = item.kind === "pull_request" ? GitPullRequest : item.kind === "message" ? MessageSquare : FileText;
  const label = item.kind === "pull_request" ? "Pull request" : item.kind === "artifact" ? "Published file" : item.kind === "review" ? "Review" : item.kind === "message" ? "Message" : item.kind === "completed" ? "Workflow completed" : item.kind === "cancelled" ? "Workflow cancelled" : "Workflow settled";
  return <li className="flex gap-3"><Icon aria-hidden className="mt-1 h-4 w-4 shrink-0 text-moss" /><div className="min-w-0 flex-1">
    {item.token ? <Link to="/a/$token" params={{ token: item.token }} className="break-words text-sm font-medium hover:underline">{item.title}</Link> : item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-words text-sm font-medium hover:underline">{item.title}<ArrowUpRight className="h-3 w-3 shrink-0" /></a> : <span className="break-words text-sm font-medium">{item.title}</span>}
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted"><span>{label}</span><span>{relativeTime(item.time)}</span>
      {item.threadId ? <Link to="/threads/$threadId" params={{ threadId: item.threadId }} className="text-moss hover:underline">Open thread</Link> : item.sessionId && <Link to="/sessions/$sessionId" params={{ sessionId: item.sessionId }} className="text-moss hover:underline">Open work</Link>}
      {item.runId && <Link to="/workflows/runs/$runId" params={{ runId: item.runId }} className="text-moss hover:underline">Open workflow run</Link>}
    </div>
  </div></li>;
}
function PageControls({ cursor, next, onPage, label }: { cursor?: string; next?: string | null; onPage: (cursor?: string) => void; label: string }) {
  return <div className="flex gap-2">{cursor && <Button size="sm" variant="ghost" onClick={() => onPage(undefined)}>Latest {label}</Button>}{next && <Button size="sm" variant="secondary" onClick={() => onPage(next)}>Next {label}</Button>}</div>;
}
