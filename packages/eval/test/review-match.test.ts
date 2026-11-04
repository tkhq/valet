import { describe, expect, it } from "vitest";
import {
  buildReviewMatcher,
  CaseValidationError,
  formatReviewSummary,
  llmGatewayFromEnv,
  parseCliArgs,
  parseEvalCase,
  profileMetrics,
  viaGateway,
  type ReviewMatchCheck,
  type ScorecardEntry,
  type Trajectory,
} from "../src/index.js";
import { resolveModelId } from "@valet/engine";

const GOLDEN = [
  { comment: "Negative slice offsets crash on Django querysets", category: "bug" },
  { comment: "member is None for API-key callers", category: "bug" },
  { comment: "Variable name is misleading", category: "style" },
];

function trajectory(review?: unknown): Trajectory {
  return {
    caseId: "review-x",
    prompt: "Review pull request",
    model: "anthropic/claude-sonnet-5-5",
    turns: [],
    toolCalls: [],
    finalOutput: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    durationMs: 1,
    ...(review !== undefined ? { metadata: { review } } : {}),
  };
}

const REVIEW = {
  summary: "s",
  confidence: 2,
  findings: [
    { path: "a.py", line: 3, severity: "high", category: "bug", title: "Negative slicing", body: "Django rejects negative slices." },
    { path: "b.py", line: 9, severity: "low", category: "bug", title: "Unused import", body: "os is unused." },
  ],
};

/** Fake LLM: extract returns fixed issues, dedup keeps singletons, judge matches on a keyword. */
function fakeLlm(issues: string[]): (system: string, prompt: string) => Promise<string> {
  return async (system, prompt) => {
    if (system.startsWith("You extract")) return JSON.stringify({ issues });
    if (system.startsWith("You group")) return JSON.stringify({ groups: issues.map((_, i) => [i]) });
    const golden = /Golden Comment[^\n]*\n(.*)\n/.exec(prompt)?.[1] ?? "";
    const candidate = /Candidate Issue[^\n]*\n(.*)\n/.exec(prompt)?.[1] ?? "";
    const match = golden.includes("Negative") && candidate.includes("Negative");
    return "```json\n" + JSON.stringify({ reasoning: "r", match, confidence: match ? 0.9 : 0.1 }) + "\n```";
  };
}

describe("review_match", () => {
  const check: ReviewMatchCheck = {
    type: "review_match",
    golden: GOLDEN,
    reference: { "cubic-v2": { matched: [0, 1, 2], fp: 1 } },
  };

  it("scores tp/fp/fn under the core profile and reports reference tools", async () => {
    const matcher = buildReviewMatcher({ llm: fakeLlm(["Negative slicing crashes", "Unused import of os"]) });
    const result = await matcher(check, trajectory(REVIEW));
    expect(result.pass).toBe(true);
    // The style golden comment is outside core: neither found nor missed.
    expect(result.metrics).toMatchObject({ tp: 1, fp: 1, fn: 1, candidates: 2 });
    expect(result.metrics).toMatchObject({ "ref:cubic-v2:tp": 2, "ref:cubic-v2:fp": 1, "ref:cubic-v2:fn": 0 });
    expect(result.detail).toContain("1/2 golden found");
  });

  it("fails when the reviewer submitted nothing, and on min_recall", async () => {
    const matcher = buildReviewMatcher({ llm: fakeLlm([]) });
    expect((await matcher(check, trajectory())).pass).toBe(false);
    const strict = await matcher({ ...check, min_recall: 0.5 }, trajectory({ ...REVIEW, findings: [] }));
    expect(strict.pass).toBe(false);
    expect(strict.metrics).toMatchObject({ tp: 0, fp: 0, fn: 2, candidates: 0 });
  });

  it("also scores the pre-verification draft when the verifier dropped findings", async () => {
    const matcher = buildReviewMatcher({ llm: fakeLlm(["Negative slicing crashes"]) });
    const t = trajectory({ ...REVIEW, findings: [REVIEW.findings[0]] });
    t.metadata = { ...t.metadata, draft: REVIEW };
    const result = await matcher(check, t);
    expect(result.metrics).toMatchObject({ tp: 1, "draft:tp": 1, "draft:fn": 1 });
  });

  it("profileMetrics counts only the profile's categories", () => {
    expect(profileMetrics(check, "all", [0, 2], 3)).toEqual({ tp: 2, fp: 3, fn: 1 });
    expect(profileMetrics(check, "strict", [0, 2], 3)).toEqual({ tp: 1, fp: 3, fn: 1 });
  });

  it("sums the scorecard table across cases", () => {
    const entry = (tp: number, fp: number, fn: number): ScorecardEntry => ({
      caseId: "c",
      status: "pass",
      durationMs: 1,
      checkResults: [
        { check, pass: true, metrics: { tp, fp, fn, "ref:cubic-v2:tp": 2, "ref:cubic-v2:fp": 0, "ref:cubic-v2:fn": 0 } },
      ],
    });
    const table = formatReviewSummary([entry(1, 1, 1), entry(1, 0, 1)]) ?? "";
    expect(table).not.toContain("before verify");
    expect(table).toContain("CODE REVIEW (2 PRs scored)");
    // valet: P 2/3, R 2/4.
    expect(table).toMatch(/valet\s+2\s+66\.7\s+50\.0/);
    expect(table).toMatch(/cubic-v2\s+2\s+100\.0\s+100\.0/);
    expect(formatReviewSummary([])).toBeUndefined();
  });
});

describe("pull_request cases", () => {
  const base = {
    id: "review-x",
    pull_request: { repo: "sentry", remote: "https://example.com/r.git", base: "a", head: "b", title: "t" },
    checks: [{ type: "review_match", golden: GOLDEN }],
  };

  it("parse without turns", () => {
    const c = parseEvalCase(base, "x.yaml");
    expect(c.turns).toEqual([]);
    expect(c.pull_request?.repo).toBe("sentry");
  });

  it("reject turns, review_match without a PR, and a bad golden list", () => {
    expect(() => parseEvalCase({ ...base, turns: [{ role: "user", content: "hi" }] }, "x.yaml")).toThrow(CaseValidationError);
    expect(() =>
      parseEvalCase({ id: "x", turns: [{ role: "user", content: "hi" }], checks: base.checks }, "x.yaml"),
    ).toThrow(/need `pull_request`/);
    expect(() => parseEvalCase({ ...base, checks: [{ type: "review_match", golden: [] }] }, "x.yaml")).toThrow(
      CaseValidationError,
    );
  });
});

describe("--verify-model", () => {
  it("sets the code-review verifier model", () => {
    expect(parseCliArgs(["--verify-model", "openai/gpt-5.6-terra"]).verifyModel).toBe("openai/gpt-5.6-terra");
    expect(parseCliArgs([]).verifyModel).toBeUndefined();
  });

  it("parses --no-verify and --review-passes", () => {
    expect(parseCliArgs(["--no-verify", "--review-passes", "2"])).toMatchObject({ verify: false, reviewPasses: 2 });
    expect(parseCliArgs([]).verify).toBeUndefined();
    expect(() => parseCliArgs(["--review-passes", "9"])).toThrow(/--review-passes/);
  });
});

describe("Valet LLM gateway", () => {
  it("reads the URL and a vlt_ key, and refuses a non-Valet key", () => {
    expect(llmGatewayFromEnv({})).toBeUndefined();
    expect(llmGatewayFromEnv({ VALET_LLM_GATEWAY_URL: "https://v.example/", VALET_API_KEY: "vlt_abc" })).toEqual({
      url: "https://v.example",
      apiKey: "vlt_abc",
    });
    expect(() => llmGatewayFromEnv({ VALET_LLM_GATEWAY_URL: "https://v.example", VALET_API_KEY: "sk-ant-x" })).toThrow(/vlt_/);
  });

  it("points anthropic models at /proxy/anthropic", () => {
    const model = resolveModelId("anthropic/claude-haiku-4-5");
    if (!model) throw new Error("model missing from catalog");
    expect(viaGateway(model, { url: "https://v.example", apiKey: "vlt_x" }).baseUrl).toBe("https://v.example/proxy/anthropic");
  });

  it("sends a Cloudflare Access token on every model call when one is set", () => {
    const gateway = llmGatewayFromEnv({ VALET_LLM_GATEWAY_URL: "https://v.example", VALET_API_KEY: "vlt_abc", VALET_GATEWAY_ACCESS_TOKEN: "tok" });
    expect(gateway?.accessToken).toBe("tok");
    const model = resolveModelId("anthropic/claude-haiku-4-5");
    if (!model || !gateway) throw new Error("model missing from catalog");
    expect(viaGateway(model, gateway).headers?.["cf-access-token"]).toBe("tok");
    expect(viaGateway(model, { url: "https://v.example", apiKey: "vlt_x" }).headers).toBe(model.headers);
  });
});
