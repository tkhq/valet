import { afterEach, describe, expect, it } from "vitest";
import type { MessageEntry } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { CreateSessionResponse, ListMessagesResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("GET /messages: bounded tail", () => {
  it("returns an ordered tail and reports older entries", async () => {
    api = await bootTestApi();
    const createRes = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: "/tmp" }),
    });
    expect(createRes.status).toBe(201);
    const { id: sessionId } = (await createRes.json()) as CreateSessionResponse;

    const engineSession = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const thread = await engineSession.ensureDefaultThread();
    const entries: MessageEntry[] = Array.from({ length: 201 }, (_, index) => ({
      id: `m${index + 1}`,
      sessionId,
      threadId: thread.id,
      parentId: null,
      type: "message",
      role: "user",
      content: `message ${index + 1}`,
      createdAt: 1,
    }));
    await api.providers.engineStore.appendEntries(sessionId, thread.id, entries);

    const tailRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages?limit=200`);
    expect(tailRes.status).toBe(200);
    const tail = (await tailRes.json()) as ListMessagesResponse;
    expect(tail.hasMore).toBe(true);
    expect(tail.messages.map((message) => message.id)).toEqual(
      Array.from({ length: 200 }, (_, index) => `m${index + 2}`),
    );

    const fullRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages?limit=201`);
    expect(fullRes.status).toBe(200);
    const full = (await fullRes.json()) as ListMessagesResponse;
    expect(full.hasMore).toBe(false);
    expect(full.messages.map((message) => message.id)).toEqual(
      Array.from({ length: 201 }, (_, index) => `m${index + 1}`),
    );
  });
});
