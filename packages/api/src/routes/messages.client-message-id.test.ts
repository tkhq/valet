/**
 * `SendPromptRequest.clientMessageId`: a resend whose first answer was lost
 * (an api restart, a gateway error) must not post the message twice.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { CreateSessionResponse, SendPromptResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function pausedSession(test: TestApi): Promise<{ sessionId: string; threadId: string }> {
  const res = await fetch(`${test.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: "/tmp" }),
  });
  expect(res.status).toBe(201);
  const { id: sessionId } = (await res.json()) as CreateSessionResponse;
  const engineSession = await test.providers.engineHost.sessionFor(sessionId, {
    userId: "local-user",
    orgId: "local-org",
    workspace: "/tmp",
  });
  const thread = await engineSession.ensureDefaultThread();
  // Keep the items queued: the assertions are about admission, not a turn.
  await thread.pause();
  return { sessionId, threadId: thread.id };
}

function send(test: TestApi, sessionId: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${test.baseUrl}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /messages: clientMessageId", () => {
  it("answers a resend with the first admission and queues the message once", async () => {
    api = await bootTestApi();
    const { sessionId, threadId } = await pausedSession(api);

    const first = await send(api, sessionId, { text: "deploy the fix", threadId, clientMessageId: "key-0000001" });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as SendPromptResponse;
    expect(firstBody.messageId).toBeTruthy();

    // The resend checks the key before it spends attachment refs. An api
    // restart empties the ref store, so a dead ref here must not fail it.
    const resend = await send(api, sessionId, {
      text: "deploy the fix", threadId, clientMessageId: "key-0000001", fileRefs: [{ ref: "gone-after-restart" }],
    });
    expect(resend.status).toBe(202);
    expect(((await resend.json()) as SendPromptResponse).messageId).toBe(firstBody.messageId);

    const other = await send(api, sessionId, { text: "deploy the fix", threadId, clientMessageId: "key-0000002" });
    expect(((await other.json()) as SendPromptResponse).messageId).not.toBe(firstBody.messageId);

    const queued = await api.providers.engineStore.listUnsettledSubmissions(sessionId);
    expect(queued.map((item) => item.dispatchId)).toEqual(["web:local-user:key-0000001", "web:local-user:key-0000002"]);
  });

  it("refuses a malformed key and names the fix", async () => {
    api = await bootTestApi();
    const { sessionId, threadId } = await pausedSession(api);
    const res = await send(api, sessionId, { text: "hello", threadId, clientMessageId: "short" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/clientMessageId must be 8 to 64/);
  });
});
