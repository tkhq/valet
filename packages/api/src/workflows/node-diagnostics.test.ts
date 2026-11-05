import { expect, it } from "vitest";
import { InMemorySessionStore, MODEL_RESPONSE_METADATA_KEY, resolveSubmissionText, type MessageEntry } from "@valet/engine";
import type { NodeCheckpoint } from "@valet/workflow";
import { readNodeDiagnostics } from "./node-diagnostics.js";

const checkpoint: NodeCheckpoint = {
  runId: "run", nodeId: "research", iteration: 0, attempt: 1, status: "failed", createdAt: 1,
  effects: { sessionId: "s", receipt: { threadId: "t", queueItemId: "q" } },
};

async function fixture() {
  const store = new InMemorySessionStore();
  await store.saveSession({ id: "s", orgId: "org", userId: "user", owner: { type: "user", id: "user" }, workspace: "/tmp", purpose: "workflow",
    status: "running", createdAt: 1, updatedAt: 1 });
  await store.saveThread("s", { id: "t", sessionId: "s", key: "workflow", queueMode: "followup", status: "active", createdAt: 1, updatedAt: 1 });
  return store;
}

function message(id: string, extra: Partial<MessageEntry> = {}): MessageEntry {
  return { id, sessionId: "s", threadId: "t", parentId: null, createdAt: 1, queueItemId: "q",
    type: "message", role: "assistant", content: "", ...extra };
}

it("keeps a missing end_turn distinct from an empty selected completion", async () => {
  const store = await fixture();
  await store.appendEntries("s", "t", [message("error", { stopReason: "error", metadata: { turnError: "Provider unavailable" } })]);
  expect(await readNodeDiagnostics(store, checkpoint)).toMatchObject({ submissions: [{
    status: "not_recorded", textState: "no_selected_message", lastAssistant: { providerError: "Provider unavailable" },
  }] });
  const old = await readNodeDiagnostics(store, { ...checkpoint, effects: undefined });
  expect(old).toMatchObject({ evidence: "no_submission_receipt", submissions: [] });
});

it("matches engine result selection and exposes disagreement between content and parts", async () => {
  const store = await fixture();
  const entries = [
    message("earlier", { content: "old", stopReason: "end_turn" }),
    message("selected", { content: "", stopReason: "end_turn", parts: [{ type: "text", text: "visible text" }] }),
    message("partial", { content: "unfinished" }),
  ];
  await store.appendEntries("s", "t", entries);
  expect(resolveSubmissionText(entries, "q")).toBe("");
  expect(await readNodeDiagnostics(store, checkpoint)).toMatchObject({ submissions: [{
    selectedMessageId: "selected", selectedTextLength: 0, textState: "empty",
    selected: { textPartsLength: 12, partTypes: ["text"] }, lastAssistant: { messageId: "partial" },
  }] });
});

it("bounds persisted provider errors and does not return message bodies", async () => {
  const store = await fixture();
  await store.appendEntries("s", "t", [message("error", { content: "PRIVATE BODY", stopReason: "error",
    metadata: { turnError: "E".repeat(100_000) } })]);
  const result = await readNodeDiagnostics(store, checkpoint);
  expect(JSON.stringify(result)).not.toContain("PRIVATE BODY");
  expect(JSON.stringify(result).length).toBeLessThan(6_000);
});

it("refuses to inspect a receipt whose queue item belongs to another thread", async () => {
  const store = await fixture();
  await store.admitSubmission("s", "other", { id: "q", threadId: "other", content: "private", status: "queued",
    attemptCount: 0, maxAttempts: 10, timeoutAt: 999999, createdAt: 1, updatedAt: 1 });
  expect(await readNodeDiagnostics(store, checkpoint)).toMatchObject({ submissions: [{
    textState: "unavailable", reason: "The submission does not belong to the checkpoint thread.",
  }] });
});

it("reports partial selection for superseded work", async () => {
  const store = await fixture();
  await store.admitSubmission("s", "t", { id: "q", threadId: "t", content: "work", status: "queued",
    attemptCount: 0, maxAttempts: 10, timeoutAt: 999999, createdAt: 1, updatedAt: 1 });
  await store.settleUnclaimed("s", "t", "q", { outcome: "superseded" });
  await store.appendEntries("s", "t", [message("partial", { content: "unfinished", stopReason: "abort" })]);
  expect(await readNodeDiagnostics(store, checkpoint)).toMatchObject({ submissions: [{
    selectionRule: "last_assistant_partial", selectedMessageId: "partial", selectedTextLength: 10,
  }] });
});

it("identifies a merged submission without selecting its local output", async () => {
  const store = await fixture();
  await store.admitSubmission("s", "t", { id: "q", threadId: "t", content: "work", status: "queued",
    attemptCount: 0, maxAttempts: 10, timeoutAt: 999999, createdAt: 1, updatedAt: 1 });
  await store.settleUnclaimed("s", "t", "q", { outcome: "merged" }, { mergedIntoItemId: "merged-target" });
  await store.appendEntries("s", "t", [message("old", { content: "local text", stopReason: "end_turn" })]);
  const result = await readNodeDiagnostics(store, checkpoint);
  expect(result).toMatchObject({ submissions: [{
    selectionRule: "merged_submission", textState: "merged", mergedIntoItemId: "merged-target",
  }] });
  expect(result.submissions[0]).not.toHaveProperty("selected");
  expect(result.submissions[0]).toHaveProperty("selectedMessageId", undefined);
});


it("exposes bounded terminal metadata for original and repair queues without response content", async () => {
  const store = await fixture();
  const response = { stopReason: "length", api: "test-api", provider: "test-provider", model: "test-model",
    blockTypes: ["thinking"], thinkingPresent: true, textLength: 0, streamedTextLength: 7,
    responseId: "r".repeat(1000), privateReasoning: "PRIVATE REASONING" };
  await store.appendEntries("s", "t", [
    message("original", { stopReason: "end_turn", metadata: { [MODEL_RESPONSE_METADATA_KEY]: response } }),
    message("repair", { queueItemId: "repair-q", stopReason: "end_turn" }),
  ]);
  const result = await readNodeDiagnostics(store, { ...checkpoint,
    effects: { sessionId: "s", firstQueueItemId: "q", repairAttempted: true, receipt: { threadId: "t", queueItemId: "repair-q" } } });
  expect(result.submissions).toMatchObject([
    { phase: "original", selected: { modelResponse: { stopReason: "length", api: "test-api", provider: "test-provider",
      thinkingPresent: true, effectiveMaxOutputTokens: null, providerTerminalStatus: null, incompleteReason: null, requestId: null } } },
    { phase: "repair", selected: { modelResponse: null } },
  ]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE REASONING");
  expect(JSON.stringify(result).length).toBeLessThan(6000);
});
