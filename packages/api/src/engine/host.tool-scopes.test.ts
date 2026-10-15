import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { Session, Thread, ToolContext, ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { createTeam } from "../services/teams.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

function context(session: Session, thread: Thread): ToolContext {
  return {
    userId: "local-user", orgId: "local-org", sessionId: session.id, threadId: thread.id, owner: session.owner,
    get toolScope() { return thread.effectiveToolScope(); },
    get toolScopeCeiling() { return thread.toolScopeCeiling(); },
    setToolFocus: (scope) => thread.setToolFocus(scope),
    credentials: session.credentialProvider({ actorId: "local-user", threadId: thread.id }),
    sandbox: session.sandbox, signal: new AbortController().signal,
    requestDecision: async () => { throw new Error("this read must not ask for approval"); },
    threadRead: (key, opts) => session.readEntries(key, opts), listThreads: async () => [],
    setModel: async ({ model }) => ({ fromModel: model, toModel: model }),
    policyResolver: session.options.policyResolver,
  };
}

describe.each(["user", "team"] as const)("EngineHost %s tool scope", (ownerType) => {
  it("persists editor focus, isolates concurrent threads, and executes only the selected read", async () => {
    let writes = 0;
    const plugin: ValetPlugin = { name: "demo", version: "1", actions: [{ service: "demo", actions: [
      { id: "demo.inspect", name: "Inspect", description: "Inspect", riskLevel: "low", parameters: Type.Object({}), execute: async (_, ctx) => ({ success: true, data: { owner: ctx.owner, actor: ctx.userId } }) },
      { id: "demo.change", name: "Change", description: "Change", riskLevel: "low", parameters: Type.Object({}), execute: async () => { writes++; return { success: true }; } },
    ] }] };
    api = await bootTestApi({ plugins: [plugin] });
    const owner = ownerType === "user" ? { type: ownerType, id: "local-user" }
      : { type: ownerType, id: (await createTeam(api.providers.db, { orgId: "local-org", name: "Scope checks", creatorUserId: "local-user" })).id };
    const session = await defaultAssistantSessionFor(api.providers, owner, { actorUserId: "local-user", orgId: "local-org" });
    const a = await session.createThread("workflow:wf_scope:alice");
    const b = await session.createThread("workflow:wf_scope:bob");
    expect((await api.providers.engineStore.getThread(session.id, a.id))?.metadata?.toolScope).toMatchObject({ actions: expect.arrayContaining(["workflows.get_run"]) });
    const focus = session.options.tools?.find((tool) => tool.name === "focus_tools");
    const call = session.options.tools?.find((tool) => tool.name === "call_tool");
    const list = session.options.tools?.find((tool) => tool.name === "list_tools");
    if (!focus || !call || !list) throw new Error("scope tools missing");
    await Promise.all([
      focus.execute({ phase: "validate", actions: ["demo.inspect"] }, context(session, a)),
      focus.execute({ phase: "repair" }, context(session, b)),
    ]);
    expect((await list.execute({ service: "demo" }, context(session, a))).text).toContain("demo.inspect");
    expect((await list.execute({ service: "demo" }, context(session, b))).text).not.toContain("demo.inspect");
    const result = await call.execute({ tool_id: "demo.inspect", params: {}, summary: "Inspect" }, context(session, a));
    expect(result.text).toContain(owner.id);
    expect((await call.execute({ tool_id: "demo.change", params: {}, summary: "Change" }, context(session, a))).text).toContain("outside this task");
    expect(writes).toBe(0);
    expect(b.effectiveToolScope()?.actions).toContain("workflows.patch_workflow");
    expect(a.effectiveToolScope()?.actions).not.toContain("workflows.patch_workflow");
  });
});
