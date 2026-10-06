import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCreateThread, useThreads } from "~/api/queries";
import { useTeams } from "~/api/settings";
import { Button, Spinner } from "~/components/primitives";
import { ChildPanel } from "~/components/session/child-panel";
import { SessionView } from "~/components/session/session-view";
import { useInvalidateMessagesOnQueueState } from "~/hooks/use-invalidate-messages-on-queue-state";
import { useWorkspaceConversation } from "~/hooks/use-workspace-conversation";
import { errorText } from "~/lib/error-text";
import { defaultThreadId, teamThreadNotice } from "~/lib/thread-default";
import { useWorkspaceScope } from "~/lib/workspace-scope";

interface ChatSearch { thread?: string; child?: string; workspace?: string }
export const Route = createFileRoute("/chat")({
  validateSearch: (raw): ChatSearch => ({
    thread: typeof raw.thread === "string" ? raw.thread : undefined,
    child: typeof raw.child === "string" ? raw.child : undefined,
    workspace: typeof raw.workspace === "string" ? raw.workspace : undefined,
  }),
  component: ChatPage,
});

function ChatPage() {
  const { thread, child, workspace } = Route.useSearch();
  const conversation = useWorkspaceConversation();
  const scope = useWorkspaceScope();
  const teams = useTeams();
  const workspaceKey = workspace ?? scope.key;
  const teamId = workspaceKey === "user" ? undefined : workspaceKey;
  const team = teams.data?.teams.find(t => t.id === teamId);
  const navigate = useNavigate({ from: Route.fullPath });
  const runtimeId = conversation.data?.sessionId;
  const createThread = useCreateThread(runtimeId ?? "");
  // The notice follows the open thread: a helper thread is private, a Slack thread follows its channel.
  const threads = useThreads(runtimeId ?? "");
  const list = threads.data?.threads ?? [];
  const active = list.find(t => t.id === (thread ?? defaultThreadId(list)));
  const sessionId = active?.sessionId ?? runtimeId;
  const activeKey = active?.key;
  useInvalidateMessagesOnQueueState(sessionId, thread);
  if (conversation.error) return <div role="alert" className="p-8 text-sm text-danger-500">
    Couldn’t open this workspace’s threads. {errorText(conversation.error)}
    <button className="ml-2 underline" onClick={() => void conversation.refetch()}>Retry</button>
  </div>;
  if (!runtimeId || !sessionId || threads.isLoading) return <div className="flex-1 grid place-items-center"><Spinner /> Opening threads…</div>;
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
        onOpenChild={id => void navigate({ search: prev => ({ ...prev, child: id }) })} enableReplies />
    </div>
    {child && <ChildPanel childId={child} onClose={() => void navigate({ search: prev => ({ ...prev, child: undefined }) })} />}
  </>;
}
