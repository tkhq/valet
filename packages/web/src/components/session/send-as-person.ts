import { createContext, useContext, useState } from "react";
import { useSendPrompt } from "~/api/queries";
import { useStreamStore } from "~/stores/stream";
import { errorText } from "~/lib/error-text";

/**
 * Sends a short reply into a thread as the person, the way the composer
 * would: the message shows at once, then takes its queue id. Quick replies
 * and widget buttons use it. `fallback` is the error to show when the send
 * fails without a message of its own.
 */
export function useSendAsPerson(sessionId: string, threadId: string | undefined, fallback: string) {
  const [error, setError] = useState<string>();
  const send = useSendPrompt(sessionId);
  const addUserMessage = useStreamStore(s => s.addUserMessage);
  const setMessageQueueItemId = useStreamStore(s => s.setMessageQueueItemId);
  const discardOptimisticMessage = useStreamStore(s => s.discardOptimisticMessage);
  async function reply(text: string) {
    if (!threadId || send.isPending) return;
    setError(undefined);
    const localId = addUserMessage(sessionId, text, threadId);
    try {
      const res = await send.mutateAsync({ text, threadId });
      if (res.messageId) setMessageQueueItemId(sessionId, localId, res.messageId);
    } catch (err) {
      discardOptimisticMessage(sessionId, localId);
      setError(errorText(err, fallback));
    }
  }
  return { reply, pending: send.isPending, error };
}

/** The thread a widget sits in, so its buttons reply there. Unset outside a live thread view. */
export const ThreadReplyContext = createContext<{ sessionId: string; threadId: string } | null>(null);

export function useThreadReplyTarget() {
  return useContext(ThreadReplyContext);
}
