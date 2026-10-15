import { expect, it } from "vitest";
import { InMemorySessionStore, type SessionEntry } from "@valet/engine";
import { readStepTranscript } from "./step-transcript.js";

async function fixture() {
  const store = new InMemorySessionStore();
  await store.saveSession({ id: "s", orgId: "o", userId: "u", owner: { type: "user", id: "u" }, workspace: "/tmp", purpose: "workflow", status: "running", createdAt: 1, updatedAt: 1 });
  await store.saveThread("s", { id: "t", sessionId: "s", key: "workflow", queueMode: "followup", status: "active", createdAt: 1, updatedAt: 1 });
  const base = { sessionId: "s", threadId: "t", parentId: null, createdAt: 1 };
  const entries: SessionEntry[] = [
    { ...base, id: "prompt", queueItemId: "q", type: "message", role: "user", content: "P".repeat(14000) },
    { ...base, id: "compact", type: "compaction", summary: "S".repeat(7000), coveredEntryIds: ["prompt"], tokenCountBefore: 9000, tokenCountAfter: 2000 },
    { ...base, id: "continue", queueItemId: "q", type: "message", role: "user", content: "Continue", metadata: { compaction_continue: true, synthetic: true } },
    { ...base, id: "tools", queueItemId: "q", type: "message", role: "assistant", content: "", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 }, parts: [{ type: "tool_call", callId: "c", toolName: "github.read", args: { query: "A".repeat(7000) }, result: { text: "R".repeat(9000) }, status: "completed" }] },
    { ...base, id: "private", queueItemId: "other", type: "message", role: "user", content: "PRIVATE" },
  ];
  await store.appendEntries("s", "t", entries);
  return store;
}

it("exposes compaction summaries and synthetic continuation provenance", async () => {
  const result = await readStepTranscript(await fixture(), "s", "t", { limit: 10 });
  expect(result?.messages[1]).toMatchObject({ messageId: "compact", text: "S".repeat(6000), textTruncated: true, compaction: { tokenCountBefore: 9000, tokenCountAfter: 2000, coveredEntryCount: 1 } });
  expect(result?.messages[2]).toMatchObject({ synthetic: true, compactionContinuation: true });
  expect(result?.messages[3]).toMatchObject({ usage: { output: 2 }, toolCalls: [{ callId: "c", resultTruncated: true, argsTruncated: true }] });
});

it("retrieves complete prompt and tool content in bounded slices", async () => {
  const store = await fixture();
  const first = await readStepTranscript(store, "s", "t", { limit: 1, content: { messageId: "prompt", field: "text", offset: 0 } });
  expect(first?.content).toMatchObject({ text: "P".repeat(6000), totalLength: 14000, nextOffset: 6000 });
  const last = await readStepTranscript(store, "s", "t", { limit: 1, content: { messageId: "prompt", field: "text", offset: 12000 } });
  expect(last?.content).toMatchObject({ text: "P".repeat(2000), totalLength: 14000, nextOffset: null });
  const tool = await readStepTranscript(store, "s", "t", { limit: 1, content: { messageId: "tools", field: "tool_result", callId: "c", offset: 6000 } });
  expect(tool?.content).toMatchObject({ text: "R".repeat(3000), totalLength: 9000, nextOffset: null });
});

it("keeps content slices scoped to the checkpoint submissions", async () => {
  const store = await fixture();
  const result = await readStepTranscript(store, "s", "t", { limit: 10, queueItemIds: ["q"], content: { messageId: "private", field: "text", offset: 0 } });
  expect(result?.content).toBeUndefined();
  expect(result?.contentError).toBeTruthy();
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

it("reports the entry cap per submission rather than across combined repair history", async () => {
  const store = await fixture();
  await store.appendEntries("s", "t", Array.from({ length: 2100 }, (_, i) => ({
    id: `batch-${i}`, sessionId: "s", threadId: "t", parentId: null, createdAt: i + 10,
    type: "message", role: "user", content: "retained", queueItemId: i < 1200 ? "original" : "repair",
  })));
  expect(await readStepTranscript(store, "s", "t", { limit: 1, queueItemIds: ["original", "repair"] })).toMatchObject({ total: 2100, entriesMayBeTruncated: false });
  expect(await readStepTranscript(store, "s", "t", { limit: 1 })).toMatchObject({ entriesMayBeTruncated: true });
});
