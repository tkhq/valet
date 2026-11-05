/**
 * The `review-pull-request` event handler: reviews each push to a pull
 * request in a child session and keeps one summary review per PR, edited in
 * place. The first review covers the whole PR. A later push gets a review of
 * only the new commits, and a recheck of earlier findings in the files those
 * commits changed; a recheck that refutes a finding marks it fixed.
 *
 * The plugin store keeps pointers only (`PullPointers`). The finding text
 * lives in the review comments on GitHub and is read back from them.
 */
import { Type, type Static, type TSchema } from "typebox";
import type { PluginChild, PluginEvent, PluginEventContext, PluginEventHandler, PluginThreadRef } from "@valet/engine";
import { cutPatch, type PullRequestDiff } from "./git.js";
import { githubClient, GitHubError, type GitHubClient, type PullFile, type ReviewComment } from "./github.js";
import { sameIssue } from "./incremental.js";
import { commentableLines } from "./linemap.js";
import { buildReviewPrompt } from "./prompt.js";
import {
  parseFindings,
  renderFixedComment,
  renderForkNotice,
  renderInlineComment,
  renderSummary,
  type PostedFinding,
} from "./render.js";
import { ReviewSchema, type Finding, type Review } from "./types.js";
import { anchorProblems, lineCount } from "./review.js";
import { buildVerifierPrompt, decideFinding, VerdictSchema, type Verdict } from "./verify.js";
import type { ReviewRound } from "./state.js";

export const REVIEWER_ROLE = "pr-reviewer";
export const VERIFIER_ROLE = "pr-verifier";

const SEVERITY_ORDER = ["low", "medium", "high", "critical"] as const;

export const ReviewSettingsSchema = Type.Object(
  {
    instructions: Type.String({
      default: "",
      maxLength: 8000,
      description: "Extra review instructions for this repository, such as conventions to check or areas to skip.",
    }),
    excludePaths: Type.Array(Type.String({ minLength: 1 }), {
      default: [],
      maxItems: 100,
      description: "Globs of paths not to review, such as `**/*.lock` or `dist/`. A pattern without a slash matches at any depth.",
    }),
    minSeverity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")], {
      default: "low",
      description: "Post only findings at this severity or above.",
    }),
    reviewDrafts: Type.Boolean({ default: false, description: "Review draft pull requests too." }),
    verify: Type.Boolean({
      default: false,
      description: "Check each new finding in its own verifier child before posting. Rechecks of earlier findings run either way.",
    }),
    model: Type.String({
      default: "anthropic/claude-sonnet-5-5",
      description: "provider/model for the reviewer and verifier children.",
    }),
  },
  { additionalProperties: false },
);
export type ReviewSettings = Static<typeof ReviewSettingsSchema>;

/** One finding's pointer: where it is and where its text lives on GitHub. */
export interface FindingPointer {
  id: string;
  path: string;
  line: number;
  /** The inline review comment. Absent: the finding is in the summary review's body. */
  commentId?: number;
  /** The GraphQL id of the comment's review thread, once known. */
  threadId?: string;
  /**
   * `resolved`: a later commit fixed it, and its thread is resolved.
   * `dismissed`: a person resolved its thread or deleted its comment. It is
   * never posted again.
   */
  status: "open" | "resolved" | "dismissed";
  /** The head that fixed it. */
  fixedIn?: string;
}

/** Everything the plugin store keeps for one pull request. */
export interface PullPointers {
  version: 1;
  /** The summary review, edited in place on each run. */
  reviewId?: number;
  lastReviewedHead?: string;
  findings: FindingPointer[];
  nextId: number;
  /** The latest 100 completed reviews, oldest first. */
  rounds?: ReviewRound[];
}

export const POINTERS_COLLECTION = "pulls";

/** Children of one kind in flight at once. */
const CHILD_CONCURRENCY = 4;
/** Findings verified per run; the rest are posted as unverified. */
const MAX_VERIFIED = 12;
const DIFF_BUDGET = 150_000;
const FILE_DIFF_CHARS = 30_000;

export interface ReviewHandlerOptions {
  /** For tests: the fetch GitHub calls go through. */
  fetch?: typeof fetch;
}

export function createReviewHandler(opts: ReviewHandlerOptions = {}): PluginEventHandler {
  return {
    id: "review-pull-request",
    description: "Review each push to a pull request and keep one review per pull request, edited in place.",
    events: ["github.pull_request.opened", "github.pull_request.synchronize", "github.pull_request.ready_for_review", "github.pull_request.reopened"],
    configSchema: ReviewSettingsSchema,
    concurrency: "supersede",
    handle: (event, ctx) => reviewPullRequestEvent(event, ctx, opts),
  };
}

interface PullTarget {
  owner: string;
  repo: string;
  number: number;
}

/** The pull request an event is about, from its repo ref and payload. */
export function pullTarget(event: Pick<PluginEvent, "refs" | "payload">): PullTarget | null {
  const [owner, repo, ...rest] = (event.refs.repo ?? "").split("/");
  if (!owner || !repo || rest.length > 0) return null;
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || !("pull_request" in payload)) return null;
  const pr = payload.pull_request;
  if (typeof pr !== "object" || pr === null || !("number" in pr) || typeof pr.number !== "number") return null;
  return { owner, repo, number: pr.number };
}

async function reviewPullRequestEvent(event: PluginEvent, ctx: PluginEventContext, opts: ReviewHandlerOptions): Promise<void> {
  const settings = ctx.config as ReviewSettings; // the host checked it against ReviewSettingsSchema and filled defaults
  const target = pullTarget(event);
  if (!target) {
    console.warn("pr-review: event names no pull request", { eventId: event.id, key: event.key });
    return;
  }
  const repoName = `${target.owner}/${target.repo}`;
  const slug = `${repoName}#${target.number}`;
  const token = await ctx.appToken("github", { owner: target.owner });
  if (!token) {
    throw new Error(`The GitHub App is not installed for ${target.owner}. Install it on ${target.owner} in Settings, then retry the delivery.`);
  }
  const gh = githubClient({ token, ...target, ...(opts.fetch ? { fetch: opts.fetch } : {}), signal: ctx.signal });

  // The event's head can be stale: GitHub timestamps have one-second
  // resolution, so read the PR's current state.
  const pr = await gh.pull();
  const head = pr.head.sha;
  if (pr.state !== "open") return log(slug, `skipped: the pull request is ${pr.state}`);
  if (pr.draft && !settings.reviewDrafts) return log(slug, "skipped: draft pull request");

  const stored = await ctx.store.get<PullPointers>(POINTERS_COLLECTION, slug);
  const prior = stored?.doc;
  if (prior?.lastReviewedHead === head) return log(slug, `skipped: ${head.slice(0, 7)} is already reviewed`);

  const save = async (next: PullPointers): Promise<void> => {
    await ctx.store.put(POINTERS_COLLECTION, slug, next, stored ? { ifRevision: stored.revision } : undefined);
  };

  if (pr.head.repo?.full_name !== pr.base.repo.full_name) {
    // A child cannot check out a fork's head yet (refs/pull/N/head).
    ctx.signal.throwIfAborted();
    const notice = renderForkNotice(head);
    const reviewId = prior?.reviewId !== undefined && (await gh.review(prior.reviewId))
      ? (await gh.updateReview(prior.reviewId, notice)).id
      : (await gh.createReview({ commitId: head, body: notice, comments: [] })).id;
    await save({ version: 1, reviewId, lastReviewedHead: head, findings: prior?.findings ?? [], nextId: prior?.nextId ?? 1, ...(prior?.rounds ? { rounds: prior.rounds } : {}) });
    return log(slug, "skipped: pull request from a fork");
  }

  const files = await gh.pullFiles();
  const reviewed = files.filter((f) => !excluded(f.filename, settings.excludePaths));
  const comparison = await gh.compare(pr.base.sha, head);
  if (!comparison) throw new Error(`GitHub cannot compare ${pr.base.sha.slice(0, 7)} with ${head.slice(0, 7)} on ${slug}. Retry the delivery after the push settles.`);
  const mergeBase = comparison.merge_base_commit.sha;

  // A follow-up review needs the last reviewed head in the new head's history.
  // A force-push or rebase drops it, and the review covers the whole PR again.
  let from: string | undefined;
  let changedSince: Set<string> | undefined;
  if (prior?.lastReviewedHead) {
    const increment = await gh.compare(prior.lastReviewedHead, head);
    if (increment?.status === "ahead") {
      from = prior.lastReviewedHead;
      changedSince = new Set((increment.files ?? []).map((f) => f.filename));
    }
  }

  const open = await recoverFindings(gh, prior);
  const thread = await ctx.threads.ensure(slug, { title: `Review ${slug}` });
  const dispatch = (label: string): string => `${event.id}:${head.slice(0, 12)}:${label}`;
  const prDiff = (await gh.compareDiff(mergeBase, head)) ?? undefined;

  // 1. Recheck open findings whose files changed. Only a refutation fixes one.
  const toRecheck = open.live.filter((f) => changedSince === undefined || changedSince.has(f.path));
  const stillOpen = open.live.filter((f) => !toRecheck.includes(f));
  const fixed: { finding: OpenFinding; reason: string }[] = [];
  const recheck = forEachLimit(toRecheck, CHILD_CONCURRENCY, async (f) => {
    const verdict = await runVerifier(ctx, thread, {
      dispatchId: dispatch(`recheck:${f.id}`),
      model: settings.model,
      prompt: buildVerifierPrompt({ title: pr.title, base: mergeBase, head, finding: f, fileDiff: fileDiff(prDiff, f.path), finish: VERDICT_FINISH, ...(prior?.lastReviewedHead ? { recheckFrom: prior.lastReviewedHead } : {}) }),
      title: `Recheck ${f.id} at ${head.slice(0, 7)}`,
      repo: repoName,
      head,
    });
    if (verdict?.verdict === "refuted") fixed.push({ finding: f, reason: verdict.counter_evidence || verdict.refutation_reason || "fixed" });
    else stillOpen.push({ ...f, line: verdict?.current_line ?? f.line });
  });

  // 2. Review the PR, or only the new commits, told what is already open.
  const review = (async () => {
    const diff = from !== undefined ? await incrementDiff(gh, from, head, reviewed) : prDiffFor(prDiff, reviewed, mergeBase, head);
    const memory = await teamNotes(ctx, repoName);
    const child = await ctx.threads.spawnChild(
      thread,
      {
        prompt: reviewerPrompt({
          review: buildReviewPrompt({
            title: pr.title,
            body: pr.body ?? "",
            base: mergeBase,
            head,
            diff,
            ...(from !== undefined ? { increment: { from } } : {}),
            knownFindings: [...open.live, ...open.dismissed.filter(hasTitle)].map((f) => ({ path: f.path, line: f.line, title: f.title })),
          }),
          instructions: settings.instructions,
          excludePaths: settings.excludePaths,
          memory,
        }),
        title: `Review ${head.slice(0, 7)}`,
        role: REVIEWER_ROLE,
        model: settings.model,
        repo: repoName,
        ref: head,
      },
      { dispatchId: dispatch("review") },
    );
    const result = await ctx.threads.awaitChild(child, { resultSchema: ReviewSchema });
    if (result.outcome !== "completed" || result.output === undefined) {
      throw new Error(`The review child for ${slug} at ${head.slice(0, 7)} ended without a review (${result.outcome}${result.error ? `: ${result.error}` : ""}). Open the plugin thread to see why, then retry the delivery.`);
    }
    return result.output as Review; // validated against ReviewSchema by awaitChild
  })();

  const [draft] = await Promise.all([review, recheck]);

  // 3. Drop findings on a line that does not exist at HEAD: the reviewer
  // child answers through awaitChild, so no tool refused them.
  const inPaths = draft.findings.filter((f) => !excluded(f.path, settings.excludePaths));
  const lineCounts = await headLineCounts(gh, files, inPaths.map((f) => f.path), head);
  const misplaced = new Set(anchorProblems(inPaths, lineCounts).map((p) => p.index));
  if (misplaced.size > 0) log(slug, `dropped ${misplaced.size} finding(s) anchored to a line that does not exist at ${head.slice(0, 7)}`);
  const candidates = inPaths.filter((_, i) => !misplaced.has(i));

  // 4. With `verify` on, check each new finding in a fresh child; refuted ones are dropped.
  const kept: Finding[] = [];
  await forEachLimit(candidates.map((f, i) => ({ f, i })), CHILD_CONCURRENCY, async ({ f, i }) => {
    if (!settings.verify || i >= MAX_VERIFIED) return void kept.push(f);
    const verdict = await runVerifier(ctx, thread, {
      dispatchId: dispatch(`verify:${i}`),
      model: settings.model,
      prompt: buildVerifierPrompt({ title: pr.title, base: mergeBase, head, finding: f, fileDiff: fileDiff(prDiff, f.path), finish: VERDICT_FINISH }),
      title: `Verify finding ${i + 1} at ${head.slice(0, 7)}`,
      repo: repoName,
      head,
    });
    const decision = decideFinding(f, verdict, await gh.fileText(f.path, head));
    if (decision.keep) kept.push(f);
  });

  // 5. New findings: drop repeats of open ones and those below the minimum severity, then assign ids.
  const minRank = SEVERITY_ORDER.indexOf(settings.minSeverity);
  let nextId = prior?.nextId ?? 1;
  const posted: PostedFinding[] = [];
  const reopened: OpenFinding[] = [];
  let hidden = draft.findings.length - candidates.length;
  for (const f of draft.findings.filter((x) => kept.includes(x))) {
    if (SEVERITY_ORDER.indexOf(f.severity) < minRank) {
      hidden++;
      continue;
    }
    if ([...stillOpen, ...posted].some((o) => sameIssue(o, f))) continue;
    // A finding a person dismissed is never posted again.
    if (open.dismissed.some((d) => (hasTitle(d) ? sameIssue(d, f) : d.path === f.path && Math.abs(d.line - f.line) <= 3))) continue;
    // A fixed finding that came back reopens its own thread.
    const back = open.fixed.find((o) => !reopened.some((r) => r.id === o.id) && sameIssue(o, f));
    if (back) {
      reopened.push({ ...f, id: back.id, line: f.line, ...(back.commentId !== undefined ? { commentId: back.commentId } : {}), ...(back.threadId !== undefined ? { threadId: back.threadId } : {}) });
      continue;
    }
    posted.push({ ...f, id: `f${nextId++}` });
  }

  // 6. Map new findings to diff lines. GitHub refuses a comment on a line outside the diff.
  const anchorable = new Map(files.map((f) => [f.filename, commentableLines(f.patch ?? "")]));
  let inline = posted.filter((f) => anchorable.get(f.path)?.has(f.line) ?? false);
  let outside = posted.filter((f) => !inline.includes(f));

  // 7. Post: one summary review, edited in place, plus inline comments.
  ctx.signal.throwIfAborted();
  const summaryOf = (): string =>
    renderSummary({
      head,
      ...(from !== undefined ? { incrementFrom: from } : {}),
      summary: draft.summary,
      confidence: draft.confidence,
      inline: [...stillOpen.filter((f) => f.commentId !== undefined), ...reopened, ...inline],
      outsideDiff: [...stillOpen.filter((f) => f.commentId === undefined), ...outside],
      fixed: fixed.map(({ finding }) => ({ finding, sha: head })),
      hidden,
    });

  const summaryReview = prior?.reviewId !== undefined ? await gh.review(prior.reviewId) : null;
  let reviewId = summaryReview?.id;
  let inlineReviewId: number | undefined;
  /** Post the inline findings in one review with `body`. A 422 (a line GitHub cannot resolve) moves them all to the summary. */
  const postInline = async (body: string): Promise<number | undefined> => {
    try {
      return (await gh.createReview({ commitId: head, body, comments: inline.map((f) => ({ path: f.path, line: f.line, side: "RIGHT", body: renderInlineComment(f) })) })).id;
    } catch (err) {
      if (!(err instanceof GitHubError) || err.status !== 422 || inline.length === 0) throw err;
      console.warn(`pr-review ${slug}: GitHub refused the inline comments, so the summary carries them`, err.message);
      outside = [...outside, ...inline];
      inline = [];
      return undefined;
    }
  };
  if (reviewId === undefined) {
    inlineReviewId = await postInline(summaryOf());
    reviewId = inlineReviewId ?? (await gh.createReview({ commitId: head, body: summaryOf(), comments: [] })).id;
  } else {
    // New findings on a later push come as threads in a review with no
    // body. GitHub wraps every inline comment in a review, so one review
    // per push adds the fewest objects; the summary stays the only body.
    if (inline.length > 0) inlineReviewId = await postInline("");
    await gh.updateReview(reviewId, summaryOf());
  }

  const commentIds = inlineReviewId !== undefined && inline.length > 0 ? await newCommentIds(gh, inlineReviewId) : new Map<string, number>();
  const warn = (what: string) => (err: unknown): void => {
    // The summary still carries the state; a failed thread edit must not fail the review.
    console.warn(`pr-review ${slug}: ${what} failed`, err instanceof Error ? err.message : err);
  };
  for (const { finding, reason } of fixed) {
    if (finding.commentId === undefined) continue;
    const comment = open.comments.get(finding.commentId);
    if (!comment) continue;
    await gh.updateComment(finding.commentId, renderFixedComment(comment.body, head, reason)).catch(warn(`marking ${finding.id} fixed`));
    if (finding.threadId) await gh.setThreadResolved(finding.threadId, true).catch(warn(`resolving the thread of ${finding.id}`));
  }
  for (const f of reopened) {
    if (f.commentId === undefined) continue;
    await gh.updateComment(f.commentId, renderInlineComment(f)).catch(warn(`reopening ${f.id}`));
    if (f.threadId) await gh.setThreadResolved(f.threadId, false).catch(warn(`unresolving the thread of ${f.id}`));
  }

  // 8. Save the new pointers.
  const byId = new Map<string, FindingPointer>((prior?.findings ?? []).map((p) => [p.id, p]));
  for (const d of open.dismissed) {
    const p = byId.get(d.id);
    if (p) byId.set(d.id, { ...p, status: "dismissed" });
  }
  for (const f of stillOpen) byId.set(f.id, pointer(f, "open", f));
  for (const { finding } of fixed) byId.set(finding.id, { ...pointer(finding, "resolved", finding), fixedIn: head });
  for (const f of reopened) byId.set(f.id, pointer(f, "open", f));
  for (const f of inline) {
    const commentId = commentIds.get(f.id);
    byId.set(f.id, pointer(f, "open", commentId !== undefined ? { commentId } : {}));
  }
  for (const f of outside) byId.set(f.id, pointer(f, "open", {}));
  const round: ReviewRound = {
    head,
    mode: from !== undefined ? "incremental" : "full",
    at: new Date().toISOString(),
    newFindings: posted.map(f => f.id),
    resolved: fixed.map(({ finding }) => finding.id),
  };
  await save({ version: 1, reviewId, lastReviewedHead: head, findings: [...byId.values()], nextId, rounds: [...(prior?.rounds ?? []), round].slice(-100) });
  log(slug, `reviewed ${head.slice(0, 7)} (${from ? "follow-up" : "full"}): ${posted.length} new, ${fixed.length} fixed, ${reopened.length} reopened, ${stillOpen.length} still open`);
}

type OpenFinding = PostedFinding & { commentId?: number; threadId?: string };
/** A finding a person dismissed. Its text is gone when they deleted the comment. */
type DismissedFinding = Pick<FindingPointer, "id" | "path" | "line"> & { title?: string };

const hasTitle = (d: DismissedFinding): d is DismissedFinding & { title: string } => d.title !== undefined;

/**
 * The PR's findings, read back from GitHub: open ones with their text,
 * fixed ones that a later finding can reopen, and the ones a person
 * dismissed by resolving the thread or deleting the comment.
 */
async function recoverFindings(
  gh: GitHubClient,
  prior: PullPointers | undefined,
): Promise<{ live: OpenFinding[]; fixed: OpenFinding[]; dismissed: DismissedFinding[]; comments: Map<number, ReviewComment> }> {
  const pointers = prior?.findings ?? [];
  const comments = new Map<number, ReviewComment>();
  const threads = new Map<number, { id: string; isResolved: boolean }>();
  if (pointers.length === 0) return { live: [], fixed: [], dismissed: [], comments };
  if (pointers.some((p) => p.commentId !== undefined)) {
    for (const c of await gh.reviewComments()) comments.set(c.id, c);
    for (const t of await gh.reviewThreads()) if (t.commentId !== null) threads.set(t.commentId, t);
  }
  const summary = prior?.reviewId !== undefined ? parseFindings((await gh.review(prior.reviewId))?.body ?? "") : new Map();
  const live: OpenFinding[] = [];
  const fixed: OpenFinding[] = [];
  const dismissed: DismissedFinding[] = [];
  for (const p of pointers) {
    const text = p.commentId !== undefined ? parseFindings(comments.get(p.commentId)?.body ?? "").get(p.id) : summary.get(p.id);
    const thread = p.commentId !== undefined ? threads.get(p.commentId) : undefined;
    const where = { path: p.path, line: p.line, ...(p.commentId !== undefined ? { commentId: p.commentId } : {}), ...((thread?.id ?? p.threadId) ? { threadId: thread?.id ?? p.threadId } : {}) };
    const gone = !text;
    // Valet resolves a thread only when it marks the finding fixed, so an
    // open finding in a resolved thread was resolved by a person.
    if (p.status === "dismissed" || gone || (p.status === "open" && thread?.isResolved)) {
      dismissed.push({ id: p.id, path: p.path, line: p.line, ...(text ? { title: text.title } : {}) });
    } else if (p.status === "open") {
      live.push({ ...text, ...where });
    } else if (p.commentId !== undefined) {
      fixed.push({ ...text, ...where });
    }
  }
  return { live, fixed, dismissed, comments };
}

/** Inline comment ids of one review, keyed by the finding id in each marker. */
async function newCommentIds(gh: GitHubClient, reviewId: number): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const c of await gh.reviewComments()) {
    if (c.pull_request_review_id !== reviewId) continue;
    for (const id of parseFindings(c.body).keys()) ids.set(id, c.id);
  }
  return ids;
}

function pointer(f: Pick<PostedFinding, "id" | "path" | "line">, status: FindingPointer["status"], ids: { commentId?: number; threadId?: string }): FindingPointer {
  return { id: f.id, path: f.path, line: f.line, status, ...(ids.commentId !== undefined ? { commentId: ids.commentId } : {}), ...(ids.threadId !== undefined ? { threadId: ids.threadId } : {}) };
}

async function runVerifier(
  ctx: PluginEventContext,
  thread: PluginThreadRef,
  req: { dispatchId: string; model: string; prompt: string; title: string; repo: string; head: string },
): Promise<Verdict | undefined> {
  const child: PluginChild = await ctx.threads.spawnChild(
    thread,
    { prompt: req.prompt, title: req.title, role: VERIFIER_ROLE, model: req.model, repo: req.repo, ref: req.head },
    { dispatchId: req.dispatchId },
  );
  const result = await ctx.threads.awaitChild(child, { resultSchema: VerdictSchema });
  // No verdict keeps the finding (`decideFinding` treats it as unverified).
  return result.outcome === "completed" ? (result.output as Verdict | undefined) : undefined; // validated against VerdictSchema by awaitChild
}

/** The role text after the reviewer's own prompt: children answer with JSON, not a submit tool. */
export const CHILD_ANSWER_NOTE = (tool: string): string =>
  `This session has no \`${tool}\` tool. Where these instructions say to call \`${tool}\`, end your final message with the result as one \`\`\`json code block instead. Use only read-only commands: do not edit files, commit, or push.`;

/** The instruction that asks a child for JSON the schema accepts. */
export function answerFormat(schema: TSchema): string {
  return ["End your final message with one ```json code block that matches this JSON Schema.", "```json", JSON.stringify(schema, null, 2), "```"].join("\n");
}

export function reviewerPrompt(input: { review: string; instructions: string; excludePaths: string[]; memory: string }): string {
  return [
    input.review,
    ...(input.instructions.trim() ? ["", "## Instructions from the repository owner", input.instructions.trim()] : []),
    ...(input.excludePaths.length > 0 ? ["", "## Paths not to review", ...input.excludePaths.map((p) => `- \`${p}\``)] : []),
    ...(input.memory ? ["", "## Team notes (from the team's memory)", input.memory] : []),
    "",
    answerFormat(ReviewSchema),
  ].join("\n");
}

/** How a verifier child ends: JSON the verdict schema accepts, not a submit tool. */
const VERDICT_FINISH = `Check the claim, then give your verdict.\n\n${answerFormat(VerdictSchema)}`;

/**
 * Line count at HEAD of each path a finding names, for `anchorProblems`.
 * Only files the PR adds or changes count; a file GitHub will not return
 * as text (a submodule) counts as one line.
 */
async function headLineCounts(gh: GitHubClient, files: PullFile[], paths: string[], head: string): Promise<Map<string, number>> {
  const present = new Set(files.filter((f) => f.status !== "removed").map((f) => f.filename));
  const counts = new Map<string, number>();
  for (const path of new Set(paths)) {
    if (!present.has(path)) continue;
    const text = await gh.fileText(path, head);
    counts.set(path, text === undefined ? 1 : lineCount(text));
  }
  return counts;
}

/** The PR diff limited to the reviewed files, cut to the budget. */
function prDiffFor(patch: string | undefined, files: PullFile[], base: string, head: string): PullRequestDiff {
  const names = files.map((f) => f.filename);
  const stat = files.map((f) => `${f.filename} | +${f.additions} -${f.deletions}`).join("\n");
  if (patch === undefined) return unrendered(stat, names, base, head);
  return { stat, files: names, ...cutPatch(onlyFiles(patch, new Set(names)), DIFF_BUDGET) };
}

/** The diff of the new commits, limited to the PR's reviewed files: a merge of the base branch is not new PR code. */
async function incrementDiff(gh: GitHubClient, from: string, head: string, files: PullFile[]): Promise<PullRequestDiff> {
  const names = new Set(files.map((f) => f.filename));
  const patch = await gh.compareDiff(from, head);
  const touched = patch === null ? [...names] : [...names].filter((n) => patch.includes(` b/${n}\n`));
  const stat = touched.join("\n");
  if (patch === null) return unrendered(stat, touched, from, head);
  return { stat, files: touched, ...cutPatch(onlyFiles(patch, names), DIFF_BUDGET) };
}

function unrendered(stat: string, files: string[], base: string, head: string): PullRequestDiff {
  return { stat, files, truncated: true, patch: `# GitHub did not render this diff. Run \`git diff ${base.slice(0, 12)} ${head.slice(0, 12)}\` in the working directory.\n` };
}

/** The file sections of a unified diff whose new path is in `names`. */
export function onlyFiles(patch: string, names: Set<string>): string {
  return patch
    .split(/^(?=diff --git )/m)
    .filter((chunk) => {
      const m = /^diff --git a\/.* b\/(.*)$/m.exec(chunk);
      return m !== null && names.has(m[1]);
    })
    .join("");
}

function fileDiff(patch: string | undefined, path: string): string {
  if (patch === undefined) return "";
  const one = onlyFiles(patch, new Set([path]));
  return one.length > FILE_DIFF_CHARS ? `${one.slice(0, FILE_DIFF_CHARS)}\n# (diff cut; run git diff for the rest)\n` : one;
}

/** Memory entries about this repository, for the reviewer's prompt. */
async function teamNotes(ctx: PluginEventContext, repo: string): Promise<string> {
  const hits = await ctx.memory.search(repo, { limit: 5 });
  return hits.map((h) => `- ${h.title}: ${h.snippet.replace(/\s+/g, " ").trim()}`).join("\n");
}

/**
 * Whether `path` matches one of the globs. `**` matches across directories,
 * `*` and `?` stay within one. A pattern without a slash matches at any
 * depth; a trailing slash matches everything under that directory.
 */
export function excluded(path: string, patterns: readonly string[]): boolean {
  return patterns.some((raw) => {
    let p = raw.trim().replace(/^\.?\//, "");
    if (p.endsWith("/")) p += "**";
    if (!p.includes("/")) p = `**/${p}`;
    let re = "";
    for (let i = 0; i < p.length; i++) {
      const ch = p[i];
      if (ch === "*" && p[i + 1] === "*") {
        const slash = p[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else if (ch === "*") re += "[^/]*";
      else if (ch === "?") re += "[^/]";
      else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`).test(path);
  });
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

function log(slug: string, message: string): void {
  console.info(`pr-review ${slug}: ${message}`);
}
