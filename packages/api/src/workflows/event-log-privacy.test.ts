import { afterEach, expect, it, vi } from "vitest";
import { decode } from "@toon-format/toon";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@valet/engine/test-helpers";
import type { RunParams, WorkflowDefinition } from "@valet/workflow";
import { eventsActionPlugin } from "../events/actions.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { LOCAL_ORG, LOCAL_USER } from "../providers/node.js";
import { eventReceipts, workflowDefinitions } from "../schema/index.js";
import { definitionVersionId } from "./definition-version.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; vi.unstubAllEnvs(); });

it.each(["session", "orchestrator"] as const)("documents event-log access in a user-owned, channel-started %s step", async (type) => {
  const faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
  vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
  try {
    api = await bootTestApi();
    const { db, plugins, actionPluginByService, workflowRunHost, workflowStore } = api.providers;
    // The harness omits this production plugin. Register it before any session is built.
    const actions = eventsActionPlugin(db, () => plugins);
    const plugin = { name: "events-actions", version: "0.1.0", actions: [actions] };
    plugins.push(plugin);
    actionPluginByService.set("events", { plugin, actionPlugin: actions });

    const owner = { ownerType: "user", ownerId: LOCAL_USER.id, actorUserId: LOCAL_USER.id } as const;
    const agent = type === "session"
      ? { id: "agent", type, mode: "start" as const, prompt: "Inspect event logs." }
      : { id: "agent", type, prompt: "Inspect event logs." };
    const definition: WorkflowDefinition = { version: "dag/v1", nodes: [{ id: "start", type: "trigger" }, agent],
      edges: [{ from: "start", to: "agent" }] };
    const now = Date.now();
    const workflowId = "wf_receipt_privacy";
    await db.insert(workflowDefinitions).values({ id: workflowId, orgId: LOCAL_ORG.id,
      ownerType: owner.ownerType, ownerId: owner.ownerId,
      name: "Receipt privacy", definition, createdAt: now, updatedAt: now });
    await db.insert(eventReceipts).values({ id: "other-private-receipt", orgId: LOCAL_ORG.id,
      service: "slack", eventKey: "slack.message", metadata: { channelId: "COTHERPRIVATE" },
      createdAt: now, updatedAt: now });

    // Match the event dispatcher's params: a channel event is input, not a conversation origin.
    const params: RunParams = { workflowId, definitionVersionId: definitionVersionId(definition),
      triggerId: "privacy-subscription", input: {
        type: "event", triggerId: "privacy-subscription", timestamp: new Date(now).toISOString(),
        data: { key: "slack.message", summary: "Private channel event", refs: { channel: "CPRIVATE" }, payload: {} },
        metadata: { eventId: "privacy-event", service: "slack" },
      } };
    const toolResults: string[] = [];
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("call_tool", {
        tool_id: "events.list_event_logs", params: {}, summary: "Inspect event logs",
      })], { stopReason: "toolUse" }),
      (context) => {
        const last = context.messages.at(-1);
        if (last?.role === "toolResult") {
          toolResults.push(last.content.map(part => part.type === "text" ? part.text : "").join(""));
        }
        return fauxAssistantMessage("Receipt check completed.");
      },
    ]);
    const runId = "receipt_privacy";
    await workflowRunHost.start(runId, params, definition, owner);
    await vi.waitFor(async () => {
      expect(await workflowStore.getRun(runId)).toMatchObject({ status: "settled", outcome: "completed" });
    }, { timeout: 15_000, interval: 50 });
    expect(await workflowStore.getRun(runId)).toMatchObject({ params, definitionVersionId: params.definitionVersionId,
      owner: { ownerType: owner.ownerType, ownerId: owner.ownerId }, actorUserId: LOCAL_USER.id });
    expect(await workflowStore.getCheckpoints(runId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "agent", status: "completed", result: expect.objectContaining({ response: "Receipt check completed." }) }),
    ]));
    expect(toolResults).toHaveLength(1);
    const result: unknown = decode(toolResults[0]!);
    // Current behavior, not a policy decision. Flip this assertion when the access rule changes.
    expect(result).toMatchObject({ receipts: [{ id: "other-private-receipt", metadata: { channelId: "COTHERPRIVATE" } }], hasMore: false });
  } finally { faux.unregister(); }
});
