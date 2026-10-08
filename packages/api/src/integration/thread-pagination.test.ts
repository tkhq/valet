import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "./_setup.js";
import type { ListThreadsResponse } from "../wire/types.js";
let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });
it("pages workspace threads and searches persisted content beyond the first page", async () => {
  api = await bootTestApi();
  const created = await fetch(`${api.baseUrl}/api/threads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const owner = await created.json() as { sessionId: string };
  for (let i = 0; i < 25; i++) {
    const now = 1000 + i;
    await api.providers.engineStore.saveThread(owner.sessionId, { id: `paged-${i}`, sessionId: owner.sessionId, key: `web:paged-${i}`, status: "active", queueMode: "followup", createdAt: now, updatedAt: now });
  }
  const base = `${api.baseUrl}/api/sessions/${encodeURIComponent(owner.sessionId)}/threads`;
  const page = await (await fetch(`${base}?limit=10`)).json() as ListThreadsResponse;
  expect(page.threads).toHaveLength(10);
  expect(page.nextCursor).toBeTypeOf("string");
  const next = await (await fetch(`${base}?limit=10&cursor=${page.nextCursor}`)).json() as ListThreadsResponse;
  // The implicit default is returned separately on each page.
  expect(next.threads.filter(t => t.id !== page.defaultThreadId).some(t => page.threads.some(first => first.id === t.id))).toBe(false);
  const selected = await (await fetch(`${base}?limit=10&threadId=paged-0&fixedId=foreign-thread`)).json() as ListThreadsResponse;
  expect(selected.threads.some(t => t.id === "paged-0")).toBe(true);
  expect(selected.threads.some(t => t.id === "foreign-thread")).toBe(false);
  const { sql } = await import("drizzle-orm");
  await api.providers.db.execute(sql`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,role,content,created_at) VALUES ('search-old',${owner.sessionId},'paged-0','message','user','needle beyond page',1001)`);
  const found = await (await fetch(`${base}?q=needle`)).json() as ListThreadsResponse;
  expect(found.threads.map(t => t.id)).toEqual(["paged-0"]);
  expect((await fetch(`${base}?limit=10&cursor=bad`)).status).toBe(400);
});
