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
import { githubClient, GitHubError, type GitHubClient, type PullFile, type PullRequest, type ReviewComment, type ReviewThread } from "./github.js";
import { matchesGlob } from "./context/glob.js";
import { consolidateFindings } from "./consolidate.js";
import { confidentEnough, mergeFindings } from "./pipeline.js";
import { gatherForReview, noteBestEffort, renderConsolidation, type StageOutcome } from "./stages.js";
import { sameIssue } from "./incremental.js";
import { commentableLines, nearestCommentableLine } from "./linemap.js";
import { buildReviewPrompt, type ReviewFocus } from "./prompt.js";
import {
  parseFindings,
  renderFixedComment,
  renderForkNotice,
  renderWithdrawnComment,
  renderShadowNotice,
  renderShadowReview,
  renderInlineComment,
  renderSummary,
  type PostedFinding,
} from "./render.js";
import { ReviewSchema, type Finding, type Review } from "./types.js";
import { anchorProblems, lineCount } from "./review.js";
import { buildVerifierPrompt, decideFinding, refutationCitesRules, refutationGrounded, VerdictSchema, type Verdict } from "./verify.js";
import type { ReviewRound } from "./state.js";

export const REVIEWER_ROLE = "pr-reviewer";

/** The role of a reviewer child limited to one defect class (see FOCUS_PROMPTS). */
export function focusRole(focus: ReviewFocus): string {
  return `${REVIEWER_ROLE}-${focus}`;
}
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
    shadow: Type.Boolean({
      default: false,
      description: "Record each review in the plugin thread only. Nothing is posted on GitHub.",
    }),
    verify: Type.Boolean({
      default: false,
      description: "Check each new finding in its own verifier child before posting. Rechecks of earlier findings run either way.",
    }),
    model: Type.String({
      default: "anthropic/claude-sonnet-5-5",
      description: "provider/model for the reviewer and verifier children.",
    }),
    riskPaths: Type.Array(Type.String({ minLength: 1 }), {
      default: [],
      maxItems: 100,
      description: "Globs of paths where a defect costs the most in this repository, such as `deploy/**` or `**/rollouts/*.yaml`. A diff over the budget keeps these files first, with auth, keys, migrations and access-control paths.",
    }),
    focuses: Type.Array(Type.Union([Type.Literal("failure"), Type.Literal("concurrency"), Type.Literal("tests")]), {
      default: [],
      maxItems: 3,
      uniqueItems: true,
      description: "Extra reviewer children, each limited to one defect class: `failure` (failure paths and attackers), `concurrency` (races and performance), `tests` (tests, contracts and false text). Each one adds about one review's cost. Empty: the general review only.",
    }),
    focusMinConfidence: Type.Number({
      default: 0.7,
      minimum: 0,
      maximum: 1,
      description: "Drop findings from the `focuses` children rated below this confidence (0-1). Findings from the general review are not affected.",
    }),
    contextBudget: Type.Integer({
      default: 12000,
      minimum: 0,
      maximum: 100000,
      description: "Tokens of context gathered before the review: repository conventions, domain notes, definitions, callers, tests and team notes. 0 turns it off.",
    }),
  },
  { additionalProperties: false },
);
export type ReviewSettings = Static<typeof ReviewSettingsSchema>;

/** One finding's pointer: where it is and where its text lives on GitHub. */
export interface FindingPointer {
  id: string;
  path: string;
  /** In the HEAD file, or in the BASE file when `side` is LEFT. */
  line: number;
  /** LEFT: the finding names a line the PR deletes. Absent: RIGHT. */
  side?: "LEFT";
  /** The inline review comment. Absent: the finding is in the summary review's body. */
  commentId?: number;
  /** The GraphQL id of the comment's review thread, once known. */
  threadId?: string;
  /**
   * `resolved`: a recheck refuted it, and its thread is resolved. `fixedIn`
   * says a later commit changed its code; `withdrawnAt` says the code did
   * not change, so the reviewer withdrew its own claim.
   * `dismissed`: a person resolved its thread or deleted its comment. It is
   * never posted again.
   */
  status: "open" | "resolved" | "dismissed";
  /** The head that fixed it. */
  fixedIn?: string;
  /** The head at which the reviewer withdrew it without a code change. */
  withdrawnAt?: string;
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
  /** Temporary retry journal, cleared after all GitHub comment/thread edits succeed. */
  pending?: {
    head: string;
    round: ReviewRound;
    updates: { pointer: FindingPointer & { commentId: number }; body: string }[];
  };
}

export const POINTERS_COLLECTION = "pulls";

/**
 * The event key of a review a person asked for in Valet (`POST
 * /api/code-review/runs`). Its payload carries `valet` options. Only this
 * key's options count: a webhook payload never sets them.
 */
export const MANUAL_REVIEW_EVENT = "github.pull_request.valet_review_requested";

/** Options of a review a person asked for. */
export interface ManualReviewOptions {
  /** Record the review in the plugin thread only. */
  shadow?: boolean;
  /** Review the files at this commit instead of the PR head (a merged or closed PR). */
  commit?: string;
}

/** The options of a manual review event, or undefined for a webhook event. */
export function manualReviewOptions(event: Pick<PluginEvent, "key" | "payload">): ManualReviewOptions | undefined {
  if (event.key !== MANUAL_REVIEW_EVENT) return undefined;
  const payload = event.payload;
  const valet = typeof payload === "object" && payload !== null && "valet" in payload ? payload.valet : undefined;
  if (typeof valet !== "object" || valet === null) return {};
  return {
    ...("shadow" in valet && valet.shadow === true ? { shadow: true } : {}),
    ...("commit" in valet && typeof valet.commit === "string" && /^[0-9a-f]{7,40}$/.test(valet.commit) ? { commit: valet.commit } : {}),
  };
}

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
  const manual = manualReviewOptions(event);
  if (settings.shadow || manual?.shadow) return shadowReview(event, ctx, gh, pr, settings, { slug, repoName, commit: manual?.commit });
  if (pr.state !== "open") return log(slug, `skipped: the pull request is ${pr.state}`);
  if (pr.draft && !settings.reviewDrafts) return log(slug, "skipped: draft pull request");

  let stored = await ctx.store.get<PullPointers>(POINTERS_COLLECTION, slug);
  let prior = stored?.doc;

  const save = async (next: PullPointers): Promise<void> => {
    stored = await ctx.store.put(POINTERS_COLLECTION, slug, next, stored ? { ifRevision: stored.revision } : undefined);
  };
  if (prior?.pending) prior = await finishPendingUpdates(gh, prior, save, ctx.signal);
  // A person who asks for a review gets one, even of a head already reviewed.
  if (manual === undefined && prior?.lastReviewedHead === head) return log(slug, `skipped: ${head.slice(0, 7)} is already reviewed`);

  if (await untrustedFork(gh, pr)) {
    ctx.signal.throwIfAborted();
    const notice = renderForkNotice(head);
    const reviewId = prior?.reviewId !== undefined && (await gh.review(prior.reviewId))
      ? (await gh.updateReview(prior.reviewId, notice)).id
      : (await gh.createReview({ commitId: head, body: notice, comments: [] })).id;
    await save({ version: 1, reviewId, lastReviewedHead: head, findings: prior?.findings ?? [], nextId: prior?.nextId ?? 1, ...(prior?.rounds ? { rounds: prior.rounds } : {}) });
    return log(slug, `skipped: pull request from a fork by ${pr.user?.login ?? "an unknown author"}, who has no write access (association ${pr.author_association ?? "unknown"})`);
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

  // 1. Recheck open findings whose files changed. Only a grounded refutation
  // resolves one. It is a fix only when the code behind it changed.
  const toRecheck = open.live.filter((f) => changedSince === undefined || changedSince.has(f.path));
  const stillOpen = open.live.filter((f) => !toRecheck.includes(f));
  const fixed: { finding: OpenFinding; reason: string; withdrawn: boolean }[] = [];
  const recheck = forEachLimit(toRecheck, CHILD_CONCURRENCY, async (f) => {
    const verdict = await runVerifier(ctx, thread, {
      dispatchId: dispatch(`recheck:${f.id}`),
      model: settings.model,
      prompt: buildVerifierPrompt({ title: pr.title, base: mergeBase, head, finding: f, fileDiff: fileDiff(prDiff, f.path), finish: VERDICT_FINISH, ...(prior?.lastReviewedHead ? { recheckFrom: prior.lastReviewedHead } : {}) }),
      title: `Recheck ${f.id} at ${head.slice(0, 7)}`,
      repo: repoName,
      head,
    });
    const reason = verdict?.counter_evidence || verdict?.refutation_reason || "refuted";
    const changed = verdict?.verdict === "refuted" && refutationGrounded(verdict)
      ? prior?.lastReviewedHead === undefined || (await flaggedCodeChanged(gh, f, prior.lastReviewedHead, head, reason, repoName))
      : undefined;
    // A withdrawal overturns the claim on unchanged code, so it must also cite any rule the claim cites.
    if (verdict !== undefined && changed !== undefined && (changed || refutationCitesRules(f, verdict))) {
      fixed.push({ finding: f, reason, withdrawn: !changed });
    }
    // The recheck names the line at HEAD, so a moved finding anchors on the RIGHT side.
    else stillOpen.push(verdict?.current_line !== undefined ? { ...f, line: verdict.current_line, side: "RIGHT" } : f);
  });

  // 2. Review the PR, or only the new commits, told what is already open.
  const review = (async () => runReviewers(ctx, thread, {
    slug, repoName, pr, base: mergeBase, head, settings,
    diff: from !== undefined ? await incrementDiff(gh, from, head, reviewed, settings.riskPaths) : prDiffFor(prDiff, reviewed, mergeBase, head, settings.riskPaths),
    ...(from !== undefined ? { incrementFrom: from } : {}),
    knownFindings: [...open.live, ...open.dismissed.filter(hasTitle)].map((f) => ({ path: f.path, line: f.line, title: f.title })),
    dispatchId: dispatch("review"),
    context: {
      // Convention files and playbooks are instructions: read them at the merge base, never at the PR head.
      readTrusted: (path) => gh.fileText(path, mergeBase),
      patch: from === undefined && prDiff !== undefined ? onlyFiles(prDiff, new Set(reviewed.map((f) => f.filename))) : undefined,
    },
  }))();

  const [draft] = await Promise.all([review, recheck]);
  // Consolidate: drop repeats inside the draft before any other step.
  const consolidated = consolidateFindings(draft.findings);

  // 3. Drop findings on a line that does not exist.
  const inPaths = consolidated.kept.filter((f) => !excluded(f.path, settings.excludePaths));
  const candidates = await anchoredFindings(gh, files, inPaths, head, mergeBase);
  if (candidates.length < inPaths.length) log(slug, `dropped ${inPaths.length - candidates.length} finding(s) anchored to a line that does not exist at ${head.slice(0, 7)}`);

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
    const decision = decideFinding(f, verdict, await readableText(gh, f.path, head));
    if (decision.keep) kept.push(f);
  });

  // 5. New findings: drop repeats of open ones and those below the minimum severity, then assign ids.
  const minRank = SEVERITY_ORDER.indexOf(settings.minSeverity);
  let nextId = prior?.nextId ?? 1;
  const posted: PostedFinding[] = [];
  const reopened: OpenFinding[] = [];
  let hidden = consolidated.kept.length - candidates.length;
  for (const f of consolidated.kept.filter((x) => kept.includes(x))) {
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

  await noteBestEffort(ctx, thread, renderConsolidation(head, draft.findings.map((f): StageOutcome => {
    const repeat = consolidated.dropped.find((d) => d.finding === f);
    const out = posted.find((p) => p.path === f.path && p.line === f.line && p.title === f.title);
    const result = repeat ? `dropped: ${repeat.reason}`
      : !inPaths.includes(f) ? "dropped: excluded path"
      : !candidates.includes(f) ? "dropped: line does not exist at HEAD"
      : !kept.includes(f) ? "dropped: the verifier refuted it"
      : SEVERITY_ORDER.indexOf(f.severity) < minRank ? `hidden: below ${settings.minSeverity}`
      : out ? `posted as ${out.id}`
      : reopened.some((r) => r.path === f.path && r.title === f.title) ? "reopened a fixed finding"
      : "dropped: repeats an open or dismissed finding";
    return { finding: f, result };
  })), dispatch("consolidate"));

  // 6. Map new findings to diff lines. GitHub refuses a comment on a line outside the diff.
  const anchorable = new Map(files.map((f) => [f.filename, { RIGHT: commentableLines(f.patch ?? "", "RIGHT"), LEFT: commentableLines(f.patch ?? "", "LEFT") }]));
  const placed = posted.map((f) => placeNearDiff(f, anchorable.get(f.path)?.[f.side ?? "RIGHT"]));
  let inline = placed.filter((f) => anchorable.get(f.path)?.[f.side ?? "RIGHT"].has(f.line) ?? false);
  let outside = placed.filter((f) => !inline.includes(f));

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
      fixed: fixed.map(({ finding, withdrawn }) => ({ finding, sha: head, withdrawn })),
      hidden,
    });

  const summaryReview = prior?.reviewId !== undefined ? await gh.review(prior.reviewId) : null;
  let reviewId = summaryReview?.id;
  let inlineReviewId: number | undefined;
  /** Post the inline findings in one review with `body`. A 422 (a line GitHub cannot resolve) moves them all to the summary. */
  const postInline = async (body: string): Promise<number | undefined> => {
    try {
      return (await gh.createReview({ commitId: head, body, comments: inline.map((f) => ({ path: f.path, line: f.line, side: f.side ?? "RIGHT", body: renderInlineComment(f) })) })).id;
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
  const updates: NonNullable<PullPointers["pending"]>["updates"] = [];
  for (const { finding, reason, withdrawn } of fixed) {
    if (finding.commentId === undefined) continue;
    const comment = open.comments.get(finding.commentId);
    if (!comment) continue;
    updates.push({
      pointer: { ...pointer(finding, "resolved", finding), commentId: finding.commentId, ...resolvedAt(head, withdrawn) },
      body: withdrawn ? renderWithdrawnComment(comment.body, reason) : renderFixedComment(comment.body, head, reason),
    });
  }
  for (const f of reopened) {
    if (f.commentId === undefined) continue;
    updates.push({ pointer: { ...pointer(f, "open", f), commentId: f.commentId }, body: renderInlineComment(f) });
  }

  // 8. Save the new pointers.
  const byId = new Map<string, FindingPointer>((prior?.findings ?? []).map((p) => [p.id, p]));
  for (const d of open.dismissed) {
    const p = byId.get(d.id);
    if (p) byId.set(d.id, { ...p, status: "dismissed" });
  }
  for (const f of stillOpen) byId.set(f.id, pointer(f, "open", f));
  for (const { finding, withdrawn } of fixed) {
    if (finding.commentId === undefined) byId.set(finding.id, { ...pointer(finding, "resolved", finding), ...resolvedAt(head, withdrawn) });
  }
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
    resolved: fixed.filter((r) => !r.withdrawn).map(({ finding }) => finding.id),
    ...(fixed.some((r) => r.withdrawn) ? { withdrawn: fixed.filter((r) => r.withdrawn).map(({ finding }) => finding.id) } : {}),
  };
  const next: PullPointers = {
    version: 1,
    reviewId,
    findings: [...byId.values()],
    nextId,
    ...(prior?.lastReviewedHead ? { lastReviewedHead: prior.lastReviewedHead } : {}),
    ...(prior?.rounds ? { rounds: prior.rounds } : {}),
    pending: { head, round, updates },
  };
  // External edits can partly succeed. Save their intent and newly posted ids
  // first, so a retry neither posts duplicates nor mistakes our resolution for
  // a person's dismissal. Pending bodies exist only until the batch completes.
  await save(next);
  await finishPendingUpdates(gh, next, save, ctx.signal);
  log(slug, `reviewed ${head.slice(0, 7)} (${from ? "follow-up" : "full"}): ${posted.length} new, ${fixed.filter((r) => !r.withdrawn).length} fixed, ${fixed.filter((r) => r.withdrawn).length} withdrawn, ${reopened.length} reopened, ${stillOpen.length} still open`);
}

async function finishPendingUpdates(
  gh: GitHubClient,
  state: PullPointers,
  save: (next: PullPointers) => Promise<void>,
  signal: AbortSignal,
): Promise<PullPointers> {
  const pending = state.pending;
  if (!pending) return state;
  const byId = new Map(state.findings.map(p => [p.id, p]));
  if (pending.updates.length > 0) {
    const comments = new Map((await gh.reviewComments()).map(c => [c.id, c]));
    const threads = await gh.reviewThreads();
    for (const { pointer: desired, body } of pending.updates) {
      signal.throwIfAborted();
      const comment = comments.get(desired.commentId);
      if (!comment) {
        // External deletion is a normal dismissal, including during a retry.
        byId.set(desired.id, { ...desired, status: "dismissed" });
        continue;
      }
      const thread = threads.find(t => t.commentId === desired.commentId || t.id === desired.threadId);
      const threadId = thread?.id ?? desired.threadId;
      if (!threadId) throw new Error(`GitHub has not returned the review thread for ${desired.id}. Retry the delivery after GitHub finishes creating the thread.`);
      if (resolvedByAnotherActor(thread)) {
        byId.set(desired.id, { ...desired, status: "dismissed" });
        continue;
      }
      if (comment.body !== body) await gh.updateComment(desired.commentId, body);
      const resolved = desired.status === "resolved";
      if (thread?.isResolved !== resolved) await gh.setThreadResolved(threadId, resolved);
      byId.set(desired.id, { ...desired, threadId });
    }
  }
  signal.throwIfAborted();
  const next: PullPointers = {
    ...state,
    lastReviewedHead: pending.head,
    findings: [...byId.values()],
    rounds: [...(state.rounds ?? []), pending.round].slice(-100),
  };
  delete next.pending;
  await save(next);
  return next;
}

function resolvedByAnotherActor(thread: ReviewThread | undefined): boolean {
  return thread?.isResolved === true && thread.author !== undefined && thread.resolvedBy !== undefined &&
    thread.author.toLowerCase() !== thread.resolvedBy.toLowerCase();
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
  const threads = new Map<number, ReviewThread>();
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
    const where = { path: p.path, line: p.line, ...(p.side === "LEFT" ? { side: "LEFT" as const } : {}), ...(p.commentId !== undefined ? { commentId: p.commentId } : {}), ...((thread?.id ?? p.threadId) ? { threadId: thread?.id ?? p.threadId } : {}) };
    const gone = !text;
    // Valet resolves a thread only when it marks the finding fixed, so an
    // open finding in a resolved thread was resolved by a person.
    if (p.status === "dismissed" || gone || resolvedByAnotherActor(thread) || (p.status === "open" && thread?.isResolved)) {
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

/**
 * A finding a few lines outside its file's hunks, moved to the nearest line
 * GitHub can comment on. A suggestion replaces the line it is anchored to,
 * so a moved finding loses its suggestion. Other findings come back as they are.
 */
export function placeNearDiff(f: PostedFinding, commentable: ReadonlySet<number> | undefined): PostedFinding {
  if (commentable === undefined || commentable.has(f.line)) return f;
  const near = nearestCommentableLine(commentable, f.line);
  if (near === undefined) return f;
  const { suggestion, ...rest } = f;
  return { ...rest, line: near, body: suggestion !== undefined ? `${rest.body.trim()}\n\nSuggested change for line ${f.line}:\n\n\`\`\`\n${suggestion.replace(/\n+$/, "")}\n\`\`\`` : rest.body };
}

function resolvedAt(head: string, withdrawn: boolean): Pick<FindingPointer, "fixedIn" | "withdrawnAt"> {
  return withdrawn ? { withdrawnAt: head } : { fixedIn: head };
}

/** Lines on each side of a finding that must read the same for its code to count as unchanged. */
const FLAGGED_CONTEXT = 2;
/** Lines on each side of a line the refutation cites, compared the same way. */
const CITED_CONTEXT = 1;
/** Lines cited in a refutation that are compared. */
const MAX_CITED_LINES = 4;
const CITED_LINE = /([\w./-]+\.\w+):(\d+)/g;

/** The lines around 1-based `line`, trimmed and joined. */
function linesAround(text: string, line: number, context: number): string {
  return text.split("\n").slice(Math.max(0, line - 1 - context), line + context).map((l) => l.trim()).join("\n");
}

/** Whether `block` (from `linesAround`) appears in `text` as whole lines, ignoring indentation. */
function hasBlock(text: string, block: string): boolean {
  return `\n${text.split("\n").map((l) => l.trim()).join("\n")}\n`.includes(`\n${block}\n`);
}

/**
 * Whether the code behind a refuted finding changed between `from`, the head
 * it was last open on, and `head`. A refutation on unchanged code withdraws
 * the finding: the reviewer changed its mind, and no commit fixed anything.
 * - The lines around the finding are gone from its file. For a LEFT finding
 *   (a deleted line), any change to the file counts.
 * - A line the refutation cites as path:line at HEAD, with its neighbours, is
 *   new since `from`, in any file. So a guard added further up the same
 *   function, a fix in a caller, or a new test reads as a fix, and an
 *   unrelated edit elsewhere in a cited file does not.
 * A GitHub read error throws and fails the delivery, like the other reads.
 */
export async function flaggedCodeChanged(
  gh: Pick<GitHubClient, "fileText">,
  f: Pick<PostedFinding, "path" | "line" | "side">,
  from: string,
  head: string,
  evidence: string,
  repoName: string,
): Promise<boolean> {
  const texts = new Map<string, Promise<[string | undefined, string | undefined]>>();
  const read = (path: string) => {
    let pair = texts.get(path);
    if (!pair) texts.set(path, (pair = Promise.all([gh.fileText(path, from), gh.fileText(path, head)])));
    return pair;
  };
  const [before, after] = await read(f.path);
  if (f.side === "LEFT" || before === undefined || after === undefined) {
    if (before !== after) return true;
  } else if (!hasBlock(after, linesAround(before, f.line, FLAGGED_CONTEXT))) {
    return true;
  }
  // Evidence sometimes prefixes a path with the repository, as `owner/name/` or `name/`.
  const prefixes = [`${repoName}/`, `${repoName.split("/").pop()}/`];
  const unprefixed = (path: string): string => prefixes.reduce((p, pre) => (p.startsWith(pre) ? p.slice(pre.length) : p), path);
  const cited = [...new Map([...evidence.matchAll(CITED_LINE)].map((m) => {
    const path = unprefixed(m[1]);
    return [`${path}:${m[2]}`, { path, line: Number(m[2]) }] as const;
  })).values()].slice(0, MAX_CITED_LINES);
  for (const { path, line } of cited) {
    const [a, b] = await read(path);
    if (b === undefined) continue;
    if (a === undefined || !hasBlock(a, linesAround(b, line, CITED_CONTEXT))) return true;
  }
  return false;
}

function pointer(f: Pick<PostedFinding, "id" | "path" | "line" | "side">, status: FindingPointer["status"], ids: { commentId?: number; threadId?: string }): FindingPointer {
  return {
    id: f.id, path: f.path, line: f.line, status,
    ...(f.side === "LEFT" ? { side: "LEFT" as const } : {}),
    ...(ids.commentId !== undefined ? { commentId: ids.commentId } : {}),
    ...(ids.threadId !== undefined ? { threadId: ids.threadId } : {}),
  };
}

async function runVerifier(
  ctx: PluginEventContext,
  thread: PluginThreadRef,
  req: { dispatchId: string; model: string; prompt: string; title: string; repo: string; head: string },
): Promise<Verdict | undefined> {
  const child: PluginChild = await ctx.threads.spawnChild(
    thread,
    { prompt: req.prompt, title: req.title, role: VERIFIER_ROLE, model: req.model, repo: req.repo, ref: req.head, gitAccess: "read" },
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

/**
 * The general reviewer child plus one child per `settings.focuses` entry,
 * merged by location with the general findings first. The general child
 * starts first and its failure fails the delivery. A focused child that
 * cannot start (the per-session child cap) or ends without a review is
 * logged and skipped, so a busy moment loses depth, never the review.
 * Focused findings below `focusMinConfidence` are dropped.
 */
async function runReviewers(
  ctx: PluginEventContext,
  thread: PluginThreadRef,
  input: Parameters<typeof runReviewerChild>[2],
): Promise<Review> {
  const focuses = [...new Set(input.settings.focuses ?? [])];
  const general = runReviewerChild(ctx, thread, input);
  if (focuses.length === 0) return general;
  const focused = focuses.map((focus) =>
    runReviewerChild(ctx, thread, { ...input, focus, dispatchId: `${input.dispatchId}:${focus}` }).catch((err: unknown) => {
      console.warn(`pr-review: ${input.slug} ${focus} reviewer skipped:`, err instanceof Error ? err.message : err);
      return undefined;
    }),
  );
  const [main, ...extra] = await Promise.all([general, ...focused]);
  const min = input.settings.focusMinConfidence;
  const extraFindings = extra.flatMap((r) => (r ? [r.findings.filter((f) => confidentEnough(f, min))] : []));
  return { ...main, findings: mergeFindings([main.findings, ...extraFindings]) };
}

/** Start the reviewer child at `head` and read its review. A child without a review fails the delivery. */
async function runReviewerChild(
  ctx: PluginEventContext,
  thread: PluginThreadRef,
  input: {
    slug: string; repoName: string; pr: PullRequest; base: string; head: string; settings: ReviewSettings; diff: PullRequestDiff;
    incrementFrom?: string; knownFindings: { path: string; line: number; title: string }[]; dispatchId: string;
    /** Gather a context pack first, in the child's sandbox. `patch` is the diff before the budget; unset uses the reviewed diff. */
    context?: { readTrusted: (path: string) => Promise<string | undefined>; patch?: string | undefined };
    /** Limit this child to one defect class. Unset: the general review. */
    focus?: ReviewFocus;
  },
): Promise<Review> {
  const [owner = "", repo = ""] = input.repoName.split("/");
  const promptWith = (pack: string | undefined, memory: string): string =>
    reviewerPrompt({
      review: buildReviewPrompt({
        title: input.pr.title,
        body: input.pr.body ?? "",
        base: input.base,
        head: input.head,
        diff: input.diff,
        ...(input.incrementFrom !== undefined ? { increment: { from: input.incrementFrom } } : {}),
        knownFindings: input.knownFindings,
        ...(pack !== undefined ? { contextPack: pack } : {}),
      }),
      instructions: input.settings.instructions,
      excludePaths: input.settings.excludePaths,
      memory,
    });
  // Without a pack, the memory search stands in for the pack's team notes. It runs only when no pack replaces the prompt.
  const fallback = async (): Promise<string> => promptWith(undefined, await teamNotes(ctx, input.repoName));
  const context = input.context;
  const budgetTokens = input.settings.contextBudget ?? 0;
  const gathers = context !== undefined && budgetTokens > 0;
  const child = await ctx.threads.spawnChild(
    thread,
    {
      // With a prepare step, the host sends the prompt that step returns; this one is only its input.
      prompt: gathers ? promptWith(undefined, "") : await fallback(),
      // Gather in the child's sandbox, on the checkout it already has. The pack goes into the first prompt, so compaction never drops it.
      ...(context && gathers
        ? {
            prepare: async (runner) => {
              const pack = await gatherForReview(ctx, {
                runner,
                readTrusted: context.readTrusted,
                owner,
                repo,
                head: input.head,
                title: input.pr.title,
                patch: context.patch ?? input.diff.patch,
                diffDropped: input.diff.dropped ?? [],
                budgetTokens,
                thread,
                dispatchId: `${input.dispatchId}:context`,
              });
              return pack ? promptWith(pack.text, "") : fallback();
            },
          }
        : {}),
      title: input.focus ? `Review ${input.head.slice(0, 7)} (${input.focus})` : `Review ${input.head.slice(0, 7)}`,
      role: input.focus ? focusRole(input.focus) : REVIEWER_ROLE,
      model: input.settings.model,
      repo: input.repoName,
      ref: input.head,
      // The child reads untrusted PR text and has bash: its git credential must not push.
      gitAccess: "read",
    },
    { dispatchId: input.dispatchId },
  );
  const result = await ctx.threads.awaitChild(child, { resultSchema: ReviewSchema });
  if (result.outcome !== "completed" || result.output === undefined) {
    throw new Error(`The review child for ${input.slug} at ${input.head.slice(0, 7)} ended without a review (${result.outcome}${result.error ? `: ${result.error}` : ""}). Open the plugin thread to see why, then retry the delivery.`);
  }
  return result.output as Review; // validated against ReviewSchema by awaitChild
}

/**
 * The findings whose line exists: the reviewer child answers through
 * awaitChild, so no tool refused them. A LEFT finding names a deleted line,
 * so it is checked against the base file.
 */
async function anchoredFindings(gh: GitHubClient, files: PullFile[], findings: Finding[], head: string, base: string): Promise<Finding[]> {
  const right = findings.map((f, i) => ({ f, i })).filter(({ f }) => f.side !== "LEFT");
  const left = findings.map((f, i) => ({ f, i })).filter(({ f }) => f.side === "LEFT");
  const headCounts = await lineCountsAt(gh, files.filter((f) => f.status !== "removed"), right.map(({ f }) => f.path), head);
  const baseCounts = left.length > 0 ? await lineCountsAt(gh, files.filter((f) => f.status !== "added"), left.map(({ f }) => f.path), base) : new Map<string, number>();
  const misplaced = new Set([
    ...anchorProblems(right.map(({ f }) => f), headCounts).map((p) => right[p.index].i),
    ...anchorProblems(left.map(({ f }) => f), baseCounts).map((p) => left[p.index].i),
  ]);
  return findings.filter((_, i) => !misplaced.has(i));
}

/**
 * A review recorded in the plugin thread only: nothing on GitHub and no
 * pointers in the store. It covers the whole PR, at `commit` when given
 * (a merged or closed PR), else at the merge commit of a merged PR or the
 * PR head. The diff, file list and line checks cover the merge base to the
 * commit it checks out, so a finding names code that exists there. GitHub's
 * compare lists at most 300 files.
 */
async function shadowReview(
  event: PluginEvent,
  ctx: PluginEventContext,
  gh: GitHubClient,
  pr: PullRequest,
  settings: ReviewSettings,
  where: { slug: string; repoName: string; commit: string | undefined },
): Promise<void> {
  const { slug, repoName } = where;
  const checkout = where.commit ?? (pr.merged && pr.merge_commit_sha ? pr.merge_commit_sha : pr.head.sha);
  const thread = await ctx.threads.ensure(slug, { title: `Review ${slug}` });
  const dispatch = (label: string): string => `${event.id}:${checkout.slice(0, 12)}:${label}`;
  if (!pr.merged && where.commit === undefined && (await untrustedFork(gh, pr))) {
    await ctx.threads.record(thread, renderShadowNotice(slug, "The pull request comes from a fork, and its author has no write access to this repository. Pass a commit to review it."), { dispatchId: dispatch("shadow-fork") });
    return log(slug, "shadow review skipped: pull request from a fork by an untrusted author");
  }
  const from = await shadowBase(gh, pr, checkout);
  const comparison = await gh.compare(from, checkout);
  if (!comparison) throw new Error(`GitHub cannot compare ${from.slice(0, 7)} with ${checkout.slice(0, 7)} on ${slug}. Pass a commit that still exists, then retry.`);
  const mergeBase = comparison.merge_base_commit.sha;
  const files = comparison.files ?? [];
  const reviewed = files.filter((f) => !excluded(f.filename, settings.excludePaths));
  const prDiff = (await gh.compareDiff(mergeBase, checkout)) ?? undefined;
  const draft = await runReviewers(ctx, thread, {
    slug, repoName, pr, base: mergeBase, head: checkout, settings,
    diff: prDiffFor(prDiff, reviewed, mergeBase, checkout, settings.riskPaths),
    knownFindings: [],
    dispatchId: dispatch("shadow-review"),
    context: { readTrusted: (path: string) => gh.fileText(path, mergeBase), patch: prDiff !== undefined ? onlyFiles(prDiff, new Set(reviewed.map((f) => f.filename))) : undefined },
  });
  const inPaths = draft.findings.filter((f) => !excluded(f.path, settings.excludePaths));
  const minRank = SEVERITY_ORDER.indexOf(settings.minSeverity);
  const shown = (await anchoredFindings(gh, files, inPaths, checkout, mergeBase)).filter((f) => SEVERITY_ORDER.indexOf(f.severity) >= minRank);
  ctx.signal.throwIfAborted();
  await ctx.threads.record(
    thread,
    renderShadowReview({ slug, commit: checkout, summary: draft.summary, confidence: draft.confidence, findings: shown, hidden: draft.findings.length - shown.length }),
    { dispatchId: dispatch("shadow-record") },
  );
  log(slug, `shadow review of ${checkout.slice(0, 7)} recorded in the plugin thread: ${shown.length} finding(s)`);
}

/**
 * The commit a shadow review diffs from. For a merged pull request read at
 * its merge commit, that is the merge commit's first parent: the base branch
 * just before the merge, so the diff is the pull request's own change for a
 * merge commit or a squash. `pr.base.sha` is the base from the pull
 * request's last update. The base branch moved on after it, so diffing from
 * it would sweep in every commit merged in between. A rebase merge of
 * several commits shows only its last commit this way. Any other checkout
 * diffs from `pr.base.sha`, through the merge base, as before.
 */
async function shadowBase(gh: GitHubClient, pr: PullRequest, checkout: string): Promise<string> {
  if (!pr.merged || !pr.merge_commit_sha || checkout !== pr.merge_commit_sha) return pr.base.sha;
  return (await gh.commitParents(checkout))?.[0] ?? pr.base.sha;
}

/** How a verifier child ends: JSON the verdict schema accepts, not a submit tool. */
const VERDICT_FINISH = `Check the claim, then give your verdict.\n\n${answerFormat(VerdictSchema)}`;

/**
 * Line count at `ref` of each path a finding names, for `anchorProblems`.
 * Only `files` (the PR files present at that side) count; a file GitHub
 * will not return as text (a submodule) counts as one line.
 */
async function lineCountsAt(gh: GitHubClient, files: PullFile[], paths: string[], ref: string): Promise<Map<string, number>> {
  const present = new Set(files.map((f) => f.filename));
  const counts = new Map<string, number>();
  for (const path of new Set(paths)) {
    if (!present.has(path)) continue;
    let text: string | undefined;
    try {
      text = await gh.fileText(path, ref);
    } catch (err) {
      // Unreadable now (a 403, 5xx or rate limit): leave its findings unchecked rather than drop them as past a 1-line file.
      console.warn(`pr-review: cannot read ${path} at ${ref.slice(0, 7)}; its findings skip the line check`, err instanceof Error ? err.message : err);
      counts.set(path, Number.POSITIVE_INFINITY);
      continue;
    }
    counts.set(path, text === undefined ? 1 : lineCount(text));
  }
  return counts;
}

/**
 * A file's text for a best-effort check (the verifier's quote check), or
 * undefined when GitHub cannot serve it: one unreadable file must not fail
 * the review. Instruction reads (`readTrusted`) call `gh.fileText` directly,
 * because a failed read there must fail the pack, not drop the rule.
 */
async function readableText(gh: GitHubClient, path: string, ref: string): Promise<string | undefined> {
  try {
    return await gh.fileText(path, ref);
  } catch (err) {
    console.warn(`pr-review: cannot read ${path} at ${ref.slice(0, 7)}; checks treat it as unreadable`, err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** The PR diff limited to the reviewed files, cut to the budget. */
function prDiffFor(patch: string | undefined, files: PullFile[], base: string, head: string, riskPaths: readonly string[] = []): PullRequestDiff {
  const names = files.map((f) => f.filename);
  const stat = files.map((f) => `${f.filename} | +${f.additions} -${f.deletions}`).join("\n");
  if (patch === undefined) return unrendered(stat, names, base, head);
  return { stat, files: names, ...cutPatch(onlyFiles(patch, new Set(names)), DIFF_BUDGET, riskPaths) };
}

/** The diff of the new commits, limited to the PR's reviewed files: a merge of the base branch is not new PR code. */
async function incrementDiff(gh: GitHubClient, from: string, head: string, files: PullFile[], riskPaths: readonly string[] = []): Promise<PullRequestDiff> {
  const names = new Set(files.map((f) => f.filename));
  const patch = await gh.compareDiff(from, head);
  const touched = patch === null ? [...names] : [...names].filter((n) => patch.includes(` b/${n}\n`));
  const stat = touched.join("\n");
  if (patch === null) return unrendered(stat, touched, from, head);
  return { stat, files: touched, ...cutPatch(onlyFiles(patch, names), DIFF_BUDGET, riskPaths) };
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

/** Author associations that show access to the base repository. */
const TRUSTED_FORK_AUTHORS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
/** Repository roles that can push a branch to the base repository. */
const PUSH_ROLES = new Set(["admin", "maintain", "write"]);

/**
 * Whether the pull request comes from a fork whose author could not push the
 * branch to the base repository. Anyone can open a pull request from a fork of
 * a public repository, and a review child runs tools in a sandbox with a token
 * for the base repository, so only authors with that access get a review.
 * GitHub computes `author_association` for the caller, and an app token sees a
 * private org member as `CONTRIBUTOR`, so the author's role decides when the
 * association does not show access.
 */
async function untrustedFork(gh: GitHubClient, pr: PullRequest): Promise<boolean> {
  if (pr.head.repo?.full_name === pr.base.repo.full_name) return false;
  if (TRUSTED_FORK_AUTHORS.has(pr.author_association ?? "")) return false;
  const role = pr.user ? await gh.permission(pr.user.login) : undefined;
  return role === undefined || !PUSH_ROLES.has(role);
}

/** Whether `path` matches one of the exclude globs (see `matchesGlob`). */
export const excluded = matchesGlob;

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
