import { afterEach, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { PluginAction, ValetPlugin } from "@valet/engine";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@valet/engine/test-helpers";
import type { WorkflowDefinition } from "@valet/workflow";
import { eventsActionPlugin } from "../events/actions.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { LOCAL_ORG, LOCAL_USER } from "../providers/node.js";
import { workflowDefinitions } from "../schema/index.js";
import { buildWorkflowEngineDeps } from "./engine-deps.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; vi.unstubAllEnvs(); });

// Known baseline defect: remove `fails` to see the private-session assertion fail.
it.fails.each(["session", "orchestrator"] as const)("refuses event logs from a channel-originated %s step", async (type) => {
  const faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
  vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
  const observations: Array<{ allowed: boolean; ownerType?: string; originPresent: boolean; shared: boolean }> = [];
  const inspect: PluginAction = {
    id: "demo.inspect", name: "Inspect", description: "Check receipt access", riskLevel: "low", parameters: Type.Object({}),
    execute: async (_params, ctx) => {
      if (!api) throw new Error("The test API is unavailable.");
      const logs = eventsActionPlugin(api.providers.db).actions.find(action => action.id === "events.list_event_logs");
      if (!logs) throw new Error("The receipt action is unavailable.");
      // Invoke the real action with the engine-built context, without adding audience fields.
      const result = await logs.execute({}, ctx);
      observations.push({ allowed: result.success, ownerType: ctx.owner?.type,
        originPresent: ctx.origin !== undefined, shared: ctx.sharedTranscript === true });
      return { success: true, data: result };
    },
  };
  const plugin: ValetPlugin = { name: "demo", version: "1", actions: [{ service: "demo", actions: [inspect] }] };
  try {
    api = await bootTestApi({ plugins: [plugin] });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const owner = { ownerType: "user", ownerId: LOCAL_USER.id } as const;
    const agent = type === "session"
      ? { id: "agent", type, mode: "start" as const, prompt: "Inspect event logs." }
      : { id: "agent", type, prompt: "Inspect event logs." };
    const definition: WorkflowDefinition = { version: "dag/v1", nodes: [{ id: "start", type: "trigger" }, agent],
      edges: [{ from: "start", to: "agent" }] };
    const now = Date.now();
    await db.insert(workflowDefinitions).values({ id: "wf_receipt_privacy", orgId: LOCAL_ORG.id, ...owner,
      name: "Receipt privacy", definition, createdAt: now, updatedAt: now });
    const runId = "receipt_privacy";
    await workflowStore.createRun(runId, { workflowId: "wf_receipt_privacy", definitionVersionId: "v1",
      input: { type: "event", data: { key: "slack.message", refs: { channel: "CPRIVATE" } } } }, definition, "v1", owner);
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore,
      actionPluginByService, credentials: engineCredentials });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("call_tool", { tool_id: "demo.inspect", params: {}, summary: "Check access" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Receipt check completed."),
    ]);
    const dispatchId = `workflow:${runId}:agent`;
    const sessionId = `wf:${runId}:agent`;
    if (type === "session") await deps.createSession({ id: sessionId, purpose: "workflow" });
    const receipt = type === "session"
      ? { sessionId, ...await deps.prompt(sessionId, "Inspect event logs.", { dispatchId }) }
      : await deps.promptOrchestrator("Inspect event logs.", { dispatchId, ownerHint: owner, queueMode: "followup" });
    const result = await deps.awaitResult(receipt.sessionId, receipt.threadId, receipt.queueItemId);
    expect(result.outcome).toBe("completed");
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ ownerType: "user", originPresent: false, shared: false });
    expect(observations[0]?.allowed).toBe(false);
  } finally { faux.unregister(); }
});
