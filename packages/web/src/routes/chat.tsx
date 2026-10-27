import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useCreateThread, usePrefetchSession, usePrefetchTranscript, useThreads, useThreadWorkspace } from "~/api/queries";
import { useTeams } from "~/api/settings";
import { Button } from "~/components/primitives";
import { ThreadShell } from "~/components/session/message-list";
import { useSidebarControls } from "~/components/layout/app-shell";
import { ChildPanel } from "~/components/session/child-panel";
import { SessionView } from "~/components/session/session-view";
import { useWorkspaceConversation } from "~/hooks/use-workspace-conversation";
import { usePageTitle } from "~/lib/page-title";
import { errorText } from "~/lib/error-text";
import { defaultThreadId, teamThreadNotice } from "~/lib/thread-default";
import { useWorkspaceScope } from "~/lib/workspace-scope";

// `threads: "open"` opens the phone thread list on arrival (the top nav's
// Threads button on other pages). The page clears it once handled.
interface ChatSearch { thread?: string; child?: string; workspace?: string; threads?: "open" }
export const Route = createFileRoute("/chat")({
  validateSearch: (raw): ChatSearch => ({
    thread: typeof raw.thread === "string" ? raw.thread : undefined,
    child: typeof raw.child === "string" ? raw.child : undefined,
    workspace: typeof raw.workspace === "string" ? raw.workspace : undefined,
    threads: raw.threads === "open" ? "open" : undefined,
  }),
  component: ChatPage,
});

function ChatPage() {
  const { thread, child, workspace, threads: threadsParam } = Route.useSearch();
  const sidebar = useSidebarControls();
  const conversation = useWorkspaceConversation();
  const scope = useWorkspaceScope();
  const teams = useTeams();
  const workspaceKey = workspace ?? scope.key;
  const teamId = workspaceKey === "user" ? undefined : workspaceKey;
  const team = teams.data?.teams.find(t => t.id === teamId);
  const navigate = useNavigate({ from: Route.fullPath });
  const openDrawer = sidebar?.present ? sidebar.openDrawer : undefined;
  // The thread is in the URL: load its transcript beside the workspace and
  // thread-list requests, not after them.
  usePrefetchTranscript(thread);
  useEffect(() => {
    if (threadsParam !== "open" || !openDrawer) return;
    openDrawer();
    void navigate({ search: (prev) => ({ ...prev, threads: undefined }), replace: true });
  }, [threadsParam, openDrawer, navigate]);
  const runtimeId = conversation.data?.sessionId;
  // Most threads live in the workspace runtime: load its detail beside the
  // thread list rather than after it.
  usePrefetchSession(runtimeId);
  const createThread = useCreateThread(runtimeId ?? "");
  // The notice follows the open thread: a helper thread is private, a Slack thread follows its channel.
  const threads = useThreads(runtimeId ?? "", undefined, thread);
  const list = threads.data?.threads ?? [];
  const active = list.find(t => t.id === (thread ?? threads.data?.defaultThreadId ?? defaultThreadId(list)));
  // A thread from another workspace (a private branch, a moved thread, a
  // branch note's source) opens in its own workspace.
  const elsewhere = useThreadWorkspace(thread && threads.data && !active ? thread : undefined).data;
  useEffect(() => {
    if (elsewhere && elsewhere !== workspaceKey) void navigate({ search: (prev) => ({ ...prev, workspace: elsewhere }), replace: true });
  }, [elsewhere, workspaceKey, navigate]);
  const sessionId = active?.sessionId ?? runtimeId;
  const activeKey = active?.key;
  usePageTitle(active?.title || "Chat");
  if (conversation.error) return <div role="alert" className="p-8 text-sm text-danger-500">
    Couldn’t open this workspace’s threads. {errorText(conversation.error)}
    <button className="ml-2 underline" onClick={() => void conversation.refetch()}>Retry</button>
  </div>;
  if (!runtimeId || !sessionId || threads.isLoading) return <ThreadShell />;
  if (threads.error) return <div role="alert" className="p-8 text-sm">
    Couldn’t load threads. {errorText(threads.error)}
    <Button variant="ghost" onClick={() => void threads.refetch()}>Retry</Button>
  </div>;
  if (teamId && !active) return <div className="m-auto text-center">
    <p>{thread ? "This thread is unavailable." : "Start a shared team conversation."}</p>
    <Button disabled={createThread.isPending} onClick={() => {
      void createThread.mutateAsync().then(created => navigate({ search: prev => ({ ...prev, thread: created.id }) })).catch(() => undefined);
    }}>New thread</Button>
    {createThread.error && <p role="alert">{errorText(createThread.error)}</p>}
  </div>;
  return <>
    <div className="flex-1 min-h-0 flex flex-col">
      <SessionView key={sessionId} sessionId={sessionId} activeThreadId={active?.id ?? thread} scopeNotice={teamId ? teamThreadNotice(team?.name ?? "this team", activeKey) : undefined}
        onOpenChild={id => void navigate({ search: prev => ({ ...prev, child: id }) })} enableReplies
        onOpenThread={id => void navigate({ search: prev => ({ ...prev, thread: id, child: undefined }) })} />
    </div>
    {child && <ChildPanel childId={child} onClose={() => void navigate({ search: prev => ({ ...prev, child: undefined }) })} />}
  </>;
}

