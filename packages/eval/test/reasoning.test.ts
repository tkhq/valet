/**
 * Reasoning-effort seam (TKAI-352): the case/suite reasoning level reaches
 * pi-ai's StreamOptions.reasoning, the CLI validates its flag, and the
 * common bundled catalog resolves supplemental models with their metadata.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@valet/engine/test-helpers";
import { parseCliArgs, parseEvalCase, resolveEvalModel, runSuite } from "../src/index.js";
import type { EvalCase } from "../src/index.js";

function makeCase(overrides: Partial<EvalCase>): EvalCase {
  return {
    id: "case-x",
    turns: [{ role: "user", content: "answer" }],
    checks: [{ type: "output_contains", value: "ok" }],
    ...overrides,
  };
}

describe("loader and CLI validation", () => {
  it("accepts a valid reasoning level and rejects garbage", () => {
    expect(parseEvalCase({ ...makeCase({}), reasoning: "high" }, "t.yaml").reasoning).toBe("high");
    expect(() => parseEvalCase({ ...makeCase({}), reasoning: "ultra" }, "t.yaml")).toThrow(/reasoning/);
    expect(parseCliArgs(["--reasoning", "medium"]).reasoning).toBe("medium");
    expect(() => parseCliArgs(["--reasoning", "eleven"])).toThrow(/--reasoning/);
  });
});

describe("reasoning threading", () => {
  it("suite-level reasoning reaches the model call and the trajectory metadata", async () => {
    const faux = registerFauxProvider({ provider: "reason-1", models: [{ id: "faux-reasoner-1", reasoning: true }] });
    let seen: string | undefined;
    faux.setResponses([
      (_context, options) => {
        seen = options?.reasoning;
        return fauxAssistantMessage("ok");
      },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-reason-"));

    const result = await runSuite([makeCase({})], {
      model: faux.getModel(),
      baselinesDir: dir,
      reasoning: "high",
    });
    expect(seen).toBe("high");
    expect(result.entries[0].trajectory?.metadata?.reasoning).toBe("high");
    faux.unregister();
  });

  it("a case's own reasoning wins over the suite override", async () => {
    const faux = registerFauxProvider({ provider: "reason-2", models: [{ id: "faux-reasoner-2", reasoning: true }] });
    let seen: string | undefined;
    faux.setResponses([
      (_context, options) => {
        seen = options?.reasoning;
        return fauxAssistantMessage("ok");
      },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-reason-"));

    await runSuite([makeCase({ reasoning: "low" })], {
      model: faux.getModel(),
      baselinesDir: dir,
      reasoning: "high",
    });
    expect(seen).toBe("low");
    faux.unregister();
  });
});

describe("catalog resolution", () => {
  it("resolves claude-fable-5-1 with upstream pricing", () => {
    const m = resolveEvalModel("anthropic/claude-fable-5-1");
    expect(m).toBeDefined();
    expect(m?.id).toBe("claude-fable-5-1");
    expect(m?.provider).toBe("anthropic");
    expect(m?.cost).toEqual({ input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 });
  });

  it("resolves Astra with the same supplemental metadata as the API", () => {
    expect(resolveEvalModel("openai/gpt-6-astra")).toMatchObject({
      id: "gpt-6-astra", provider: "openai", api: "openai-responses",
      contextWindow: 272_000, maxTokens: 128_000,
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      compat: { supportsStrictMode: true, supportsOpenAIGrammarTools: true,
        supportsAdditionalTools: true, supportsToolSearch: true, supportsExplicitPromptCacheMode: true },
    });
  });

  it("still resolves catalog specs and rejects unknowns", () => {
    expect(resolveEvalModel("anthropic/claude-haiku-4-5")?.id).toBe("claude-haiku-4-5");
    expect(resolveEvalModel("nope/never")).toBeUndefined();
  });
});
