import { useQuery } from "@tanstack/react-query";
import type { ThreadAddress, ThreadShareMode } from "@valet/api/wire";
import { useEffect, useMemo } from "react";
import { api } from "~/api/client";
import { useMessages } from "~/api/queries";
import { useMe } from "~/api/settings";
import { useAnnounceThreadView, useSessionWebSocket } from "~/api/ws";
import { useActiveViewers } from "~/api/active-viewers";
import { TypingLine, ViewerFaces } from "./viewer-faces";
import { Badge, LoadingRow } from "~/components/primitives";
import { Composer } from "~/components/session/composer";
import { PinnedPlan } from "~/components/session/thread-plan";
import { MessageList } from "~/components/session/message-list";
import { useThreadEdit } from "~/components/session/use-thread-edit";
import { errorText } from "~/lib/error-text";
import { usePageTitle } from "~/lib/page-title";
import {
  queueBusy,
  usePendingGateForThread,
  useQueueStateForThread,
  useSessionStream,
  useStreamStore,
  useThreadLiveStatus,
} from "~/stores/stream";

/**
 * A personal thread another member shared with the viewer
 * (docs/specs/2026-10-13-thread-sharing-design.md). The viewer sees this one
 * thread live and, with "reply", sends prompts. Everything else of the owner's
 * workspace stays out of reach: no sidebar, no sandbox tabs, no settings, and
 * approvals stay with the owner. Every request uses the thread's address, so
 * the server checks the share each time.
 */
export function SharedThreadView({ address, guest }: {
  address: ThreadAddress;
  guest: { mode: ThreadShareMode; ownerName: string };
}) {
  const { sessionId, id: threadId } = address;
  usePageTitle(address.title || "Shared thread");
  useSessionWebSocket(sessionId, threadId);
  const stream = useSessionStream(sessionId);
  const me = useMe();
  useAnnounceThreadView(sessionId, threadId, threadId);
  const viewers = useActiveViewers(sessionId, threadId, me.data?.id);
  const messagesQ = useMessages(sessionId, threadId);
  const setThreadMessages = useStreamStore((s) => s.setThreadMessages);
  useEffect(() => {
    if (messagesQ.data) setThreadMessages(sessionId, threadId, messagesQ.data.messages, messagesQ.data.hasMore);
  }, [sessionId, threadId, messagesQ.data, setThreadMessages]);

  // A gate opened before this page loaded arrives by REST, later ones by the stream.
  const decisionsQ = useQuery({ queryKey: ["thread-decisions", threadId], queryFn: () => api.listThreadDecisions(threadId) });
  const setPendingGates = useStreamStore((s) => s.setPendingGates);
  useEffect(() => {
    if (decisionsQ.data) setPendingGates(sessionId, decisionsQ.data.gates.filter((gate) => gate.status === "pending"));
  }, [sessionId, decisionsQ.data, setPendingGates]);

  // A guest who may reply may edit their own messages, under the same rule
  // as the owner. A fork would create a thread in the owner's workspace.
  const edit = useThreadEdit(sessionId, threadId, messagesQ, stream.messages, { readOnly: guest.mode !== "reply" });
  const pendingGate = usePendingGateForThread(sessionId, threadId);
  const queueState = useQueueStateForThread(sessionId, threadId);
  const status = useThreadLiveStatus(sessionId, threadId);
  const busy = (status.status !== "idle" && status.status !== "error") || queueBusy(queueState);
  const queuedMessages = useMemo(() => {
    const byItemId = new Map(stream.messages.filter((m) => m.role === "user" && m.queueItemId).map((m) => [m.queueItemId, m]));
    return (queueState?.pendingIds ?? []).map((id) => byItemId.get(id)).filter((m) => m !== undefined);
  }, [stream.messages, queueState?.pendingIds]);

  if (messagesQ.error) {
    return <div role="alert" className="m-auto max-w-md p-8 text-center text-sm">
      You cannot open this thread. {errorText(messagesQ.error)} Ask {guest.ownerName} to share it again.
    </div>;
  }
  if (messagesQ.isLoading) return <div className="flex flex-1 items-center justify-center"><LoadingRow label="Loading thread…" /></div>;

  const header = (
    <header className="flex min-h-[--nav-height] flex-wrap items-center gap-2 border-b border-line bg-paper px-3 py-2 sm:px-4">
      <span className="min-w-0 truncate text-sm font-semibold tracking-tight text-ink font-display">{address.title || "Untitled thread"}</span>
      <Badge variant="accent" data-testid="thread-shared">Shared by {guest.ownerName}</Badge>
      <Badge>{guest.mode === "reply" ? "View + reply" : "View only"}</Badge>
      <ViewerFaces viewers={viewers} />
    </header>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <MessageList header={header} messages={stream.messages} threadId={threadId} agentBusy={busy}
        pendingIds={queueState?.pendingIds} viewerId={me.data?.id} ratings={false} {...edit.list} />
      <PinnedPlan threadId={threadId} />
      {pendingGate && (
        <p role="status" className="border-t border-line px-4 py-2 text-xs text-muted">
          Waiting for {guest.ownerName} to {pendingGate.type === "approval"
            ? "approve this action."
            : pendingGate.type === "question" ? "answer a question." : "respond to a request."}
        </p>
      )}
      <TypingLine viewers={viewers} />
      {guest.mode === "reply" ? (
        <Composer sessionId={sessionId} threadId={threadId} agentStatus={status.status}
          queuedMessages={queuedMessages} queuedItemCount={queueState?.pendingIds.length ?? 0} guest {...edit.composer} />
      ) : (
        <p role="status" className="border-t border-line px-4 py-3 text-sm text-muted">
          You can watch this thread. To send messages, ask {guest.ownerName} to allow replies.
        </p>
      )}
    </div>
  );
}
