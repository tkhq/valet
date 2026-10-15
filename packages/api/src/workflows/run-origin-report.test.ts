import { afterEach, expect, it } from "vitest";
import { LocalRunHost, type NodeCheckpoint, type WorkflowRun } from "@valet/workflow";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureAssistantExecution, ensureDefaultAssistantSession } from "../assistants/service.js";
import { createTeam } from "../services/teams.js";
import { createWorkflowDefinition } from "./service.js";
import { buildWorkflowEngineDeps } from "./engine-deps.js";
import { readRunFollowUp } from "./run-follow-up.js";
import { approvalReport, buildRunApprovalReport, buildRunOriginReport, runReport } from "./run-attention.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

const checkpoint = (nodeId: string, status: NodeCheckpoint["status"], extra: Partial<NodeCheckpoint> = {}): NodeCheckpoint =>
  ({ runId: "run-1", nodeId, iteration: 0, status, attempt: 1, createdAt: 1, ...extra });

it("says what a settled run did", () => {
  expect(runReport("Triage", "run-1", "failed", [checkpoint("fetch", "failed", { error: "GitHub 404" })]))
    .toContain('Workflow "Triage" failed. fetch: GitHub 404');
  expect(runReport("Triage", "run-1", "cancelled", [])).toContain('Workflow "Triage" was cancelled.');
  const done = runReport("Triage", "run-1", "completed", [
    checkpoint("start", "completed"),
    checkpoint("done", "completed", { result: { outcome: "success", output: { labeled: 3 }, message: "Labeled 3 issues" } }),
  ]);
  expect(done).toContain('Workflow "Triage" completed.');
  expect(done).toContain("Labeled 3 issues");
  expect(done).toContain('Output: {"labeled":3}');
});

it("reports a settled run to the thread that started it, once", async () => {
  api = await bootTestApi();
  const { session, sessionId } = await ensureDefaultAssistantSession(api.providers, { type: "user", id: "local-user" },
    { actorUserId: "local-user", orgId: "local-org" });
  const thread = await session.createThread("web:fixing");
  thread.pause();
  const run = (origin?: WorkflowRun["params"]["origin"]): WorkflowRun => ({
    runId: "run-1", status: "settled", outcome: "failed", waitingOn: [], updatedAt: 2, attempt: 1, wakeRequested: false, createdAt: 1,
    definition: { version: "dag/v1" }, definitionVersionId: "v1", actorUserId: "local-user",
    params: { workflowId: "wf-1", definitionVersionId: "v1", ...(origin ? { origin } : {}) },
  });
  let current = run({ assistantSessionId: sessionId, threadId: thread.id });
  const report = buildRunOriginReport({
    db: api.providers.db, engineHost: api.providers.engineHost,
    store: { getRun: async () => current, getCheckpoints: async () => [checkpoint("fetch", "failed", { error: "GitHub 404" })] },
  });
  const info = { runId: "run-1", workflowId: "wf-1", outcome: "failed" as const, settledAt: 2 };
  expect(await readRunFollowUp(api.providers, "local-org", current)).toMatchObject({ registered: true, status: "not_recorded" });
  await report(info);
  expect(await readRunFollowUp(api.providers, "local-org", current)).toMatchObject({
    registered: true, status: "queued", threadId: thread.id,
  });
  // A reclaimed run settles twice; the thread hears about it once.
  await report(info);
  const queued = (await api.providers.engineStore.listUnsettledSubmissions(sessionId)).filter((item) => item.threadId === thread.id);
  expect(queued).toHaveLength(1);
  expect(JSON.stringify(queued[0])).toContain("workflow.settled");
  expect(JSON.stringify(queued[0])).toContain("GitHub 404");

  // A run with no thread waiting (scheduled or event-started) reports nowhere.
  current = run();
  expect(await readRunFollowUp(api.providers, "local-org", current)).toMatchObject({ registered: false, status: "no_origin" });
  await report({ ...info, runId: "run-2" });
  expect((await api.providers.engineStore.listUnsettledSubmissions(sessionId)).filter((item) => item.threadId === thread.id)).toHaveLength(1);
});

it.each(["app-assistant:local-user", "slack:C_PRIVATE:1.2"])("reports a legacy team origin settlement inside its isolated %s audience", async (key) => {
  api = await bootTestApi();
  const p = api.providers;
  const team = await createTeam(p.db, { orgId: "local-org", name: "Report audience", creatorUserId: "local-user" });
  const owner = { type: "team", id: team.id } as const;
  const meta = { actorUserId: "local-user", orgId: "local-org" };
  const root = await ensureDefaultAssistantSession(p, owner, meta);
  const source = await root.session.createThread(key);
  const execution = await ensureAssistantExecution(p, owner, meta, key);
  const target = execution.session.thread(key);
  await target.pause();
  const run: WorkflowRun = { runId: "legacy-report", status: "settled", outcome: "failed", waitingOn: [], updatedAt: 2,
    attempt: 1, wakeRequested: false, createdAt: 1, definition: { version: "dag/v1" }, definitionVersionId: "v1", actorUserId: "local-user",
    params: { workflowId: "wf-legacy", definitionVersionId: "v1", origin: { assistantSessionId: root.sessionId, threadId: source.id } } };
  const report = buildRunOriginReport({ db: p.db, engineHost: p.engineHost,
    store: { getRun: async () => run, getCheckpoints: async () => [checkpoint("step", "failed", { error: "private failure" })] } });
  const info = { runId: run.runId, workflowId: "wf-legacy", outcome: "failed", settledAt: 2 } as const;
  await report(info);
  await report(info);
  expect(await readRunFollowUp(p, "local-org", run)).toMatchObject({
    registered: true, status: "queued", sessionId: execution.sessionId, threadId: target.id,
  });
  expect(await p.engineStore.listUnsettledSubmissions(root.sessionId)).toEqual([]);
  const queued = await p.engineStore.listUnsettledSubmissions(execution.sessionId);
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({ threadId: target.id, content: { signalType: "workflow.settled" } });
  expect(await p.engineStore.getSession(execution.sessionId)).toMatchObject({ parentSessionId: root.sessionId, parentThreadId: source.id });
});

it("says a run waits for approval and where to read who can approve it", () => {
  const text = approvalReport("Dashboard", "run-1");
  expect(text).toContain('Workflow "Dashboard" is waiting for approval.');
  expect(text).toContain("pendingGates lists every step that waits");
  expect(text).toContain("/workflows/runs/run-1");
});

it("queues one approval signal per drive behind the person's messages", async () => {
  api = await bootTestApi();
  const { session, sessionId } = await ensureDefaultAssistantSession(api.providers, { type: "user", id: "local-user" },
    { actorUserId: "local-user", orgId: "local-org" });
  const thread = await session.createThread("web:approving");
  thread.pause();
  let params: WorkflowRun["params"] = {
    workflowId: "wf-1", definitionVersionId: "v1", origin: { assistantSessionId: sessionId, threadId: thread.id },
  };
  const report = buildRunApprovalReport({
    db: api.providers.db, engineHost: api.providers.engineHost,
    store: {
      getRun: async () => ({
        runId: "run-1", status: "parked", waitingOn: [], updatedAt: 2, attempt: 1, wakeRequested: false, createdAt: 1,
        definition: { version: "dag/v1" }, definitionVersionId: "v1", actorUserId: "local-user", params,
      }),
      getCheckpoints: async () => [],
    },
  });
  const unsettled = async () => (await api!.providers.engineStore.listUnsettledSubmissions(sessionId))
    .filter((item) => item.threadId === thread.id).map((item) => item.dispatchId ?? "person");

  // A personal thread steers. The signal must not supersede what the person queued.
  await thread.submitPrompt("Also, rename the dashboard workflow to Hiring.", {});
  await report({ runId: "run-1", attempt: 3 });
  await report({ runId: "run-1", attempt: 3 });
  expect(await unsettled()).toEqual(["person", "workflow-approval:run-1:3"]);

  // A later drive that opens a gate queues its own signal.
  await report({ runId: "run-1", attempt: 4 });
  expect(await unsettled()).toEqual(["person", "workflow-approval:run-1:3", "workflow-approval:run-1:4"]);

  // A sub-run copies its parent's origin but reports nothing.
  params = { ...params, parentRunId: "parent-run", parentNodeId: "child" };
  await report({ runId: "run-1", attempt: 5 });
  // A run no thread started reports nowhere.
  params = { workflowId: "wf-1", definitionVersionId: "v1" };
  await report({ runId: "run-1", attempt: 6 });
  expect(await unsettled()).toHaveLength(3);
});

it("automatically admits a completion follow-up after the run host settles a run", async () => {
  api = await bootTestApi();
  const p = api.providers;
  await p.workflowRunHost.stopHost();
  const { session, sessionId } = await ensureDefaultAssistantSession(p, { type: "user", id: "local-user" },
    { actorUserId: "local-user", orgId: "local-org" });
  const thread = await session.createThread("web:auto-workflow-report");
  await thread.pause();
  const host = new LocalRunHost({
    store: p.workflowStore,
    engine: buildWorkflowEngineDeps({ host: p.engineHost, store: p.workflowStore, db: p.db,
      engineStore: p.engineStore, credentials: p.engineCredentials, actionPluginByService: new Map() }),
    onRunSettled: buildRunOriginReport({ db: p.db, engineHost: p.engineHost, store: p.workflowStore }),
  });
  const definition = { version: "dag/v1", nodes: [{ id: "trigger", type: "trigger" }, { id: "stop", type: "stop" }],
    edges: [{ from: "trigger", to: "stop" }] };
  const saved = await createWorkflowDefinition({ ...p, credentials: p.engineCredentials },
    { userId: "local-user", orgId: "local-org" }, { name: "Automatic report", definition });
  host.startHost();
  try {
    await host.start("auto-report", { workflowId: saved.id, definitionVersionId: "v1",
      origin: { assistantSessionId: sessionId, threadId: thread.id } }, definition, { ownerType: "user", ownerId: "local-user", actorUserId: "local-user" });
    await expect.poll(async () => (await p.engineStore.listUnsettledSubmissions(sessionId))
      .filter(item => item.dispatchId === "workflow-settled:auto-report"), { timeout: 5_000 }).toMatchObject([
      { threadId: thread.id, status: "queued", content: { signalType: "workflow.settled", attributes: { outcome: "completed" } } },
    ]);
    expect(await p.workflowStore.getRun("auto-report")).toMatchObject({ status: "settled", outcome: "completed" });
  } finally {
    await host.stopHost();
  }
});
