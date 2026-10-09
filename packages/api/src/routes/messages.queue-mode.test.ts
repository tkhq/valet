/**
 * Per-submit queueMode and promoteItemId on POST /messages (TKAI-240).
 * Mid-turn web followup must not abort; promote steers the existing item.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { childWatches } from "../schema/index.js";
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
  it.each([
    { input: "a steer", cleared: true },
    // Promotion supersedes only running work. It moves the followup ahead
    // of the queued delegated item, which still runs for the channel turn.
    { input: "a promoted followup", cleared: false },
    { input: "a followup", cleared: false },
  ])("clears a child reply origin only when human input supersedes the delegated item: $input", async ({ input, cleared }) => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user", orgId: "local-org", workspace: "/tmp",
    });
    // Pause the thread so no keyless turn settles the delegated item first.
    const thread = await session.ensureDefaultThread();
    await thread.pause();
    const post = async (body: Record<string, unknown>) => {
      const response = await fetch(`${api!.baseUrl}/api/sessions/${sessionId}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, threadId: thread.id }),
      });
      expect(response.status).toBe(202);
      return ((await response.json()) as SendPromptResponse).messageId!;
    };
    // The delegated item, admitted here as the child's queued work.
    const delegated = await post({ text: "Delegated work" });
    const originJson = JSON.stringify({ channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" });
    await api.providers.db.insert(childWatches).values({
      childSessionId: sessionId, parentSessionId: "parent", parentThreadId: "thread-parent",
      queueItemId: delegated, actorUserId: "local-user", orgId: "local-org", settled: false,
      createdAt: Date.now(), originJson,
    });

    if (input === "a steer") await post({ text: "Do it my way instead", queueMode: "steer" });
    else {
      const followup = await post({ text: "Private follow-up", queueMode: "followup" });
      if (input === "a promoted followup") await post({ text: "", promoteItemId: followup });
    }

    const watched = await api.providers.engineStore.getQueueItem(sessionId, delegated);
    expect(watched?.supersededByItemId !== undefined).toBe(cleared);
    const [watch] = await api.providers.db.select().from(childWatches).where(eq(childWatches.childSessionId, sessionId));
    expect(watch?.originJson).toBe(cleared ? null : originJson);
  });

  it.each([
    { rejection: "an unknown file reference", body: { text: "Private follow-up", fileRefs: [{ ref: "missing-ref" }] } },
    { rejection: "an unknown promoted item", body: { promoteItemId: "missing-item" } },
  ])("keeps a child reply origin when the web prompt has $rejection", async ({ body }) => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user", orgId: "local-org", workspace: "/tmp",
    });
    await session.pause();
    const originJson = JSON.stringify({ channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" });
    await api.providers.db.insert(childWatches).values({
      childSessionId: sessionId, parentSessionId: "parent", parentThreadId: "thread-parent",
      queueItemId: "original", actorUserId: "local-user", orgId: "local-org", settled: false,
      createdAt: Date.now(), originJson,
    });
    const response = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    const [watch] = await api.providers.db.select().from(childWatches).where(eq(childWatches.childSessionId, sessionId));
    expect(watch?.originJson).toBe(originJson);
  });

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

  it("promotes the selected followup while preserving other queued work", async () => {
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
    expect(original?.status).toBe("queued");
    expect(original?.supersededByItemId).toBeUndefined();
  });
});
