import { afterEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureAssistantExecution } from "../assistants/service.js";
import { pluginThreadKey } from "../plugins/plugin-thread-key.js";
import { agentSessions } from "../schema/index.js";
import type { ListThreadsResponse, WorkspaceActiveWorkResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

const owner = { type: "user", id: "local-user" } as const;
const meta = { orgId: "local-org", actorUserId: "local-user" };

async function queueItem(id: string, sessionId: string, threadId: string): Promise<void> {
  await api!.providers.db.execute(sql`INSERT INTO engine_queue_items (id,session_id,thread_id,status,outcome,content,attempt_count,max_attempts,timeout_at,created_at,updated_at)
    VALUES (${id},${sessionId},${threadId},'running',${null},'prompt',1,1,10000,1,2)`);
}

it("keeps plugin threads out of the thread list but opens one by link", async () => {
  api = await bootTestApi();
  const key = pluginThreadKey("demo", "pr-1");
  const execution = await ensureAssistantExecution(api.providers, owner, meta, key, { isolated: true, title: "PR 1" });
  const thread = await execution.session.createThread(key, { title: "PR 1" });

  const list = await (await fetch(`${api.baseUrl}/api/threads`)).json() as ListThreadsResponse;
  expect(list.threads.map((t) => t.id)).not.toContain(thread.id);
  const search = await (await fetch(`${api.baseUrl}/api/threads?q=PR`)).json() as ListThreadsResponse;
  expect(search.threads.map((t) => t.id)).not.toContain(thread.id);
  const selected = await (await fetch(`${api.baseUrl}/api/threads?threadId=${thread.id}`)).json() as ListThreadsResponse;
  expect(selected.threads.map((t) => t.id)).toContain(thread.id);
});

it("keeps running plugin threads and plugin children out of Home active work", async () => {
  api = await bootTestApi();
  const key = pluginThreadKey("demo", "pr-2");
  const execution = await ensureAssistantExecution(api.providers, owner, meta, key, { isolated: true });
  const pluginThread = await execution.session.createThread(key);
  await api.providers.db.insert(agentSessions).values([
    { id: "child_plg_abc", ownerType: "user", ownerId: "local-user", orgId: "local-org", userId: "local-user", title: "Plugin child", workspace: "w", createdAt: 1, updatedAt: 1 },
    { id: "plain-child", ownerType: "user", ownerId: "local-user", orgId: "local-org", userId: "local-user", title: "Person's child", workspace: "w", createdAt: 1, updatedAt: 1 },
  ]);
  await queueItem("plugin-thread-q", execution.sessionId, pluginThread.id);
  await queueItem("plugin-child-q", "child_plg_abc", "t1");
  await queueItem("plain-child-q", "plain-child", "t2");

  const response = await fetch(`${api.baseUrl}/api/workspaces/user/active-work`);
  expect(response.status).toBe(200);
  const ids = (await response.json() as WorkspaceActiveWorkResponse).items.map((i) => i.id);
  expect(ids).toContain("plain-child-q");
  expect(ids).not.toContain("plugin-thread-q");
  expect(ids).not.toContain("plugin-child-q");
});
