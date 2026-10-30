import { UNATTENDED_WORKFLOW_KEY, WORKFLOW_STEP_KEY, type Appearance } from "@valet/shared";
import { seedWorkspaceAssistant } from "../test-helpers/assistant-fixture.js";
/**
 * Unit tests for `buildWorkflowEngineDeps`'s Task 7/Task 6 seams:
 * `invokeAction` (now a real headless `ActionInvoker` with durable dedup —
 * plugin-system-v2 plan Task 6), `promptOrchestrator` (real `EngineHost`
 * orchestrator wiring, no LLM call required — `submitPrompt` returns before
 * the turn actually runs), and `llmComplete`'s no-network unknown-model
 * failure path. The key-gated real-Anthropic completion path is exercised
 * separately in `src/integration/workflow-engine-deps.test.ts`.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { Type } from "typebox";
import type { ActionPlugin, PluginAction, ValetPlugin } from "@valet/engine";
import type { WorkflowRunOrigin } from "@valet/workflow";
import type { Usage } from "@earendil-works/pi-ai/compat";
import * as piAi from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxResponseStep } from "@valet/engine/test-helpers";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { buildWorkflowEngineDeps, mapPiAiUsage, unattendedRefusalError, workflowRunThreadKey, workflowStepThreadKey } from "./engine-deps.js";
import { isWorkflowRunThread } from "./editor-thread-context.js";
import { eq, sql } from "drizzle-orm";
import { legacyWorkflowAdmissions, assistants, childWatches, orgs, workflowDefinitions } from "../schema/index.js";
import { LOCAL_ORG, LOCAL_USER } from "../providers/node.js";
import { createLlmProvider } from "../services/llm-providers.js";
import { ensureDefaultAssistantSession, loadAssistantBySessionId, resolveDefaultAssistant } from "../assistants/service.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  vi.unstubAllEnvs();
});

async function seedRun(
  a: TestApi,
  runId: string,
  workflowId: string,
  origin?: WorkflowRunOrigin,
  presence?: { definition?: Appearance; run?: Appearance },
): Promise<void> {
  const { db, workflowStore } = a.providers;
  const now = Date.now();
  await db
    .insert(workflowDefinitions)
    .values({
      id: workflowId,
      orgId: LOCAL_ORG.id,
      ownerType: "user",
      ownerId: LOCAL_USER.id,
      name: "engine-deps-unit-test",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: now,
      updatedAt: now,
    });
  await workflowStore.createRun(
    runId,
    { workflowId, definitionVersionId: "v1", ...(origin ? { origin } : {}), ...(presence?.run ? { presence: presence.run } : {}) },
    { version: "dag/v1", nodes: [], edges: [], ...(presence?.definition ? { presence: presence.definition } : {}) },
    "v1",
    { ownerType: "user", ownerId: LOCAL_USER.id },
  );
}

/** Fixture `demo.ping` action — counts invocations and echoes whether a credential was resolved, so tests can assert dedup (no re-invocation) and the missing-credential-still-executes contract. */
function makeFixturePlugin(): { plugin: ValetPlugin; actionPlugin: ActionPlugin; calls: () => number } {
  let count = 0;
  const action: PluginAction = {
    id: "demo.ping",
    name: "ping",
    description: "ping",
    riskLevel: "low",
    parameters: Type.Object({ msg: Type.String() }),
    execute: async (args, ctx) => {
      count += 1;
      const credential = await ctx.credentials.get();
      return {
        success: true,
        data: { echoed: (args as { msg: string }).msg, hasCredential: credential !== null },
      };
    },
  };
  const actionPlugin: ActionPlugin = { service: "demo", actions: [action] };
  const plugin: ValetPlugin = { name: "demo", version: "0.0.1", actions: [actionPlugin] };
  return { plugin, actionPlugin, calls: () => count };
}

describe("workflow presence snapshots", () => {
  it("uses the persisted snapshot for both queue paths and direct actions after definition edits", async () => {
    const action: PluginAction = {
      id: "demo.identity", name: "identity", description: "Read sender", riskLevel: "low", parameters: Type.Object({}),
      execute: async (_args, ctx) => ({ success: true, data: await ctx.resolveOutboundSender?.() }),
    };
    const actionPlugin: ActionPlugin = { service: "demo", actions: [action] };
    api = await bootTestApi({ plugins: [{ name: "demo", version: "1", actions: [actionPlugin] }] });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const build = () => buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials });
    await seedRun(api, "presence-run", "presence-workflow", undefined, {
      definition: { displayName: "Snapshot", avatarUrl: "https://example.com/snapshot.png" },
      run: { displayName: "Subscription" },
    });
    await db.update(workflowDefinitions).set({ definition: { version: "dag/v1", nodes: [], edges: [], presence: { displayName: "Edited" } } })
      .where(eq(workflowDefinitions.id, "presence-workflow"));
    const expected = { displayName: "Subscription", avatarUrl: "https://example.com/snapshot.png" };
    const sessionId = "wf:presence-run:session";
    const sessionReceipt = await build().prompt(sessionId, "read sender", { dispatchId: "workflow:presence-run:session" });
    expect((await engineStore.getQueueItem(sessionId, sessionReceipt.queueItemId))?.metadata?.presence).toEqual(expected);
    const reportReceipt = await build().promptOrchestrator("report", { dispatchId: "workflow:presence-run:report", queueMode: "followup", ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id } });
    expect((await engineStore.getQueueItem(reportReceipt.sessionId, reportReceipt.queueItemId))?.metadata?.presence).toEqual(expected);
    expect(await build().invokeAction({ service: "demo", action: "identity", params: {}, invocationId: "workflow:presence-run:identity" }))
      .toEqual({ ok: true, result: expected });
    await seedRun(api, "plain-run", "plain-workflow");
    expect(await build().invokeAction({ service: "demo", action: "identity", params: {}, invocationId: "workflow:plain-run:identity" }))
      .toEqual({ ok: true, result: undefined });
  });
});

describe("buildWorkflowEngineDeps: invokeAction", () => {
  it("happy path: resolves the fixture action and returns {ok:true, result}", async () => {
    const fixture = makeFixturePlugin();
    api = await bootTestApi({ plugins: [fixture.plugin] });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_invoke_happy";
    await seedRun(api, runId, "wf_invoke_happy");

    const result = await deps.invokeAction({
      service: "demo",
      action: "ping",
      params: { msg: "hello" },
      invocationId: `workflow:${runId}:node1`,
    });

    expect(result).toEqual({ ok: true, result: { echoed: "hello", hasCredential: false } });
    expect(fixture.calls()).toBe(1);
  });

  it("is idempotent by invocationId: a duplicate call executes the action ONCE and returns the identical original result", async () => {
    const fixture = makeFixturePlugin();
    api = await bootTestApi({ plugins: [fixture.plugin] });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_invoke_dup";
    await seedRun(api, runId, "wf_invoke_dup");
    const req = {
      service: "demo",
      action: "ping",
      params: { msg: "dup" },
      invocationId: `workflow:${runId}:node1`,
    };

    const first = await deps.invokeAction(req);
    const second = await deps.invokeAction(req);

    expect(second).toEqual(first);
    expect(fixture.calls()).toBe(1);
  });

  it("unknown action: returns a stable {ok:false} that is also deduped (never invokes execute)", async () => {
    const fixture = makeFixturePlugin();
    api = await bootTestApi({ plugins: [fixture.plugin] });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_invoke_unknown";
    await seedRun(api, runId, "wf_invoke_unknown");
    const req = {
      service: "demo",
      action: "does_not_exist",
      params: {},
      invocationId: `workflow:${runId}:node1`,
    };

    const first = await deps.invokeAction(req);
    const second = await deps.invokeAction(req);

    expect(first).toEqual({ ok: false, error: "unknown action: demo.does_not_exist" });
    expect(second).toEqual(first);
    expect(fixture.calls()).toBe(0);
  });

  it("param validation failure: missing required param returns {ok:false} and never invokes execute", async () => {
    const fixture = makeFixturePlugin();
    api = await bootTestApi({ plugins: [fixture.plugin] });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_invoke_badparams";
    await seedRun(api, runId, "wf_invoke_badparams");

    const result = await deps.invokeAction({
      service: "demo",
      action: "ping",
      params: {},
      invocationId: `workflow:${runId}:node1`,
    });

    expect(result.ok).toBe(false);
    expect(fixture.calls()).toBe(0);
  });

  it("missing credential: the action still executes and sees credentials.get() === null", async () => {
    const fixture = makeFixturePlugin();
    api = await bootTestApi({ plugins: [fixture.plugin] });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_invoke_nocred";
    await seedRun(api, runId, "wf_invoke_nocred");

    const result = await deps.invokeAction({
      service: "demo",
      action: "ping",
      params: { msg: "no creds here" },
      invocationId: `workflow:${runId}:node1`,
    });

    expect(result).toEqual({ ok: true, result: { echoed: "no creds here", hasCredential: false } });
    expect(fixture.calls()).toBe(1);
  });

  it("a team-owned run resolves a direct team credential, not the clicker's", async () => {
    const fixture = makeFixturePlugin();
    api = await bootTestApi({ plugins: [fixture.plugin] });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const { createTeam } = await import("../services/teams.js");
    const team = await createTeam(db, {
      orgId: LOCAL_ORG.id,
      name: "engine-deps-team",
      creatorUserId: LOCAL_USER.id,
    });
    await engineCredentials.save({ type: "team", id: team.id }, "demo", {
      type: "api_key",
      apiKey: "team-demo-key",
    });

    const now = Date.now();
    const workflowId = "wf_invoke_team";
    const runId = "wfrun_invoke_team";
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      orgId: LOCAL_ORG.id,
      ownerType: "team",
      ownerId: team.id,
      name: "team-engine-deps",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: now,
      updatedAt: now,
    });
    await workflowStore.createRun(
      runId,
      { workflowId, definitionVersionId: "v1" },
      { version: "dag/v1", nodes: [], edges: [] },
      "v1",
      { ownerType: "team", ownerId: team.id, actorUserId: LOCAL_USER.id },
    );

    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });
    const result = await deps.invokeAction({
      service: "demo",
      action: "ping",
      params: { msg: "team" },
      invocationId: `workflow:${runId}:node1`,
    });
    expect(result).toEqual({ ok: true, result: { echoed: "team", hasCredential: true } });
  });
});

describe("buildWorkflowEngineDeps: promptOrchestrator", () => {
  it("ensures the owner's DEFAULT assistant session and admits a followup signal envelope", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_orch_unit";
    await seedRun(api, runId, "wf_orch_unit");

    const dispatchId = `workflow:${runId}:node1`;
    const receipt = await deps.promptOrchestrator("please look into this", {
      dispatchId,
      queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    });

    // An `orchestrator` node names an owner, so the dispatch lands on that
    // owner's default assistant — the row `resolveDefaultAssistant` created.
    const defaultAssistant = await resolveDefaultAssistant(db, "local-org", { type: "user", id: LOCAL_USER.id });
    expect(receipt.sessionId).toBe(defaultAssistant.sessionId);
    expect(defaultAssistant).toBeDefined();
    expect(receipt.threadId).toBeTruthy();
    expect(receipt.queueItemId).toBeTruthy();

    // The assistant session actually exists and is live.
    const session = engineHost.liveSession(receipt.sessionId);
    expect(session).not.toBeNull();

    // The queued item carries the followup queueMode and the SignalContent
    // envelope shape (kind/signalType/body/attributes) — never a raw string
    // prompt. `attributes.runId` is what lets the client render a link back
    // to the run instead of a bare "workflow.request" label.
    const item = await engineStore.getQueueItem(receipt.sessionId, receipt.queueItemId);
    expect(item).toBeDefined();
    expect(item?.dispatchId).toBe(dispatchId);
    expect(item?.content).toEqual({
      kind: "signal",
      signalType: "workflow.request",
      body: "please look into this",
      attributes: { runId: "wfrun_orch_unit" },
      tagName: "signal",
    });
  });

  it("routes a team-owned run to the team's default assistant", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const { createTeam } = await import("../services/teams.js");
    const team = await createTeam(db, {
      orgId: LOCAL_ORG.id,
      name: "orchestrator-routing-team",
      creatorUserId: LOCAL_USER.id,
    });
    const workflowId = "wf_orch_team";
    const runId = "wfrun_orch_team";
    const now = Date.now();
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      orgId: LOCAL_ORG.id,
      ownerType: "team",
      ownerId: team.id,
      name: "team-orchestrator-routing",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: now,
      updatedAt: now,
    });
    await workflowStore.createRun(
      runId,
      { workflowId, definitionVersionId: "v1" },
      { version: "dag/v1", nodes: [], edges: [] },
      "v1",
      { ownerType: "team", ownerId: team.id, actorUserId: LOCAL_USER.id },
    );
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const receipt = await deps.promptOrchestrator("review team work", {
      dispatchId: `workflow:${runId}:node1`,
      queueMode: "followup",
      ownerHint: { ownerType: "team", ownerId: team.id },
    });

    const teamDefault = await resolveDefaultAssistant(db, LOCAL_ORG.id, { type: "team", id: team.id });
    const personalDefault = await resolveDefaultAssistant(db, LOCAL_ORG.id, { type: "user", id: LOCAL_USER.id });
    expect(receipt.sessionId).not.toBe(teamDefault.sessionId);
    expect((await loadAssistantBySessionId(db, receipt.sessionId))?.id).toBe(teamDefault.id);
    engineHost.evictCache(receipt.sessionId);
    await expect(deps.abort(receipt.sessionId, receipt.threadId, receipt.queueItemId)).resolves.toBeUndefined();
    expect(receipt.sessionId).not.toBe(personalDefault.sessionId);
  });

  it.each(["app-assistant:local-user", "slack:C_PRIVATE:1.2"])("moves legacy team workflow origin %s into its isolated audience", async (key) => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const { createTeam } = await import("../services/teams.js");
    const team = await createTeam(db, { orgId: LOCAL_ORG.id, name: "Legacy origin", creatorUserId: LOCAL_USER.id });
    const owner = { type: "team", id: team.id } as const;
    const root = await ensureDefaultAssistantSession(api.providers, owner, { actorUserId: LOCAL_USER.id, orgId: LOCAL_ORG.id });
    const originThread = await root.session.createThread(key);
    const runId = "legacy-team-origin-run", workflowId = "legacy-team-origin-workflow", now = Date.now();
    await db.insert(workflowDefinitions).values({ id: workflowId, orgId: LOCAL_ORG.id, ownerType: "team", ownerId: team.id,
      name: "Legacy", definition: { version: "dag/v1", nodes: [], edges: [] }, createdAt: now, updatedAt: now });
    await workflowStore.createRun(runId, { workflowId, definitionVersionId: "v1",
      origin: { assistantSessionId: root.sessionId, threadId: originThread.id } },
    { version: "dag/v1", nodes: [], edges: [] }, "v1", { ownerType: "team", ownerId: team.id, actorUserId: LOCAL_USER.id });
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials });
    const options = { dispatchId: `workflow:${runId}:report`, queueMode: "followup", ownerHint: { ownerType: "team", ownerId: team.id } } as const;
    const receipt = await deps.promptOrchestrator("report into the original audience", options);
    expect(receipt.sessionId).not.toBe(root.sessionId);
    expect(await engineStore.getSession(receipt.sessionId)).toMatchObject({ parentSessionId: root.sessionId, parentThreadId: originThread.id });
    expect(await engineStore.getThread(receipt.sessionId, receipt.threadId)).toMatchObject({ key });
    expect(await deps.promptOrchestrator("report into the original audience", options)).toEqual(receipt);
    expect(await engineStore.listUnsettledSubmissions(root.sessionId)).toEqual([]);
    // A pre-cutover admission whose workflow checkpoint was lost must not run again.
    await engineStore.admitSubmission(root.sessionId, originThread.id, { id: "old-admission", threadId: originThread.id,
      dispatchId: `workflow:${runId}:old-report`, content: { kind: "signal", signalType: "workflow.request", body: "old report", attributes: { runId } },
      status: "queued", attemptCount: 0, maxAttempts: 10, timeoutAt: now + 60_000, createdAt: now, updatedAt: now });
    engineHost.evictCache(root.sessionId);
    const oldReceipt = await deps.promptOrchestrator("old report", { ...options, dispatchId: `workflow:${runId}:old-report` });
    expect(oldReceipt).toEqual({ sessionId: root.sessionId, threadId: originThread.id, queueItemId: "old-admission" });
    expect(await deps.awaitResult(oldReceipt.sessionId, oldReceipt.threadId, oldReceipt.queueItemId)).toMatchObject({ outcome: "aborted" });
  });

  it.each(["archived", "missing"])("fails closed for a supplied %s origin instead of using the default audience", async (state) => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const root = await ensureDefaultAssistantSession(api.providers, { type: "user", id: LOCAL_USER.id }, { actorUserId: LOCAL_USER.id, orgId: LOCAL_ORG.id });
    const origin = await root.session.createThread("app-assistant:local-user");
    const runId = "unavailable-origin";
    await seedRun(api, runId, "unavailable-workflow", { assistantSessionId: state === "missing" ? "gone-session" : root.sessionId, threadId: origin.id });
    if (state === "archived") await db.update(assistants).set({ archivedAt: Date.now() }).where(eq(assistants.id, root.assistant.id));
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials });
    await expect(deps.promptOrchestrator("private report", { dispatchId: `workflow:${runId}:node`, queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id } })).rejects.toThrow("origin assistant is unavailable");
    expect(await engineStore.listUnsettledSubmissions(root.sessionId)).toEqual([]);
  });

  it("reuses the exact assistant thread recorded as the run origin", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const assistant = await resolveDefaultAssistant(db, "local-org", { type: "user", id: LOCAL_USER.id });
    const session = await engineHost.assistantSessionFor(
      assistant.id,
      { actorUserId: LOCAL_USER.id, orgId: "local-org" },
      { sessionId: assistant.sessionId },
    );
    const originThread = await session.createThread("web:origin");
    const runId = "wfrun_orch_origin";
    await seedRun(api, runId, "wf_orch_origin", {
      assistantSessionId: assistant.sessionId,
      threadId: originThread.id,
    });
    const deps = buildWorkflowEngineDeps({
      host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials,
    });

    const receipt = await deps.promptOrchestrator("continue here", {
      dispatchId: `workflow:${runId}:node1`,
      queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    });
    expect(receipt).toMatchObject({ sessionId: assistant.sessionId, threadId: originThread.id });
  });

  it("reuses a legacy orchestrator-prefixed origin session", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    // Rows migrated from `orchestrator_identities` keep their legacy
    // session id. The assistants table is the authority on which session
    // ids are assistant sessions, so an origin must resolve through it.
    const legacySessionId = `orchestrator:user:${LOCAL_USER.id}`;
    await db.insert(assistants).values({
      id: "legacy-assistant",
      orgId: LOCAL_ORG.id,
      ownerType: "user",
      ownerId: LOCAL_USER.id,
      sessionId: legacySessionId,
      createdAt: Date.now(),
    });
    const session = await engineHost.assistantSessionFor(
      "legacy-assistant",
      { actorUserId: LOCAL_USER.id, orgId: LOCAL_ORG.id },
      { sessionId: legacySessionId },
    );
    const originThread = await session.createThread("web:legacy-origin");
    const runId = "wfrun_orch_legacy_origin";
    await seedRun(api, runId, "wf_orch_legacy_origin", {
      assistantSessionId: legacySessionId,
      threadId: originThread.id,
    });
    const deps = buildWorkflowEngineDeps({
      host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials,
    });

    const receipt = await deps.promptOrchestrator("continue here", {
      dispatchId: `workflow:${runId}:node1`,
      queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    });
    expect(receipt).toMatchObject({ sessionId: legacySessionId, threadId: originThread.id });
  });

  it("rejects a missing durable origin thread without creating a replacement", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const assistant = await resolveDefaultAssistant(db, "local-org", { type: "user", id: LOCAL_USER.id });
    const session = await engineHost.assistantSessionFor(
      assistant.id,
      { actorUserId: LOCAL_USER.id, orgId: "local-org" },
      { sessionId: assistant.sessionId },
    );
    const before = session.listThreads().length;
    const runId = "wfrun_orch_missing_origin";
    await seedRun(api, runId, "wf_orch_missing_origin", {
      assistantSessionId: assistant.sessionId,
      threadId: "th-missing-origin",
    });
    const deps = buildWorkflowEngineDeps({
      host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials,
    });

    await expect(deps.promptOrchestrator("continue here", {
      dispatchId: `workflow:${runId}:node1`,
      queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    })).rejects.toThrow("origin thread");
    expect(session.listThreads()).toHaveLength(before);
  });

  it("is idempotent by dispatchId: a duplicate dispatch returns the original receipt", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_orch_dup";
    await seedRun(api, runId, "wf_orch_dup");

    const dispatchId = `workflow:${runId}:node1`;
    const opts = {
      dispatchId,
      queueMode: "followup" as const,
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    };

    const first = await deps.promptOrchestrator("noted please", opts);
    const second = await deps.promptOrchestrator("noted please", opts);

    expect(second).toEqual(first);
  });

  it("groups every prompt from the same run onto one thread", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_orch_thread";
    await seedRun(api, runId, "wf_orch_thread");

    const first = await deps.promptOrchestrator("first node's ask", {
      dispatchId: `workflow:${runId}:node1`,
      queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    });
    const second = await deps.promptOrchestrator("second node's ask", {
      dispatchId: `workflow:${runId}:node2`,
      queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    });

    expect(second.threadId).toBe(first.threadId);
    expect(second.sessionId).toBe(first.sessionId);
  });

  it("gives every run its own thread on the one assistant", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore,
      actionPluginByService, credentials: engineCredentials });
    await seedRun(api, "run_first", "wf_shared");
    await workflowStore.createRun("run_second", { workflowId: "wf_shared", definitionVersionId: "v1" },
      { version: "dag/v1", nodes: [], edges: [] }, "v1", { ownerType: "user", ownerId: LOCAL_USER.id });
    await seedRun(api, "run_other", "wf_other");
    const submit = (runId: string) => deps.promptOrchestrator("report", {
      dispatchId: `workflow:${runId}:node1`, queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    });
    const [first, second] = await Promise.all([submit("run_first"), submit("run_second")]);
    // Two runs of ONE definition. Each keeps its own thread, so neither
    // waits behind the other's turn, gate, or Stop.
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.threadId).not.toBe(first.threadId);
    expect(second.queueItemId).not.toBe(first.queueItemId);
    const session = engineHost.liveSession(first.sessionId);
    expect(session?.threadById(first.threadId)?.key).toBe("signal:workflow:run_first");
    expect(session?.threadById(second.threadId)?.key).toBe("signal:workflow:run_second");
    expect(await submit("run_first")).toEqual(first);
    expect((await submit("run_other")).threadId).not.toBe(first.threadId);
    const item = await engineStore.getQueueItem(second.sessionId, second.queueItemId);
    expect(item?.content).toMatchObject({ attributes: { runId: "run_second" } });
  });

  it("aborts one run's thread and leaves another run's queued work alone", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore,
      actionPluginByService, credentials: engineCredentials });
    await seedRun(api, "run_stopped", "wf_stop");
    await workflowStore.createRun("run_spared", { workflowId: "wf_stop", definitionVersionId: "v1" },
      { version: "dag/v1", nodes: [], edges: [] }, "v1", { ownerType: "user", ownerId: LOCAL_USER.id });
    const submit = (runId: string) => deps.promptOrchestrator("report", {
      dispatchId: `workflow:${runId}:node1`, queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    });
    const stopped = await submit("run_stopped");
    const spared = await submit("run_spared");

    // The thread Stop button: `POST /threads/:id/abort` aborts the whole
    // thread. It must reach one run only.
    const session = engineHost.liveSession(stopped.sessionId);
    if (!session) throw new Error("Assistant session is not live");
    await session.abort({ threadId: stopped.threadId });

    expect((await engineStore.getQueueItem(stopped.sessionId, stopped.queueItemId))?.status).toBe("settled");
    expect((await engineStore.getQueueItem(spared.sessionId, spared.queueItemId))?.status).not.toBe("settled");
  });

  it("refuses an approval in a workflow run before a gate opens and keeps each run on its own thread", async () => {
    // Nobody watches a run, so a gate would hold its thread until it expires
    // (72 hours by default). The engine refuses the request instead, and the
    // turn reports that the step needs approval.
    const faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
    try {
      let executed = false;
      const gated: PluginAction = {
        id: "demo.review",
        name: "review",
        description: "critical-risk fixture action, so calling it needs approval",
        riskLevel: "critical",
        parameters: Type.Object({}),
        execute: async () => { executed = true; return { success: true, data: { reviewed: true } }; },
      };
      const plugin: ValetPlugin = {
        name: "demo", version: "0.0.1",
        actions: [{ service: "demo", actions: [gated] }],
      };
      api = await bootTestApi({ plugins: [plugin] });
      const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
      const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore,
        actionPluginByService, credentials: engineCredentials });
      await seedRun(api, "run_first", "wf_gate");
      // An agent started the second run, so its agent steps never use saved permissions.
      await workflowStore.createRun("run_next", { workflowId: "wf_gate", definitionVersionId: "v1", startedBy: "agent" },
        { version: "dag/v1", nodes: [], edges: [] }, "v1", { ownerType: "user", ownerId: LOCAL_USER.id });
      const submit = (runId: string, text: string) => deps.promptOrchestrator(text, {
        dispatchId: `workflow:${runId}:node1`, queueMode: "followup",
        ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
      });

      let toolResult = "";
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("call_tool", { tool_id: "demo.review", params: {}, summary: "review it" }, { id: "tc-gate" })],
          { stopReason: "toolUse" },
        ),
        (context) => {
          const last = context.messages.at(-1);
          toolResult = last?.role === "toolResult" ? last.content.map((part) => part.type === "text" ? part.text : "").join("") : "";
          return fauxAssistantMessage("The review step needs approval before the next run.");
        },
      ]);
      const first = await submit("run_first", "first run");
      await vi.waitFor(async () => {
        expect((await engineStore.getQueueItem(first.sessionId, first.queueItemId))?.status).toBe("settled");
      }, { timeout: 15_000, interval: 50 });
      expect(toolResult).toContain("Valet sent no approval request");
      expect(executed).toBe(false);
      // Nothing waits, and the refused approval fails the step so the owner hears about it.
      expect((await engineStore.listDecisionGates(first.sessionId, first.threadId)).map((gate) => gate.status)).toEqual(["resolved"]);
      const settled = await deps.awaitResult(first.sessionId, first.threadId, first.queueItemId);
      expect(settled.outcome).toBe("failed");
      expect(settled.error).toContain("demo.review did not run");
      expect(settled.error).not.toContain("An agent started this run");

      faux.appendResponses([
        fauxAssistantMessage(
          [fauxToolCall("call_tool", { tool_id: "demo.review", params: {}, summary: "review it" }, { id: "tc-gate-next" })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("second run reported"),
      ]);
      const next = await submit("run_next", "second run");
      expect(next.sessionId).toBe(first.sessionId);
      expect(next.threadId).not.toBe(first.threadId);
      await vi.waitFor(async () => {
        expect((await engineStore.getQueueItem(next.sessionId, next.queueItemId))?.status).toBe("settled");
      }, { timeout: 15_000, interval: 50 });
      const settledNext = await deps.awaitResult(next.sessionId, next.threadId, next.queueItemId);
      expect(settledNext.outcome).toBe("failed");
      expect(settledNext.error).toContain("An agent started or retried this run, so its agent steps do not use the workflow's saved permissions");
    } finally {
      faux.unregister();
    }
  });

  it("waits for a delegated child's report and returns the turn that the report starts", async () => {
    // A Thread step's turn can hand the work to a child with `task` and end.
    // The child's report starts the turn that finishes the step. Before the
    // fix, the step settled on the first turn and the report was dropped.
    const faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
    try {
      let releaseChild: () => void = () => {};
      const childMayAnswer = new Promise<void>((resolve) => { releaseChild = resolve; });
      const route: Extract<FauxResponseStep, (...args: never[]) => unknown> = async (context) => {
        const brief = JSON.stringify(context.messages.find((message) => message.role === "user"));
        if (brief.includes("CHILD BRIEF")) {
          await childMayAnswer;
          return fauxAssistantMessage("Finding: the retry loop never stops.");
        }
        const last = context.messages.at(-1);
        if (last?.role === "toolResult") return fauxAssistantMessage("I'm reviewing the pull request.");
        if (JSON.stringify(last).includes("child.settled")) return fauxAssistantMessage("Posted the review with one finding.");
        return fauxAssistantMessage([fauxToolCall("task", { prompt: "CHILD BRIEF: review the diff.", title: "review" }, { id: "task-1" })],
          { stopReason: "toolUse" });
      };
      faux.setResponses(Array.from({ length: 6 }, () => route));
      api = await bootTestApi();
      const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
      const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore,
        actionPluginByService, credentials: engineCredentials });
      await seedRun(api, "run_delegates", "wf_delegates");
      const receipt = await deps.promptOrchestrator("Review the pull request and post the result.", {
        dispatchId: "workflow:run_delegates:review", queueMode: "followup",
        ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
      });

      // The first turn ends while the child still works. The step is not done.
      await vi.waitFor(async () => {
        expect((await engineStore.getQueueItem(receipt.sessionId, receipt.queueItemId))?.status).toBe("settled");
      }, { timeout: 15_000, interval: 50 });
      expect(await db.select().from(childWatches).where(eq(childWatches.parentThreadId, receipt.threadId))).toHaveLength(1);
      expect(await deps.isSettled(receipt.sessionId, receipt.queueItemId)).toBe(false);
      const settled = deps.awaitResult(receipt.sessionId, receipt.threadId, receipt.queueItemId);

      releaseChild();
      // The test API runs no wake-watcher timer, so drive its delivery pass here.
      const deliver = setInterval(() => { void api?.providers.wakeWatcher.sweep(); }, 200);
      const result = await settled.finally(() => clearInterval(deliver));
      expect(result).toMatchObject({ outcome: "completed", text: "Posted the review with one finding." });
      expect(await deps.isSettled(receipt.sessionId, receipt.queueItemId)).toBe(true);
    } finally {
      faux.unregister();
    }
  }, 60_000);

  it.each(["", ":repair"])("retains the original upgrade admission when a rendered workflow prompt changes%s", async (suffix) => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore,
      actionPluginByService, credentials: engineCredentials });
    await seedRun(api, "old_render", "old_render_workflow");
    const root = await ensureDefaultAssistantSession(api.providers, { type: "user", id: LOCAL_USER.id },
      { actorUserId: LOCAL_USER.id, orgId: LOCAL_ORG.id });
    const thread = await root.session.createThread("signal:workflow:old_render");
    const dispatchId = `workflow:old_render:node${suffix}`;
    const id = `old-admission${suffix}`, now = Date.now();
    await engineStore.admitSubmission(root.sessionId, thread.id, { id, threadId: thread.id, dispatchId,
      content: { kind: "signal", signalType: "workflow.request", body: "Original rendered prompt", attributes: { runId: "old_render" } },
      status: "queued", attemptCount: 0, maxAttempts: 10, timeoutAt: now + 60_000, createdAt: now, updatedAt: now });
    await db.insert(legacyWorkflowAdmissions).values({ queueItemId: id, sessionId: root.sessionId,
      threadId: thread.id, dispatchId, orgId: LOCAL_ORG.id });
    const receipt = await deps.promptOrchestrator("Original rendered prompt with a newly appended output schema", {
      dispatchId, queueMode: "followup", ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id } });
    expect(receipt).toEqual({ sessionId: root.sessionId, threadId: thread.id, queueItemId: id });
    expect((await engineStore.getQueueItem(root.sessionId, id))?.content).toMatchObject({ body: "Original rendered prompt" });
    expect(await engineStore.listUnsettledSubmissions(root.sessionId)).toHaveLength(1);
  });

  it("keeps an existing per-run thread for retries after an upgrade", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore,
      actionPluginByService, credentials: engineCredentials });
    await seedRun(api, "run_legacy", "wf_legacy");
    const assistant = await resolveDefaultAssistant(db, LOCAL_ORG.id, { type: "user", id: LOCAL_USER.id });
    const session = await engineHost.assistantSessionFor(assistant.id,
      { actorUserId: LOCAL_USER.id, orgId: LOCAL_ORG.id }, { sessionId: assistant.sessionId });
    const oldThread = session.thread("signal:workflow:run_legacy");
    const dispatchId = "workflow:run_legacy:node1";
    const original = await oldThread.submitPrompt({ kind: "signal", signalType: "workflow.request",
      body: "report", attributes: { runId: "run_legacy" } }, { dispatchId, queueMode: "followup" });
    const retried = await deps.promptOrchestrator("report", { dispatchId, queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id } });
    expect(retried).toEqual({ sessionId: session.id, threadId: oldThread.id, queueItemId: original.queueItemId });
  });

  it("throws a descriptive error for a run with no recorded owner", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_orch_no_owner";
    const workflowId = "wf_orch_no_owner";
    const now = Date.now();
    await db
      .insert(workflowDefinitions)
      .values({
        id: workflowId,
        orgId: LOCAL_ORG.id,
        ownerType: "user",
        ownerId: LOCAL_USER.id,
        name: "no-owner-run",
        definition: { version: "dag/v1", nodes: [], edges: [] },
        createdAt: now,
        updatedAt: now,
      });
    await workflowStore.createRun(
      runId,
      { workflowId, definitionVersionId: "v1" },
      { version: "dag/v1", nodes: [], edges: [] },
      "v1",
      // no owner passed
    );

    await expect(
      deps.promptOrchestrator("hello", {
        dispatchId: `workflow:${runId}:node1`,
        queueMode: "followup",
        ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
      }),
    ).rejects.toThrow(/no recorded owner/);
  });
});

describe("buildWorkflowEngineDeps: promptOrchestrator step threads", () => {
  const OWNER_HINT = { ownerType: "user", ownerId: LOCAL_USER.id };

  it("gives each step and foreach entry its own thread in the run's session, and re-issues land on it", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials });
    const runId = "wfrun_step_threads";
    await seedRun(api, runId, "wf_step_threads");
    const step = (iteration: number) => ({ nodeId: "review", iteration });
    const dispatch = (suffix: string, stepThread?: { nodeId: string; iteration: number }) =>
      deps.promptOrchestrator(`review ${suffix}`, { dispatchId: `workflow:${runId}:${suffix}`, queueMode: "followup", ownerHint: OWNER_HINT,
        ...(stepThread ? { stepThread } : {}) });

    const summary = await dispatch("summary");
    const first = await dispatch("review", step(0));
    const second = await dispatch("review:1", step(1));

    expect(new Set([summary.sessionId, first.sessionId, second.sessionId]).size).toBe(1);
    expect(new Set([summary.threadId, first.threadId, second.threadId]).size).toBe(3);
    const keyOf = async (threadId: string) => (await engineStore.getThread(first.sessionId, threadId))?.key;
    expect(await keyOf(summary.threadId)).toBe(workflowRunThreadKey(runId));
    expect(await keyOf(first.threadId)).toBe(workflowStepThreadKey(runId, "review", 0));
    expect(await keyOf(second.threadId)).toBe(workflowStepThreadKey(runId, "review", 1));
    expect(isWorkflowRunThread({ key: workflowStepThreadKey(runId, "review", 1) })).toBe(true);

    // A crash before the receipt was saved re-issues the same dispatch.
    expect(await dispatch("review:1", step(1))).toEqual(second);
    // The repair turn goes to the thread whose reply it corrects.
    const repair = await deps.promptOrchestrator("fix the json", { dispatchId: `workflow:${runId}:review:1:repair`, queueMode: "followup",
      ownerHint: OWNER_HINT, stepThread: step(1), taskSourceQueueItemId: second.queueItemId });
    expect(repair.threadId).toBe(second.threadId);
    expect(repair.queueItemId).not.toBe(second.queueItemId);
  });

  it("puts a team run's step threads in the run's own execution", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const { createTeam } = await import("../services/teams.js");
    const team = await createTeam(db, { orgId: LOCAL_ORG.id, name: "step-thread-team", creatorUserId: LOCAL_USER.id });
    const now = Date.now();
    await db.insert(workflowDefinitions).values({ id: "wf_step_team", orgId: LOCAL_ORG.id, ownerType: "team", ownerId: team.id,
      name: "team-step-threads", definition: { version: "dag/v1", nodes: [], edges: [] }, createdAt: now, updatedAt: now });
    const runId = "wfrun_step_team";
    await workflowStore.createRun(runId, { workflowId: "wf_step_team", definitionVersionId: "v1" }, { version: "dag/v1", nodes: [], edges: [] },
      "v1", { ownerType: "team", ownerId: team.id, actorUserId: LOCAL_USER.id });
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials });
    const hint = { ownerType: "team", ownerId: team.id };

    const report = await deps.promptOrchestrator("report", { dispatchId: `workflow:${runId}:report`, queueMode: "followup", ownerHint: hint });
    const entry = await deps.promptOrchestrator("entry", { dispatchId: `workflow:${runId}:each:2`, queueMode: "followup", ownerHint: hint,
      stepThread: { nodeId: "each", iteration: 2 } });

    const teamAssistant = await resolveDefaultAssistant(db, LOCAL_ORG.id, { type: "team", id: team.id });
    expect(entry.sessionId).toBe(report.sessionId);
    expect(entry.sessionId).not.toBe(teamAssistant.sessionId);
    expect(entry.threadId).not.toBe(report.threadId);
    expect((await engineStore.getThread(entry.sessionId, entry.threadId))?.key).toBe(workflowStepThreadKey(runId, "each", 2));
  });

  it.each([
    ["own threads", 2, true],
    ["the run thread", 1, false],
  ] as const)("runs agent turns on %s, at most %i at once", async (_label, expected, ownThreads) => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    // An earlier faux registration in this file can remove the built-in
    // transport, so restore whatever was there, if anything.
    const original = piAi.getApiProvider("anthropic-messages");
    const sourceId = "step-thread-parallel-test";
    // Each entry's turn holds its reply until a second entry's turn is in
    // flight, or until a short timeout. Serial turns never overlap.
    let inFlight = 0;
    let maxInFlight = 0;
    const holding: Array<() => void> = [];
    const stream = vi.fn<piAi.ApiStreamSimpleFunction>((_model, context) => {
      const events = piAi.createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      if (!JSON.stringify(last ?? "").includes("parallel-entry")) {
        events.end(fauxAssistantMessage("ok"));
        return events;
      }
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const release = () => { inFlight -= 1; events.end(fauxAssistantMessage("entry done")); };
      holding.push(release);
      if (holding.length >= 2) {
        for (const held of holding.splice(0)) held();
      } else {
        setTimeout(() => {
          const index = holding.indexOf(release);
          if (index >= 0) { holding.splice(index, 1); release(); }
        }, 1_500);
      }
      return events;
    });
    piAi.registerApiProvider({ api: "anthropic-messages", stream, streamSimple: stream }, sourceId);
    try {
      api = await bootTestApi();
      const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
      const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials });
      const runId = `wfrun_parallel_${ownThreads ? "steps" : "run"}`;
      await seedRun(api, runId, `wf_parallel_${ownThreads ? "steps" : "run"}`);
      const receipts = await Promise.all([0, 1].map((iteration) => deps.promptOrchestrator(`parallel-entry ${iteration}`, {
        dispatchId: `workflow:${runId}:each${iteration > 0 ? `:${iteration}` : ""}`, queueMode: "followup", ownerHint: OWNER_HINT,
        ...(ownThreads ? { stepThread: { nodeId: "each", iteration } } : {}),
      })));
      await vi.waitFor(async () => {
        for (const receipt of receipts) {
          expect((await engineStore.getQueueItem(receipt.sessionId, receipt.queueItemId))?.status).toBe("settled");
        }
      }, { timeout: 15_000, interval: 50 });
      expect(maxInFlight).toBe(expected);
      for (const receipt of receipts) {
        expect((await deps.awaitResult(receipt.sessionId, receipt.threadId, receipt.queueItemId)).outcome).toBe("completed");
      }
    } finally {
      piAi.unregisterApiProviders(sourceId);
      if (original) piAi.registerApiProvider(original);
    }
  });
});

describe("buildWorkflowEngineDeps: llmComplete", () => {
  it.each([
    ["openai/gpt-6.1-sol", false], ["gpt-6.1-sol", false], ["gpt-6.1-sol", true],
  ] as const)("completes with supplemental model %s (Anthropic disabled: %s)", async (model, disableAnthropic) => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    const original = piAi.getApiProvider("openai-responses");
    if (!original) throw new Error("The OpenAI Responses transport must be registered.");
    const stream = vi.fn<piAi.ApiStreamSimpleFunction>(() => {
      const events = piAi.createAssistantMessageEventStream();
      events.end(fauxAssistantMessage("ok"));
      return events;
    });
    // API tests reuse modules across files. Override the transport so an
    // earlier import of engine-deps cannot bypass this test's fake response.
    piAi.registerApiProvider({ api: "openai-responses", stream, streamSimple: stream });
    try {
      api = await bootTestApi();
      const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
      const deps = buildWorkflowEngineDeps({
        host: engineHost, store: workflowStore, db, engineStore,
        actionPluginByService, credentials: engineCredentials,
      });

      if (disableAnthropic) {
        await createLlmProvider(db, {
          orgId: LOCAL_ORG.id, kind: "anthropic", name: "Anthropic", enabled: false,
        });
      }
      const runId = `wfrun_llm_${model.includes("/") ? "namespaced" : "bare"}`;
      await seedRun(api, runId, `wf_llm_${model.includes("/") ? "namespaced" : "bare"}`);
      const result = await deps.llmComplete({ runId, nodeId: "summarize", iteration: 0, model, prompt: "hi" });
      expect(result.text).toBe("ok");
      expect(stream).toHaveBeenCalledWith(expect.objectContaining({
        id: "gpt-6.1-sol", provider: "openai", contextWindow: 272_000,
        thinkingLevelMap: expect.objectContaining({ high: "high" }),
      }), expect.anything(), expect.anything());
    } finally {
      piAi.registerApiProvider(original);
    }
  });

  it("sends the owner's default reasoning level, and a step's own level wins", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    const original = piAi.getApiProvider("openai-responses");
    if (!original) throw new Error("OpenAI transport is required");
    const stream = vi.fn<piAi.ApiStreamSimpleFunction>(() => {
      const events = piAi.createAssistantMessageEventStream();
      events.end(fauxAssistantMessage("ok"));
      return events;
    });
    piAi.registerApiProvider({ api: "openai-responses", stream, streamSimple: stream });
    try {
      api = await bootTestApi();
      const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
      await db.update(orgs).set({ reasoningSettings: { default: "medium" } }).where(eq(orgs.id, LOCAL_ORG.id));
      const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials });
      await seedRun(api, "wfrun_reasoning", "wf_reasoning");
      await deps.llmComplete({ runId: "wfrun_reasoning", nodeId: "summarize", iteration: 0, model: "openai/gpt-6.1-sol", prompt: "hi" });
      expect(stream.mock.calls[0]![2]).toMatchObject({ reasoning: "medium" });
      await deps.llmComplete({ runId: "wfrun_reasoning", nodeId: "summarize", iteration: 0, model: "openai/gpt-6.1-sol", prompt: "hi", reasoning: "high" });
      expect(stream.mock.calls[1]![2]).toMatchObject({ reasoning: "high" });
    } finally { piAi.registerApiProvider(original); }
  });

  it.each(["error", "aborted"] as const)("rejects a provider %s response instead of returning empty success", async (stopReason) => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    const original = piAi.getApiProvider("openai-responses");
    if (!original) throw new Error("OpenAI transport is required");
    const stream = vi.fn<piAi.ApiStreamSimpleFunction>(() => {
      const events = piAi.createAssistantMessageEventStream();
      events.end({ ...fauxAssistantMessage(""), stopReason, errorMessage: "Provider rejected this model" });
      return events;
    });
    piAi.registerApiProvider({ api: "openai-responses", stream, streamSimple: stream });
    try {
      api = await bootTestApi();
      const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
      const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials });
      const runId = `wfrun_provider_${stopReason}`;
      await seedRun(api, runId, `wf_provider_${stopReason}`);
      await expect(deps.llmComplete({ runId, nodeId: "summarize", iteration: 0, model: "openai/gpt-6.1-sol", prompt: "hi" })).rejects.toThrow('Provider rejected this model');
    } finally { piAi.registerApiProvider(original); }
  });

  it("records each call's usage under its step and iteration, a failed call included", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    const original = piAi.getApiProvider("openai-responses");
    if (!original) throw new Error("OpenAI transport is required");
    const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
      cost: { input: 0.001, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.0015 } };
    let fail = false;
    const stream = vi.fn<piAi.ApiStreamSimpleFunction>(() => {
      const events = piAi.createAssistantMessageEventStream();
      events.end({ ...fauxAssistantMessage(fail ? "" : "ok"), usage,
        ...(fail ? { stopReason: "error" as const, errorMessage: "Provider failed after billing" } : {}) });
      return events;
    });
    piAi.registerApiProvider({ api: "openai-responses", stream, streamSimple: stream });
    try {
      api = await bootTestApi();
      const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
      const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials });
      await seedRun(api, "wfrun_usage", "wf_usage");
      await deps.llmComplete({ runId: "wfrun_usage", nodeId: "summarize", iteration: 2, model: "openai/gpt-6.1-sol", prompt: "hi" });
      fail = true;
      await expect(deps.llmComplete({ runId: "wfrun_usage", nodeId: "classify", iteration: 0, model: "openai/gpt-6.1-sol", prompt: "hi" }))
        .rejects.toThrow("Provider failed after billing");
      // AppDb abstracts Postgres and PGlite; the selected columns define the row.
      const rows = await db.execute(sql`SELECT session_id, entry_type, (usage::jsonb->>'total')::int AS total
        FROM engine_entries WHERE session_id LIKE 'wf:wfrun_usage:%' ORDER BY session_id`) as { rows: unknown[] };
      expect(rows.rows).toEqual([
        { session_id: "wf:wfrun_usage:classify", entry_type: "usage", total: 12 },
        { session_id: "wf:wfrun_usage:summarize:2", entry_type: "usage", total: 12 },
      ]);
    } finally { piAi.registerApiProvider(original); }
  });

  it("throws descriptively for an unknown model id, without any network call", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_llm_unknown";
    await seedRun(api, runId, "wf_llm_unknown");
    await expect(
      deps.llmComplete({ runId, nodeId: "summarize", iteration: 0, model: "definitely-not-a-real-model-id", prompt: "hi" }),
    ).rejects.toThrow(/unknown or unavailable model/);
  });
});

describe("unattendedRefusalError", () => {
  // An agent step's ask_approval used to open a card; since build-time
  // approval, a run refuses it. "Allow the action" cannot fix an
  // ask_approval request, so the notice names the Approval step.
  it("tells the owner to replace an agent step's approval request with an Approval step", () => {
    const error = unattendedRefusalError([{ title: "Create the Linear onboarding project for the new hire?" }]);
    expect(error).toContain("Valet sent no approval request");
    expect(error).toContain("\"Create the Linear onboarding project for the new hire?\"");
    expect(error).toContain("add an Approval step before this step");
    expect(error).toContain("remove the request for approval from this step's prompt");
    expect(error).toContain("A Tool step asks for approval on each run by itself");
    expect(error).not.toContain("Review permissions");
  });

  it("names each refused action and both ways to run it", () => {
    const error = unattendedRefusalError([
      { title: "Approve Save Project?", context: { tool_id: "linear.save_project" } },
      { title: "Approve Save Project?", context: { tool_id: "linear.save_project" } },
    ]);
    expect(error).toContain("linear.save_project did not run");
    expect(error.match(/linear\.save_project/g)).toHaveLength(3);
    expect(error).toContain("move linear.save_project to a Tool step, which asks for approval on each run");
    // Review permissions cannot grant an MCP action in a Tool step, and a Tool
    // step after an Approval step would ask twice.
    expect(error).not.toContain("Approval step");
    expect(error).toContain("Review permissions");
    expect(error).not.toContain("team account");
  });

  it("names the team account fix for a teammate's shared account", () => {
    const error = unattendedRefusalError([
      { title: "Let a teammate use your Linear account?", context: { tool_id: "linear.save_project", approver: { userId: "u_lender" } } },
    ]);
    expect(error).toContain("connect a team account on the team's Integrations page");
  });

  // A run an agent starts never uses saved permissions in agent steps
  // (`step-grants.ts`), so "use Review permissions" sent the owner to redo a
  // review that had already been done.
  it("says that an agent-started run does not use saved permissions", () => {
    const error = unattendedRefusalError([
      { title: "Approve save_milestone?", context: { tool_id: "linear.save_milestone" } },
    ], { agentStarted: true });
    expect(error).toContain("linear.save_milestone did not run");
    expect(error).toContain("An agent started or retried this run, so its agent steps do not use the workflow's saved permissions");
    // The marker can come from the source run or from an agent's retry, so
    // the fix is a new run, never a retry.
    expect(error).toContain("Start a new run from the workflow page, or wait for the workflow to start one on its own.");
    expect(error).not.toContain("A retry keeps this");
    expect(error).toContain("move linear.save_milestone to a Tool step, which asks for approval on each run");
    // The setup a new run needs, when the step does not have it yet.
    expect(error).toContain("A new run uses saved permissions for linear.save_milestone only if this step lists it in its actions and Review permissions allows it.");
  });
});

describe("mapPiAiUsage", () => {
  it("maps every field, not a subset — this is the fix for the completion usage that used to be silently discarded", () => {
    const usage: Usage = {
      input: 120,
      output: 30,
      cacheRead: 5,
      cacheWrite: 2,
      totalTokens: 157,
      cost: { input: 0.001, output: 0.002, cacheRead: 0.00001, cacheWrite: 0.00002, total: 0.00303 },
    };

    expect(mapPiAiUsage(usage)).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      totalTokens: 157,
      costUsd: 0.00303,
    });
  });

  it("passes through zeros unchanged (no accidental truthiness/default-value bugs)", () => {
    const usage: Usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    expect(mapPiAiUsage(usage)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    });
  });
});

it("keys a run a Slack channel's event started by that channel", () => {
  expect(workflowRunThreadKey("run_1")).toBe("signal:workflow:run_1");
  expect(workflowRunThreadKey("run_1", "CPRIV")).toBe("slack-events:CPRIV:workflow:run_1");
});


it("retains task references and marks both workflow dispatch paths and their repairs unattended", async () => {
  api = await bootTestApi();
  const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
  await seedRun(api, "task-contract-run", "task-contract-workflow");
  const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials });
  const sessionId = "wf:task-contract-run:session";
  const task = "Exclude internal repos; return URL, owner, and evidence.";
  const primary = await deps.prompt(sessionId, task, { dispatchId: "workflow:task-contract-run:session" });
  const repair = await deps.prompt(sessionId, "Correct the JSON", { dispatchId: "workflow:task-contract-run:session:repair", taskSourceQueueItemId: primary.queueItemId, queueMode: "followup" });
  expect((await engineStore.getQueueItem(sessionId, primary.queueItemId))?.metadata).toMatchObject({ preserveTask: true, [UNATTENDED_WORKFLOW_KEY]: true });
  expect((await engineStore.getQueueItem(sessionId, repair.queueItemId))?.metadata).toMatchObject({ preserveTask: true, [UNATTENDED_WORKFLOW_KEY]: true, taskSourceQueueItemId: primary.queueItemId });
  const ownerHint = { ownerType: "user", ownerId: LOCAL_USER.id };
  const report = await deps.promptOrchestrator(task, { dispatchId: "workflow:task-contract-run:report", ownerHint, queueMode: "followup" });
  const reportRepair = await deps.promptOrchestrator("Correct the JSON", { dispatchId: "workflow:task-contract-run:report:repair", ownerHint, queueMode: "followup", taskSourceQueueItemId: report.queueItemId });
  expect(reportRepair.sessionId).toBe(report.sessionId);
  expect(reportRepair.threadId).toBe(report.threadId);
  // A Thread step and its repair name the step, so its agent can use the workflow's saved grants.
  const step = { [WORKFLOW_STEP_KEY]: { runId: "task-contract-run", nodeId: "report" } };
  expect((await engineStore.getQueueItem(report.sessionId, report.queueItemId))?.metadata).toMatchObject({ preserveTask: true, [UNATTENDED_WORKFLOW_KEY]: true, ...step });
  expect((await engineStore.getQueueItem(reportRepair.sessionId, reportRepair.queueItemId))?.metadata).toMatchObject({ preserveTask: true, [UNATTENDED_WORKFLOW_KEY]: true, taskSourceQueueItemId: report.queueItemId, ...step });
});
