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

it("applies a new org compaction window to a loaded thread without a rebuild", async () => {
  api = await bootTestApi();
  const { session } = await ensureDefaultAssistantSession(api.providers, { type: "user", id: "local-user" }, {
    actorUserId: "local-user", orgId: "local-org",
  });
  const thread = await session.createThread("web:compaction-window");
  const limit = async () => {
    const res = await fetch(`${api!.baseUrl}/api/threads/${thread.id}/context`);
    const body = await res.json() as ThreadContextResponse;
    if (!body.context) throw new Error("The test model has a context window.");
    return body.context;
  };
  const before = await limit();
  expect(before.contextWindow - 20_000).toBeGreaterThan(60_000);
  expect(before.limit).toBe(Math.min(before.contextWindow - 20_000, 200_000));

  const patch = async (compactionWindowTokens: number | null) => fetch(`${api!.baseUrl}/api/org/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ compactionWindowTokens }),
  });
  expect((await patch(60_000)).status).toBe(200);
  expect((await limit()).limit).toBe(Math.min(before.contextWindow - 20_000, 60_000));

  expect((await patch(null)).status).toBe(200);
  expect((await limit()).limit).toBe(before.limit);
});
