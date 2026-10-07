import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureAssistantExecution } from "../assistants/service.js";
import { workflowDefinitions, sessionThreads } from "../schema/index.js";
import { createTeam, addMember } from "../services/teams.js";
import type { GetWorkflowRunResponse, ListThreadsResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

it("keeps run histories under Automations while retaining the human origin and editor", async () => {
  api = await bootTestApi();
  const { db, workflowStore } = api.providers;
  const team = await createTeam(db, { orgId: "local-org", name: "Run conversations", creatorUserId: "local-user" });
  await addMember(db, { teamId: team.id, userId: "test-member", role: "member" });
  const owner = { type: "team", id: team.id } as const;
  const meta = { orgId: "local-org", actorUserId: "local-user" };
  const origin = await ensureAssistantExecution(api.providers, owner, meta, "app-assistant:local-user");
  const human = origin.session.thread("app-assistant:local-user");
  await human.pause();
  const editor = await ensureAssistantExecution(api.providers, owner, meta, "workflow:wf_conversations:local-user");
  const editorThread = editor.session.thread("workflow:wf_conversations:local-user");
  await editorThread.pause();
  const definition = { version: "dag/v1", nodes: [], edges: [] } as const;
  await db.insert(workflowDefinitions).values({ id: "wf_conversations", orgId: "local-org", ownerType: "team", ownerId: team.id,
    name: "Conversations", definition, createdAt: 1, updatedAt: 1 });
  await workflowStore.createRun("run_conversations", { workflowId: "wf_conversations", definitionVersionId: "v1",
    origin: { assistantSessionId: origin.sessionId, threadId: human.id } },
    { version: "dag/v1", nodes: [], edges: [] }, "v1", { ownerType: "team", ownerId: team.id });
  const execution = await ensureAssistantExecution(api.providers, owner, meta, "signal:workflow:run_conversations");
  const report = execution.session.thread("signal:workflow:run_conversations");
  await report.pause();
  // The run has no completed checkpoints. Its live conversation must already be reachable.
  const response = await fetch(`${api.baseUrl}/api/workflows/runs/run_conversations`);
  expect(response.status).toBe(200);
  const detail = await response.json() as GetWorkflowRunResponse;
  expect(detail.conversations).toEqual([{ sessionId: execution.sessionId, threadId: report.id }]);
  expect(detail.checkpoints).toEqual([]);
  const listResponse = await fetch(`${api.baseUrl}/api/threads?workspace=${team.id}`);
  expect(listResponse.status).toBe(200);
  const list = await listResponse.json() as ListThreadsResponse;
  expect(list.threads.map(thread => thread.id)).toContain(human.id);
  expect(list.threads.map(thread => thread.id)).toContain(editorThread.id);
  expect(list.threads.map(thread => thread.id)).not.toContain(report.id);
  const selected = await fetch(`${api.baseUrl}/api/threads?workspace=${team.id}&threadId=${report.id}`);
  expect((await selected.json() as ListThreadsResponse).threads.map(thread => thread.id)).toContain(report.id);
  await db.insert(sessionThreads).values({ id: report.id, sessionId: execution.sessionId, archivedAt: Date.now(), createdAt: Date.now() }).onConflictDoUpdate({ target: sessionThreads.id, set: { archivedAt: Date.now() } });
  const archivedSelected = await fetch(`${api.baseUrl}/api/threads?workspace=${team.id}&threadId=${report.id}`);
  expect((await archivedSelected.json() as ListThreadsResponse).threads.find(thread => thread.id === report.id)?.archivedAt).toBeTruthy();
  const history = await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(execution.sessionId)}/messages?threadId=${report.id}`);
  expect(history.status).toBe(200);
  const denied = await fetch(`${api.baseUrl}/api/workflows/runs/run_conversations`, { headers: { "x-valet-test-user-id": "test-member" } });
  expect(denied.status).toBe(404);
});

it("finds older run threads stored directly in a personal assistant runtime", async () => {
  api = await bootTestApi();
  const owner = { type: "user", id: "local-user" } as const;
  const runtime = await ensureAssistantExecution(api.providers, owner,
    { orgId: "local-org", actorUserId: "local-user" }, "signal:workflow:run_personal");
  const report = runtime.session.thread("signal:workflow:run_personal");
  await report.pause();
  await api.providers.db.insert(workflowDefinitions).values({ id: "wf_personal", orgId: "local-org", ownerType: "user", ownerId: "local-user",
    name: "Personal", definition: { version: "dag/v1", nodes: [], edges: [] }, createdAt: 1, updatedAt: 1 });
  await api.providers.workflowStore.createRun("run_personal", { workflowId: "wf_personal", definitionVersionId: "v1" },
    { version: "dag/v1", nodes: [], edges: [] }, "v1", { ownerType: "user", ownerId: "local-user" });
  const response = await fetch(`${api.baseUrl}/api/workflows/runs/run_personal`);
  expect(response.status).toBe(200);
  expect((await response.json() as GetWorkflowRunResponse).conversations)
    .toEqual([{ sessionId: runtime.sessionId, threadId: report.id }]);
  const foreignSelected = await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(runtime.sessionId)}/threads?threadId=${report.id}`, {
    headers: { "x-valet-test-user-id": "test-member" },
  });
  expect(foreignSelected.status).toBe(404);
  for (const archived of ["", "?archived=1"]) {
    const list = await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(runtime.sessionId)}/threads${archived}`);
    expect(list.status).toBe(200);
    expect((await list.json() as ListThreadsResponse).threads.map(thread => thread.id)).not.toContain(report.id);
  }
});
