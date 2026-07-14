/**
 * REST round-trip for `entry.signal` (plan decision 2 / Task 1).
 *
 * Seeds a `MessageEntry` with `signal` directly into the engine store (no
 * LLM turn needed — signal entries persist at turn claim, which we're not
 * exercising here), then asserts `GET /messages` returns the trimmed wire
 * `signal` shape. Regression guard for the CLAUDE.md persistence-shape
 * checklist: engine entry → bridge → REST `entryToMessage`.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { MessageEntry } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { CreateSessionResponse, ListMessagesResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("GET /messages: entry.signal round-trip", () => {
  it("returns the trimmed wire signal for a persisted signal entry", async () => {
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

    const signalEntry: MessageEntry = {
      id: "e-signal-1",
      sessionId,
      threadId: thread.id,
      parentId: null,
      type: "message",
      role: "user",
      content: "the child finished the task",
      signal: {
        signalType: "child.settled",
        attributes: { title: "Fix the bug", outcome: "success" },
        tagName: "signal",
        senderSessionId: "child-1",
        hopCount: 1,
      },
      createdAt: Date.now(),
    };
    const plainEntry: MessageEntry = {
      id: "e-plain-1",
      sessionId,
      threadId: thread.id,
      parentId: null,
      type: "message",
      role: "user",
      content: "hello",
      createdAt: Date.now(),
    };
    await api.providers.engineStore.appendEntries(sessionId, thread.id, [signalEntry, plainEntry]);

    const msgRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`);
    expect(msgRes.status).toBe(200);
    const { messages } = (await msgRes.json()) as ListMessagesResponse;

    const signalMessage = messages.find((m) => m.id === "e-signal-1");
    expect(signalMessage).toBeDefined();
    // Wire signal keeps signalType/attributes/senderSessionId — drops
    // tagName/hopCount (engine-internal, plan decision 2).
    expect(signalMessage?.signal).toEqual({
      signalType: "child.settled",
      attributes: { title: "Fix the bug", outcome: "success" },
      senderSessionId: "child-1",
    });

    const plainMessage = messages.find((m) => m.id === "e-plain-1");
    expect(plainMessage).toBeDefined();
    expect(plainMessage?.signal).toBeUndefined();
  });
});
