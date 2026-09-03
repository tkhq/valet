import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ActionPlugin, ValetPlugin } from "@valet/engine";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@valet/engine/test-helpers";
import {
  buildRealCatalogTools,
  envKeyForService,
  loadEvalCredentials,
  parseEnvFile,
  runCase,
  runSuite,
  toolResultText,
} from "../src/index.js";
import type { EvalCase } from "../src/index.js";

const seenTokens: string[] = [];

const fakeActions: ActionPlugin = {
  service: "fake",
  actions: [
    {
      id: "fake.read_thing",
      name: "Read Thing",
      description: "reads a thing",
      riskLevel: "low",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_args, ctx) => {
        const cred = await ctx.credentials.get();
        seenTokens.push(cred?.accessToken ?? "(none)");
        return { success: true, data: `thing read with ${cred?.accessToken ?? "no token"}` };
      },
    },
    {
      id: "fake.write_thing",
      name: "Write Thing",
      description: "writes a thing",
      riskLevel: "high",
      parameters: Type.Object({ id: Type.String() }),
      execute: async () => ({ success: true, data: "wrote" }),
    },
  ],
};

const fakePlugin: ValetPlugin = {
  name: "fake",
  version: "0.0.1",
  description: "fake plugin for integration tests",
  actions: [fakeActions],
};

function integrationCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "integration-case",
    profile: "integration",
    turns: [{ role: "user", content: "read the thing" }],
    checks: [{ type: "no_errors" }],
    ...overrides,
  };
}

describe("parseEnvFile", () => {
  it("parses KEY=VALUE lines, comments, and quotes", () => {
    const parsed = parseEnvFile('# comment\nGITHUB_TOKEN=abc\nLINEAR_API_KEY="quoted"\n\nBAD LINE\n');
    expect(parsed).toEqual({ GITHUB_TOKEN: "abc", LINEAR_API_KEY: "quoted" });
  });
});

describe("loadEvalCredentials", () => {
  it("maps env vars to credential services, file entries winning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-creds-"));
    const file = join(dir, ".env.eval");
    writeFileSync(file, "GITHUB_TOKEN=from-file\n");
    const creds = await loadEvalCredentials({
      envFilePath: file,
      env: { GITHUB_TOKEN: "from-env", LINEAR_API_KEY: "lin-env" },
    });
    expect(creds).toEqual({ github: "from-file", linear: "lin-env" });
  });

  it("rejects production variables in .env.eval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-creds-"));
    const file = join(dir, ".env.eval");
    writeFileSync(file, "DATABASE_URL=postgres://prod\nGITHUB_TOKEN=x\n");
    await expect(loadEvalCredentials({ envFilePath: file, env: {} })).rejects.toThrow(
      /DATABASE_URL/,
    );
  });

  it("tolerates a missing file", async () => {
    const creds = await loadEvalCredentials({ envFilePath: "/nonexistent/.env.eval", env: {} });
    expect(creds).toEqual({});
  });

  it("envKeyForService reverses the map", () => {
    expect(envKeyForService("github")).toBe("GITHUB_TOKEN");
    expect(envKeyForService("unknown-service")).toBeUndefined();
  });
});

describe("runCase with profile: integration", () => {
  it("seeds credentials and exposes only low-risk actions", async () => {
    seenTokens.length = 0;
    const faux = registerFauxProvider({ provider: "int-1" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "call_tool",
            { tool_id: "fake.read_thing", params: { id: "t1" }, summary: "read" },
            { id: "tc1" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall(
            "call_tool",
            { tool_id: "fake.write_thing", params: { id: "t1" }, summary: "write" },
            { id: "tc2" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);

    const result = await runCase(integrationCase(), {
      model: faux.getModel(),
      realPlugins: [fakePlugin],
      credentials: { fake: "tok-123" },
    });

    expect(result.outcome).toBe("completed");
    expect(seenTokens).toEqual(["tok-123"]);
    const read = result.trajectory.toolCalls.find((c) => c.actionId === "fake.read_thing");
    expect(toolResultText(read?.result)).toContain("tok-123");
    // riskLevel high is excluded from the integration profile.
    const write = result.trajectory.toolCalls.find((c) => c.actionId === "fake.write_thing");
    expect(toolResultText(write?.result)).toContain("unknown tool_id");
    faux.unregister();
  });

  it("profile: full exposes mutation actions too", async () => {
    const faux = registerFauxProvider({ provider: "int-2" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "call_tool",
            { tool_id: "fake.write_thing", params: { id: "t1" }, summary: "write" },
            { id: "tc1" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);

    const result = await runCase(integrationCase({ profile: "full" }), {
      model: faux.getModel(),
      realPlugins: [fakePlugin],
      credentials: { fake: "tok-123" },
    });

    const write = result.trajectory.toolCalls.find((c) => c.actionId === "fake.write_thing");
    expect(toolResultText(write?.result)).toContain("wrote");
    faux.unregister();
  });

  it("rejects the profile when no realPlugins are wired", async () => {
    const faux = registerFauxProvider({ provider: "int-3" });
    await expect(runCase(integrationCase(), { model: faux.getModel() })).rejects.toThrow(
      /realPlugins/,
    );
    faux.unregister();
  });
});

describe("runSuite skip rules (TKAI-336)", () => {
  it("skips an integration case whose credential is missing, naming the env var", async () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-suite336-"));
    const result = await runSuite(
      [integrationCase({ required_credentials: ["github"] })],
      { model: "anthropic/claude-haiku-4-5", baselinesDir: dir, realPlugins: [fakePlugin] },
    );
    expect(result.entries[0].status).toBe("skip");
    expect(result.entries[0].skipReason).toContain("github");
    expect(result.entries[0].skipReason).toContain("GITHUB_TOKEN");
  });

  it("skips a full case when Docker is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-suite336-"));
    const result = await runSuite([integrationCase({ profile: "full" })], {
      model: "anthropic/claude-haiku-4-5",
      baselinesDir: dir,
      realPlugins: [fakePlugin],
      dockerAvailable: false,
    });
    expect(result.entries[0].status).toBe("skip");
    expect(result.entries[0].skipReason).toContain("Docker");
  });
});

describe("buildRealCatalogTools", () => {
  it("returns the catalog pair and filters by profile", () => {
    expect(buildRealCatalogTools([fakePlugin], "integration").map((t) => t.name)).toEqual([
      "list_tools",
      "call_tool",
    ]);
    // A plugin with no low-risk actions disappears from the integration catalog.
    const writeOnly: ValetPlugin = {
      ...fakePlugin,
      actions: [{ ...fakeActions, actions: [fakeActions.actions[1]] }],
    };
    expect(buildRealCatalogTools([writeOnly], "integration").map((t) => t.name)).toEqual([
      "list_tools",
      "call_tool",
    ]);
  });
});
