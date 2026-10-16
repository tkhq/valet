import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as piAi from "@earendil-works/pi-ai/compat";
import { intersectToolScopes, type ToolScope } from "@valet/shared";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureDefaultAssistantSession } from "../assistants/service.js";
import { actionPolicies, workflowRuns } from "../schema/index.js";
import { workflowsActionPlugin } from "./actions.js";
import { buildRunApprovalReport, buildRunOriginReport } from "./run-attention.js";
import { createWorkflowDefinition, getWorkflowDefinition, retryWorkflowRun, startWorkflowRun, type WorkflowServiceDeps } from "./service.js";
import { buildWorkflowEngineDeps } from "./engine-deps.js";
import { workflowToolFocus } from "../plugins/tool-focus.js";

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  vi.unstubAllEnvs();
});

async function scopedRunFixture() {
  let deps: WorkflowServiceDeps | undefined;
  const actions = workflowsActionPlugin(() => {
    if (!deps) throw new Error("Workflow services are not ready");
    return deps;
  });
  api = await bootTestApi({ plugins: [{ name: "workflows", version: "0.0.1", actions: [actions] }] });
  const p = api.providers;
  await p.workflowRunHost.stopHost();
  deps = { ...p, credentials: p.engineCredentials };
  await p.db.insert(actionPolicies).values({ id: "nested-test-allow", orgId: "local-org", principalType: "org", principalId: "local-org", service: "workflows", mode: "allow", origin: "admin", createdAt: 1, updatedAt: 1 });
  const owner = { userId: "local-user", orgId: "local-org" };
  const workflow = await createWorkflowDefinition(deps, owner, { name: "Scoped workflow", definition: {
    version: "dag/v1", nodes: [{ id: "trigger", type: "trigger" }, { id: "stop", type: "stop" }], edges: [{ from: "trigger", to: "stop" }],
  } });
  const { session, sessionId } = await ensureDefaultAssistantSession(p, { type: "user", id: "local-user" },
    { actorUserId: "local-user", orgId: "local-org" });
  const thread = await session.createThread("web:scope-inheritance");
  await thread.pause();
  return { p, deps, owner, workflow, origin: { assistantSessionId: sessionId, threadId: thread.id } };
}

it("keeps a headless nested start inside the workflow's delegated ceiling", async () => {
  const { p, deps, owner, workflow, origin } = await scopedRunFixture();
  const scope = { actions: ["workflows.start_run", "workflows.get_run"] };
  const parent = await startWorkflowRun(deps, owner, workflow.id, {}, origin, "manual", scope, {});
  if (!parent || !("runId" in parent)) throw new Error("Parent run did not start");
  const engine = buildWorkflowEngineDeps({ db: p.db, host: p.engineHost, store: p.workflowStore,
    engineStore: p.engineStore, actionPluginByService: p.actionPluginByService, credentials: p.engineCredentials });
  const started = await engine.invokeAction({ service: "workflows", action: "start_run",
    params: { workflow_id: workflow.id }, invocationId: `workflow:${parent.runId}:nested` });
  if (!started.ok || !started.result || typeof started.result !== "object"
    || !("runId" in started.result) || typeof started.result.runId !== "string") {
    throw new Error(`Nested run did not start: ${JSON.stringify(started)}`);
  }
  const childRunId = started.result.runId;
  const child = await p.workflowStore.getRun(childRunId);
  expect(child?.params).toMatchObject({ toolScope: scope, originToolScope: scope, origin });
  await buildRunOriginReport({ db: p.db, engineHost: p.engineHost, store: p.workflowStore })({
    runId: childRunId, workflowId: workflow.id, outcome: "failed", settledAt: 2,
  });
  const reports = (await p.engineStore.listUnsettledSubmissions(origin.assistantSessionId))
    .filter(item => item.dispatchId === `workflow-settled:${childRunId}`);
  expect(reports).toHaveLength(1);
  expect(reports[0]?.metadata?.toolScope).toEqual(scope);
});

const retryCeilings: Array<{ name: string; originToolScope?: ToolScope }> = [
  { name: "legacy execution-only restriction" },
  { name: "captured unrestricted origin", originToolScope: {} },
  { name: "captured restricted origin", originToolScope: { actions: ["workflows.get_run"] } },
  { name: "captured deny-all origin", originToolScope: { tools: [], actions: [] } },
];

it.each(retryCeilings)("retains execution and reporting scope when retrying a $name", async ({ originToolScope }) => {
  const { p, deps, owner, workflow, origin } = await scopedRunFixture();
  const scope = { actions: ["workflows.get_run"] };
  const started = await startWorkflowRun(deps, owner, workflow.id, {}, origin, "manual", scope, originToolScope);
  if (!started || !("runId" in started)) throw new Error("Original run did not start");
  await p.workflowStore.settleRun(started.runId, "failed");
  const retry = await retryWorkflowRun(deps, owner, started.runId);
  if (typeof retry !== "object" || !("runId" in retry)) throw new Error(`Retry did not start: ${JSON.stringify(retry)}`);
  const run = await p.workflowStore.getRun(retry.runId);
  expect(run?.params.toolScope).toEqual(scope);
  expect(run?.params.originToolScope).toEqual(originToolScope);
  await buildRunOriginReport({ db: p.db, engineHost: p.engineHost, store: p.workflowStore })({
    runId: retry.runId, workflowId: workflow.id, outcome: "failed", settledAt: 2,
  });
  const reports = (await p.engineStore.listUnsettledSubmissions(origin.assistantSessionId))
    .filter(item => item.dispatchId === `workflow-settled:${retry.runId}`);
  expect(reports).toHaveLength(1);
  expect(reports[0]?.metadata?.toolScope).toEqual(originToolScope ?? scope);
});

const limits: Array<{ name: string; ceiling?: ToolScope; canRepair: boolean }> = [
  { name: "no inherited ceiling", canRepair: true },
  { name: "an explicitly unrestricted ceiling", ceiling: {}, canRepair: true },
  { name: "a delegated read and run ceiling", ceiling: { tools: ["focus_tools", "call_tool"], actions: ["workflows.start_run", "workflows.get_run"] }, canRepair: false },
];

it.each(limits)("continues a real workflow run with $name", async ({ ceiling, canRepair }) => {
  const original = piAi.getApiProvider("anthropic-messages");
  let responses: piAi.AssistantMessage[] = [];
  const stream: piAi.ApiStreamSimpleFunction = () => {
    const events = piAi.createAssistantMessageEventStream();
    const response = responses.shift();
    if (!response) throw new Error("Unexpected model request in workflow continuation test");
    events.push({ type: "start", partial: response });
    for (const [contentIndex, block] of response.content.entries()) {
      if (block.type === "toolCall") events.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: response });
    }
    if (response.stopReason === "toolUse" || response.stopReason === "stop") {
      events.push({ type: "done", reason: response.stopReason, message: response });
    }
    events.end(response);
    return events;
  };
  piAi.registerApiProvider({ api: "anthropic-messages", stream, streamSimple: stream }, "workflow-repair-continuation");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-no-network");
  try {
    let deps: WorkflowServiceDeps | undefined;
    const actions = workflowsActionPlugin(() => {
      if (!deps) throw new Error("Workflow services are not ready");
      return deps;
    });
    api = await bootTestApi({ plugins: [{ name: "workflows", version: "0.0.1", actions: [actions] }] });
    const p = api.providers;
    await p.workflowRunHost.stopHost();
    deps = { ...p, credentials: p.engineCredentials };
    await p.db.insert(actionPolicies).values({ id: "repair-test-allow", orgId: "local-org", principalType: "org", principalId: "local-org", service: "workflows", mode: "allow", origin: "admin", createdAt: 1, updatedAt: 1 });
    const owner = { userId: "local-user", orgId: "local-org" };
    const workflow = await createWorkflowDefinition(deps, owner, { name: "Needs repair", definition: {
      version: "dag/v1", nodes: [{ id: "trigger", type: "trigger" }, { id: "stop", type: "stop" }], edges: [{ from: "trigger", to: "stop" }],
    } });
    const { session, sessionId } = await ensureDefaultAssistantSession(p, { type: "user", id: "local-user" }, { actorUserId: "local-user", orgId: "local-org" });
    const thread = await session.createThread(`workflow:${workflow.id}:local-user`);
    responses = [
      piAi.fauxAssistantMessage([piAi.fauxToolCall("focus_tools", { phase: "validate" })], { stopReason: "toolUse" }),
      piAi.fauxAssistantMessage([piAi.fauxToolCall("call_tool", { tool_id: "workflows.start_run", params: { workflow_id: workflow.id }, summary: "Run the authorized workflow test" })], { stopReason: "toolUse" }),
      piAi.fauxAssistantMessage("Waiting for the workflow result."),
    ];
    const start = await thread.submitPrompt("Test this workflow.", { ...(ceiling ? { metadata: { toolScope: ceiling } } : {}) });
    await thread.awaitResult(start.queueItemId);
    const [row] = await p.db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflow.id));
    if (!row) throw new Error(`The real start_run action did not start a run: ${JSON.stringify(await thread.readEntries())}`);
    const run = await p.workflowStore.getRun(row.id);
    if (!run) throw new Error("The workflow run was not stored");
    // Delegated workflow execution keeps the narrower validation focus.
    expect(run.params.toolScope).toEqual(intersectToolScopes(ceiling, workflowToolFocus("validate")));
    expect(run.params.toolScope).not.toEqual(workflowToolFocus("repair"));

    await thread.pause();
    const reports = { db: p.db, engineHost: p.engineHost, store: p.workflowStore };
    await buildRunApprovalReport(reports)({ runId: row.id, attempt: 1 });
    const approval = (await p.engineStore.listUnsettledSubmissions(sessionId)).find(item => item.dispatchId === `workflow-approval:${row.id}:1`);
    responses = [piAi.fauxAssistantMessage("Waiting for approval.")];
    await thread.resume();
    if (!approval) throw new Error("Approval report was not queued");
    await thread.awaitResult(approval.id);

    await thread.pause();
    await p.workflowStore.settleRun(row.id, "failed");
    const report = buildRunOriginReport(reports);
    await report({ runId: row.id, workflowId: workflow.id, outcome: "failed", settledAt: 2 });
    await report({ runId: row.id, workflowId: workflow.id, outcome: "failed", settledAt: 2 });
    const completions = (await p.engineStore.listUnsettledSubmissions(sessionId)).filter(item => item.dispatchId === `workflow-settled:${row.id}`);
    expect(completions).toHaveLength(1);
    const completion = completions[0];
    if (!completion) throw new Error("Completion report was not queued");
    responses = [
      piAi.fauxAssistantMessage([piAi.fauxToolCall("focus_tools", { phase: "repair" })], { stopReason: "toolUse" }),
      piAi.fauxAssistantMessage([piAi.fauxToolCall("workflows__patch_workflow", { workflow_id: workflow.id, name: "Repaired" })], { stopReason: "toolUse" }),
      piAi.fauxAssistantMessage("Checked the workflow."),
    ];
    await thread.resume();
    await thread.awaitResult(completion.id);
    expect((await getWorkflowDefinition(deps, owner, workflow.id))?.name).toBe(canRepair ? "Repaired" : "Needs repair");
    expect((await p.workflowStore.getRun(row.id))?.params.toolScope).toEqual(run.params.toolScope);
    expect(approval.metadata?.toolScope).toEqual(ceiling ?? {});
    expect(completion.metadata?.toolScope).toEqual(ceiling ?? {});
  } finally {
    piAi.unregisterApiProviders("workflow-repair-continuation");
    if (original) piAi.registerApiProvider(original);
  }
});
