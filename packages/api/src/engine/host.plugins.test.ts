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
import type {
  ActionPlugin,
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  PluginAction,
  Sandbox,
  Session,
  SessionEntry,
  ToolContext,
  ValetPlugin,
} from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";

const stubCredentials: CredentialProvider = {
  get: async (): Promise<Credential | null> => null,
  request: async (): Promise<Credential> => {
    throw new Error("not implemented in test stub");
  },
};

function makeCtx(credentials: CredentialProvider = stubCredentials): ToolContext {
  const sandbox: Partial<Sandbox> & { id: string } = { id: "sb-1" };
  return {
    userId: "local-user",
    orgId: "local-org",
    sessionId: "s1",
    threadId: "t1",
    credentials,
    sandbox: sandbox as Sandbox,
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error("not implemented in test stub");
    },
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
  };
}

function expectPromptToolConsistency(session: Session): void {
  if (session.options.systemPrompt?.includes("list_tools")) {
    expect(session.options.tools?.map((tool) => tool.name)).toContain("list_tools");
  }
}

async function listTools(
  session: Session,
  credentials: CredentialProvider = stubCredentials,
  query?: string,
): Promise<string> {
  const tool = session.options.tools?.find((candidate) => candidate.name === "list_tools");
  if (!tool) throw new Error("session has no list_tools tool");
  return (await tool.execute(query ? { query } : {}, makeCtx(credentials))).text ?? "";
}

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

    const session = await defaultAssistantSessionFor(api.providers, 
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );

    expectPromptToolConsistency(session);
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

    expectPromptToolConsistency(parent);
    expectPromptToolConsistency(child);
    const toolNames = (child.options.tools ?? []).map((t) => t.name);
    // `skill` joins the catalog tools whenever the plugin set ships a skill
    // (see `plugins/skill-tool.ts`).
    expect(toolNames.sort()).toEqual(["call_tool", "list_tools", "skill"]);
    expect(child.options.skills?.map((s) => s.name)).toEqual(["demo-skill"]);
    expect(child.options.roles?.map((r) => r.name)).toEqual(["demo-role"]);
  });

  it("workflow sessions keep list_tools when their prompt names it", async () => {
    api = await bootTestApi({ plugins: [] });
    const session = await api.providers.engineHost.workflowSessionFor("wf:catalog:node", {
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: "/tmp",
    });

    expectPromptToolConsistency(session);
    expect(session.options.tools?.map((tool) => tool.name)).toContain("list_tools");
  });

  it("with plugins: [] the orchestrator keeps catalog and memory tools", async () => {
    api = await bootTestApi({ plugins: [] });
    const { engineHost } = api.providers;

    const session = await defaultAssistantSessionFor(api.providers, 
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );

    const toolNames = (session.options.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("list_tools");
    expect(toolNames).toContain("call_tool");
    expect(toolNames).toEqual(
      expect.arrayContaining(["mem_write", "mem_patch", "mem_read", "mem_search", "mem_rm"]),
    );
    expect(session.options.skills).toBeUndefined();
    expect(session.options.roles).toBeUndefined();
  });

  it("refreshes an unconfigured service in the same session after the org credential is stored", async () => {
    // The action schema stays private while the org credential is absent.
    // The live inventory rechecks the credential on each list_tools call.
    const gatedPlugin: ValetPlugin = {
      name: "gated",
      version: "0.0.1",
      actions: [{ service: "gated", actions: [makeAction("gated.ping")] } satisfies ActionPlugin],
      credentials: [
        { type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } },
      ],
    };
    api = await bootTestApi({ plugins: [gatedPlugin] });
    const { engineHost, engineCredentials } = api.providers;

    const before = await engineHost.sessionFor("gate-before", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    expect((before.options.tools ?? []).map((t) => t.name)).toContain("list_tools");
    const unavailable = await listTools(before);
    expect(unavailable).toContain("deployment_unconfigured");
    expect(unavailable).not.toContain("gated.ping");

    await engineCredentials.save({ type: "org", id: "local-org" }, "gated", {
      type: "bot_token",
      accessToken: "org-token",
    });

    const available = await listTools(before, {
      get: async (service): Promise<Credential | null> => {
        if (service !== "gated") return null;
        const stored = await engineCredentials.get({ type: "org", id: "local-org" }, service);
        return stored?.accessToken ? { accessToken: stored.accessToken } : null;
      },
      request: stubCredentials.request,
    });
    expect(available).toContain("gated.ping");
    expect(available).not.toContain("deployment_unconfigured");
  });

  it("keeps a service's tools for a team session when the team holds its own token and no org row exists", async () => {
    // Team credentials design: a team may store its own verified token for
    // an org-provided service. The gate must read the team row before it
    // strips the service, or the token a team admin stored is never used.
    const gatedPlugin: ValetPlugin = {
      name: "gated",
      version: "0.0.1",
      actions: [{ service: "gated", actions: [makeAction("gated.ping")] } satisfies ActionPlugin],
      credentials: [
        { type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } },
      ],
    };
    api = await bootTestApi({ plugins: [gatedPlugin] });
    const { engineHost, engineCredentials } = api.providers;
    await engineCredentials.save({ type: "team", id: "team_1" }, "gated", {
      type: "bot_token",
      accessToken: "team-token",
      metadata: { teamId: "T0TEAM" },
    });

    const teamSession = await engineHost.sessionFor("gate-team-own", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
      ownerType: "team",
      ownerTeamId: "team_1",
    });
    expect((teamSession.options.tools ?? []).map((t) => t.name)).toContain("list_tools");

    // The row is that team's alone: a user session in the same org still
    // sees the service as unconfigured.
    const userSession = await engineHost.sessionFor("gate-user-still-unconfigured", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    expect((userSession.options.tools ?? []).map((t) => t.name)).toContain("list_tools");
    expect(await listTools(userSession)).toContain("deployment_unconfigured");
  });

  it("with plugins: [] a generic session keeps the catalog pair", async () => {
    api = await bootTestApi({ plugins: [] });
    const { engineHost } = api.providers;

    const session = await engineHost.sessionFor("plain-session-no-plugins", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });

    expectPromptToolConsistency(session);
    expect(session.options.tools?.map((tool) => tool.name)).toEqual(["list_tools", "call_tool"]);
    const nativeResult = await listTools(session, stubCredentials, "thread");
    expect(nativeResult).toContain("list_threads, thread_read");
    expect(session.options.skills).toBeUndefined();
    expect(session.options.roles).toBeUndefined();
  });
});
