/**
 * `SendPromptRequest.clientMessageId`: a resend whose first answer was lost
 * (an api restart, a gateway error) must not post the message twice.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { createSkill } from "../services/skills.js";
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

    const resend = await send(api, sessionId, { text: "deploy the fix", threadId, clientMessageId: "key-0000001" });
    expect(resend.status).toBe(202);
    expect(((await resend.json()) as SendPromptResponse).messageId).toBe(firstBody.messageId);

    const other = await send(api, sessionId, { text: "deploy the fix", threadId, clientMessageId: "key-0000002" });
    expect(((await other.json()) as SendPromptResponse).messageId).not.toBe(firstBody.messageId);

    const queued = await api.providers.engineStore.listUnsettledSubmissions(sessionId);
    expect(queued.map((item) => item.dispatchId)).toEqual(["web:local-user:key-0000001", "web:local-user:key-0000002"]);
  });

  it("answers a resend with a file before it spends the file's ref", async () => {
    api = await bootTestApi();
    const { sessionId, threadId } = await pausedSession(api);
    // The first try queued text and one uploaded file, then its answer was lost.
    const engineSession = await api.providers.engineHost.sessionFor(sessionId, { userId: "local-user", orgId: "local-org", workspace: "/tmp" });
    const first = await engineSession.prompt(
      { text: "read the log", attachments: [{ type: "file", path: "/workspace/uploads/log.txt", bytes: 3, sha256: "sha256:abc", mimeType: "text/plain", name: "log.txt" }] },
      { threadId, dispatchId: "web:local-user:key-0000004" },
    );

    // An api restart empties the ref store, so a dead ref here must not fail the resend.
    const resend = await send(api, sessionId, {
      text: "read the log", threadId, clientMessageId: "key-0000004", fileRefs: [{ ref: "gone-after-restart" }],
    });
    expect(resend.status).toBe(202);
    expect(((await resend.json()) as SendPromptResponse).messageId).toBe(first.queueItemId);
  });

  it("refuses a resend whose key first sent a different message", async () => {
    api = await bootTestApi();
    const { sessionId, threadId } = await pausedSession(api);
    const image = (name: string) => ({ type: "image", url: `data:image/png;base64,${name}`, mimeType: "image/png", name });

    const first = await send(api, sessionId, { text: "look at this", threadId, clientMessageId: "key-0000003", attachments: [image("QQ==")] });
    expect(first.status).toBe(202);

    // The person swapped the image before the resend.
    const swapped = await send(api, sessionId, { text: "look at this", threadId, clientMessageId: "key-0000003", attachments: [image("Qg==")] });
    expect(swapped.status).toBe(409);
    expect(((await swapped.json()) as { error: string }).error).toMatch(/without clientMessageId, or with a new key/);

    const retyped = await send(api, sessionId, { text: "look at that", threadId, clientMessageId: "key-0000003", attachments: [image("QQ==")] });
    expect(retyped.status).toBe(409);

    const queued = await api.providers.engineStore.listUnsettledSubmissions(sessionId);
    expect(queued).toHaveLength(1);
  });

  it("compares slash text as text unless it expands a skill", async () => {
    api = await bootTestApi();
    await createSkill(api.providers.db, { userId: "local-user", orgId: "local-org" }, {
      name: "standup", description: "Summarize a standup", content: "Summarize $1", frontmatter: { invocation: "prompt" },
    });
    const { sessionId, threadId } = await pausedSession(api);
    // An unknown "/word" is an ordinary prompt, so it compares like one.
    const first = await send(api, sessionId, { text: "/alpha", threadId, clientMessageId: "key-0000005" });
    expect(first.status).toBe(202);
    const other = await send(api, sessionId, { text: "/beta", threadId, clientMessageId: "key-0000005" });
    expect(other.status).toBe(409);

    // A skill queues its expansion, so a resend compares the skill and its arguments.
    const skill = await send(api, sessionId, { text: "/skill:standup ops", threadId, clientMessageId: "key-0000006" });
    expect(skill.status).toBe(202);
    const resend = await send(api, sessionId, { text: "/skill:standup ops", threadId, clientMessageId: "key-0000006" });
    expect(resend.status).toBe(202);
    expect(((await resend.json()) as SendPromptResponse).messageId).toBe(((await skill.json()) as SendPromptResponse).messageId);
    const otherArgs = await send(api, sessionId, { text: "/skill:standup eng", threadId, clientMessageId: "key-0000006" });
    expect(otherArgs.status).toBe(409);

    const queued = await api.providers.engineStore.listUnsettledSubmissions(sessionId);
    expect(queued.map((item) => item.dispatchId)).toEqual(["web:local-user:key-0000005", "web:local-user:key-0000006"]);
    expect(queued.map((item) => item.content)).toEqual(["/alpha", expect.stringContaining("Summarize ops")]);
  });

  it("refuses a malformed key and names the fix", async () => {
    api = await bootTestApi();
    const { sessionId, threadId } = await pausedSession(api);
    const res = await send(api, sessionId, { text: "hello", threadId, clientMessageId: "short" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/clientMessageId must be 8 to 64/);
  });
});
