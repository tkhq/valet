/**
 * Folder rows in the chat sidebar: a person's project folders, and one
 * built-in folder per Presence line that holds the threads the line opened.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Folder, FolderOpen, MoreHorizontal } from "lucide-react";
import type { ThreadLineGroup, ThreadSummary } from "@valet/api/wire";
import { useLineGroupThreads } from "~/api/queries";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, StatusDot } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { safeLocalStorage } from "~/lib/safe-storage";
import { isThreadUnread } from "~/lib/thread-read";
import { CHROME_BUTTON, HOVER_CHROME, NESTED_ROW, PHONE_HIDDEN, SIDEBAR_LABEL, TOP_ROW } from "./sidebar-rows";

/** The open/closed button of a folder row: its icon, its name, then any marks. */
export function FolderToggle({ open, label, disabled, onToggle, children }: {
  open: boolean;
  label: string;
  disabled?: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <button type="button" disabled={disabled} aria-expanded={open} onClick={onToggle}
      className="flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md pl-2 text-left focus-visible:bg-ink-wash focus-visible:outline-none">
      {open ? <FolderOpen aria-hidden className="h-4 w-4 shrink-0 text-muted" /> : <Folder aria-hidden className="h-4 w-4 shrink-0 text-muted" />}
      <span className="truncate">{label}</span>
      {children}
    </button>
  );
}

const openGroupsKey = (sessionId: string) => `valet:line-groups-open:${encodeURIComponent(sessionId)}`;

function readOpenGroups(sessionId: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(safeLocalStorage().getItem(openGroupsKey(sessionId)) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

/** Which line folders are open, per workspace. A folder opens when the open thread is in it. */
function useOpenGroups(sessionId: string, groupOfOpenThread: string | undefined) {
  const [open, setOpen] = useState(() => readOpenGroups(sessionId));
  useEffect(() => setOpen(readOpenGroups(sessionId)), [sessionId]);
  const save = (next: Set<string>) => {
    setOpen(next);
    try { safeLocalStorage().setItem(openGroupsKey(sessionId), JSON.stringify([...next])); } catch { /* In-session only when storage is unavailable. */ }
  };
  useEffect(() => {
    if (groupOfOpenThread && !open.has(groupOfOpenThread)) save(new Set([...open, groupOfOpenThread]));
    // Opens the folder once per newly opened thread. Closing it again stays closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupOfOpenThread]);
  const toggle = (key: string) => {
    const next = new Set(open);
    if (!next.delete(key)) next.add(key);
    save(next);
  };
  return { open, toggle };
}

/** The Presence section: one folder per line, newest activity first. */
export function LineGroupsSection({ sessionId, groups, members, sort, groupOfOpenThread, openThreadId, renderThread }: {
  sessionId: string;
  groups: ThreadLineGroup[];
  /** Each group's threads from the first page, by group key. */
  members: ReadonlyMap<string, ThreadSummary[]>;
  sort: string;
  groupOfOpenThread: string | undefined;
  openThreadId: string | undefined;
  renderThread: (thread: ThreadSummary) => ReactNode;
}) {
  const { open, toggle } = useOpenGroups(sessionId, groupOfOpenThread);
  if (groups.length === 0) return null;
  return (
    <section aria-label="Presence" className="space-y-0.5">
      <h2 className={SIDEBAR_LABEL}>Presence</h2>
      {groups.map((group) => (
        <LineGroupFolder key={group.key} sessionId={sessionId} group={group} preview={members.get(group.key) ?? []} sort={sort}
          open={open.has(group.key)} onToggle={() => toggle(group.key)} openThreadId={openThreadId} renderThread={renderThread} />
      ))}
    </section>
  );
}

function LineGroupFolder({ sessionId, group, preview, sort, open, onToggle, openThreadId, renderThread }: {
  sessionId: string;
  group: ThreadLineGroup;
  preview: ThreadSummary[];
  sort: string;
  open: boolean;
  onToggle: () => void;
  openThreadId: string | undefined;
  renderThread: (thread: ThreadSummary) => ReactNode;
}) {
  const [more, setMore] = useState(false);
  const rest = useLineGroupThreads(sessionId, group.key, { sort, after: group.nextCursor, enabled: more });
  const threads = [...new Map([...preview, ...(rest.data?.pages.flatMap((page) => page.threads) ?? [])].map((thread) => [thread.id, thread])).values()];
  const unread = threads.some((thread) => thread.id !== openThreadId && isThreadUnread(thread));
  const canShowMore = group.nextCursor !== undefined && (!more || rest.hasNextPage);
  const lineLink = group.kind === "subscription"
    ? { to: "/presence/rules/$id" as const, params: { id: group.ruleId } }
    : { to: "/presence/routines/$id" as const, params: { id: group.ruleId } };
  return (
    <section aria-label={`Presence line: ${group.name}`} className="mb-0.5">
      <div className={cn("group gap-0.5 pr-1 hover:bg-ink-wash", TOP_ROW)}>
        <FolderToggle open={open} label={group.name} onToggle={onToggle}>
          <span className="ml-auto shrink-0 text-xs text-muted">{group.threadCount}</span>
          {unread && <StatusDot tone="info" label="Unread" className="mx-1.5" />}
        </FolderToggle>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button" aria-label={`Line menu: ${group.name}`} className={cn(CHROME_BUTTON, HOVER_CHROME, PHONE_HIDDEN)}><MoreHorizontal className="h-3.5 w-3.5" aria-hidden /></button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {group.name !== "Deleted line" && <DropdownMenuItem asChild><Link {...lineLink}>Open line</Link></DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open && <div className="mt-0.5 space-y-0.5">
        {threads.map(renderThread)}
        {rest.error && <p role="alert" className="py-1 pl-10 pr-4 text-xs text-danger-500">Could not load more threads. <button type="button" className="underline" onClick={() => void rest.refetch()}>Retry</button></p>}
        {canShowMore && <button type="button" disabled={rest.isFetching}
          onClick={() => { if (!more) setMore(true); else void rest.fetchNextPage(); }}
          className={cn(NESTED_ROW, "w-[calc(100%-1rem)] pl-8 pr-2 text-muted hover:bg-ink-wash hover:text-ink focus-visible:bg-ink-wash focus-visible:outline-none")}>
          {rest.isFetching ? "Loading threads…" : "Show more"}
        </button>}
      </div>}
    </section>
  );
}
