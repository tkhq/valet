import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@valet/engine/test-helpers";
import {
  buildJudgeRunner,
  parseJudgeResponse,
  renderTrajectoryForJudge,
  runCheck,
} from "../src/index.js";
import type { Trajectory } from "../src/index.js";

function makeTrajectory(overrides: Partial<Trajectory> = {}): Trajectory {
  return {
    caseId: "t",
    prompt: "write a haiku about autumn",
    model: "m",
    turns: [{ index: 0 }],
    toolCalls: [],
    finalOutput: "Crisp leaves drift downward / amber light on quiet paths / the year exhales slow",
    usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
    durationMs: 100,
    ...overrides,
  };
}

describe("parseJudgeResponse", () => {
  it("parses plain JSON", () => {
    expect(parseJudgeResponse('{"score": 4, "reason": "good"}')).toEqual({ score: 4, reason: "good" });
  });

  it("parses JSON inside fences or prose", () => {
    expect(parseJudgeResponse('Here you go:\n```json\n{"score": 2, "reason": "weak"}\n```')).toEqual({
      score: 2,
      reason: "weak",
    });
  });

  it("rejects out-of-range scores and non-JSON", () => {
    expect(parseJudgeResponse('{"score": 9, "reason": "x"}')).toBeNull();
    expect(parseJudgeResponse("no json here")).toBeNull();
    expect(parseJudgeResponse('{"reason": "missing score"}')).toBeNull();
  });
});

describe("renderTrajectoryForJudge", () => {
  it("includes tool calls, args, results, and the final output", () => {
    const t = makeTrajectory({
      toolCalls: [
        {
          toolName: "mem_write",
          callId: "c1",
          status: "completed",
          args: { path: "a.md" },
          result: { text: "Created: a.md" },
          index: 0,
        },
      ],
    });
    const rendered = renderTrajectoryForJudge(t);
    expect(rendered).toContain('mem_write({"path":"a.md"}) [completed] → Created: a.md');
    expect(rendered).toContain("final output:");
    expect(rendered).toContain("Crisp leaves");
  });
});

describe("buildJudgeRunner (faux judge)", () => {
  it("passes when the judge score meets the threshold", async () => {
    const faux = registerFauxProvider({ provider: "judge-1" });
    faux.setResponses([fauxAssistantMessage('{"score": 5, "reason": "excellent haiku"}')]);

    const judge = buildJudgeRunner({ model: faux.getModel() });
    const r = await judge({ type: "judge_output", rubric: "Is this a haiku?" }, makeTrajectory(), undefined);

    expect(r.pass).toBe(true);
    expect(r.score).toBe(5);
    expect(r.detail).toContain("excellent haiku");
    faux.unregister();
  });

  it("fails below the threshold and honors a per-check threshold", async () => {
    const faux = registerFauxProvider({ provider: "judge-2" });
    faux.setResponses([
      fauxAssistantMessage('{"score": 3, "reason": "not quite"}'),
      fauxAssistantMessage('{"score": 3, "reason": "not quite"}'),
    ]);

    const judge = buildJudgeRunner({ model: faux.getModel() });
    const strict = await judge({ type: "judge_output", rubric: "r" }, makeTrajectory(), undefined);
    expect(strict.pass).toBe(false);
    expect(strict.score).toBe(3);

    const lenient = await judge(
      { type: "judge_output", rubric: "r", threshold: 3 },
      makeTrajectory(),
      undefined,
    );
    expect(lenient.pass).toBe(true);
    faux.unregister();
  });

  it("fails with a detail when the judge returns unparseable output", async () => {
    const faux = registerFauxProvider({ provider: "judge-3" });
    faux.setResponses([fauxAssistantMessage("I think it's pretty good!")]);

    const judge = buildJudgeRunner({ model: faux.getModel() });
    const r = await judge({ type: "judge_trajectory", rubric: "r" }, makeTrajectory(), undefined);

    expect(r.pass).toBe(false);
    expect(r.detail).toContain("unparseable");
    faux.unregister();
  });

  it("judge_equivalence without a baseline fails with a corrective detail", async () => {
    const judge = buildJudgeRunner({});
    const r = await judge({ type: "judge_equivalence" }, makeTrajectory(), undefined);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("--save-baseline");
  });

  it("judge_equivalence renders both trajectories for the judge", async () => {
    const faux = registerFauxProvider({ provider: "judge-4" });
    let seenPrompt = "";
    faux.setResponses([
      (context) => {
        const last = context.messages.at(-1);
        seenPrompt = Array.isArray(last?.content)
          ? last.content
              .map((b) => (typeof b === "object" && b !== null && "text" in b ? String((b as { text: unknown }).text) : ""))
              .join("")
          : String(last?.content ?? "");
        return fauxAssistantMessage('{"score": 5, "reason": "same outcome"}');
      },
    ]);

    const judge = buildJudgeRunner({ model: faux.getModel() });
    const baseline = makeTrajectory({ finalOutput: "baseline output text" });
    const r = await judge({ type: "judge_equivalence" }, makeTrajectory(), baseline);

    expect(r.pass).toBe(true);
    expect(seenPrompt).toContain("<baseline>");
    expect(seenPrompt).toContain("<candidate>");
    expect(seenPrompt).toContain("baseline output text");
    faux.unregister();
  });

  it("fails with a detail on an unknown judge_model override", async () => {
    const judge = buildJudgeRunner({});
    const r = await judge(
      { type: "judge_output", rubric: "r", judge_model: "nope/never" },
      makeTrajectory(),
      undefined,
    );
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("unknown judge model");
  });

  it("wires into runCheck through CheckContext", async () => {
    const faux = registerFauxProvider({ provider: "judge-5" });
    faux.setResponses([fauxAssistantMessage('{"score": 4, "reason": "fine"}')]);
    const judge = buildJudgeRunner({ model: faux.getModel() });

    const r = await runCheck({ type: "judge_output", rubric: "r" }, makeTrajectory(), { judge });
    expect(r.pass).toBe(true);
    faux.unregister();
  });
});

// Real-LLM judge tests (TKAI-331 done-when). Skip without a key.
describe.skipIf(!process.env.ANTHROPIC_API_KEY)("buildJudgeRunner (live LLM)", () => {
  const rubric = "The output is a haiku about autumn: three lines evoking the season.";

  it("scores a known-good output as passing", { timeout: 60_000 }, async () => {
    const judge = buildJudgeRunner({});
    const r = await judge({ type: "judge_output", rubric }, makeTrajectory(), undefined);
    expect(r.score).toBeGreaterThanOrEqual(4);
    expect(r.pass).toBe(true);
  });

  it("scores a known-bad output as failing", { timeout: 60_000 }, async () => {
    const judge = buildJudgeRunner({});
    const bad = makeTrajectory({ finalOutput: "SELECT * FROM users WHERE deleted_at IS NULL;" });
    const r = await judge({ type: "judge_output", rubric }, bad, undefined);
    expect(r.score).toBeLessThan(4);
    expect(r.pass).toBe(false);
  });
});
