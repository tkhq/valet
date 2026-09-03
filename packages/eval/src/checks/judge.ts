/**
 * LLM-as-judge check handlers (TKAI-331).
 *
 * A grading model scores the trajectory against a rubric and returns JSON
 * `{ score, reason }` (score 1-5). A check passes when score >= threshold
 * (default 4). Judge failures — call errors, unparseable output — produce a
 * FAIL result with the judge error in `detail`, never a crash.
 */
import { completeSimple, resolveModelId, type Model } from "@valet/engine";
import { toolResultText } from "../trajectory.js";
import type { CheckResult, JudgeCheck, Trajectory } from "../types.js";
import type { JudgeRunner } from "./index.js";

/** Default grading model. */
export const DEFAULT_JUDGE_MODEL = "anthropic/claude-haiku-4-5";
/**
 * Grading model used when the default judge IS the model under test: a
 * judge must never grade its own model (self-preference bias), so the
 * runner escalates to this instead.
 */
export const CONFLICT_JUDGE_MODEL = "anthropic/claude-sonnet-5";

const DEFAULT_THRESHOLD = 4;
/** Majority-vote sample count for judge calls. Odd, so votes cannot tie. */
const DEFAULT_JUDGE_SAMPLES = 3;
const RESULT_TEXT_MAX = 400;
const OUTPUT_MAX = 8_000;

const JUDGE_SYSTEM_PROMPT = [
  "You are a strict evaluation judge for an AI agent platform.",
  "Score the material against the rubric on a 1-5 scale:",
  "1 = fails the rubric entirely, 3 = partially meets it, 5 = fully meets it.",
  'Respond with ONLY a JSON object: {"score": <1-5>, "reason": "<one line>"}.',
].join(" ");

export interface JudgeOptions {
  /**
   * Grading model: a spec string or a live `Model` handle. Default
   * `DEFAULT_JUDGE_MODEL`. A check's `judge_model` overrides per check
   * (spec string only).
   */
  model?: string | Model<string>;
  /** API key for the judge calls. Absent → pi-ai's env-var fallback. */
  apiKey?: string;
  /**
   * The model under test (spec form). When the resolved judge matches it,
   * the runner escalates to `CONFLICT_JUDGE_MODEL` and says so in the
   * result detail — a judge must never grade its own model.
   */
  modelUnderTest?: string;
  /**
   * Judge samples per check (majority vote on pass/fail; the reported
   * score is the median). Default `DEFAULT_JUDGE_SAMPLES`. Use 1 for
   * fast, cheap, less reliable grading.
   */
  samples?: number;
}

/** Median of a non-empty list (mean of the middle pair for even lengths). */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Render a trajectory for the judge: turns, tool calls, final output. */
export function renderTrajectoryForJudge(t: Trajectory, label = "trajectory"): string {
  const lines: string[] = [
    `<${label}>`,
    `prompt: ${t.prompt}`,
    `turns: ${t.turns.length}`,
    "tool calls:",
  ];
  if (t.toolCalls.length === 0) lines.push("  (none)");
  for (const call of t.toolCalls) {
    const args = call.args !== undefined ? JSON.stringify(call.args) : "{}";
    const result = toolResultText(call.result).slice(0, RESULT_TEXT_MAX).replace(/\s+/g, " ");
    lines.push(`  ${call.index + 1}. ${call.toolName}(${args}) [${call.status}]${result ? ` → ${result}` : ""}`);
  }
  lines.push(`final output:\n${t.finalOutput.slice(0, OUTPUT_MAX)}`, `</${label}>`);
  return lines.join("\n");
}

/** Parse the judge's `{ score, reason }` JSON, tolerating fenced or prefixed output. */
export function parseJudgeResponse(text: string): { score: number; reason: string } | null {
  const candidates: string[] = [text];
  const block = text.match(/\{[\s\S]*\}/);
  if (block) candidates.push(block[0]);
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed !== "object" || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      if (typeof record.score !== "number" || !Number.isFinite(record.score)) continue;
      if (record.score < 1 || record.score > 5) continue;
      return { score: record.score, reason: typeof record.reason === "string" ? record.reason : "" };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function buildPrompt(check: JudgeCheck, trajectory: Trajectory, baseline: Trajectory | undefined): string {
  switch (check.type) {
    case "judge_output":
      // The judge sees the TASK, not just the output: without the prompt it
      // grades blind and rewards fluent answers to the wrong question.
      return [
        "Score the agent's final output against this rubric, in the context of the task it was given.",
        `<task>\n${trajectory.prompt.slice(0, OUTPUT_MAX)}\n</task>`,
        `<rubric>\n${check.rubric}\n</rubric>`,
        `<output>\n${trajectory.finalOutput.slice(0, OUTPUT_MAX)}\n</output>`,
      ].join("\n\n");
    case "judge_trajectory":
      return [
        "Score the agent's approach — its tool calls, sequencing, and final output — against this rubric.",
        `<rubric>\n${check.rubric}\n</rubric>`,
        renderTrajectoryForJudge(trajectory),
      ].join("\n\n");
    case "judge_equivalence": {
      if (baseline === undefined) throw new Error("judge_equivalence needs a baseline trajectory");
      const extra = check.rubric !== undefined ? `\n\nAdditional grading guidance:\n${check.rubric}` : "";
      return [
        "Compare the two trajectories below. Score how logically equivalent their outcomes are: " +
          "5 = they achieve the same outcome, 1 = they achieve different outcomes." +
          extra,
        renderTrajectoryForJudge(baseline, "baseline"),
        renderTrajectoryForJudge(trajectory, "candidate"),
      ].join("\n\n");
    }
  }
}

/**
 * Build a `JudgeRunner` backed by a grading model. The runner never throws:
 * every failure mode becomes a FAIL `CheckResult` with the error in `detail`.
 */
export function buildJudgeRunner(opts: JudgeOptions = {}): JudgeRunner {
  return async (check, trajectory, baseline): Promise<CheckResult> => {
    const failed = (detail: string): CheckResult => ({ check, pass: false, detail });

    if (check.type === "judge_equivalence" && baseline === undefined) {
      return failed(
        "judge_equivalence needs a baseline trajectory. Run with --save-baseline first, then re-run.",
      );
    }

    let model: Model<string>;
    let modelSpec: string;
    const specOverride = check.judge_model ?? (typeof opts.model === "string" ? opts.model : undefined);
    if (specOverride !== undefined) {
      const resolved = resolveModelId(specOverride);
      if (!resolved) {
        return failed(`unknown judge model \`${specOverride}\`. Use provider/model form.`);
      }
      model = resolved;
      modelSpec = specOverride;
    } else if (opts.model !== undefined && typeof opts.model !== "string") {
      model = opts.model;
      modelSpec = `${opts.model.provider}/${opts.model.id}`;
    } else {
      const resolved = resolveModelId(DEFAULT_JUDGE_MODEL);
      if (!resolved) return failed(`default judge model ${DEFAULT_JUDGE_MODEL} did not resolve.`);
      model = resolved;
      modelSpec = DEFAULT_JUDGE_MODEL;
    }

    // A judge must never grade its own model (self-preference bias). An
    // explicitly configured judge (per-check judge_model, or a harness
    // opts.model) is honored as written; only the implicit DEFAULT judge
    // escalates when it matches the model under test.
    let conflictNote = "";
    if (
      check.judge_model === undefined &&
      opts.model === undefined &&
      opts.modelUnderTest !== undefined &&
      sameModelSpec(modelSpec, opts.modelUnderTest)
    ) {
      const escalated = resolveModelId(CONFLICT_JUDGE_MODEL);
      if (!escalated) {
        return failed(
          `judge model equals the model under test (${modelSpec}) and the conflict judge ` +
            `${CONFLICT_JUDGE_MODEL} did not resolve. Set judge_model on the check.`,
        );
      }
      model = escalated;
      modelSpec = CONFLICT_JUDGE_MODEL;
      conflictNote = ` (judge escalated to ${CONFLICT_JUDGE_MODEL}: default judge equals the model under test)`;
    }

    const samples = Math.max(1, opts.samples ?? DEFAULT_JUDGE_SAMPLES);
    const scores: number[] = [];
    const reasons: string[] = [];
    for (let i = 0; i < samples; i++) {
      let responseText: string;
      try {
        const result = await completeSimple(
          model,
          {
            systemPrompt: JUDGE_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: buildPrompt(check, trajectory, baseline) }],
                timestamp: Date.now(),
              },
            ],
          },
          { apiKey: opts.apiKey, maxRetries: 1, maxRetryDelayMs: 15_000 },
        );
        if (result.stopReason === "error" || result.stopReason === "aborted" || result.stopReason === "length") {
          return failed(`judge call failed (${result.stopReason}): ${result.errorMessage ?? "no error message"}`);
        }
        responseText = result.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
      } catch (err) {
        return failed(`judge call threw: ${err instanceof Error ? err.message : String(err)}`);
      }

      const parsed = parseJudgeResponse(responseText);
      if (parsed === null) {
        return failed(
          `judge returned unparseable output (expected {"score", "reason"} JSON): ${responseText.slice(0, 200)}`,
        );
      }
      scores.push(parsed.score);
      if (parsed.reason) reasons.push(parsed.reason);
    }

    const threshold = check.threshold ?? DEFAULT_THRESHOLD;
    // Majority vote on pass/fail; the reported score is the median, which
    // resists one outlier sample in either direction.
    const passVotes = scores.filter((s) => s >= threshold).length;
    const pass = passVotes * 2 > samples;
    const score = median(scores);
    const voteNote = samples > 1 ? ` [${passVotes}/${samples} votes, scores ${scores.join(",")}]` : "";
    const detail =
      `judge score ${score}/5 (threshold ${threshold})${voteNote}` +
      `${reasons.length > 0 ? `: ${reasons[0]}` : ""}${conflictNote}`;
    return { check, pass, score, detail };
  };
}

/** Two specs name the same model when their `provider/id` forms match (a bare id implies anthropic). */
function sameModelSpec(a: string, b: string): boolean {
  const norm = (s: string): string => (s.includes("/") ? s : `anthropic/${s}`);
  return norm(a) === norm(b);
}
