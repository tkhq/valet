import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "~/api/client";
import { MessageItem } from "~/components/session/message-item";

/** Read-only transcript for one submission, never the entire shared assistant. */
export function StepLogs({ sessionId, threadId, queueItemId, active }: {
  sessionId: string;
  threadId: string;
  queueItemId: string;
  active: boolean;
}) {
  const [limit, setLimit] = useState(200);
  const logs = useQuery({
    queryKey: ["workflow-step-logs", sessionId, threadId, queueItemId, limit, active],
    queryFn: () => api.listMessages(sessionId, { threadId, queueItemId, limit }),
    refetchInterval: active ? 5000 : false,
  });
  if (logs.isPending) return <p className="text-xs text-muted" role="status">Loading agent logs…</p>;
  if (logs.isError) return <div className="text-xs text-danger-500" role="alert">
    Could not load agent logs. <button type="button" className="underline" onClick={() => void logs.refetch()}>Retry</button>
  </div>;
  // Older servers ignore the new filter. Never display another submission.
  const messages = logs.data.messages.filter((message) => message.queueItemId === queueItemId);
  return <section aria-label="Agent logs" className="min-w-0 rounded border border-line">
    <p className="border-b border-line px-3 py-2 text-xs text-muted">Latest attempt logs</p>
    <div className="max-h-[32rem] overflow-auto">
      {messages.length === 0 ? <p className="p-3 text-xs text-muted">No messages recorded for this attempt yet.</p> : messages.map((message) =>
        message.role === "user" ? <details key={message.id} className="border-b border-line p-3 text-xs">
          <summary className="cursor-pointer text-muted">Step input</summary>
          <p className="mt-2 whitespace-pre-wrap break-words">{message.content}</p>
        </details> : <MessageItem key={message.id} message={message} suppressEmptyPlaceholder={active} />,
      )}
    </div>
    {logs.data.hasMore && <div className="border-t border-line p-3 text-xs text-muted">
      {limit < 2000 ? <button type="button" className="text-accent hover:underline" onClick={() => setLimit(Math.min(2000, limit + 200))}>Load earlier logs</button>
        : "Showing the latest 2,000 entries for this attempt."}
    </div>}
  </section>;
}
