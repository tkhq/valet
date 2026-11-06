import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ActionPlugin, ValetPlugin } from "@valet/engine";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@valet/engine/test-helpers";
import { bundledPlugins } from "@valet/api/plugins";
import { join } from "node:path";
import { buildMockCatalogTools, loadCases, runCase, runChecks, toolResultText } from "../src/index.js";
import type { EvalCase } from "../src/index.js";

const githubActions: ActionPlugin = {
  service: "github",
  actions: [
    {
      id: "github.list_pull_requests",
      name: "List Pull Requests",
      description: "List pull requests for a repository",
      riskLevel: "low",
      parameters: Type.Object({ owner: Type.String(), repo: Type.String() }),
      execute: async () => {
        throw new Error("the real execute must never run in a mock catalog");
      },
    },
    {
      id: "github.create_issue",
      name: "Create Issue",
      description: "Create an issue",
      riskLevel: "high",
      parameters: Type.Object({ owner: Type.String(), repo: Type.String(), title: Type.String() }),
      execute: async () => {
        throw new Error("the real execute must never run in a mock catalog");
      },
    },
  ],
};

const fakeGithubPlugin: ValetPlugin = {
  name: "github",
  version: "0.0.1",
  description: "fake github plugin for tests",
  actions: [githubActions],
};

const CANNED = '[{"number": 42, "title": "Fix auth bug", "state": "open"}]';

function mockCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "mock-case",
    profile: "mock",
    turns: [{ role: "user", content: "list the PRs in acme/valet" }],
    mock_tools: { "github.list_pull_requests": { response: CANNED } },
    checks: [{ type: "no_errors" }],
    ...overrides,
  };
}

describe("buildMockCatalogTools", () => {
  it("exposes list_tools and call_tool", () => {
    const tools = buildMockCatalogTools(
      { "github.list_pull_requests": { response: CANNED } },
      [fakeGithubPlugin],
    );
    expect(tools.map((t) => t.name)).toEqual(["list_tools", "call_tool"]);
  });

  it("throws on an unknown mocked action id, naming the known ones", () => {
    expect(() =>
      buildMockCatalogTools({ "github.not_real": { response: "x" } }, [fakeGithubPlugin]),
    ).toThrow(/github\.list_pull_requests/);
    expect(() =>
      buildMockCatalogTools({ "jira.get_issue": { response: "x" } }, [fakeGithubPlugin]),
    ).toThrow(/No plugin exposes the service `jira`/);
  });

  it("the real plugin registry backs the catalog (schemas match production)", () => {
    const tools = buildMockCatalogTools(
      { "github.list_pull_requests": { response: CANNED } },
      bundledPlugins,
    );
    expect(tools.map((t) => t.name)).toEqual(["list_tools", "call_tool"]);
  });
});

describe("citation eval cases", () => {
  it("name only real actions, so every mocked tool exists in the bundled plugins", async () => {
    const cases = await loadCases(join(import.meta.dirname, "../../../evals/cases/citations"));
    const mocked = cases.filter((c) => c.profile === "mock");
    expect(mocked.map((c) => c.id).sort()).toEqual(["drive-source-citations", "github-source-citations", "gmail-source-citations", "multi-source-attribution", "slack-source-citations"]);
    for (const c of mocked) expect(() => buildMockCatalogTools(c.mock_tools ?? {}, bundledPlugins), c.id).not.toThrow();
  });
});

describe("runCase with profile: mock", () => {
  it("numbers the sources a mocked tool returns so citation_validity passes", async () => {
    const faux = registerFauxProvider({ provider: "mock-src" });
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("call_tool", { tool_id: "github.list_pull_requests", params: { owner: "acme", repo: "valet" }, summary: "list" }, { id: "tc1" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("PR 42 fixes the auth bug [s1]"),
    ]);
    const result = await runCase(
      mockCase({
        mock_tools: {
          "github.list_pull_requests": {
            response: CANNED,
            sources: [{ service: "github", title: "acme/valet#42 Fix auth bug", url: "https://github.com/acme/valet/pull/42" }],
          },
        },
        checks: [{ type: "citation_validity" }],
      }),
      { model: faux.getModel(), mockPlugins: [fakeGithubPlugin] },
    );
    const call = result.trajectory.toolCalls.find((c) => c.toolName === "call_tool");
    expect(toolResultText(call?.result)).toContain("[s1] acme/valet#42 Fix auth bug");
    const [check] = await runChecks([{ type: "citation_validity" }], result.trajectory);
    expect(check?.pass).toBe(true);
  });

  it("assigns distinct ids across source tools for separate fact attribution", async () => {
    const cases = await loadCases(join(import.meta.dirname, "../../../evals/cases/citations"));
    const case_ = cases.find(c => c.id === "multi-source-attribution");
    if (!case_) throw new Error("Missing multi-source attribution case");
    const faux = registerFauxProvider({ provider: "mock-multi-src" });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("call_tool", { tool_id: "slack.read_history", params: { channel: "C0LAUNCH" }, summary: "read launch" }, { id: "slack" }),
        fauxToolCall("call_tool", { tool_id: "github.get_issue", params: { owner: "acme", repo: "valet", issueNumber: 42 }, summary: "read blocker" }, { id: "github" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("Launch is Tuesday, Nov 12 [s1]. Early cookie expiry blocks release [s2]."),
    ]);
    try {
      const result = await runCase(case_, { model: faux.getModel(), mockPlugins: bundledPlugins });
      expect(result.outcome).toBe("completed");
      const slack = result.trajectory.toolCalls.find(c => c.actionId === "slack.read_history");
      const github = result.trajectory.toolCalls.find(c => c.actionId === "github.get_issue");
      expect(toolResultText(slack?.result)).toContain("[s1] Launch date");
      expect(toolResultText(github?.result)).toContain("[s2] acme/valet#42 Release blocker");
      const checks = await runChecks([{ type: "citation_validity" }], result.trajectory);
      expect(checks[0]?.pass).toBe(true);
    } finally {
      faux.unregister();
    }
  });

  it("agent calls the mocked tool and gets the canned response; checks pass", async () => {
    const faux = registerFauxProvider({ provider: "mock-1" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "call_tool",
            {
              tool_id: "github.list_pull_requests",
              params: { owner: "acme", repo: "valet" },
              summary: "list PRs",
            },
            { id: "tc1" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("PR #42 (Fix auth bug) is open"),
    ]);

    const result = await runCase(mockCase(), {
      model: faux.getModel(),
      mockPlugins: [fakeGithubPlugin],
    });

    expect(result.outcome).toBe("completed");
    const call = result.trajectory.toolCalls.find((c) => c.toolName === "call_tool");
    expect(call).toBeDefined();
    expect(call?.actionId).toBe("github.list_pull_requests");
    expect(call?.status).toBe("completed");
    expect(toolResultText(call?.result)).toContain("Fix auth bug");

    const checkResults = await runChecks(
      [
        { type: "tool_called", tool: "github.list_pull_requests" },
        { type: "tool_args_match", tool: "github.list_pull_requests", args: { owner: "acme" } },
        { type: "tool_result_matches", tool: "github.list_pull_requests", pattern: "Fix auth bug" },
      ],
      result.trajectory,
    );
    expect(checkResults.map((r) => r.pass)).toEqual([true, true, true]);
    faux.unregister();
  });

  it("an unmocked action of an exposed service returns a not-available error, not a crash", async () => {
    const faux = registerFauxProvider({ provider: "mock-2" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "call_tool",
            {
              tool_id: "github.create_issue",
              params: { owner: "acme", repo: "valet", title: "t" },
              summary: "create issue",
            },
            { id: "tc1" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("that tool was unavailable"),
    ]);

    const result = await runCase(mockCase(), {
      model: faux.getModel(),
      mockPlugins: [fakeGithubPlugin],
    });

    expect(result.outcome).toBe("completed");
    const call = result.trajectory.toolCalls.find((c) => c.actionId === "github.create_issue");
    expect(call).toBeDefined();
    expect(toolResultText(call?.result)).toContain("not available in this eval case");
    faux.unregister();
  });

  it("rejects a mock case when no mockPlugins are wired", async () => {
    const faux = registerFauxProvider({ provider: "mock-3" });
    await expect(runCase(mockCase(), { model: faux.getModel() })).rejects.toThrow(/mockPlugins/);
    faux.unregister();
  });
});
