/**
 * Unit tests for `buildWorkflowEngineDeps`'s Task 7/Task 6 seams:
 * `invokeAction` (now a real headless `ActionInvoker` with durable dedup —
 * plugin-system-v2 plan Task 6), `promptOrchestrator` (real `EngineHost`
 * orchestrator wiring, no LLM call required — `submitPrompt` returns before
 * the turn actually runs), and `llmComplete`'s no-network unknown-model
 * failure path. The key-gated real-Anthropic completion path is exercised
 * separately in `src/integration/workflow-engine-deps.test.ts`.
 */
import type { Presence } from "@valet/shared";
import { seedWorkspaceAssistant } from "../test-helpers/assistant-fixture.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import { Type } from "typebox";
import type { ActionPlugin, PluginAction, ValetPlugin } from "@valet/engine";
import type { WorkflowRunOrigin } from "@valet/workflow";
import type { Usage } from "@earendil-works/pi-ai/compat";
import * as piAi from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@valet/engine/test-helpers";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { linkIdentity } from "../channels/identity-links.js";
import { agentInputPrompt, SHARED_ASSISTANT_INPUT_ERROR } from "./agent-files.js";
import { buildWorkflowEngineDeps, mapPiAiUsage, workflowRunThreadKey } from "./engine-deps.js";
import { eq } from "drizzle-orm";
import { legacyAssistantRuntimes, legacyWorkflowRuntimes, legacyWorkflowAdmissions, assistants, orgs, sessionThreads, workflowDefinitions } from "../schema/index.js";
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
  presence?: { definition?: Presence; run?: Presence },
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
    const options = { dispatchId: `workflow:${runId}:report`, queueMode: "followup" as const, ownerHint: { ownerType: "team", ownerId: team.id }, files: key.startsWith("slack:") ? undefined : [{ path: "audience.txt", content: "private input" }] };
    const receipt = await deps.promptOrchestrator("report into the original audience", options);
    expect(receipt.sessionId).not.toBe(root.sessionId);
    expect(await engineStore.getSession(receipt.sessionId)).toMatchObject({ parentSessionId: root.sessionId, parentThreadId: originThread.id });
    expect(await engineStore.getThread(receipt.sessionId, receipt.threadId)).toMatchObject({ key });
    expect(await deps.promptOrchestrator("report into the original audience", options)).toEqual(receipt);
    if (options.files) {
      expect(await engineHost.liveSession(receipt.sessionId)?.attachment.current()?.readFile(
        `/workspace/.valet/workflow-inputs/${runId}/report/0/audience.txt`)).toBe("private input");
    }
    expect(await engineStore.listUnsettledSubmissions(root.sessionId)).toEqual([]);
    // A pre-cutover admission whose workflow checkpoint was lost must not run again.
    await engineStore.admitSubmission(root.sessionId, originThread.id, { id: "old-admission", threadId: originThread.id,
      dispatchId: `workflow:${runId}:old-report`, content: { kind: "signal", signalType: "workflow.request", body: "old report", attributes: { runId } },
      status: "queued", attemptCount: 0, maxAttempts: 10, timeoutAt: now + 60_000, createdAt: now, updatedAt: now });
    const retainedOptions = { ...options, files: [{ path: "audience.txt", content: "private input" }], dispatchId: `workflow:${runId}:retained-files` };
    await engineStore.admitSubmission(root.sessionId, originThread.id, { id: "retained-files", threadId: originThread.id,
      dispatchId: retainedOptions.dispatchId,
      content: { kind: "signal", signalType: "workflow.request",
        body: agentInputPrompt(engineHost.sandboxWorkingDirectory(root.session), "retained report", retainedOptions), attributes: { runId } },
      status: "queued", attemptCount: 0, maxAttempts: 10, timeoutAt: now + 60_000, createdAt: now, updatedAt: now });
    await expect(deps.promptOrchestrator("retained report", retainedOptions))
      .rejects.toMatchObject({ name: "AgentInputFileError", message: SHARED_ASSISTANT_INPUT_ERROR });
    engineHost.evictCache(root.sessionId);
    const oldReceipt = await deps.promptOrchestrator("old report", { ...options, files: undefined, dispatchId: `workflow:${runId}:old-report` });
    expect(oldReceipt).toEqual({ sessionId: root.sessionId, threadId: originThread.id, queueItemId: "old-admission" });
    expect(await deps.awaitResult(oldReceipt.sessionId, oldReceipt.threadId, oldReceipt.queueItemId)).toMatchObject({ outcome: "aborted" });
  });

  it.each(["no channels", "owner DM", "archived shared thread"])("rejects personal-root orchestrator files with %s before any write", async scenario => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const root = await ensureDefaultAssistantSession(api.providers, { type: "user", id: LOCAL_USER.id }, { actorUserId: LOCAL_USER.id, orgId: LOCAL_ORG.id });
    if (scenario !== "no channels") {
      const thread = await root.session.createThread(scenario === "owner DM" ? "slack:D_OWN:1.2" : "slack:C_SHARED:1.2");
      if (scenario === "owner DM") await linkIdentity(db, { provider: "slack", externalId: "U_OWNER", userId: LOCAL_USER.id });
      else await db.insert(sessionThreads).values({ id: thread.id, sessionId: root.sessionId, createdAt: Date.now(), archivedAt: Date.now() });
    }
    await seedRun(api, "personal-inputs", "personal-inputs-wf");
    const ready = vi.spyOn(root.session.attachment, "ensureReady");
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials });
    await expect(deps.promptOrchestrator("Read", { dispatchId: "workflow:personal-inputs:build", queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id }, files: [{ path: "private.txt", content: "secret" }] }))
      .rejects.toMatchObject({ name: "AgentInputFileError", message: SHARED_ASSISTANT_INPUT_ERROR });
    expect(ready).not.toHaveBeenCalled();
    expect(await engineStore.listUnsettledSubmissions(root.sessionId)).toEqual([]);
  });

  it("rejects a team Slack execution whose resource audience cannot be verified", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const { createTeam } = await import("../services/teams.js");
    const team = await createTeam(db, { orgId: LOCAL_ORG.id, name: "Unverified files", creatorUserId: LOCAL_USER.id });
    const root = await ensureDefaultAssistantSession(api.providers, { type: "team", id: team.id }, { actorUserId: LOCAL_USER.id, orgId: LOCAL_ORG.id });
    const thread = await root.session.createThread("slack:C_PRIVATE:1.2");
    const now = Date.now(), runId = "unverified-files", workflowId = "unverified-wf";
    const definition = { version: "dag/v1" as const, nodes: [], edges: [] };
    await db.insert(workflowDefinitions).values({ id: workflowId, orgId: LOCAL_ORG.id, ownerType: "team", ownerId: team.id,
      name: "Unverified", definition, createdAt: now, updatedAt: now });
    await workflowStore.createRun(runId, { workflowId, definitionVersionId: "v1", origin: { assistantSessionId: root.sessionId, threadId: thread.id } },
      definition, "v1", { ownerType: "team", ownerId: team.id, actorUserId: LOCAL_USER.id });
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials });
    await expect(deps.promptOrchestrator("Read", { dispatchId: `workflow:${runId}:build`, queueMode: "followup",
      ownerHint: { ownerType: "team", ownerId: team.id }, files: [{ path: "private.txt", content: "secret" }] }))
      .rejects.toMatchObject({ name: "AgentInputFileError", message: SHARED_ASSISTANT_INPUT_ERROR });
    const sessions = await engineStore.listSessions(LOCAL_USER.id);
    for (const session of sessions) {
      expect(await engineStore.listUnsettledSubmissions(session.id)).toEqual([]);
      expect(engineHost.liveSession(session.id)?.attachment.state).not.toBe("ready");
    }
  });

  it("rejects input delivery to a retained shared team runtime before provisioning", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const { createTeam } = await import("../services/teams.js");
    const team = await createTeam(db, { orgId: LOCAL_ORG.id, name: "Shared files", creatorUserId: LOCAL_USER.id });
    const root = await ensureDefaultAssistantSession(api.providers, { type: "team", id: team.id }, { actorUserId: LOCAL_USER.id, orgId: LOCAL_ORG.id });
    const now = Date.now(), runId = "shared-inputs", workflowId = "shared-workflow";
    await db.insert(legacyAssistantRuntimes).values({ sessionId: root.sessionId, orgId: LOCAL_ORG.id, ownerType: "team", ownerId: team.id });
    await db.insert(workflowDefinitions).values({ id: workflowId, orgId: LOCAL_ORG.id, ownerType: "team", ownerId: team.id,
      name: "Shared", definition: { version: "dag/v1", nodes: [], edges: [] }, createdAt: now, updatedAt: now });
    await db.insert(legacyWorkflowRuntimes).values({ workflowId, sessionId: root.sessionId, orgId: LOCAL_ORG.id });
    await workflowStore.createRun(runId, { workflowId, definitionVersionId: "v1" }, { version: "dag/v1", nodes: [], edges: [] }, "v1", { ownerType: "team", ownerId: team.id, actorUserId: LOCAL_USER.id });
    const ready = vi.spyOn(root.session.attachment, "ensureReady");
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials });
    await expect(deps.promptOrchestrator("Read", { dispatchId: `workflow:${runId}:build`, queueMode: "followup",
      ownerHint: { ownerType: "team", ownerId: team.id }, files: [{ path: "private.txt", content: "secret" }] }))
      .rejects.toMatchObject({ name: "AgentInputFileError", message: SHARED_ASSISTANT_INPUT_ERROR });
    expect(ready).not.toHaveBeenCalled();
    expect(await engineStore.listUnsettledSubmissions(root.sessionId)).toEqual([]);
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

  it("keeps a second run moving while the first parks on an approval gate", async () => {
    // The incident this reverts: a gate holds its thread's claim until
    // someone answers it (72 hours by default), and a thread runs its queue
    // in series. On a shared thread, the second run of the same workflow
    // waited behind the first run's unanswered approval.
    const faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
    try {
      const gated: PluginAction = {
        id: "demo.review",
        name: "review",
        description: "critical-risk fixture action, so calling it opens an approval gate",
        riskLevel: "critical",
        parameters: Type.Object({}),
        execute: async () => ({ success: true, data: { reviewed: true } }),
      };
      const plugin: ValetPlugin = {
        name: "demo", version: "0.0.1",
        actions: [{ service: "demo", actions: [gated] }],
      };
      api = await bootTestApi({ plugins: [plugin] });
      const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
      const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore,
        actionPluginByService, credentials: engineCredentials });
      await seedRun(api, "run_parked", "wf_gate");
      await workflowStore.createRun("run_next", { workflowId: "wf_gate", definitionVersionId: "v1" },
        { version: "dag/v1", nodes: [], edges: [] }, "v1", { ownerType: "user", ownerId: LOCAL_USER.id });
      const submit = (runId: string, text: string) => deps.promptOrchestrator(text, {
        dispatchId: `workflow:${runId}:node1`, queueMode: "followup",
        ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
      });

      // The first run's turn calls the critical-risk action and blocks.
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("call_tool", { tool_id: "demo.review", params: {}, summary: "review it" }, { id: "tc-gate" })],
          { stopReason: "toolUse" },
        ),
      ]);
      const parked = await submit("run_parked", "first run");
      await vi.waitFor(async () => {
        const gates = await engineStore.listDecisionGates(parked.sessionId, parked.threadId);
        expect(gates.filter((gate) => gate.status === "pending")).toHaveLength(1);
      }, { timeout: 15_000, interval: 50 });

      // The second run of the SAME workflow, dispatched while that gate is
      // open. Its own thread lets its turn run and settle.
      faux.appendResponses([fauxAssistantMessage("second run reported")]);
      const next = await submit("run_next", "second run");
      expect(next.sessionId).toBe(parked.sessionId);
      expect(next.threadId).not.toBe(parked.threadId);
      await vi.waitFor(async () => {
        expect((await engineStore.getQueueItem(next.sessionId, next.queueItemId))?.status).toBe("settled");
      }, { timeout: 15_000, interval: 50 });

      // The first run is still waiting for its answer, as it should be.
      expect((await engineStore.getQueueItem(parked.sessionId, parked.queueItemId))?.status).not.toBe("settled");
      const stillPending = await engineStore.listDecisionGates(parked.sessionId, parked.threadId);
      expect(stillPending.filter((gate) => gate.status === "pending")).toHaveLength(1);
    } finally {
      faux.unregister();
    }
  });

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
      const result = await deps.llmComplete({ runId, model, prompt: "hi" });
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
      await deps.llmComplete({ runId: "wfrun_reasoning", model: "openai/gpt-6.1-sol", prompt: "hi" });
      expect(stream.mock.calls[0]![2]).toMatchObject({ reasoning: "medium" });
      await deps.llmComplete({ runId: "wfrun_reasoning", model: "openai/gpt-6.1-sol", prompt: "hi", reasoning: "high" });
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
      await expect(deps.llmComplete({ runId, model: "openai/gpt-6.1-sol", prompt: "hi" })).rejects.toThrow('Provider rejected this model');
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
      deps.llmComplete({ runId, model: "definitely-not-a-real-model-id", prompt: "hi" }),
    ).rejects.toThrow(/unknown or unavailable model/);
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
