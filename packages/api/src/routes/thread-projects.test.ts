import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions } from "../schema/index.js";
import { orgs, teams, teamMembers } from "../schema/index.js";
import type { ThreadProjects, ThreadProjectsOperation, ThreadProjectsResponse } from "@valet/shared";
import { z } from "zod";
import { threadProjectsSchema } from "../services/thread-projects-schema.js";

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
  return z.object({ value: threadProjectsSchema, revision: z.number() }).parse(await response.json());
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
