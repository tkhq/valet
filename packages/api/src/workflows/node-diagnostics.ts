import { readModelResponseMetadata, MESSAGE_TURN_ERROR_KEY, type MessageEntry, type SessionStore } from "@valet/engine";
import type { NodeCheckpoint } from "@valet/workflow";

const ENTRY_LIMIT = 2_000;
const ERROR_CHARS = 2_000;

/** Read only submissions named by an authorized checkpoint. Never load the session runtime. */
export async function readNodeDiagnostics(store: SessionStore, checkpoint: NodeCheckpoint) {
  const effects = checkpoint.effects;
  const sessionId = typeof effects?.sessionId === "string" ? effects.sessionId : undefined;
  const receipt = effects?.receipt;
  const threadId = receipt && typeof receipt === "object" && "threadId" in receipt && typeof receipt.threadId === "string"
    ? receipt.threadId : undefined;
  const queueItemId = receipt && typeof receipt === "object" && "queueItemId" in receipt && typeof receipt.queueItemId === "string"
    ? receipt.queueItemId : undefined;
  const firstQueueItemId = typeof effects?.firstQueueItemId === "string" ? effects.firstQueueItemId : undefined;
  const repairAttempted = effects?.repairAttempted === true;
  const ids = [...new Set([firstQueueItemId, queueItemId].filter((id): id is string => !!id))];
  const submissions = await Promise.all(ids.map(async id => {
    const phase = repairAttempted && id === queueItemId ? "repair" : "original";
    if (!sessionId || !threadId) return { phase, queueItemId: id, textState: "unavailable", reason: "No session or thread was recorded for this run." };
    const item = await store.getQueueItem(sessionId, id);
    if (item && item.threadId !== threadId) {
      return { phase, queueItemId: id, textState: "unavailable", reason: "The submission does not belong to the checkpoint thread." };
    }
    const entries = await store.getEntries(sessionId, threadId, { queueItemId: id, limit: ENTRY_LIMIT });
    const assistants = entries.filter((entry): entry is MessageEntry =>
      entry.type === "message" && entry.role === "assistant" && entry.queueItemId === id);
    // This is awaitResult's selection rule: content of the last end_turn entry.
    // Parts are reported separately because they can disagree with stored content.
    const last = assistants.at(-1);
    const merged = item?.outcome?.outcome === "merged";
    const partial = item?.outcome?.outcome === "superseded";
    const selected = merged ? undefined : partial ? last : [...assistants].reverse().find(entry => entry.stopReason === "end_turn");
    return {
      phase, queueItemId: id,
      status: item?.status ?? "not_recorded",
      outcome: item?.outcome?.outcome,
      error: item?.outcome?.error?.slice(0, ERROR_CHARS),
      model: item?.model,
      attemptCount: item?.attemptCount,
      maxAttempts: item?.maxAttempts,
      timeoutAt: item?.timeoutAt,
      leaseExpiresAt: item?.leaseExpiresAt,
      abortRequestedAt: item?.abortRequestedAt,
      createdAt: item?.createdAt,
      updatedAt: item?.updatedAt,
      mergedIntoItemId: item?.mergedIntoItemId,
      assistantMessageCount: assistants.length,
      entriesMayBeTruncated: entries.length >= ENTRY_LIMIT,
      selectionRule: merged ? "merged_submission" : partial ? "last_assistant_partial" : "last_assistant_end_turn",
      textState: merged ? "merged" : !selected ? "no_selected_message" : selected.content.length === 0 ? "empty" : "present",
      selectedMessageId: selected?.id,
      selectedTextLength: selected?.content.length,
      ...(selected ? { selected: messageDiagnostics(selected) } : {}),
      ...(last ? { lastAssistant: messageDiagnostics(last) } : {}),
    };
  }));
  return {
    iteration: checkpoint.iteration, status: checkpoint.status,
    error: checkpoint.error?.slice(0, ERROR_CHARS),
    sessionId, threadId, queueItemId, firstQueueItemId, repairAttempted,
    schemaError: typeof effects?.firstError === "string" ? effects.firstError.slice(0, ERROR_CHARS) : undefined,
    evidence: ids.length > 0 ? "recorded_submissions" : "no_submission_receipt",
    submissions,
  };
}

function messageDiagnostics(entry: MessageEntry) {
  const error = entry.metadata?.[MESSAGE_TURN_ERROR_KEY];
  return {
    messageId: entry.id, queueItemId: entry.queueItemId, createdAt: entry.createdAt,
    stopReason: entry.stopReason, model: entry.model,
    textLength: entry.content.length,
    textPartsLength: (entry.parts ?? []).reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0),
    partTypes: [...new Set((entry.parts ?? []).map(part => part.type))],
    usage: entry.usage, cost: entry.cost,
    modelResponse: readModelResponseMetadata(entry),
    ...(typeof error === "string" ? { providerError: error.slice(0, ERROR_CHARS) } : {}),
  };
}
