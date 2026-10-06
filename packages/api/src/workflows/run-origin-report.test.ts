import { afterEach, expect, it } from "vitest";
import type { NodeCheckpoint, WorkflowRun } from "@valet/workflow";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureAssistantExecution, ensureDefaultAssistantSession } from "../assistants/service.js";
import { createTeam } from "../services/teams.js";
import { buildRunOriginReport, runReport } from "./run-attention.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

const checkpoint = (nodeId: string, status: NodeCheckpoint["status"], extra: Partial<NodeCheckpoint> = {}): NodeCheckpoint =>
  ({ runId: "run-1", nodeId, iteration: 0, status, attempt: 1, createdAt: 1, ...extra });

it("says what a settled run did", () => {
  expect(runReport("Triage", "run-1", "failed", [checkpoint("fetch", "failed", { error: "GitHub 404" })]))
    .toContain('Workflow "Triage" failed. fetch: GitHub 404.');
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
  await report(info);
  // A reclaimed run settles twice; the thread hears about it once.
  await report(info);
  const queued = (await api.providers.engineStore.listUnsettledSubmissions(sessionId)).filter((item) => item.threadId === thread.id);
  expect(queued).toHaveLength(1);
  expect(JSON.stringify(queued[0])).toContain("workflow.settled");
  expect(JSON.stringify(queued[0])).toContain("GitHub 404");

  // A run with no thread waiting (scheduled or event-started) reports nowhere.
  current = run();
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
  expect(await p.engineStore.listUnsettledSubmissions(root.sessionId)).toEqual([]);
  const queued = await p.engineStore.listUnsettledSubmissions(execution.sessionId);
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({ threadId: target.id, content: { signalType: "workflow.settled" } });
  expect(await p.engineStore.getSession(execution.sessionId)).toMatchObject({ parentSessionId: root.sessionId, parentThreadId: source.id });
});
