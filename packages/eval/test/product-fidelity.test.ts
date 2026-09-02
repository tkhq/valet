/**
 * Production-fidelity coverage (adversarial-review findings 8, 9, 11):
 * drive/allowed_actions/variants loader rules, action-level catalog
 * restriction, per-submission turn budgets. The live product-drive round
 * trip needs a real key and boots the real api; it skips without
 * ANTHROPIC_API_KEY.
 */
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ActionPlugin, ValetPlugin } from "@valet/engine";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@valet/engine/test-helpers";
import {
  buildMockCatalogTools,
  expandVariants,
  parseEvalCase,
  runCase,
  runDeterministicCheck,
  runProductCase,
  toolResultText,
} from "../src/index.js";
import type { EvalCase, Trajectory } from "../src/index.js";

const BASE = {
  id: "a-case",
  turns: [{ role: "user", content: "hello" }],
  checks: [{ type: "no_errors" }],
};

describe("loader: drive and allowed_actions", () => {
  it("accepts drive: product on orchestrator cases and rejects it otherwise", () => {
    const c = parseEvalCase({ ...BASE, drive: "product", session_type: "orchestrator" }, "t.yaml");
    expect(c.drive).toBe("product");
    expect(() => parseEvalCase({ ...BASE, drive: "product" }, "t.yaml")).toThrow(/orchestrator/);
    expect(() => parseEvalCase({ ...BASE, drive: "http" }, "t.yaml")).toThrow(/drive/);
  });

  it("validates allowed_actions ids", () => {
    const c = parseEvalCase({ ...BASE, allowed_actions: ["github.get_issue"] }, "t.yaml");
    expect(c.allowed_actions).toEqual(["github.get_issue"]);
    expect(() => parseEvalCase({ ...BASE, allowed_actions: ["github"] }, "t.yaml")).toThrow(
      /fully-qualified/,
    );
  });
});

describe("loader: variants", () => {
  it("expands variants into sibling cases and drops the base", () => {
    const docs = expandVariants(
      {
        ...BASE,
        id: "vary",
        variants: [
          { suffix: "a", turns: [{ role: "user", content: "variant a" }] },
          { suffix: "b", turns: [{ role: "user", content: "variant b" }] },
        ],
      },
      "t.yaml",
    );
    expect(docs).toHaveLength(2);
    const cases = docs.map((d) => parseEvalCase(d, "t.yaml"));
    expect(cases.map((c) => c.id)).toEqual(["vary-a", "vary-b"]);
    expect(cases[1].turns[0].content).toBe("variant b");
    // Un-overridden fields inherit from the base.
    expect(cases[0].checks).toEqual([{ type: "no_errors" }]);
  });

  it("rejects a bad suffix and an empty list", () => {
    expect(() => expandVariants({ ...BASE, variants: [] }, "t.yaml")).toThrow(/non-empty/);
    expect(() => expandVariants({ ...BASE, variants: [{ suffix: "Bad Suffix" }] }, "t.yaml")).toThrow(
      /kebab-case/,
    );
  });

  it("a document without variants passes through unchanged", () => {
    expect(expandVariants(BASE as Record<string, unknown>, "t.yaml")).toEqual([BASE]);
  });
});

describe("allowed_actions restricts inside the catalog", () => {
  const fakeGithub: ValetPlugin = {
    name: "github",
    version: "0.0.1",
    description: "fake",
    actions: [
      {
        service: "github",
        actions: [
          {
            id: "github.get_issue",
            name: "Get Issue",
            description: "gets",
            riskLevel: "low",
            parameters: Type.Object({}),
            execute: async () => ({ success: true, data: "issue" }),
          },
          {
            id: "github.list_pull_requests",
            name: "List PRs",
            description: "lists",
            riskLevel: "low",
            parameters: Type.Object({}),
            execute: async () => ({ success: true, data: "prs" }),
          },
        ],
      } satisfies ActionPlugin,
    ],
  };

  it("an unlisted action is unknown even though its service is mocked", async () => {
    const faux = registerFauxProvider({ provider: "fidelity-aa" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "call_tool",
            { tool_id: "github.list_pull_requests", params: {}, summary: "list" },
            { id: "t1" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);

    const evalCase: EvalCase = {
      id: "aa-case",
      profile: "mock",
      allowed_actions: ["github.get_issue"],
      turns: [{ role: "user", content: "list PRs" }],
      mock_tools: {
        "github.get_issue": { response: "{}" },
        "github.list_pull_requests": { response: "[]" },
      },
      checks: [{ type: "no_errors" }],
    };
    const result = await runCase(evalCase, { model: faux.getModel(), mockPlugins: [fakeGithub] });
    const call = result.trajectory.toolCalls.find((c) => c.toolName === "call_tool");
    expect(toolResultText(call?.result)).toContain("unknown tool_id");
    faux.unregister();
  });
});

describe("max_turns per_submission", () => {
  function trajectoryWithTurns(perSubmission: Record<string, number>): Trajectory {
    const turns = Object.entries(perSubmission).flatMap(([q, n], si) =>
      Array.from({ length: n }, (_, i) => ({ index: si * 10 + i, queueItemId: q })),
    );
    return {
      caseId: "t",
      prompt: "p",
      model: "m",
      turns,
      toolCalls: [],
      finalOutput: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      durationMs: 1,
    };
  }

  it("budgets the worst submission, not the case total", () => {
    const t = trajectoryWithTurns({ q1: 2, q2: 3, q3: 1 });
    // Total 6 turns; per-submission worst is 3.
    expect(runDeterministicCheck({ type: "max_turns", value: 5 }, t).pass).toBe(false);
    expect(runDeterministicCheck({ type: "max_turns", value: 3, per_submission: true }, t).pass).toBe(true);
    const r = runDeterministicCheck({ type: "max_turns", value: 2, per_submission: true }, t);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("q2");
  });

  it("loader accepts per_submission", () => {
    const c = parseEvalCase(
      { ...BASE, checks: [{ type: "max_turns", value: 2, per_submission: true }] },
      "t.yaml",
    );
    expect(c.checks[0]).toEqual({ type: "max_turns", value: 2, per_submission: true });
  });
});

// ── Live product drive ──────────────────────────────────────────────────────

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("product drive (live: boots the real api)", () => {
  it(
    "runs a memory round trip through the REAL orchestrator over HTTP",
    { timeout: 300_000 },
    async () => {
      const evalCase: EvalCase = {
        id: "product-live-smoke",
        drive: "product",
        session_type: "orchestrator",
        turns: [
          {
            role: "user",
            content:
              "Remember this fact in your memory: the deploy window is Thursday. Then read it back and repeat the stored fact verbatim.",
          },
        ],
        timeout_ms: 240_000,
        checks: [],
      };
      const result = await runProductCase(evalCase, { model: "anthropic/claude-haiku-4-5" });

      expect(result.outcome).toBe("completed");
      // The REAL persona and REAL mem_* tools: the trajectory must show a
      // production mem_write (HTTP-backed), not the eval stand-in.
      const memWrite = result.trajectory.toolCalls.find((c) => c.toolName === "mem_write");
      expect(memWrite).toBeDefined();
      expect(memWrite?.status).toBe("completed");
      expect(result.trajectory.finalOutput.toLowerCase()).toContain("thursday");
      expect(result.trajectory.metadata?.drive).toBe("product");
    },
  );
});
