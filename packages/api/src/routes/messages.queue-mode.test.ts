/**
 * Per-submit queueMode and promoteItemId on POST /messages (TKAI-240).
 * Mid-turn web followup must not abort; promote steers the existing item.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { CreateSessionResponse, SendPromptResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function createSession(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: "/tmp" }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as CreateSessionResponse;
  return id;
}

describe("POST /messages: queueMode and promote", () => {
  it("400s when queueMode is not followup or steer", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello", queueMode: "collect" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/followup|steer/);
  });

  it("404s when promoteItemId names no queue item", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "", promoteItemId: "queue_missing" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not found/i);
    expect(body.error).toMatch(/send the message again/i);
  });

  it("admits a followup without aborting the running item, then promote steers", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const engineSession = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const thread = await engineSession.ensureDefaultThread();
    // Pause so the keyless claim loop cannot settle the first item before
    // the followup and promote land. The assertion is about admission, not
    // a live model turn.
    await thread.pause();

    const first = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "original", threadId: thread.id }),
    });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as SendPromptResponse;
    expect(firstBody.messageId).toBeTruthy();

    const followup = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "later",
        threadId: thread.id,
        queueMode: "followup",
      }),
    });
    expect(followup.status).toBe(202);
    const followupBody = (await followup.json()) as SendPromptResponse;
    expect(followupBody.messageId).toBeTruthy();
    expect(followupBody.messageId).not.toBe(firstBody.messageId);

    const store = api.providers.engineStore;
    const running = await store.getQueueItem(sessionId, firstBody.messageId!);
    const queued = await store.getQueueItem(sessionId, followupBody.messageId!);
    expect(queued?.status).toBe("queued");
    expect(running?.outcome?.outcome).not.toBe("superseded");

    const promote = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "",
        threadId: thread.id,
        promoteItemId: followupBody.messageId,
      }),
    });
    expect(promote.status).toBe(202);
    const promoteBody = (await promote.json()) as SendPromptResponse;
    expect(promoteBody.messageId).toBeTruthy();
    expect(promoteBody.messageId).not.toBe(followupBody.messageId);

    const original = await store.getQueueItem(sessionId, firstBody.messageId!);
    const supersededFollowup = await store.getQueueItem(sessionId, followupBody.messageId!);
    expect(supersededFollowup?.outcome).toEqual({ outcome: "superseded" });
    expect(original?.supersededByItemId).toBe(promoteBody.messageId);
  });
});
