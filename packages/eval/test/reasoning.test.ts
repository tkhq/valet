/**
 * Reasoning-effort seam (TKAI-352): the case/suite reasoning level reaches
 * pi-ai's StreamOptions.reasoning, the CLI validates its flag, and the
 * extra-models table resolves specs the static catalog lacks (unpriced).
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
    const faux = registerFauxProvider({ provider: "reason-1" });
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
    const faux = registerFauxProvider({ provider: "reason-2" });
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

describe("extra-models fallback", () => {
  it("resolves claude-fable-5-1 as an unpriced clone with the right wire id", () => {
    const m = resolveEvalModel("anthropic/claude-fable-5-1");
    expect(m).toBeDefined();
    expect(m?.id).toBe("claude-fable-5-1");
    expect(m?.provider).toBe("anthropic");
    expect((m as { cost?: unknown }).cost).toBeUndefined();
  });

  it("still resolves catalog specs and rejects unknowns", () => {
    expect(resolveEvalModel("anthropic/claude-haiku-4-5")?.id).toBe("claude-haiku-4-5");
    expect(resolveEvalModel("nope/never")).toBeUndefined();
  });
});
