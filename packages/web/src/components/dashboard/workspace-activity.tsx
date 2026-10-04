import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { FileText, GitPullRequest, MessageSquare, ArrowUpRight, CircleAlert, LoaderCircle, CheckCheck } from "lucide-react";
import type { ArtifactListItem, GlobalWorkflowRunSummary, WaitingThread, WorkspaceOutcome, WorkspaceActiveWorkItem } from "@valet/api/wire";
import type { OwnerFilter } from "~/api/client";
import { useWorkspaceOutcomes, useWorkspaceActiveWork, useWaitingThreads, useFinishWaitingThread } from "~/api/catch-up";
import { useArtifacts } from "~/api/artifacts";
import { useDismissRun, useWorkflows, useWorkflowActionRequired } from "~/api/workflows";
import { Badge, Button, ErrorRow, LoadingRow, textLinkClass, WorkRow, WorkSection } from "~/components/primitives";
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
  if (run.needsApproval || (run.outcome === "failed" && !run.dismissed)) return "attention";
  return run.status === "settled" ? "result" : "progress";
}

type ResultItem = {
  id: string; title: string; kind: string; time: number;
  sessionId?: string; threadId?: string; runId?: string; token?: string; url?: string;
};

/** A GitHub pull request named by a result link: `owner/repo #12`, and its page. */
export function pullRequestOf(url?: string): { label: string; url: string } | undefined {
  const match = url ? /^(https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+))/.exec(url) : null;
  return match ? { label: `${match[2]} #${match[3]}`, url: match[1]! } : undefined;
}

/**
 * Results grouped by what the work changed: a published file, a pull request,
 * a thread's conversation, or a workflow run. Nine Slack messages in one
 * thread are one line of work, so they are one row, newest first.
 */
export function groupResults(items: ResultItem[]): ResultItem[][] {
  const groups = new Map<string, ResultItem[]>();
  for (const item of [...items].sort((a, b) => b.time - a.time)) {
    const pr = item.kind === "message" ? undefined : pullRequestOf(item.url);
    const key = item.token ? `file:${item.token}` : pr ? `pr:${pr.url}` : item.threadId ? `thread:${item.threadId}`
      : item.runId ? `run:${item.runId}` : item.id;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()];
}

/** What a group of results did, in words: "9 Slack messages · 1 review". */
export function resultSummary(group: ResultItem[]): string {
  const count = (kind: string) => group.filter((item) => item.kind === kind).length;
  const plural = (n: number, one: string, many: string) => n === 1 ? one : `${n} ${many}`;
  return [
    count("pull_request") > 0 && "Opened the pull request",
    count("review") > 0 && plural(count("review"), "Submitted a review", "reviews"),
    count("message") > 0 && plural(count("message"), "Sent a Slack message", "Slack messages"),
    count("artifact") > 0 && "Published a file",
  ].filter(Boolean).join(" · ");
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
  const activeWork = useWorkspaceActiveWork(owner);
  const waitingQ = useWaitingThreads(owner);
  const outcomes = useWorkspaceOutcomes(owner);
  const [artifactCursor, setArtifactCursor] = useState<string>();
  const artifacts = useArtifacts(owner, { limit: 25, cursor: artifactCursor, refetchInterval: 10_000 });
  const workflows = useWorkflows(owner, { refetchInterval: 10_000 });
  const gates = useWorkflowActionRequired();
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
  const resultGroups = groupResults(resultItems);
  const loading = activeWork.isPending || workflows.isPending || gates.isPending;
  const errors = [
    { label: "active work", query: activeWork }, { label: "threads waiting on you", query: waitingQ }, { label: "results", query: outcomes }, { label: "artifacts", query: artifacts },
    { label: "workflows", query: workflows }, { label: "approval details", query: gates },
  ].filter(entry => entry.query.error);
  const incomplete = !activeWork.error && activeWork.hasNextPage;
  return <div className="space-y-7">
    {errors.map(({ label, query }) => <ErrorRow key={label}>Could not load {label}. <button className="underline" onClick={() => void query.refetch()}>Retry</button></ErrorRow>)}
    {loading && <LoadingRow label="Loading work…" />}
    {incomplete && <p className="text-xs text-muted">More active work is available. Use the paging controls below to see it.</p>}
    {(needsYou.length + attentionRuns.length + questions.length > 0) && <WorkSection title="Needs attention" icon={<CircleAlert className="h-4 w-4 text-amber" />} count={needsYou.length + attentionRuns.length + questions.length}>
      {needsYou.map(row => <ActiveRow key={row.id} row={row} />)}
      {questions.map(row => <WaitingRow key={`${row.sessionId}:${row.threadId}`} row={row} onDone={() => finish.mutate(row)} />)}
      {attentionRuns.map(row => <RunRow key={row.runId} row={row} prompt={gates.error ? undefined : gates.data?.items.find(item => item.runId === row.runId && item.owner.type === owner.ownerType && item.owner.id === owner.ownerId)?.gate.prompt} />)}
    </WorkSection>}
    {replies.length > 0 && <WorkSection title="Unanswered replies" icon={<MessageSquare className="h-4 w-4 text-muted" />} count={replies.length}>
      {replies.map(row => <WaitingRow key={`${row.sessionId}:${row.threadId}`} row={row} onDone={() => finish.mutate(row)} />)}
    </WorkSection>}
    {(inProgress.length + progressRuns.length > 0) && <WorkSection title="In progress" icon={<LoaderCircle className="h-4 w-4 text-moss" />} count={inProgress.length + progressRuns.length}>
      {inProgress.map(row => <ActiveRow key={row.id} row={row} />)}
      {progressRuns.map(row => <RunRow key={row.runId} row={row} />)}
    </WorkSection>}
    {!activeWork.error && activeWork.hasNextPage && <Button variant="secondary" size="sm" disabled={activeWork.isFetchingNextPage} onClick={() => void activeWork.fetchNextPage()}>Load more active work</Button>}
    {(resultGroups.length > 0 || outcomes.isPending || artifacts.isPending) && <WorkSection title="Recent results" icon={<CheckCheck className="h-4 w-4 text-moss" />} count={resultGroups.length}>
      {(outcomes.isPending || artifacts.isPending) && <LoadingRow label="Loading results…" />}
      {resultGroups.map(group => <ResultGroupRow key={group[0]!.id} group={group} />)}
    </WorkSection>}
    <div className="flex flex-wrap gap-3">
      {!outcomes.error && outcomes.hasNextPage && <Button size="sm" variant="secondary" disabled={outcomes.isFetchingNextPage} onClick={() => void outcomes.fetchNextPage()}>Load more results</Button>}
      {!artifacts.error && <PageControls cursor={artifactCursor} next={artifacts.data?.nextCursor} onPage={setArtifactCursor} label="artifacts" />}
    </div>
  </div>;
}

function ActiveRow({ row }: { row: WorkspaceActiveWorkItem }) {
  return <WorkRow title={<Link to="/threads/$threadId" params={{ threadId: row.threadId }}>{row.title || "Untitled thread"}</Link>}
    badge={<RunStateBadge state={row.state} />} time={row.updatedAt} />;
}
function WaitingRow({ row, onDone }: { row: WaitingThread; onDone: () => void }) {
  const detail = row.question ?? row.preview;
  return <WorkRow
    title={<Link to="/threads/$threadId" params={{ threadId: row.threadId }}>{row.title}</Link>}
    time={row.lastAgentActivityAt}
    detail={detail && <>{row.question ? <span className="font-medium text-ink">Valet asks: </span> : null}{detail}</>}
    actions={<>
      <Button asChild variant="secondary" size="sm"><Link to="/threads/$threadId" params={{ threadId: row.threadId }}>Reply</Link></Button>
      <Button variant="ghost" size="sm" onClick={onDone} title="Archive this thread. It leaves this list and the sidebar." aria-label={`Done with ${row.title}`}>Done</Button>
    </>} />;
}
function RunRow({ row, prompt }: { row: GlobalWorkflowRunSummary; prompt?: string }) {
  const dismiss = useDismissRun();
  const failed = !row.needsApproval && row.outcome === "failed";
  const label = row.needsApproval ? "Approval needed" : failed ? "Failed" : row.status === "parked" ? "Waiting" : row.status === "pending" ? "Queued" : row.status === "terminalizing" ? "Finishing" : "Running";
  return <WorkRow title={<Link to="/workflows/runs/$runId" params={{ runId: row.runId }}>{row.workflowName}</Link>}
    badge={<Badge variant={runCategory(row) === "attention" ? "warning" : "neutral"}>{label}</Badge>} time={row.updatedAt} detail={prompt}
    actions={failed ? <Button variant="ghost" size="sm" disabled={dismiss.isPending} onClick={() => dismiss.mutate(row.runId)}>Dismiss</Button> : undefined} />;
}
function ResultGroupRow({ group }: { group: ResultItem[] }) {
  const latest = group[0]!;
  const pr = latest.kind === "message" ? undefined : pullRequestOf(latest.url);
  const opened = group.find((item) => item.kind === "pull_request");
  const name = latest.token ? latest.title : pr ? (opened?.title && opened.title !== "Pull request opened" ? opened.title : pr.label) : latest.title;
  const Icon = pr ? GitPullRequest : latest.kind === "message" ? MessageSquare : FileText;
  const threadId = group.find((item) => item.threadId)?.threadId;
  const runId = group.find((item) => item.runId)?.runId;
  const external = pr?.url ?? latest.url;
  const title = latest.token ? <Link to="/a/$token" params={{ token: latest.token }}>{name}</Link>
    : threadId && !pr ? <Link to="/threads/$threadId" params={{ threadId }}>{name}</Link>
    : external ? <a href={external} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1">{name}<ArrowUpRight aria-hidden className="h-3 w-3 shrink-0" /></a>
    : name;
  return <WorkRow
    title={<span className="inline-flex items-center gap-2"><Icon aria-hidden className="h-4 w-4 shrink-0 text-moss" />{title}</span>}
    time={latest.time}
    detail={resultSummary(group)}
    actions={<>
      {threadId && pr && <Link to="/threads/$threadId" params={{ threadId }} className={textLinkClass}>Open thread</Link>}
      {threadId && !pr && latest.url && <a href={latest.url} target="_blank" rel="noopener noreferrer" className={textLinkClass}>Open in Slack</a>}
      {runId && <Link to="/workflows/runs/$runId" params={{ runId }} className={textLinkClass}>Open run</Link>}
    </>} />;
}
function PageControls({ cursor, next, onPage, label }: { cursor?: string; next?: string | null; onPage: (cursor?: string) => void; label: string }) {
  return <div className="flex gap-2">{cursor && <Button size="sm" variant="ghost" onClick={() => onPage(undefined)}>Latest {label}</Button>}{next && <Button size="sm" variant="secondary" onClick={() => onPage(next)}>Next {label}</Button>}</div>;
}
