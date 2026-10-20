import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureDefaultAssistantSession } from "../assistants/service.js";
import type { ThreadContextResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

it("reports a thread's context fill on both thread addresses", async () => {
  api = await bootTestApi();
  const { session, sessionId } = await ensureDefaultAssistantSession(api.providers, { type: "user", id: "local-user" }, {
    actorUserId: "local-user", orgId: "local-org",
  });
  const thread = await session.createThread("web:context-meter");

  const byThread = await fetch(`${api.baseUrl}/api/threads/${thread.id}/context`);
  expect(byThread.status).toBe(200);
  const body = await byThread.json() as ThreadContextResponse;
  if (!body.context) throw new Error("The test model has a context window.");
  // A new thread holds only the system prompt, which the estimate counts.
  expect(body.context.tokens).toBeGreaterThan(0);
  expect(body.context.tokens).toBeLessThan(body.context.limit);
  expect(body.context.limit).toBeLessThan(body.context.contextWindow);
  expect(body.context.autoCompact).toBe(true);
  expect(typeof body.context.model).toBe("string");

  const bySession = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/threads/${thread.id}/context`);
  expect(await bySession.json()).toEqual(body);
});

it("reads an unknown thread as missing", async () => {
  api = await bootTestApi();
  expect((await fetch(`${api.baseUrl}/api/threads/th-missing/context`)).status).toBe(404);
});
