/**
 * The `skill` tool on a real session. Boots the API with two REAL plugin
 * packages (`@valet/plugin-github`, `@valet/plugin-slack`), then drives the
 * tool's `execute()` with a hand-built `ToolContext` — the same idiom
 * `orchestrator/memory-tools.test.ts` uses — so the assertion covers the
 * whole path: plugin manifest → `pluginSessionExtras` → session tools →
 * rendered markdown.
 *
 * `session.options` is the engine's public seam for a built session's
 * tools, so this reads it directly instead of casting private state.
 */
import { describe, it, expect, afterEach } from "vitest";
import githubPlugin from "@valet/plugin-github/plugin";
import slackPlugin from "@valet/plugin-slack/plugin";
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  Sandbox,
  SessionEntry,
  ToolContext,
  ToolDef,
} from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";

const stubCredentials: CredentialProvider = {
  get: async (): Promise<Credential | null> => null,
  request: async (): Promise<Credential> => {
    throw new Error("not implemented in test stub");
  },
};

function makeCtx(): ToolContext {
  // Only `id` is read on this path; a full fake Sandbox would be noise.
  const sandbox: Partial<Sandbox> & { id: string } = { id: "sb-1" };
  return {
    userId: "local-user",
    orgId: "local-org",
    sessionId: "s1",
    threadId: "t1",
    credentials: stubCredentials,
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

function findSkillTool(tools: ToolDef[] | undefined): ToolDef {
  const tool = tools?.find((t) => t.name === "skill");
  if (!tool) throw new Error(`no "skill" tool on the session: ${tools?.map((t) => t.name).join(", ")}`);
  return tool;
}

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("the `skill` tool on a real session", () => {
  it("lists every installed skill in its description", async () => {
    api = await bootTestApi({ plugins: [githubPlugin, slackPlugin] });
    const session = await api.providers.engineHost.sessionFor("skill-tool-list", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });

    const tool = findSkillTool(session.options.tools);
    expect(tool.description).toContain("github");
    expect(tool.description).toContain("slack-tools");
    expect(tool.protectedFromPruning).toBe(true);
  });

  it("renders a real plugin skill's markdown body", async () => {
    api = await bootTestApi({ plugins: [githubPlugin, slackPlugin] });
    const session = await api.providers.engineHost.sessionFor("skill-tool-render", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });

    const tool = findSkillTool(session.options.tools);
    const result = await tool.execute({ name: "github" }, makeCtx());

    // Real text from packages/plugin-github/skills/github.md — not a stub.
    expect(result.text).toContain("# GitHub Integration Tools");
    // Frontmatter is stripped by `loadSkillFromMarkdown`.
    expect(result.text).not.toContain("---\nname: github");
  });

  it("names the available skills when the requested one does not exist", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const session = await api.providers.engineHost.sessionFor("skill-tool-unknown", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });

    const tool = findSkillTool(session.options.tools);
    const result = await tool.execute({ name: "not-a-skill" }, makeCtx());

    expect(result.text).toContain("not-a-skill");
    expect(result.text).toContain("github");
  });

  it("is absent from a session whose plugins ship no skills", async () => {
    api = await bootTestApi({ plugins: [] });
    const session = await api.providers.engineHost.sessionFor("skill-tool-none", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });

    expect((session.options.tools ?? []).map((t) => t.name)).not.toContain("skill");
  });
});
