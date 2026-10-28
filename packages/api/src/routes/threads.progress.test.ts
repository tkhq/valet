import { afterEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions } from "../schema/index.js";
import type { ThreadProgressResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

it("reads durable progress only through content/read thread authorization", async () => {
  api = await bootTestApi();
  const created = await fetch(`${api.baseUrl}/api/threads`, { method: "POST" });
  expect(created.status).toBe(201);
  const thread = await created.json() as { id: string; sessionId: string };
  const read = (user = "local-user", suffix = "") => fetch(`${api!.baseUrl}/api/threads/${thread.id}/progress${suffix}`, { headers: { "x-valet-test-user-id": user } });
  expect(await (await read()).json()).toEqual({ progress: null });
  const now = Date.now();
  await api.providers.engineStore.admitSubmission(thread.sessionId, thread.id, {
    id: "progress-turn", threadId: thread.id, content: "private prompt content", status: "queued",
    attemptCount: 0, maxAttempts: 10, timeoutAt: now + 3_600_000, createdAt: now, updatedAt: now,
  });
  const response = await read();
  expect(response.status).toBe(200);
  const body = await response.json() as ThreadProgressResponse;
  expect(body.progress).toMatchObject({ turnId: "progress-turn", status: "pending", tasks: [], omittedTasks: 0 });
  expect(typeof body.progress?.revision).toBe("string");
  expect(JSON.stringify(body)).not.toContain("private prompt content");
  expect((await read("test-member")).status).toBe(404);
  expect((await read("local-user", "?threadId=other")).status).toBe(400);
  expect((await fetch(`${api.baseUrl}/api/threads/missing/progress`)).status).toBe(404);
  for (const share of ["view", "reply"]) {
    const changed = await fetch(`${api.baseUrl}/api/threads/${thread.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ share }) });
    expect(changed.status).toBe(200);
    const guest = await read("test-member");
    expect(guest.status).toBe(200);
    expect(await guest.json()).toEqual(body);
  }
  await api.providers.db.update(agentSessions).set({ orgId: "different-org" }).where(eq(agentSessions.id, thread.sessionId));
  expect((await read()).status).toBe(404);
  expect((await read("test-member")).status).toBe(404);
});
