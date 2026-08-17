/**
 * Which session builders get the host's pinned actions, and which do not.
 *
 * `EngineHost.sessionExtras` is the one funnel for FOUR session builders, so
 * a pin list applied inside it would reach sessions no person is watching
 * and sessions whose acting principal is not the person typing. These tests
 * hold the scope: a pinned tool appears in a USER-owned assistant session
 * and in no other session kind.
 *
 * The fixture plugin declares the same action ids `PINNED_ACTIONS` names, so
 * the pins resolve without the real workflow service wiring.
 * `session.options` is the engine's public seam for a built session, so the
 * assertions read it directly instead of casting private state.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Type } from "typebox";
import type { ActionPlugin, PluginAction, ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { createTeam } from "../services/teams.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";

const USER = "local-user";
const ORG = "local-org";

/** The direct tool name `workflows.patch_workflow` maps to. */
const PATCH_TOOL = "workflows__patch_workflow";

function makeAction(id: string): PluginAction {
  return {
    id,
    name: id,
    description: id,
    riskLevel: "medium",
    parameters: Type.Object({ workflow_id: Type.String() }),
    execute: async () => ({ success: true }),
  };
}

/** Declares the ids `PINNED_ACTIONS` pins, so the pins are accepted. */
const workflowsFixture: ValetPlugin = {
  name: "workflows-fixture",
  version: "0.0.1",
  actions: [
    {
      service: "workflows",
      actions: [makeAction("workflows.get_workflow"), makeAction("workflows.patch_workflow")],
    } satisfies ActionPlugin,
  ],
};

function toolNames(tools: readonly { name: string }[] | undefined): string[] {
  return (tools ?? []).map((t) => t.name);
}

describe("EngineHost pinned-action scope", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("gives a user-owned assistant session the direct save tool", async () => {
    // The workflow editor panel opens exactly this session, and the pin is
    // what stops the model describing an edit it never applied.
    api = await bootTestApi({ plugins: [workflowsFixture] });
    const session = await defaultAssistantSessionFor(
      api.providers,
      { type: "user", id: USER },
      { actorUserId: USER, orgId: ORG },
    );
    expect(toolNames(session.options.tools)).toContain(PATCH_TOOL);
  });

  it("withholds the direct save tool from a team-owned assistant session", async () => {
    // A team assistant's session is cached on the assistant id and freezes
    // `userId` to the first person who woke it. `patch_workflow` authorizes
    // on that frozen user, so a second member would drive the first
    // member's principal.
    api = await bootTestApi({ plugins: [workflowsFixture] });
    const team = await createTeam(api.providers.db, {
      orgId: ORG,
      name: "Platform",
      creatorUserId: USER,
    });
    const session = await defaultAssistantSessionFor(
      api.providers,
      { type: "team", id: team.id },
      { actorUserId: USER, orgId: ORG },
    );
    const names = toolNames(session.options.tools);
    expect(names).not.toContain(PATCH_TOOL);
    expect(names).not.toContain("workflows__get_workflow");
    // The action stays reachable the way it always was.
    expect(names).toContain("call_tool");
  });

  it("withholds the direct save tool from a workflow-run session", async () => {
    // A `session` node builds its prompt from run context, so a trigger, a
    // webhook or an email can put text in it. That text must not meet a
    // one-call save tool with no human present.
    api = await bootTestApi({ plugins: [workflowsFixture] });
    const session = await api.providers.engineHost.workflowSessionFor("wf:run1:node1", {
      actorUserId: USER,
      orgId: ORG,
      owner: { type: "user", id: USER },
      workspace: "/tmp",
    });
    const names = toolNames(session.options.tools);
    expect(names).not.toContain(PATCH_TOOL);
    expect(names).toContain("call_tool");
  });

  it("withholds the direct save tool from a REST session and its children", async () => {
    api = await bootTestApi({ plugins: [workflowsFixture] });
    const { engineHost } = api.providers;

    const parent = await engineHost.sessionFor("pins-parent", {
      userId: USER,
      orgId: ORG,
      workspace: "/tmp",
    });
    expect(toolNames(parent.options.tools)).not.toContain(PATCH_TOOL);

    const child = await engineHost.childSessionFor("pins-child", {
      parentSessionId: "pins-parent",
      parentThreadId: parent.thread("web:default").id,
      actorUserId: USER,
      orgId: ORG,
      owner: { type: "user", id: USER },
      workspace: "/tmp",
    });
    const names = toolNames(child.options.tools);
    expect(names).not.toContain(PATCH_TOOL);
    expect(names).toContain("call_tool");
  });
});
