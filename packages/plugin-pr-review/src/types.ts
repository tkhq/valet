import { Type, type Static } from "typebox";

export const FindingSchema = Type.Object({
  path: Type.String({ description: "Repo-relative path of the file the comment anchors to." }),
  line: Type.Integer({ minimum: 1, description: "Line in the HEAD version of the file." }),
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
  title: Type.String({ description: "One line naming the single defect and where it is." }),
  body: Type.String({
    description: "One sentence joining the trigger to the wrong result. No other claim: no restated title, second effect, impact, or fix.",
  }),
  suggestion: Type.Optional(Type.String({ description: "Replacement code only, for the anchored line(s), if short. No prose." })),
});

export const ReviewSchema = Type.Object({
  summary: Type.String({ description: "2-5 sentences: what the PR changes and the main risks found." }),
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
