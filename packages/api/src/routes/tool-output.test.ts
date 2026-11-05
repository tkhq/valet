/**
 * The transcript ships large tool output trimmed, and the thread's tool-output
 * route returns the full result for a step that opens (`services/transcript-trim.ts`).
 */
import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { ListMessagesResponse, ToolOutputResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

it("trims a large result in the transcript and returns it whole on request", async () => {
  api = await bootTestApi();
  const created = await fetch(`${api.baseUrl}/api/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const thread = await created.json() as { id: string; sessionId: string };
  const log = `first line\n${"x".repeat(40_000)}\nlast line`;
  await api.providers.engineStore.appendEntries(thread.sessionId, thread.id, [{
    id: "big-output", sessionId: thread.sessionId, threadId: thread.id, parentId: null, type: "message", role: "assistant", content: "Read the log",
    parts: [{ type: "tool_call", callId: "call-1", toolName: "bash", status: "completed", args: { command: "cat build.log" }, result: { content: [{ type: "text", text: log }] } }],
    createdAt: 1,
  }]);
  api.providers.engineHost.evictCache(thread.sessionId);

  const transcript = await (await fetch(`${api.baseUrl}/api/threads/${thread.id}/messages`)).json() as ListMessagesResponse;
  const part = transcript.messages.find((m) => m.id === "big-output")?.parts[0];
  if (part?.kind !== "tool_call") throw new Error("expected the tool call");
  expect(part.resultTrimmed).toEqual({ chars: log.length, entryId: "big-output", threadId: thread.id });
  expect(JSON.stringify(part.result).length).toBeLessThan(10_000);

  const full = await fetch(`${api.baseUrl}/api/threads/${thread.id}/tool-output?entryId=big-output&callId=call-1`);
  expect(full.status).toBe(200);
  expect(((await full.json()) as ToolOutputResponse).result).toEqual({ content: [{ type: "text", text: log }] });
  expect((await fetch(`${api.baseUrl}/api/threads/${thread.id}/tool-output?entryId=big-output&callId=nope`)).status).toBe(404);
  expect((await fetch(`${api.baseUrl}/api/threads/${thread.id}/tool-output`)).status).toBe(400);
});
