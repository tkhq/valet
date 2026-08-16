/**
 * plugin-system-v2 plan Task 5: every EngineHost session builder must fold
 * in `pluginSessionExtras` (Task 4) — plugin catalog tools (`list_tools`/
 * `call_tool`) plus skills/roles — for the orchestrator, generic, child, and
 * workflow session paths. `session.options` is the engine's public seam for
 * this (readonly `CreateSessionOptions` on `Session`, see
 * `packages/engine/src/session.ts`), so tests assert against it directly
 * instead of casting private state.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Type } from "typebox";
import type { ActionPlugin, PluginAction, ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";

function makeAction(id: string): PluginAction {
  return {
    id,
    name: id,
    description: id,
    riskLevel: "low",
    parameters: Type.Object({}),
    execute: async () => ({ success: true }),
  };
}

const fixturePlugin: ValetPlugin = {
  name: "demo",
  version: "0.0.1",
  actions: [{ service: "demo", actions: [makeAction("demo.ping")] } satisfies ActionPlugin],
  skills: [{ name: "demo-skill", content: "demo skill content" }],
  roles: [{ name: "demo-role", content: "demo role content" }],
};

describe("EngineHost + plugin extras", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("orchestrator session gets plugin catalog tools + skills + roles, memory tools first", async () => {
    api = await bootTestApi({ plugins: [fixturePlugin] });
    const { engineHost } = api.providers;

    const session = await engineHost.orchestratorSessionFor(
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );

    const toolNames = (session.options.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("list_tools");
    expect(toolNames).toContain("call_tool");
    // Memory tools stay first in the array (orchestrator contract).
    expect(toolNames[0]).toBe("mem_write");
    expect(toolNames.indexOf("mem_write")).toBeLessThan(toolNames.indexOf("list_tools"));

    expect(session.options.skills?.map((s) => s.name)).toEqual(["demo-skill"]);
    expect(session.options.roles?.map((r) => r.name)).toEqual(["demo-role"]);
  });

  it("child session carries the same plugin catalog tools", async () => {
    api = await bootTestApi({ plugins: [fixturePlugin] });
    const { engineHost } = api.providers;

    const parent = await engineHost.sessionFor("parent-plugins", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");

    const child = await engineHost.childSessionFor("child-plugins", {
      parentSessionId: "parent-plugins",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: "/tmp",
    });

    const toolNames = (child.options.tools ?? []).map((t) => t.name);
    // `skill` joins the catalog tools whenever the plugin set ships a skill
    // (see `plugins/skill-tool.ts`).
    expect(toolNames.sort()).toEqual(["call_tool", "list_tools", "skill"]);
    expect(child.options.skills?.map((s) => s.name)).toEqual(["demo-skill"]);
    expect(child.options.roles?.map((r) => r.name)).toEqual(["demo-role"]);
  });

  it("with plugins: [] nothing changes — orchestrator gets only memory tools, no skills/roles", async () => {
    api = await bootTestApi({ plugins: [] });
    const { engineHost } = api.providers;

    const session = await engineHost.orchestratorSessionFor(
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );

    const toolNames = (session.options.tools ?? []).map((t) => t.name);
    expect(toolNames).not.toContain("list_tools");
    expect(toolNames).not.toContain("call_tool");
    expect(toolNames).toEqual(
      expect.arrayContaining(["mem_write", "mem_patch", "mem_read", "mem_search", "mem_rm"]),
    );
    expect(session.options.skills).toBeUndefined();
    expect(session.options.roles).toBeUndefined();
  });

  it("with plugins: [] a generic session gets no tools/skills/roles at all", async () => {
    api = await bootTestApi({ plugins: [] });
    const { engineHost } = api.providers;

    const session = await engineHost.sessionFor("plain-session-no-plugins", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });

    expect(session.options.tools).toBeUndefined();
    expect(session.options.skills).toBeUndefined();
    expect(session.options.roles).toBeUndefined();
  });
});
