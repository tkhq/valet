import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowDownLeft, ArrowUpRight, FileText, Link2, Plus, Terminal } from "lucide-react";
import type { Message } from "@valet/api/wire";
import { api, type OwnerFilter } from "~/api/client";
import { qkCatchUp } from "~/api/catch-up";
import { useThreadChannelActivity } from "~/api/channels";
import { relativeTime } from "~/lib/relative-time";

/** Context belongs to the selected thread, never the entire shared runtime. */
export function ThreadContextPanel({ owner, sessionId, threadId, messages, busy, onCreate, onAttach, onReveal }: {
  owner: OwnerFilter;
  sessionId: string;
  threadId: string;
  messages: Message[];
  busy: boolean;
  onCreate: () => void;
  onAttach: () => void;
  onReveal: (messageId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const artifacts = useInfiniteQuery({
    queryKey: qkCatchUp.workArtifacts(owner, sessionId, threadId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listArtifacts(owner, { sourceSessionId: sessionId, sourceThreadId: threadId, limit: 10, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });
  const outputs = artifacts.error ? [] : artifacts.data?.pages.flatMap((page) => page.artifacts) ?? [];
  const threadMessages = messages.filter((message) => message.threadId === threadId);
  // Uploads download under their original name; links open in a new tab.
  const sources = new Map<string, { title: string; href: string; download?: string }>();
  for (const message of threadMessages) {
    if (message.role !== "user") continue;
    for (const attachment of message.attachments ?? []) {
      const href = attachment.kind === "file" ? api.threadFileUrl(sessionId, threadId, attachment.path) : attachment.url;
      sources.set(href, { title: attachment.name, href, download: attachment.name });
    }
    const text = message.content;
    for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>\]\)]+)/g)) {
      const href = (match[2] ?? match[3]).replace(/[.,;!?]+$/, "");
      try {
        const url = new URL(href);
        if (url.protocol !== "http:" && url.protocol !== "https:") continue;
        sources.set(href, { title: match[1] ?? `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`, href });
      } catch { /* Incomplete streamed URL. */ }
    }
  }
  const sourceRows = [...sources.entries()];
  const activeTools = busy ? threadMessages.flatMap((message) => message.parts.flatMap((part) => {
    if (part.kind !== "tool_call" || part.status !== "running") return [];
    const args = part.args;
    const command = args && typeof args === "object" && "command" in args && typeof args.command === "string" ? args.command : part.toolName;
    return [{ id: part.callId, label: command, messageId: message.id }];
  })) : [];
  const channelActivity = useThreadChannelActivity(sessionId, threadId).data;
  const latest = channelActivity?.latest;
  const LatestIcon = latest?.direction === "out" ? ArrowUpRight : ArrowDownLeft;
  const latestLabel = latest ? `${latest.direction === "out" ? "Valet" : latest.author ?? "Someone"}: ${latest.text ?? "(message)"}` : "";
  const rowClass = "flex w-full min-w-0 items-center gap-2.5 rounded-md py-1.5 text-left text-sm text-muted hover:text-ink";
  return (
    <aside aria-label="Thread context" className="rounded-2xl bg-ink-wash p-4 text-sm">
      <section aria-label="Outputs" className="pb-3">
        <div className="mb-2 flex items-center justify-between text-muted">
          <h2 className="font-medium">Outputs</h2>
          <button type="button" onClick={onCreate} aria-label="Create an output" className="rounded p-1 hover:bg-ink-wash-strong hover:text-ink"><Plus className="h-4 w-4" /></button>
        </div>
        {artifacts.isLoading && <p className="text-xs text-muted">Loading outputs…</p>}
        {artifacts.error && <p className="text-xs text-muted">Could not load outputs. <button className="underline" onClick={() => void artifacts.refetch()}>Retry</button></p>}
        {!artifacts.isLoading && !artifacts.error && outputs.length === 0 && <button onClick={onCreate} className="text-muted hover:text-ink">Create a file or site</button>}
        {outputs.map((output) => <Link key={output.id} to="/a/$token" params={{ token: output.token }} className={rowClass}><FileText className="h-4 w-4 shrink-0" /><span className="truncate">{output.title}</span></Link>)}
        {!artifacts.error && artifacts.hasNextPage && <button className="mt-2 text-xs text-muted hover:text-ink" disabled={artifacts.isFetchingNextPage} onClick={() => void artifacts.fetchNextPage()}>View more outputs</button>}
      </section>
      <section aria-label="Active tools" className="border-t border-line py-3">
        <h2 className="mb-2 font-medium text-muted">Active tools</h2>
        {activeTools.length === 0 && <p className="text-xs text-muted">No active tool calls</p>}
        {activeTools.map((tool) => <button key={tool.id} onClick={() => onReveal(tool.messageId)} className={rowClass} title={tool.label}><Terminal className="h-4 w-4 shrink-0 text-ink" /><span className="truncate text-ink">{tool.label}</span></button>)}
      </section>
      {latest && channelActivity && (
        // One summary row, whatever the thread's length: the transcript already holds every message.
        <section aria-label="Channel" className="border-t border-line py-3">
          <div className="mb-2 flex items-center justify-between text-muted">
            <h2 className="font-medium">Channel</h2>
            <Link to="/channel" search={{ key: latest.channelKey }} className="text-xs hover:text-ink">Open channel</Link>
          </div>
          <p className="text-xs text-muted">
            {channelActivity.total} {channelActivity.total === 1 ? "message" : "messages"} in the channel · latest {relativeTime(latest.createdAt)}
          </p>
          {latest.url
            ? <a href={latest.url} target="_blank" rel="noopener noreferrer" className={rowClass} title={latestLabel}><LatestIcon className="h-4 w-4 shrink-0" /><span className="truncate">{latestLabel}</span></a>
            : <p className={rowClass} title={latestLabel}><LatestIcon className="h-4 w-4 shrink-0" /><span className="truncate">{latestLabel}</span></p>}
        </section>
      )}
      <section aria-label="Sources" className="border-t border-line pt-3">
        <div className="mb-2 flex items-center justify-between text-muted">
          <h2 className="font-medium">Sources</h2>
          <button type="button" onClick={onAttach} aria-label="Add a source" className="rounded p-1 hover:bg-ink-wash-strong hover:text-ink"><Plus className="h-4 w-4" /></button>
        </div>
        {sourceRows.length === 0 && <p className="text-xs text-muted">Files and links you share appear here.</p>}
        {(showAll ? sourceRows : sourceRows.slice(0, 3)).map(([key, source]) => {
          const Icon = source.download ? FileText : Link2;
          return <a key={key} href={source.href} {...(source.download ? { download: source.download } : { target: "_blank", rel: "noopener noreferrer" })} className={rowClass} title={source.title}><Icon className="h-4 w-4 shrink-0" /><span className="truncate">{source.title}</span></a>;
        })}
        {sourceRows.length > 3 && <button onClick={() => setShowAll(!showAll)} className="mt-2 text-xs text-muted hover:text-ink">{showAll ? "Show less" : `View all (${sourceRows.length})`}</button>}
      </section>
    </aside>
  );
}
