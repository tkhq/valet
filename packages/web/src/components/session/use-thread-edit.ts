import { useEffect, useState } from "react";
import type { ListMessagesResponse } from "@valet/api/wire";
import { useReturnToBranch } from "~/api/queries";
import type { StreamMessage } from "~/stores/stream";
import type { ComposerEditTarget } from "./composer";

/**
 * Edit state for one thread view (docs/specs/2026-10-22-thread-edit-fork-design.md).
 * While a message is in the composer, the rows it replaces are dimmed. Once
 * the edit is sent, exactly those rows are hidden (a row the old turn is
 * still streaming included) until REST no longer lists the edited message,
 * so a refetch before the server moves the thread cannot show them again.
 * Rows that arrive after Send show. Spread `list` on `MessageList` and
 * `composer` on `Composer`.
 */
export function useThreadEdit(
  sessionId: string,
  threadId: string | undefined,
  rest: { data?: ListMessagesResponse; dataUpdatedAt: number },
  messages: readonly StreamMessage[],
  opts: { readOnly?: boolean } = {},
) {
  const [editTarget, setEditTarget] = useState<ComposerEditTarget>();
  const [hiddenFrom, setHiddenFrom] = useState<{ threadId: string; messageId: string; ids: ReadonlySet<string>; sentAt: number }>();
  const returnToBranch = useReturnToBranch(sessionId);
  useEffect(() => setEditTarget(undefined), [threadId]);
  useEffect(() => {
    if (!hiddenFrom || !rest.data || rest.dataUpdatedAt <= hiddenFrom.sentAt) return;
    if (!rest.data.messages.some((message) => message.id === hiddenFrom.messageId)) setHiddenFrom(undefined);
  }, [hiddenFrom, rest.data, rest.dataUpdatedAt]);

  function startEdit(message: StreamMessage) {
    const attachments = message.attachments ?? [];
    setEditTarget({
      messageId: message.id,
      text: message.content,
      images: attachments.flatMap((attachment) => attachment.kind === "image" && attachment.url.startsWith("data:")
        ? [{
            id: `edit-${message.id}-${attachment.name}`,
            name: attachment.name,
            mimeType: attachment.mimeType,
            // Decoded size of the base64 payload, for the image size limit.
            bytes: Math.floor(attachment.url.length * 0.75),
            dataUrl: attachment.url,
          }]
        : []),
      droppedFiles: attachments.filter((attachment) => attachment.kind === "file").length,
    });
  }

  const cancelEdit = () => setEditTarget(undefined);
  return {
    editing: editTarget !== undefined,
    startEdit,
    cancelEdit,
    list: opts.readOnly || !threadId ? {} : {
      onEdit: startEdit,
      onReturnToBranch: async (noteEntryId: string) => {
        await returnToBranch.mutateAsync({ threadId, noteEntryId });
      },
      editingId: editTarget?.messageId,
      hiddenIds: hiddenFrom && hiddenFrom.threadId === threadId ? hiddenFrom.ids : undefined,
    },
    composer: {
      editTarget,
      onCancelEdit: cancelEdit,
      onEditSubmit: (messageId: string) => {
        if (!threadId) return;
        const rows = messages.filter((message) => message.threadId === threadId);
        const from = rows.findIndex((message) => message.id === messageId);
        const ids = new Set(from < 0 ? [messageId] : rows.slice(from).map((message) => message.id));
        setHiddenFrom({ threadId, messageId, ids, sentAt: Date.now() });
      },
      onEditResult: (ok: boolean) => {
        if (ok) setEditTarget(undefined);
        else setHiddenFrom(undefined);
      },
    },
  };
}
