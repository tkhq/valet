import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CaseValidationError, loadCases, parseEvalCase } from "../src/index.js";

const CASES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../evals/cases");

describe("loadCases", () => {
  it("loads the placeholder case from evals/cases with the expected shape", async () => {
    const cases = await loadCases(CASES_DIR);
    const memCase = cases.find((c) => c.id === "memory-write-read");
    expect(memCase).toBeDefined();
    if (!memCase) throw new Error("unreachable");
    expect(memCase.turns).toHaveLength(1);
    expect(memCase.turns[0].role).toBe("user");
    expect(memCase.turns[0].content).toContain("deploy freeze");
    expect(memCase.timeout_ms).toBe(120000);
    expect(memCase.checks.length).toBeGreaterThanOrEqual(4);
    expect(memCase.checks[0]).toEqual({ type: "tool_called", tool: "mem_write" });
    expect(memCase.checks).toContainEqual({ type: "all_terminal" });
    expect(memCase.checks).toContainEqual({ type: "no_errors" });
  });

  it("rejects duplicate case ids across files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-cases-"));
    const doc = [
      "id: dup-case",
      "turns:",
      "  - role: user",
      "    content: hi",
      "checks:",
      "  - type: no_errors",
    ].join("\n");
    writeFileSync(join(dir, "a.yaml"), doc);
    writeFileSync(join(dir, "b.yaml"), doc);
    await expect(loadCases(dir)).rejects.toThrow(/duplicate case id/);
  });

  it("names the missing directory in its error", async () => {
    await expect(loadCases("/nonexistent/eval/cases")).rejects.toThrow(/cases directory not found/);
  });
});

describe("parseEvalCase", () => {
  const minimal = {
    id: "a-case",
    turns: [{ role: "user", content: "hello" }],
    checks: [{ type: "no_errors" }],
  };

  it("accepts a minimal case", () => {
    const c = parseEvalCase(minimal, "test.yaml");
    expect(c.id).toBe("a-case");
    expect(c.checks).toEqual([{ type: "no_errors" }]);
  });

  it("accepts all optional fields", () => {
    const c = parseEvalCase(
      {
        ...minimal,
        description: "d",
        model: "anthropic/claude-haiku-4-5",
        timeout_ms: 5000,
        tools: ["mem_write"],
        session_type: "orchestrator",
        profile: "mock",
        mock_tools: { "github.list_pull_requests": { response: "[]" } },
        required_credentials: ["github"],
      },
      "test.yaml",
    );
    expect(c.session_type).toBe("orchestrator");
    expect(c.profile).toBe("mock");
    expect(c.mock_tools).toEqual({ "github.list_pull_requests": { response: "[]" } });
    expect(c.required_credentials).toEqual(["github"]);
  });

  it("rejects a non-kebab-case id", () => {
    expect(() => parseEvalCase({ ...minimal, id: "Bad Case" }, "t.yaml")).toThrow(CaseValidationError);
  });

  it("rejects an empty turns array", () => {
    expect(() => parseEvalCase({ ...minimal, turns: [] }, "t.yaml")).toThrow(/turns/);
  });

  it("rejects a non-user turn role", () => {
    expect(() =>
      parseEvalCase({ ...minimal, turns: [{ role: "assistant", content: "x" }] }, "t.yaml"),
    ).toThrow(/role/);
  });

  it("rejects an unknown check type", () => {
    expect(() => parseEvalCase({ ...minimal, checks: [{ type: "nope" }] }, "t.yaml")).toThrow(
      /checks\[0\].type/,
    );
  });

  it("rejects tool_called without a tool", () => {
    expect(() => parseEvalCase({ ...minimal, checks: [{ type: "tool_called" }] }, "t.yaml")).toThrow(
      /tool/,
    );
  });

  it("rejects tool_called mixing count with min/max", () => {
    expect(() =>
      parseEvalCase(
        { ...minimal, checks: [{ type: "tool_called", tool: "x", count: 1, min: 1 }] },
        "t.yaml",
      ),
    ).toThrow(/count/);
  });

  it("rejects an invalid regex pattern", () => {
    expect(() =>
      parseEvalCase(
        { ...minimal, checks: [{ type: "tool_result_matches", tool: "x", pattern: "(" }] },
        "t.yaml",
      ),
    ).toThrow(/regular expression/);
  });

  it("rejects output_contains with both value and pattern", () => {
    expect(() =>
      parseEvalCase(
        { ...minimal, checks: [{ type: "output_contains", value: "a", pattern: "b" }] },
        "t.yaml",
      ),
    ).toThrow(/exactly one/);
  });

  it("rejects output_contains with neither value nor pattern", () => {
    expect(() =>
      parseEvalCase({ ...minimal, checks: [{ type: "output_contains" }] }, "t.yaml"),
    ).toThrow(/exactly one/);
  });

  it("rejects max_turns without a numeric value", () => {
    expect(() =>
      parseEvalCase({ ...minimal, checks: [{ type: "max_turns", value: "three" }] }, "t.yaml"),
    ).toThrow(/value/);
  });

  it("rejects judge_output without a rubric", () => {
    expect(() => parseEvalCase({ ...minimal, checks: [{ type: "judge_output" }] }, "t.yaml")).toThrow(
      /rubric/,
    );
  });

  it("accepts judge_equivalence without a rubric", () => {
    const c = parseEvalCase({ ...minimal, checks: [{ type: "judge_equivalence" }] }, "t.yaml");
    expect(c.checks[0]).toEqual({ type: "judge_equivalence" });
  });

  it("rejects mock_tools without a string response", () => {
    expect(() =>
      parseEvalCase({ ...minimal, mock_tools: { "a.b": { response: 42 } } }, "t.yaml"),
    ).toThrow(/response/);
  });
});
