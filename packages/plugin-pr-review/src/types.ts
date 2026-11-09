import { Type, type Static } from "typebox";

export const FindingSchema = Type.Object({
  path: Type.String({ description: "Repo-relative path of the file the comment anchors to." }),
  line: Type.Integer({ minimum: 1, description: "Line the comment anchors to: in the HEAD file, or in the BASE file when side is LEFT." }),
  side: Type.Optional(
    Type.Union([Type.Literal("RIGHT"), Type.Literal("LEFT")], {
      description: "RIGHT (default): the defect is in the HEAD file. LEFT: the defect is code the PR deletes, and `line` is that deleted line in the BASE file.",
    }),
  ),
  severity: Type.Union([Type.Literal("critical"), Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
  category: Type.Union([
    Type.Literal("bug"),
    Type.Literal("security"),
    Type.Literal("concurrency"),
    Type.Literal("data"),
    Type.Literal("api"),
    Type.Literal("performance"),
    Type.Literal("test_gap"),
    Type.Literal("maintainability"),
  ]),
  // Required of the reviewer by submit_review (evidenceProblems), optional in
  // the type: a finding read back from a posted comment has neither.
  trigger: Type.Optional(
    Type.String({ description: "Required. The concrete input or state, reachable by real callers, that makes the code fail. Not posted." }),
  ),
  evidence: Type.Optional(
    Type.String({ description: "Required. path:line references to the code you read that shows the failure, at least one. Not posted." }),
  ),
  confidence: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description:
        "Probability that the repo's maintainers would agree this is a real defect worth fixing in this PR. Calibrated: of findings you rate 0.7, about 7 in 10 should be real. Not posted.",
    }),
  ),
  title: Type.String({ description: "One line naming the single defect and where it is." }),
  body: Type.String({
    description: "One sentence joining the trigger to the wrong result. No other claim: no restated title, second effect, impact, or fix.",
  }),
  suggestion: Type.Optional(Type.String({ description: "Replacement code only, for the anchored line(s), if short. No prose." })),
});

export const ReviewSchema = Type.Object({
  summary: Type.String({
    description: "1-3 sentences on what the PR changes. Do not describe defects or risks here: each finding states its own trigger and result, and the review lists the findings under the summary.",
  }),
  confidence: Type.Integer({
    minimum: 1,
    maximum: 5,
    description: "Merge confidence: 5 = safe to merge, 1 = will break production.",
  }),
  findings: Type.Array(FindingSchema),
});

export type Finding = Static<typeof FindingSchema>;
export type Review = Static<typeof ReviewSchema>;

export interface ReviewUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export interface ReviewRun {
  /** The review after verification. */
  review?: Review;
  /** The reviewer's review before verification. */
  draft?: Review;
  /** One per draft finding, when verification ran. */
  verdicts?: { index: number; verdict: "confirmed" | "refuted" | "unverifiable" | "unverified"; kept: boolean; reason: string }[];
  outcome: "completed" | "no_review" | "failed" | "timeout";
  error?: string;
  model: string;
  durationMs: number;
  toolCalls: number;
  usage: ReviewUsage;
}
