/**
 * `review_match`: score a submitted code review against golden comments
 * with the method of Martian Code Review Bench (MIT,
 * github.com/withmartian/code-review-benchmark @ e616e84, offline/
 * code_review_benchmark step2, step2_5, step3). The prompts below are
 * Martian's, verbatim, so our numbers sit next to their published vendor
 * results under the same judge.
 *
 * 1. Extract: one LLM call splits all review comments into issues.
 * 2. Dedup: one LLM call groups issues a single fix would close.
 * 3. Judge: every golden comment against every issue. The highest-confidence
 *    match marks the golden comment found and its issue (and the issue's
 *    duplicates) matched. Unmatched issues are false positives.
 */
import { completeSimple, resolveModelId, type Model } from "@valet/engine";
import { viaGateway, type LlmGateway } from "../gateway.js";
import type { CheckResult, ReviewMatchCheck, ReviewProfile, Trajectory } from "../types.js";

export const DEFAULT_REVIEW_JUDGE_MODEL = "anthropic/claude-sonnet-4-5";

/** Martian's PROFILE_CATEGORIES (analysis/benchmark_dashboard.py). */
export const REVIEW_PROFILE_CATEGORIES: Record<ReviewProfile, ReadonlySet<string>> = {
  strict: new Set(["bug", "security", "concurrency", "data", "api"]),
  core: new Set(["bug", "security", "concurrency", "data", "api", "perf", "test_gap", "doc_defect"]),
  all: new Set(["bug", "security", "concurrency", "data", "api", "perf", "test_gap", "doc_defect", "style", "speculative"]),
};

const EXTRACT_SYSTEM = "You extract code review issues from comments. Always respond with valid JSON.";
const EXTRACT_PROMPT = `You are analyzing an AI code review comment to extract individual issues mentioned.

The comment may discuss multiple distinct problems. Extract each separate issue as a standalone item.

Code Review Comment:
{comment}

Instructions:
- Extract each distinct code issue, bug, or concern mentioned
- Each issue should be a single, specific problem (not a general observation)
- Ignore meta-commentary like "I found 2 issues" - extract the actual issues
- Ignore sign-offs, greetings, or formatting instructions
- If the comment contains no actionable code review issues, return an empty list

Example input:
"Found several problems: 1) The getUserById function doesn't handle null input, which will cause a crash.
2) The cache key uses user.name but should use user.id for uniqueness.
Also, consider adding retry logic for the API call."

Example output:
{"issues": [
  "getUserById function doesn't handle null input, causing potential crash",
  "Cache key uses user.name instead of user.id, breaking uniqueness",
  "Missing retry logic for API call"
]}

Respond with ONLY a JSON object:
{"issues": ["issue 1", "issue 2", ...]}`;

const DEDUP_SYSTEM = "You group duplicate code review comments. Always respond with valid JSON only.";
const DEDUP_PROMPT = `You are identifying duplicate code review comments.

Below is a numbered list of issues extracted from an AI tool's code review.
Some tools post the same issue in both a summary comment and an inline comment,
creating near-identical duplicates. Your job is to find those duplicates.

Two candidates are duplicates ONLY IF:
- They describe the same problem AND
- A single code change would fix both (i.e., they would be one bug report)

Two candidates are NOT duplicates if:
- They describe the same TYPE of bug but in different files, functions, or
  classes (e.g., "negative slicing in OptimizedCursorPaginator" vs "negative
  slicing in BasePaginator" are separate issues — fixing one does not fix
  the other)
- They describe related but distinct problems (e.g., "returns wrong type" vs
  "caller crashes because of wrong type" are separate issues)

When in doubt, keep candidates separate — it is better to leave a duplicate
ungrouped than to incorrectly merge two distinct issues.

Candidates:
{candidates}

Return ONLY a JSON object where each group is a list of 0-based indices.
Singletons (no duplicate) must still appear as single-element groups.

Example for 4 candidates where 0 and 2 are duplicates:
{"groups": [[0, 2], [1], [3]]}

Your response:`;

const JUDGE_SYSTEM = "You are a precise code review evaluator. Always respond with valid JSON.";
const JUDGE_PROMPT = `You are evaluating AI code review tools.
Determine if the candidate issue matches the golden (expected) comment.

Golden Comment (the issue we're looking for):
{golden_comment}

Candidate Issue (from the tool's review):
{candidate}

Instructions:
- Determine if the candidate identifies the SAME underlying issue as the golden comment
- Accept semantic matches - different wording is fine if it's the same problem
- Focus on whether they point to the same bug, concern, or code issue

Respond with ONLY a JSON object:
{"reasoning": "brief explanation", "match": true/false, "confidence": 0.0-1.0}`;

/** Parallel judge calls per case. */
const JUDGE_CONCURRENCY = 16;

/** One LLM call: system + user text in, response text out. Injectable for tests. */
export type ReviewLlm = (system: string, prompt: string) => Promise<string>;

export type ReviewMatcher = (check: ReviewMatchCheck, trajectory: Trajectory) => Promise<CheckResult>;

export interface ReviewMatcherOptions {
  /** Grading model spec or handle. Default: the check's judge_model, else DEFAULT_REVIEW_JUDGE_MODEL. */
  model?: string | Model<string>;
  apiKey?: string;
  /** Send judge calls through this Valet gateway with its key (wins over apiKey). */
  gateway?: LlmGateway;
  /** Replace the model call (tests). */
  llm?: ReviewLlm;
}

/** The review the reviewer submitted, as the runner records it. */
interface SubmittedReview {
  summary: string;
  findings: { path: string; line: number; title: string; body: string; suggestion?: string }[];
}

function submittedReview(t: Trajectory, key: "review" | "draft" = "review"): SubmittedReview | undefined {
  const r = t.metadata?.[key];
  if (typeof r !== "object" || r === null || !("findings" in r) || !Array.isArray(r.findings)) return undefined;
  // Shape written by the runner from the reviewer's validated submit_review args.
  return r as SubmittedReview;
}

/**
 * Comment bodies as the reviewer would post them inline on GitHub. Martian
 * joins a tool's comments with this separator before extraction.
 */
export function reviewCommentText(review: SubmittedReview): string {
  return review.findings
    .map((f) => `**${f.title}**\n\n${f.body}${f.suggestion ? `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\`` : ""}`)
    .join("\n\n---\n\n");
}

export function buildReviewMatcher(opts: ReviewMatcherOptions = {}): ReviewMatcher {
  return async (check, trajectory) => {
    const failed = (detail: string): CheckResult => ({ check, pass: false, detail });
    const review = submittedReview(trajectory);
    if (review === undefined) return failed("the reviewer did not submit a review (no submit_review call)");

    const llm = judgeLlm(check, opts);
    if (typeof llm === "string") return failed(llm);

    let scored: ReviewScore;
    try {
      scored = await scoreReview(llm, check, reviewCommentText(review));
    } catch (err) {
      return failed(`review judge failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const profile = check.profile ?? "core";
    const metrics = profileMetrics(check, profile, scored.matchedGolden, scored.fp);

    // When a verifier dropped findings, also score the reviewer's draft, so
    // the scorecard shows what verification cost in recall and saved in noise.
    const draft = submittedReview(trajectory, "draft");
    let draftMetrics: Record<string, number> = {};
    if (draft !== undefined && draft.findings.length > review.findings.length) {
      try {
        const d = await scoreReview(llm, check, reviewCommentText(draft));
        const m = profileMetrics(check, profile, d.matchedGolden, d.fp);
        draftMetrics = { "draft:tp": m.tp, "draft:fp": m.fp, "draft:fn": m.fn };
      } catch {
        // The draft score is diagnostic; the case score above stands.
      }
    } else if (draft !== undefined) {
      draftMetrics = { "draft:tp": metrics.tp, "draft:fp": metrics.fp, "draft:fn": metrics.fn };
    }
    const recall = metrics.tp + metrics.fn > 0 ? metrics.tp / (metrics.tp + metrics.fn) : 0;
    const minRecall = check.min_recall ?? 0;
    const detail =
      `${metrics.tp}/${metrics.tp + metrics.fn} golden found, ${metrics.fp} unmatched of ${scored.candidates} issues (${profile})` +
      (scored.judgeErrors > 0 ? `; ${scored.judgeErrors} judge call(s) failed` : "") +
      (scored.missed.length > 0 ? `; missed: ${scored.missed.map((m) => m.slice(0, 80)).join(" | ")}` : "");
    return {
      check,
      pass: recall >= minRecall,
      detail,
      metrics: {
        ...metrics,
        candidates: scored.candidates,
        ...(scored.judgeErrors > 0 ? { judge_errors: scored.judgeErrors } : {}),
        ...draftMetrics,
        ...crossRepoMetrics(check, profile, scored.matchedGolden, "cross:"),
        ...referenceMetrics(check, profile),
      },
    };
  };
}

/** The judge for a check, or an error message when its model is unknown. */
function judgeLlm(check: ReviewMatchCheck, opts: ReviewMatcherOptions): ReviewLlm | string {
  if (opts.llm !== undefined) return opts.llm;
  const spec = check.judge_model ?? (typeof opts.model === "string" ? opts.model : undefined);
  const model =
    spec !== undefined ? resolveModelId(spec) : typeof opts.model === "object" ? opts.model : resolveModelId(DEFAULT_REVIEW_JUDGE_MODEL);
  if (!model) return `unknown judge model \`${spec ?? DEFAULT_REVIEW_JUDGE_MODEL}\`. Use provider/model form.`;
  return opts.gateway !== undefined ? modelLlm(viaGateway(model, opts.gateway), opts.gateway.apiKey) : modelLlm(model, opts.apiKey);
}

/**
 * Score another tool's review comments against a case's golden comments,
 * with the same extract, dedup and judge steps. Importers use it to fill a
 * case's `reference` for tools Martian did not publish.
 */
export async function scoreReviewText(
  check: ReviewMatchCheck,
  commentText: string,
  opts: ReviewMatcherOptions = {},
): Promise<{ matched: number[]; fp: number; candidates: number }> {
  const llm = judgeLlm(check, opts);
  if (typeof llm === "string") throw new Error(llm);
  const scored = await scoreReview(llm, check, commentText);
  return { matched: scored.matchedGolden, fp: scored.fp, candidates: scored.candidates };
}

interface ReviewScore {
  candidates: number;
  /** Golden indexes the review found. */
  matchedGolden: number[];
  fp: number;
  missed: string[];
  judgeErrors: number;
}

async function scoreReview(llm: ReviewLlm, check: ReviewMatchCheck, commentText: string): Promise<ReviewScore> {
  // Martian skips extraction for reviews under 20 characters.
  const candidates = commentText.trim().length >= 20 ? await extractIssues(llm, commentText) : [];
  // Martian keys candidates by text, so identical issues count once.
  const unique = [...new Set(candidates)];
  const groups = unique.length >= 2 ? await dedupGroups(llm, unique) : unique.map((_, i) => [i]);
  const siblings = new Map<number, number[]>();
  for (const g of groups) for (const i of g) siblings.set(i, g.filter((j) => j !== i));

  const pairs = check.golden.flatMap((_, gi) => unique.map((_, ci) => ({ gi, ci })));
  let judgeErrors = 0;
  // Like Martian, a pair whose judge call fails counts as no match; the
  // error count rides along so a flaky run is visible.
  const verdicts = await mapLimit(pairs, JUDGE_CONCURRENCY, ({ gi, ci }) =>
    judgePair(llm, check.golden[gi].comment, unique[ci]).catch(() => {
      judgeErrors++;
      return { match: false, confidence: 0 };
    }),
  );
  const best = new Map<number, number>();
  const candidateMatched = new Set<number>();
  pairs.forEach(({ gi, ci }, k) => {
    const v = verdicts[k];
    if (!v.match || v.confidence <= (best.get(gi) ?? 0)) return;
    best.set(gi, v.confidence);
    candidateMatched.add(ci);
    for (const s of siblings.get(ci) ?? []) candidateMatched.add(s);
  });
  const matchedGolden = [...best.keys()].sort((a, b) => a - b);
  return {
    candidates: unique.length,
    matchedGolden,
    fp: unique.length - candidateMatched.size,
    missed: check.golden.filter((_, gi) => !best.has(gi)).map((g) => g.comment),
    judgeErrors,
  };
}

/** tp/fp/fn under a profile: golden comments outside it neither score nor count as missed. */
export function profileMetrics(
  check: ReviewMatchCheck,
  profile: ReviewProfile,
  matchedGolden: number[],
  fp: number,
): { tp: number; fp: number; fn: number } {
  const cats = REVIEW_PROFILE_CATEGORIES[profile];
  const matched = new Set(matchedGolden);
  let tp = 0;
  let fn = 0;
  check.golden.forEach((g, i) => {
    if (!cats.has(g.category)) return;
    if (matched.has(i)) tp++;
    else fn++;
  });
  return { tp, fp, fn };
}

function referenceMetrics(check: ReviewMatchCheck, profile: ReviewProfile): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [tool, ref] of Object.entries(check.reference ?? {})) {
    const m = profileMetrics(check, profile, ref.matched, ref.fp);
    out[`ref:${tool}:tp`] = m.tp;
    out[`ref:${tool}:fp`] = m.fp;
    out[`ref:${tool}:fn`] = m.fn;
    Object.assign(out, crossRepoMetrics(check, profile, ref.matched, `ref:${tool}:cross_`));
  }
  return out;
}

/** Found and missed cross-repo golden comments in the profile, as `<prefix>tp` and `<prefix>fn`. Empty when the case has none. */
function crossRepoMetrics(check: ReviewMatchCheck, profile: ReviewProfile, matchedGolden: number[], prefix: string): Record<string, number> {
  const cats = REVIEW_PROFILE_CATEGORIES[profile];
  const cross = check.golden.flatMap((g, i) => (g.cross_repo === true && cats.has(g.category) ? [i] : []));
  if (cross.length === 0) return {};
  const tp = cross.filter((i) => matchedGolden.includes(i)).length;
  return { [`${prefix}tp`]: tp, [`${prefix}fn`]: cross.length - tp };
}

// Replacer functions: a `$&` or `$'` inside review text must stay literal.
export async function extractIssues(llm: ReviewLlm, comment: string): Promise<string[]> {
  const parsed = await callJson(llm, EXTRACT_SYSTEM, EXTRACT_PROMPT.replace("{comment}", () => comment), 3);
  if (!isRecord(parsed) || !Array.isArray(parsed.issues)) throw new Error("extract step returned no `issues` array");
  return parsed.issues.filter((x): x is string => typeof x === "string" && x.length > 0);
}

async function dedupGroups(llm: ReviewLlm, candidates: string[]): Promise<number[][]> {
  const numbered = candidates.map((c, i) => `${i}. ${c}`).join("\n");
  try {
    const parsed = await callJson(llm, DEDUP_SYSTEM, DEDUP_PROMPT.replace("{candidates}", () => numbered), 3);
    const groups = isRecord(parsed) && Array.isArray(parsed.groups) ? parsed.groups : undefined;
    if (groups && validGroups(groups, candidates.length)) return groups;
  } catch {
    // Martian falls back to all singletons when dedup fails.
  }
  return candidates.map((_, i) => [i]);
}

function validGroups(groups: unknown[], n: number): groups is number[][] {
  const seen = new Set<number>();
  for (const g of groups) {
    if (!Array.isArray(g)) return false;
    for (const i of g) {
      if (!Number.isInteger(i) || i < 0 || i >= n || seen.has(i)) return false;
      seen.add(i);
    }
  }
  return seen.size === n;
}

export async function judgePair(llm: ReviewLlm, golden: string, candidate: string): Promise<{ match: boolean; confidence: number }> {
  const prompt = JUDGE_PROMPT.replace("{golden_comment}", () => golden).replace("{candidate}", () => candidate);
  const parsed = await callJson(llm, JUDGE_SYSTEM, prompt, 5);
  if (!isRecord(parsed)) throw new Error("judge step returned a non-object");
  return {
    match: parsed.match === true,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
  };
}

/** Call and parse JSON, tolerating a fenced block, with Martian's retry counts. */
async function callJson(llm: ReviewLlm, system: string, prompt: string, attempts: number): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      let text = (await llm(system, prompt)).trim();
      const fenced = /^```(?:json)?\s*([\s\S]*?)```/.exec(text);
      if (fenced) text = fenced[1].trim();
      return JSON.parse(text);
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function modelLlm(model: Model<string>, apiKey: string | undefined): ReviewLlm {
  return async (system, prompt) => {
    const result = await completeSimple(
      model,
      { systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
      { apiKey, temperature: 0, maxRetries: 2, maxRetryDelayMs: 30_000 },
    );
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw new Error(`judge call failed (${result.stopReason}): ${result.errorMessage ?? "no error message"}`);
    }
    return result.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
