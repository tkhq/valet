import { afterEach, expect, it } from "vitest";
import { ensureAssistantExecution, ensureDefaultAssistantSession, retireAssistant } from "../assistants/service.js";
import { changeThreadProjects } from "../services/thread-projects.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, assistants, legacyAssistantConversations, legacyAssistantRuntimes, pluginStore, sessionThreads } from "../schema/index.js";
import { orgs, teams, teamMembers } from "../schema/index.js";
import type { ThreadProjects, ThreadProjectsOperation, ThreadProjectsResponse } from "@valet/shared";
import { z } from "zod";
import { threadProjectsDocumentSchema, threadProjectsSchema } from "../services/thread-projects-schema.js";
import { and, eq, sql } from "drizzle-orm";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

async function runtime(a: TestApi, id = "sidebar-runtime", ownerType: "user" | "team" = "user", ownerId = "local-user", orgId = "local-org") {
  await a.providers.db.insert(agentSessions).values({ id, userId: ownerId, orgId, workspace: "/", ownerType, ownerId, createdAt: 1, updatedAt: 1 });
  for (const threadId of ["chat-a", "chat-b"]) await a.providers.engineStore.saveThread(id, {
    id: threadId, sessionId: id, key: `web:${threadId}`, status: "active", queueMode: "steer", createdAt: 1, updatedAt: 1,
  });
  return `${a.baseUrl}/api/me/thread-projects/${id}`;
}
function patch(url: string, operations: ThreadProjectsOperation[], userId?: string) {
  return fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json", ...(userId ? { "x-valet-test-user-id": userId } : {}) },
    body: JSON.stringify({ expectedViewerId: userId ?? "local-user", operations }) });
}
async function read(url: string, userId?: string): Promise<ThreadProjectsResponse> {
  const response = await fetch(url, { headers: userId ? { "x-valet-test-user-id": userId } : {} });
  expect(response.status).toBe(200);
  return z.object({ value: threadProjectsSchema, revision: z.number(), generation: z.number().optional() }).parse(await response.json());
}

it("keeps a project created by one device available to another device", async () => {
  api = await bootTestApi();
  await api.providers.db.insert(agentSessions).values({
    id: "sidebar-runtime", userId: "local-user", orgId: "local-org", workspace: "/",
    ownerType: "user", ownerId: "local-user", createdAt: 1, updatedAt: 1,
  });
  const url = `${api.baseUrl}/api/me/thread-projects/sidebar-runtime`;
  const created = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedViewerId: "local-user", operations: [{ type: "create", id: "project-a", name: "Customer reports" }] }),
  });
  expect(created.status).toBe(200);
  expect(await (await fetch(url)).json()).toMatchObject({ value: { projects: [{ id: "project-a", name: "Customer reports" }] } });
});

it("preserves concurrent changes and exposes rename, move, and pins to other devices", async () => {
  api = await bootTestApi();
  const url = await runtime(api);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => patch(url, [{ type: "create", id: `project-${i}`, name: `Project ${i}` }])));
  expect(results.map(result => result.status)).toEqual(Array(8).fill(200));
  expect((await read(url)).value.projects).toHaveLength(8);
  expect((await patch(url, [
    { type: "rename", id: "project-0", name: "Customer reports" },
    { type: "assign", threadId: "chat-a", projectId: "project-0" },
    { type: "pin", threadId: "chat-a", pinned: true },
  ])).status).toBe(200);
  expect((await read(url)).value).toMatchObject({ projects: expect.arrayContaining([{ id: "project-0", name: "Customer reports", collapsed: false }]),
    assignments: { "chat-a": "project-0" }, pinned: ["chat-a"] });
});

it("merges both devices' legacy folders without overwriting edits or resurrecting deleted state", async () => {
  api = await bootTestApi();
  const url = await runtime(api);
  const legacy: ThreadProjects = { projects: [{ id: "p", name: "Old name", collapsed: false }, { id: "gone", name: "Deleted", collapsed: false }],
    assignments: { "chat-a": "p" }, pinned: ["chat-a"], grouped: true, collapsed: false };
  expect((await patch(url, [{ type: "import", value: legacy }])).status).toBe(200);
  expect((await patch(url, [
    { type: "rename", id: "p", name: "New name" }, { type: "delete", id: "gone", archivedThreadIds: [] },
    { type: "assign", threadId: "chat-a", projectId: null }, { type: "pin", threadId: "chat-a", pinned: false },
  ])).status).toBe(200);
  const otherDevice = { ...legacy, projects: [...legacy.projects, { id: "other", name: "Other device", collapsed: false }], assignments: { ...legacy.assignments, "chat-b": "other" } };
  for (let i = 0; i < 3; i++) expect((await patch(url, [{ type: "import", value: otherDevice }])).status).toBe(200);
  expect((await read(url)).value).toEqual({ ...legacy,
    projects: [{ id: "p", name: "New name", collapsed: false }, { id: "other", name: "Other device", collapsed: false }],
    assignments: { "chat-b": "other" }, pinned: [],
  });
  expect((await patch(url, [{ type: "rename", id: "gone", name: "Restore" }])).status).toBe(409);
  expect((await patch(url, [{ type: "create", id: "gone", name: "Restore" }])).status).toBe(409);
});

it("keeps folders private to the viewer and runtime and denies unavailable sessions and private threads", async () => {
  api = await bootTestApi();
  await api.providers.db.insert(teams).values([{ id: "team-a", orgId: "local-org", name: "A", createdAt: 1 }, { id: "team-b", orgId: "local-org", name: "B", createdAt: 1 }]);
  await api.providers.db.insert(teamMembers).values([
    { teamId: "team-a", userId: "local-user", role: "member" }, { teamId: "team-a", userId: "test-member", role: "member" },
  ]);
  const team = await runtime(api, "team-runtime", "team", "team-a");
  const personal = await runtime(api);
  const unavailable = await runtime(api, "unavailable-team", "team", "team-b");
  await api.providers.db.insert(orgs).values({ id: "other-org", name: "Other", createdAt: 1 });
  const foreignOrg = await runtime(api, "other-org-runtime", "user", "local-user", "other-org");
  expect((await patch(team, [{ type: "create", id: "mine", name: "Mine" }])).status).toBe(200);
  expect((await read(team, "test-member")).value.projects).toEqual([]);
  expect((await fetch(`${team}?expectedViewerId=local-user`, { headers: { "x-valet-test-user-id": "test-member" } })).status).toBe(403);
  expect((await fetch(team, { method: "PATCH", headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
    body: JSON.stringify({ expectedViewerId: "local-user", operations: [{ type: "create", id: "old-account", name: "Old account" }] }),
  })).status).toBe(403);
  expect((await read(team, "test-member")).value.projects).toEqual([]);
  expect((await read(personal)).value.projects).toEqual([]);
  expect((await fetch(personal, { headers: { "x-valet-test-user-id": "test-member" } })).status).toBe(404);
  for (const url of [unavailable, foreignOrg]) {
    expect((await fetch(url)).status).toBe(404);
    expect((await patch(url, [{ type: "create", id: "x", name: "X" }])).status).toBe(404);
  }
  await api.providers.engineStore.saveThread("team-runtime", { id: "private", sessionId: "team-runtime", key: "app-assistant:test-member:private", status: "active", queueMode: "steer", createdAt: 1, updatedAt: 1 });
  expect((await patch(team, [{ type: "pin", threadId: "private", pinned: true }])).status).toBe(404);
  expect((await patch(team, [{ type: "assign", threadId: "private", projectId: "mine" }])).status).toBe(404);
  expect((await read(team)).value).toMatchObject({ projects: [{ id: "mine", name: "Mine" }], pinned: [], assignments: {} });
});

it("does not remove a project when another device adds a chat during archive", async () => {
  api = await bootTestApi();
  const url = await runtime(api);
  await patch(url, [{ type: "create", id: "p", name: "Reports" }, { type: "assign", threadId: "chat-a", projectId: "p" }]);
  await patch(url, [{ type: "assign", threadId: "chat-b", projectId: "p" }]);
  expect((await patch(url, [{ type: "delete", id: "p", archivedThreadIds: ["chat-a"] }])).status).toBe(409);
  expect((await read(url)).value.projects).toHaveLength(1);
  expect((await patch(url, [{ type: "delete", id: "p", archivedThreadIds: ["chat-a", "chat-b"] }])).status).toBe(200);
  expect((await read(url)).value).toMatchObject({ projects: [], assignments: {} });
});

it("rejects invalid, oversized, and tenant-supplied preference payloads", async () => {
  api = await bootTestApi();
  const url = await runtime(api);
  for (const body of [null, { operations: [{ type: "create", id: "p", name: "P" }] },
    { expectedViewerId: "local-user", operations: [] },
    { expectedViewerId: "local-user", userId: "test-member", operations: [{ type: "create", id: "p", name: "P" }] },
    { expectedViewerId: "local-user", operations: [{ type: "create", id: "p", name: "x".repeat(101) }] },
    { expectedViewerId: "local-user", operations: [{ type: "create", id: "__proto__", name: "Bad" }] },
    { expectedViewerId: "local-user", operations: Array.from({ length: 501 }, () => ({ type: "grouped", value: true })) }]) {
    expect((await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status).toBe(400);
  }
  expect((await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedViewerId: "local-user", operations: [{ type: "create", id: "p", name: "x".repeat(2 * 1024 * 1024) }] }),
  })).status).toBe(413);
  expect((await read(url)).value.projects).toEqual([]);
});

it("returns a recoverable import conflict while keeping server organization available", async () => {
  api = await bootTestApi();
  const url = await runtime(api);
  const value: ThreadProjects = { projects: Array.from({ length: 150 }, (_, i) => ({ id: `server-${i}`, name: `Server ${i}`, collapsed: false })),
    assignments: {}, pinned: [], grouped: true, collapsed: false };
  expect((await patch(url, [{ type: "import", value }])).status).toBe(200);
  const response = await patch(url, [{ type: "import", value: { ...value,
    projects: Array.from({ length: 60 }, (_, i) => ({ id: `local-${i}`, name: `Local ${i}`, collapsed: false })) } }]);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "import-limit" });
  expect((await read(url)).value.projects).toHaveLength(150);
  expect((await patch(url, [{ type: "rename", id: "server-0", name: "Ready" }])).status).toBe(200);
});

it("exposes the compacted create generation and an explicit closed import conflict", async () => {
  api = await bootTestApi();
  const url = await runtime(api);
  await patch(url, [{ type: "create", id: "p", name: "P" }]);
  const [row] = await api.providers.db.select().from(pluginStore).where(and(eq(pluginStore.collection, "thread-projects"), eq(pluginStore.scopeId, "local-user"))).limit(1);
  if (!row) throw new Error("Missing saved folders");
  const document = threadProjectsDocumentSchema.parse(row.doc);
  document.touchedPins = Array.from({ length: 20000 }, (_, i) => `old-${i}`);
  await api.providers.db.update(pluginStore).set({ doc: document }).where(eq(pluginStore.id, row.id));
  expect((await read(url)).generation).toBe(1);
  const legacy = await patch(url, [{ type: "import", value: { projects: [], assignments: {}, pinned: ["chat-a"], grouped: true, collapsed: false } }]);
  expect(legacy.status).toBe(409);
  expect(await legacy.json()).toMatchObject({ code: "import-closed" });
  expect((await patch(url, [{ type: "create", id: "old", name: "Old" }])).status).toBe(409);
  expect((await patch(url, [{ type: "create", id: "new", name: "New", generation: 1 }])).status).toBe(200);
});

it("removes archived and deleted live references in batches without changing another runtime", async () => {
  api = await bootTestApi();
  const url = await runtime(api);
  const other = await runtime(api, "other-runtime");
  await api.providers.engineStore.saveThread("other-runtime", { id: "other-chat", sessionId: "other-runtime", key: "web:other-chat", status: "active", queueMode: "steer", createdAt: 1, updatedAt: 1 });
  await patch(url, [{ type: "create", id: "p", name: "P" }]);
  expect((await patch(other, [{ type: "create", id: "other", name: "Other" }, { type: "assign", threadId: "other-chat", projectId: "other" }, { type: "pin", threadId: "other-chat", pinned: true }])).status).toBe(200);
  const ids = Array.from({ length: 101 }, (_, i) => `archived-${i}`);
  const [row] = await api.providers.db.select().from(pluginStore).where(and(eq(pluginStore.scopeId, "local-user"), eq(pluginStore.key, JSON.stringify(["local-org", "sidebar-runtime"])))).limit(1);
  if (!row) throw new Error("Missing saved folders");
  const document = threadProjectsDocumentSchema.parse(row.doc);
  document.value.assignments = Object.fromEntries([...ids, "chat-b", "still-active"].map(id => [id, "p"]));
  document.value.pinned = [...ids, "chat-b", "still-active"];
  await api.providers.db.update(pluginStore).set({ doc: document }).where(eq(pluginStore.id, row.id));
  for (const id of [...ids, "still-active"]) {
    await api.providers.engineStore.saveThread("sidebar-runtime", { id, sessionId: "sidebar-runtime", key: `web:${id}`, status: "active", queueMode: "steer", createdAt: 1, updatedAt: 1 });
  }
  await api.providers.db.insert(sessionThreads).values(ids.map(id => ({ id, sessionId: "sidebar-runtime", createdAt: 1, archivedAt: 2 })));
  await api.providers.db.execute(sql`DELETE FROM engine_threads WHERE session_id = ${"sidebar-runtime"} AND id = ${"chat-b"}`);
  const pruned = await read(url);
  expect(pruned.value.assignments).toEqual({ "still-active": "p" });
  expect(pruned.value.pinned).toEqual(["still-active"]);
  expect((await read(other)).value).toMatchObject({ assignments: { "other-chat": "other" }, pinned: ["other-chat"] });
  const [saved] = await api.providers.db.select().from(pluginStore).where(eq(pluginStore.id, row.id)).limit(1);
  const cleaned = threadProjectsDocumentSchema.parse(saved?.doc);
  expect(cleaned.value.assignments).toEqual({ "still-active": "p" });
  expect(cleaned.touchedAssignments).toContain("archived-100");
  expect(cleaned.touchedPins).toContain("chat-b");
  await api.providers.db.update(sessionThreads).set({ archivedAt: null }).where(and(eq(sessionThreads.id, "archived-100"), eq(sessionThreads.sessionId, "sidebar-runtime")));
  expect((await patch(url, [{ type: "import", value: document.value }])).status).toBe(200);
  expect((await read(url)).value).toEqual(pruned.value);
  expect((await patch(url, [{ type: "pin", threadId: "archived-0", pinned: true }])).status).toBe(404);
});


async function subscriptionExecution(a: TestApi, key = "events") {
  await a.providers.db.insert(teams).values({ id: "folder-team", orgId: "local-org", name: "Folders", createdAt: 1 });
  await a.providers.db.insert(teamMembers).values([
    { teamId: "folder-team", userId: "local-user", role: "admin" },
    { teamId: "folder-team", userId: "test-member", role: "member" },
  ]);
  const owner = { type: "team" as const, id: "folder-team" };
  const meta = { orgId: "local-org", actorUserId: "local-user" };
  const root = await ensureDefaultAssistantSession(a.providers, owner, meta);
  const execution = await ensureAssistantExecution(a.providers, owner, meta, key);
  const thread = await execution.session.createThread(key);
  return { root, execution, thread, url: `${a.baseUrl}/api/me/thread-projects/${encodeURIComponent(root.sessionId)}` };
}

it("assigns and pins a listed subscription execution thread in its workspace folders", async () => {
  api = await bootTestApi();
  const { root, execution, thread, url } = await subscriptionExecution(api);
  expect(execution.sessionId).not.toBe(root.sessionId);
  const listed = await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(root.sessionId)}/threads`);
  expect(listed.status).toBe(200);
  expect(await listed.json()).toMatchObject({ threads: expect.arrayContaining([
    expect.objectContaining({ id: thread.id, sessionId: execution.sessionId }),
  ]) });
  expect((await patch(url, [{ type: "create", id: "reports", name: "Reports" }])).status).toBe(200);
  const move: ThreadProjectsOperation[] = [{ type: "assign", threadId: thread.id, projectId: "reports" }, { type: "pin", threadId: thread.id, pinned: true }];
  for (let retry = 0; retry < 2; retry++) expect((await patch(url, move)).status).toBe(200);
  expect((await read(url)).value).toMatchObject({ assignments: { [thread.id]: "reports" }, pinned: [thread.id] });
  expect((await read(url, "test-member")).value).toMatchObject({ projects: [], assignments: {}, pinned: [] });
});

it("preserves saved execution references during folder refresh and legacy import", async () => {
  api = await bootTestApi();
  const { root, thread, url } = await subscriptionExecution(api);
  const value: ThreadProjects = { projects: [{ id: "reports", name: "Reports", collapsed: false }],
    assignments: { [thread.id]: "reports" }, pinned: [thread.id], grouped: true, collapsed: false };
  await changeThreadProjects(api.providers.db, { orgId: "local-org", userId: "local-user", sessionId: root.sessionId }, [{ type: "import", value }]);
  expect((await read(url)).value).toEqual(value);
  expect((await patch(url, [{ type: "import", value }])).status).toBe(200);
  expect((await read(url)).value).toEqual(value);
});

it("checks the execution's governing conversation before accepting a public-looking inner thread", async () => {
  api = await bootTestApi();
  const { execution, url } = await subscriptionExecution(api, "app-assistant:test-member");
  const inner = await execution.session.createThread("web:looks-shared");
  await patch(url, [{ type: "create", id: "p", name: "Private" }]);
  for (const threadId of [inner.id, "missing-thread"]) {
    expect((await patch(url, [{ type: "assign", threadId, projectId: "p" }, { type: "pin", threadId, pinned: true }])).status).toBe(404);
  }
  expect((await patch(url, [{ type: "create", id: "mine", name: "Mine" },
    { type: "assign", threadId: inner.id, projectId: "mine" }, { type: "pin", threadId: inner.id, pinned: true },
  ], "test-member")).status).toBe(200);
  expect((await read(url, "test-member")).value).toMatchObject({ assignments: { [inner.id]: "mine" }, pinned: [inner.id] });
  expect((await read(url)).value).toMatchObject({ assignments: {}, pinned: [] });
});

it("rejects unrelated runtimes even when they have the same owner or a foreign thread ID", async () => {
  api = await bootTestApi();
  const { url } = await subscriptionExecution(api);
  await patch(url, [{ type: "create", id: "p", name: "Reports" }]);
  await runtime(api, "unrelated", "team", "folder-team");
  await api.providers.db.insert(orgs).values({ id: "foreign-org", name: "Foreign", createdAt: 1 });
  await runtime(api, "foreign", "team", "folder-team", "foreign-org");
  for (const [sessionId, threadId] of [["unrelated", "unrelated-chat"], ["foreign", "foreign-chat"]]) {
    await api.providers.engineStore.saveThread(sessionId, { id: threadId, sessionId, key: "web:shared", status: "active", queueMode: "steer", createdAt: 1, updatedAt: 1 });
    expect((await patch(url, [{ type: "assign", threadId, projectId: "p" }, { type: "pin", threadId, pinned: true }])).status).toBe(404);
  }
  expect((await read(url)).value).toMatchObject({ assignments: {}, pinned: [] });
});

it("cleans archived and deleted execution references while retaining the project", async () => {
  api = await bootTestApi();
  const { execution, thread, url } = await subscriptionExecution(api);
  const deleted = await execution.session.createThread("web:deleted");
  await patch(url, [{ type: "create", id: "p", name: "Reports" },
    ...[thread.id, deleted.id].flatMap((threadId): ThreadProjectsOperation[] => [
      { type: "assign", threadId, projectId: "p" }, { type: "pin", threadId, pinned: true },
    ]),
  ]);
  await api.providers.db.execute(sql`UPDATE engine_threads SET status = 'archived' WHERE session_id = ${execution.sessionId} AND id = ${thread.id}`);
  expect((await read(url)).value).toMatchObject({ assignments: { [deleted.id]: "p" }, pinned: [deleted.id] });
  await api.providers.db.update(agentSessions).set({ status: "deleted" }).where(eq(agentSessions.id, execution.sessionId));
  expect((await read(url)).value).toMatchObject({ projects: [{ id: "p", name: "Reports" }], assignments: {}, pinned: [] });
  expect((await patch(url, [{ type: "pin", threadId: deleted.id, pinned: true }])).status).toBe(404);
});

it("organizes migration-retained history until the assistant is explicitly retired", async () => {
  api = await bootTestApi();
  const { root: old, thread, url: oldUrl } = await subscriptionExecution(api);
  const retained = await old.session.createThread("web:retained-shared");
  const { db, engineHost } = api.providers;
  await db.insert(legacyAssistantRuntimes).values({ assistantId: old.assistant.id, sessionId: old.sessionId,
    orgId: "local-org", ownerType: "team", ownerId: "folder-team" });
  await db.insert(legacyAssistantConversations).values({ threadId: retained.id, sessionId: old.sessionId, conversationKey: retained.key });
  await db.update(assistants).set({ ownerId: `folder-team:retired:${old.assistant.id}`, archivedAt: 123 }).where(eq(assistants.id, old.assistant.id));
  engineHost.evictCache(old.sessionId);
  const current = await ensureDefaultAssistantSession(api.providers, { type: "team", id: "folder-team" }, { orgId: "local-org", actorUserId: "local-user" });
  const url = `${api.baseUrl}/api/me/thread-projects/${encodeURIComponent(current.sessionId)}`;
  expect(url).not.toBe(oldUrl);
  const listed = await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(current.sessionId)}/threads`);
  expect(await listed.json()).toMatchObject({ threads: expect.arrayContaining([expect.objectContaining({ id: retained.id })]) });
  expect((await patch(url, [{ type: "create", id: "p", name: "History" }, { type: "assign", threadId: retained.id, projectId: "p" }, { type: "pin", threadId: retained.id, pinned: true }])).status).toBe(200);
  expect((await read(url)).value).toMatchObject({ assignments: { [retained.id]: "p" }, pinned: [retained.id] });
  // Executions attached to the old root do not become executions of the new root.
  expect((await patch(url, [{ type: "pin", threadId: thread.id, pinned: true }])).status).toBe(404);
  await retireAssistant(db, old.assistant.id);
  expect((await read(url)).value).toMatchObject({ projects: [{ id: "p", name: "History" }], assignments: {}, pinned: [] });
  expect((await patch(url, [{ type: "pin", threadId: retained.id, pinned: true }])).status).toBe(404);
});
