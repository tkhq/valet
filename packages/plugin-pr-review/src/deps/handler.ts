/**
 * The `review-dependencies` event handler: on each push to a pull request
 * that changes a dependency manifest or lockfile, it lists the packages
 * added, upgraded and removed, looks each new version up in OSV and the
 * package registries, asks one child whether the code reaches each new
 * advisory, and keeps one dependency summary review per pull request,
 * edited in place, with inline comments on the lines that add the packages.
 *
 * It is a separate handler from `review-pull-request`, turned on by its own
 * line. It has its own store collection, summary marker and finding ids
 * (`d<n>`), so it never touches the general review's summary, findings or
 * merge confidence. A pull request that changes no dependency file costs two
 * GitHub reads and posts nothing.
 */
import { Type, type Static } from "typebox";
import type { PluginAcceptContext, PluginEvent, PluginEventContext, PluginEventHandler } from "@valet/engine";
import { githubClient, GitHubError, type GitHubClient, type PullFile } from "../github.js";
import { answerFormat, excluded, forEachLimit, pullTarget, untrustedFork } from "../handler.js";
import { commentableLines } from "../linemap.js";
import { dependencyChanges, type ChangedFile, type PackageChange } from "./diff.js";
import { dependencyFindings, lowerSeverity, SEVERITY_ORDER, type ChangeFacts, type DependencyFinding, type Severity } from "./findings.js";
import { lookupAdvisories, MAX_ADVISORY_READS, type Advisory } from "./osv.js";
import { dependencyFile } from "./parse.js";
import { buildReachabilityPrompt, MAX_REACHABILITY, REACHABILITY_ROLE, ReachabilitySchema, type Reachability, type ReachabilityVerdict } from "./reachability.js";
import { packageFacts, type PackageFacts, type RegistryUrls } from "./registry.js";
import {
  dependencyFindingIds,
  renderDependencyComment,
  renderDependencySummary,
  renderResolvedComment,
  type DependencySummaryInput,
  type PostedDependencyFinding,
} from "./render.js";

export const DEPENDENCY_HANDLER = "review-dependencies";
export const DEPENDENCY_COLLECTION = "dependency-pulls";

export const DependencySettingsSchema = Type.Object(
  {
    minSeverity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")], {
      default: "low",
      description: "Post only findings at this severity or above.",
    }),
    reachability: Type.Boolean({
      default: true,
      description: "Ask a child session whether the code calls the affected part of each new advisory. An advisory the code does not reach posts one severity level lower.",
    }),
    model: Type.String({ default: "anthropic/claude-sonnet-5-5", description: "provider/model for the reachability child." }),
    newPackageDays: Type.Integer({
      default: 30,
      minimum: 0,
      maximum: 365,
      description: "Flag an added package first published fewer days ago than this. 0 turns the check off.",
    }),
    ignore: Type.Array(Type.String({ minLength: 1 }), {
      default: [],
      maxItems: 200,
      description: "Package names or advisory ids (GHSA-, CVE-, GO- and others) to skip.",
    }),
    excludePaths: Type.Array(Type.String({ minLength: 1 }), {
      default: [],
      maxItems: 100,
      description: "Globs of dependency files not to check, such as `fixtures/**`. A pattern without a slash matches at any depth.",
    }),
    reviewDrafts: Type.Boolean({ default: false, description: "Check draft pull requests on every push too." }),
  },
  { additionalProperties: false },
);
export type DependencySettings = Static<typeof DependencySettingsSchema>;

/** One posted finding's pointer. The finding text is derived again from the key on each run, or read from GitHub. */
export interface DependencyPointer {
  id: string;
  key: string;
  kind: DependencyFinding["kind"];
  severity: Severity;
  title: string;
  path?: string;
  line?: number;
  /** The inline comment. Absent: the finding is in the summary review's body. */
  commentId?: number;
  threadId?: string;
  /** `resolved`: a later push dropped the package version. `dismissed`: a person resolved the thread or deleted the comment. */
  status: "open" | "resolved" | "dismissed";
  resolvedIn?: string;
  /** The reachability verdict, so a later run shows it without a new child. */
  reach?: Pick<ReachabilityVerdict, "reachable" | "evidence" | "reason">;
}

export interface DependencyPullState {
  version: 1;
  reviewId?: number;
  lastReviewedHead?: string;
  findings: DependencyPointer[];
  nextId: number;
}

export interface DependencyHandlerOptions {
  /** For tests: the fetch GitHub, OSV and registry calls go through. */
  fetch?: typeof fetch;
  /** For tests: the registry base URLs. */
  registryUrls?: RegistryUrls;
  /** For tests: the clock the new-package check uses. */
  now?: () => Date;
}

const PUSH_EVENTS = ["github.pull_request.opened", "github.pull_request.synchronize", "github.pull_request.reopened", "github.pull_request.ready_for_review"];

/** Registry reads per run, and how many run at once. */
const MAX_REGISTRY_READS = 60;
const REGISTRY_CONCURRENCY = 8;

export function createDependencyReviewHandler(opts: DependencyHandlerOptions = {}): PluginEventHandler {
  return {
    id: DEPENDENCY_HANDLER,
    description: "Check the packages a pull request adds or upgrades for advisories, license changes, new or renamed packages and install scripts, in one summary review per pull request.",
    events: PUSH_EVENTS,
    configSchema: DependencySettingsSchema,
    concurrency: "supersede",
    accepts: acceptsDependencyEvent,
    handle: (event, ctx) => reviewDependencies(event, ctx, opts),
  };
}

/** A push to a draft runs only when the line checks drafts, so it cannot cancel a run in flight for nothing. */
export function acceptsDependencyEvent(event: PluginEvent, ctx: PluginAcceptContext): boolean {
  const settings = ctx.config as DependencySettings; // the host checked it against DependencySettingsSchema and filled defaults
  const payload = event.payload;
  const pr = typeof payload === "object" && payload !== null && "pull_request" in payload ? payload.pull_request : undefined;
  const draft = typeof pr === "object" && pr !== null && "draft" in pr && pr.draft === true;
  return !(draft && event.key !== "github.pull_request.ready_for_review" && !settings.reviewDrafts);
}

/** The dependency files a pull request changes, outside the line's excluded paths. */
export function changedDependencyFiles(files: PullFile[], excludePaths: readonly string[]): PullFile[] {
  return files.filter((f) => dependencyFile(f.filename) !== undefined && !excluded(f.filename, excludePaths));
}

async function reviewDependencies(event: PluginEvent, ctx: PluginEventContext, opts: DependencyHandlerOptions): Promise<void> {
  const settings = ctx.config as DependencySettings; // the host checked it against DependencySettingsSchema and filled defaults
  const target = pullTarget(event);
  if (!target) return void console.warn("dependency review: event names no pull request", { eventId: event.id, key: event.key });
  const repoName = `${target.owner}/${target.repo}`;
  const slug = `${repoName}#${target.number}`;
  const token = await ctx.appToken("github", { owner: target.owner });
  if (!token) throw new Error(`The GitHub App is not installed for ${target.owner}. Install it on ${target.owner} in Settings, then retry the delivery.`);
  const doFetch = opts.fetch ?? fetch;
  const gh = githubClient({ token, ...target, fetch: doFetch, signal: ctx.signal });

  const pr = await gh.pull();
  const head = pr.head.sha;
  if (pr.state !== "open") return log(slug, `skipped: the pull request is ${pr.state}`);
  if (pr.draft && !settings.reviewDrafts) return log(slug, "skipped: draft pull request");

  const depFiles = changedDependencyFiles(await gh.pullFiles(), settings.excludePaths);
  let stored = await ctx.store.get<DependencyPullState>(DEPENDENCY_COLLECTION, slug);
  const prior = stored?.doc;
  // No dependency file and nothing posted before: no reads past the file list, no posts.
  if (depFiles.length === 0 && !prior?.findings.some((f) => f.status === "open")) return log(slug, "skipped: no dependency file changed");
  if (prior?.lastReviewedHead === head) return log(slug, `skipped: ${head.slice(0, 7)} is already checked`);
  const save = async (next: DependencyPullState): Promise<void> => {
    stored = await ctx.store.put(DEPENDENCY_COLLECTION, slug, next, stored ? { ifRevision: stored.revision } : undefined);
  };

  // 1. The package changes, from each dependency file at the merge base and at the head.
  const comparison = await gh.compare(pr.base.sha, head);
  if (!comparison) throw new Error(`GitHub cannot compare ${pr.base.sha.slice(0, 7)} with ${head.slice(0, 7)} on ${slug}. Retry the delivery after the push settles.`);
  const mergeBase = comparison.merge_base_commit.sha;
  const read = (path: string, ref: string): Promise<string | undefined> => gh.fileText(path, ref);
  const changed: ChangedFile[] = await Promise.all(
    depFiles.map(async (f) => ({
      path: f.filename,
      base: f.status === "added" ? undefined : await read(f.previous_filename ?? f.filename, mergeBase),
      head: f.status === "removed" ? undefined : await read(f.filename, head),
    })),
  );
  changed.push(...(await siblingManifests(depFiles, head, read)));
  const { changes: all, truncated } = dependencyChanges(changed);
  const ignored = new Set(settings.ignore.map((s) => s.toLowerCase()));
  const changes = all.filter((c) => !ignored.has(c.name.toLowerCase()));
  // A manifest edit that changes no dependency (a script, the version field) posts nothing on a pull request with no dependency review yet.
  if (changes.length === 0 && prior?.reviewId === undefined) return log(slug, "skipped: the dependency files changed, but no package did");

  // 2. Advisories for every new version, and registry facts within the read budget.
  const checked = changes.map((c, i) => ({ c, i })).filter(({ c }) => c.kind !== "removed" && c.to !== undefined && c.to !== "");
  ctx.signal.throwIfAborted();
  const found = checked.length > 0 ? await lookupAdvisories(checked.map(({ c }) => ({ ecosystem: c.ecosystem, name: c.name, version: c.to ?? "" })), { fetch: doFetch, signal: ctx.signal }) : [];
  const advisories: Advisory[][] = changes.map(() => []);
  checked.forEach(({ i }, j) => {
    advisories[i] = (found[j] ?? []).filter((a) => !ignored.has(a.id.toLowerCase()) && !a.aliases.some((x) => ignored.has(x.toLowerCase())));
  });
  const unread = new Set(found.flat().filter((a) => a.unread).map((a) => a.id));
  const facts = await registryFacts(changes, { fetch: doFetch, signal: ctx.signal, ...(opts.registryUrls ? { urls: opts.registryUrls } : {}) });
  const candidates = dependencyFindings(changes, advisories, facts, { newPackageDays: settings.newPackageDays, now: opts.now?.() ?? new Date() });

  // 3. Keep, resolve or add by key. A dismissed finding is never posted again.
  const pointers = new Map((prior?.findings ?? []).map((p) => [p.key, p]));
  const dismissedNow = await dismissedFindings(gh, prior);
  const current = new Map(candidates.map((f) => [f.key, f]));
  // A finding resolved earlier comes back when the pull request adds that version again.
  const fresh = candidates.filter((f) => !pointers.has(f.key) || pointers.get(f.key)?.status === "resolved");
  const dropped = [...pointers.values()].filter((p) => p.status === "open" && !dismissedNow.has(p.id) && !current.has(p.key));

  // 4. Reachability: one child for the new advisories, in a sandbox at the head. Not for an untrusted fork.
  const reach = new Map<string, ReachabilityVerdict>();
  let reachabilityNote: string | undefined;
  const toJudge = fresh.filter((f) => f.kind === "advisory");
  if (toJudge.length > 0) {
    if (!settings.reachability) reachabilityNote = "Reachability was not checked: it is off for this line.";
    else if (await untrustedFork(gh, pr)) reachabilityNote = "Reachability was not checked: the pull request comes from a fork whose author has no write access to this repository.";
    else {
      const judged = toJudge.slice(0, MAX_REACHABILITY);
      const verdicts = await judgeReachability(ctx, { event, slug, repoName, head, model: settings.model, findings: judged });
      if (verdicts === undefined) reachabilityNote = "Reachability was not checked: the reachability child ended without an answer. Open the plugin thread to see why.";
      else verdicts.forEach((v) => {
        const f = judged[Number(v.ref.replace(/^a/, "")) - 1];
        if (f) reach.set(f.key, v);
      });
      if (toJudge.length > judged.length) reachabilityNote = `Reachability was checked for the first ${judged.length} new advisories only.`;
    }
  }

  // 5. Severity after reachability, then the minimum-severity filter.
  const minRank = SEVERITY_ORDER.indexOf(settings.minSeverity);
  const judgedFinding = (f: DependencyFinding, v: Pick<ReachabilityVerdict, "reachable" | "evidence" | "reason"> | undefined): DependencyFinding => (v ? withReachability(f, v) : f);
  let hidden = 0;
  let nextId = prior?.nextId ?? 1;
  const toPost: { id: string; finding: DependencyFinding; reach?: ReachabilityVerdict }[] = [];
  for (const f of fresh) {
    const v = reach.get(f.key);
    const shown = judgedFinding(f, v);
    if (SEVERITY_ORDER.indexOf(shown.severity) < minRank) {
      hidden++;
      continue;
    }
    toPost.push({ id: `d${nextId++}`, finding: shown, ...(v ? { reach: v } : {}) });
  }

  // 6. Anchor each new finding on a line the diff shows, else list it in the summary.
  const patches = new Map(depFiles.map((f) => [f.filename, commentableLines(f.patch ?? "", "RIGHT")]));
  const anchorOf = (f: DependencyFinding): { path: string; line: number } | undefined => {
    for (const loc of f.locations) if (loc.line !== undefined && patches.get(loc.path)?.has(loc.line)) return { path: loc.path, line: loc.line };
    return undefined;
  };
  let inline = toPost.filter((p) => anchorOf(p.finding) !== undefined);
  let outsideNew = toPost.filter((p) => !inline.includes(p));

  // 7. Post: one summary review, edited in place, plus one review of inline comments per push.
  const keptOpen = [...pointers.values()].filter((p) => p.status === "open" && !dismissedNow.has(p.id) && current.has(p.key));
  const summaryOf = (): string => {
    const open: PostedDependencyFinding[] = [
      ...keptOpen.map((p) => ({ id: p.id, key: p.key, kind: p.kind, severity: p.severity, title: p.title, ...(p.path ? { path: p.path } : {}), ...(p.line ? { line: p.line } : {}) })),
      ...toPost.map((p) => {
        const at = anchorOf(p.finding);
        const loc = at ?? p.finding.locations[0];
        return { id: p.id, key: p.finding.key, kind: p.finding.kind, severity: p.finding.severity, title: p.finding.title, ...(loc?.path ? { path: loc.path } : {}), ...(loc?.line ? { line: loc.line } : {}) };
      }),
    ];
    const outside: DependencySummaryInput["outside"] = [
      // An open finding without a comment keeps its text in the summary: derive it again from the current finding.
      ...keptOpen.filter((p) => p.commentId === undefined).flatMap((p) => {
        const f = current.get(p.key);
        return f ? [{ id: p.id, finding: judgedFinding(f, p.reach), ...(p.path ? { where: `${p.path}${p.line ? `:${p.line}` : ""}` } : {}) }] : [];
      }),
      ...outsideNew.map((p) => ({ id: p.id, finding: p.finding, ...(p.finding.locations[0] ? { where: p.finding.locations[0].path } : {}) })),
    ];
    return renderDependencySummary({
      head,
      changes,
      truncated,
      open,
      outside,
      resolved: [
        ...(prior?.findings ?? []).filter((p) => p.status === "resolved" && p.resolvedIn && !current.has(p.key)).map((p) => ({ title: p.title, sha: p.resolvedIn ?? head })),
        ...dropped.map((p) => ({ title: p.title, sha: head })),
      ],
      hidden,
      ...(reachabilityNote ? { reachabilityNote } : {}),
      ...(unread.size > 0 ? { notes: [`${unread.size} advisory record(s) past the per-run limit of ${MAX_ADVISORY_READS} are named by id only.`] } : {}),
    });
  };

  ctx.signal.throwIfAborted();
  const summary = prior?.reviewId !== undefined ? await gh.review(prior.reviewId) : null;
  let reviewId = summary?.id;
  let inlineReviewId: number | undefined;
  const postInline = async (body: string): Promise<number | undefined> => {
    try {
      return (await gh.createReview({
        commitId: head,
        body,
        comments: inline.map((p) => {
          const at = anchorOf(p.finding);
          return { path: at?.path ?? "", line: at?.line ?? 1, side: "RIGHT" as const, body: renderDependencyComment(p.id, p.finding) };
        }),
      })).id;
    } catch (err) {
      if (!(err instanceof GitHubError) || err.status !== 422 || inline.length === 0) throw err;
      console.warn(`dependency review ${slug}: GitHub refused the inline comments, so the summary carries them`, err.message);
      outsideNew = [...outsideNew, ...inline];
      inline = [];
      return undefined;
    }
  };
  if (reviewId === undefined) {
    inlineReviewId = await postInline(summaryOf());
    reviewId = inlineReviewId ?? (await gh.createReview({ commitId: head, body: summaryOf(), comments: [] })).id;
  } else {
    if (inline.length > 0) inlineReviewId = await postInline("");
    await gh.updateReview(reviewId, summaryOf());
  }
  const commentIds = inlineReviewId !== undefined && inline.length > 0 ? await newCommentIds(gh, inlineReviewId) : new Map<string, number>();

  // 8. Save the new findings before editing old comments, so a retry does not post them twice.
  const byKey = new Map((prior?.findings ?? []).map((p) => [p.key, p]));
  for (const p of byKey.values()) if (dismissedNow.has(p.id)) byKey.set(p.key, { ...p, status: "dismissed" });
  for (const p of [...inline, ...outsideNew]) {
    const at = anchorOf(p.finding);
    const loc = at ?? p.finding.locations[0];
    const commentId = inline.includes(p) ? commentIds.get(p.id) : undefined;
    byKey.set(p.finding.key, {
      id: p.id, key: p.finding.key, kind: p.finding.kind, severity: p.finding.severity, title: p.finding.title, status: "open",
      ...(loc?.path ? { path: loc.path } : {}), ...(loc?.line ? { line: loc.line } : {}),
      ...(commentId !== undefined ? { commentId } : {}),
      ...(p.reach ? { reach: { reachable: p.reach.reachable, evidence: p.reach.evidence.slice(0, 300), reason: p.reach.reason.slice(0, 300) } } : {}),
    });
  }
  const base: DependencyPullState = { version: 1, reviewId, findings: [...byKey.values()], nextId, ...(prior?.lastReviewedHead ? { lastReviewedHead: prior.lastReviewedHead } : {}) };
  await save(base);

  // 9. Mark findings whose package version the pull request no longer adds.
  if (dropped.some((p) => p.commentId !== undefined)) {
    const comments = new Map((await gh.reviewComments()).map((c) => [c.id, c]));
    const threads = await gh.reviewThreads();
    for (const p of dropped) {
      ctx.signal.throwIfAborted();
      if (p.commentId === undefined) continue;
      const comment = comments.get(p.commentId);
      if (!comment) continue;
      const body = renderResolvedComment(comment.body, head);
      if (comment.body !== body) await gh.updateComment(p.commentId, body);
      const thread = threads.find((t) => t.commentId === p.commentId);
      if (thread && !thread.isResolved) await gh.setThreadResolved(thread.id, true);
    }
  }
  for (const p of dropped) byKey.set(p.key, { ...p, status: "resolved", resolvedIn: head });
  await save({ ...base, findings: [...byKey.values()], lastReviewedHead: head });
  log(slug, `checked ${head.slice(0, 7)}: ${changes.length} package change(s), ${checked.length} version(s) looked up, ${toPost.length} new finding(s) (${inline.length} inline), ${keptOpen.length} still open, ${dropped.length} resolved, ${hidden} hidden`);
}

/**
 * For a changed lockfile whose manifest did not change, the manifest at the
 * head, read once, so its names count as direct. npm and pnpm lockfiles and
 * `go.mod` record direct dependencies themselves.
 */
async function siblingManifests(files: PullFile[], head: string, read: (path: string, ref: string) => Promise<string | undefined>): Promise<ChangedFile[]> {
  const SIBLING: Record<string, string> = { "yarn.lock": "package.json", "Cargo.lock": "Cargo.toml", "uv.lock": "pyproject.toml", "poetry.lock": "pyproject.toml" };
  const changed = new Set(files.map((f) => f.filename));
  const wanted = new Set<string>();
  for (const f of files) {
    const slash = f.filename.lastIndexOf("/");
    const manifest = SIBLING[f.filename.slice(slash + 1)];
    if (!manifest || f.status === "removed") continue;
    const path = `${f.filename.slice(0, slash + 1)}${manifest}`;
    if (!changed.has(path)) wanted.add(path);
  }
  const out: ChangedFile[] = [];
  for (const path of wanted) {
    const text = await read(path, head).catch(() => undefined);
    // The same text at both ends: it marks direct dependencies and changes nothing.
    if (text !== undefined) out.push({ path, base: text, head: text });
  }
  return out;
}

/** Registry facts per change: the head version, and the base version of an upgrade or downgrade, direct dependencies first. */
async function registryFacts(changes: PackageChange[], opts: { fetch: typeof fetch; signal: AbortSignal; urls?: RegistryUrls }): Promise<ChangeFacts[]> {
  type Job = { i: number; end: "to" | "from"; version: string; created: boolean };
  const jobs: Job[] = [];
  const order = changes.map((c, i) => ({ c, i })).sort((a, b) => Number(b.c.direct) - Number(a.c.direct) || Number(b.c.kind === "added") - Number(a.c.kind === "added"));
  for (const { c, i } of order) {
    if (c.kind === "removed" || !c.to) continue;
    // The Go proxy gives dates only, so only an added module is worth a read.
    if (c.ecosystem === "Go" && c.kind !== "added") continue;
    jobs.push({ i, end: "to", version: c.to, created: c.kind === "added" });
    if (c.kind !== "added" && c.from && c.ecosystem !== "Go") jobs.push({ i, end: "from", version: c.from, created: false });
  }
  const out: ChangeFacts[] = changes.map(() => ({}));
  await forEachLimit(jobs.slice(0, MAX_REGISTRY_READS), REGISTRY_CONCURRENCY, async (job) => {
    const c = changes[job.i];
    const facts: PackageFacts | undefined = await packageFacts({ ecosystem: c.ecosystem, name: c.name, version: job.version, created: job.created }, opts);
    if (facts) out[job.i][job.end] = facts;
  });
  return out;
}

/** An advisory finding with its reachability verdict: shown in the body, and one severity lower when the code does not reach it. */
export function withReachability(f: DependencyFinding, v: Pick<ReachabilityVerdict, "reachable" | "evidence" | "reason">): DependencyFinding {
  if (f.kind !== "advisory") return f;
  const line =
    v.reachable === "yes" ? `**Reachable.** ${v.reason} ${v.evidence}`
      : v.reachable === "no" ? `**Not reached by this code**, so the severity is one level lower. ${v.reason} ${v.evidence}`
        : `**Reachability unknown.** ${v.reason}`;
  return { ...f, severity: v.reachable === "no" ? lowerSeverity(f.severity) : f.severity, body: `${f.body}\n\n${line.trim()}` };
}

async function judgeReachability(
  ctx: PluginEventContext,
  input: { event: PluginEvent; slug: string; repoName: string; head: string; model: string; findings: DependencyFinding[] },
): Promise<ReachabilityVerdict[] | undefined> {
  const thread = await ctx.threads.ensure(`${input.slug}:dependencies`, { title: `Dependency review ${input.slug}` });
  try {
    const child = await ctx.threads.spawnChild(
      thread,
      {
        prompt: `${buildReachabilityPrompt({ repo: input.repoName, head: input.head, findings: input.findings })}\n\n${answerFormat(ReachabilitySchema)}`,
        title: `Reachability at ${input.head.slice(0, 7)}`,
        role: REACHABILITY_ROLE,
        model: input.model,
        repo: input.repoName,
        ref: input.head,
        // The child reads untrusted advisory and PR text and has bash: its git credential must not push.
        gitAccess: "read",
      },
      { dispatchId: `${input.event.id}:${input.head.slice(0, 12)}:dependency-reachability` },
    );
    const result = await ctx.threads.awaitChild(child, { resultSchema: ReachabilitySchema });
    return result.outcome === "completed" && result.output !== undefined ? (result.output as Reachability).verdicts : undefined; // validated against ReachabilitySchema by awaitChild
  } catch (err) {
    // A child that cannot start (the child cap) loses the reachability note, never the advisories.
    if (ctx.signal.aborted) throw err;
    console.warn(`dependency review ${input.slug}: reachability child failed`, err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** Ids of open findings a person dismissed since the last run: the comment is gone, or someone else resolved its thread. */
async function dismissedFindings(gh: GitHubClient, prior: DependencyPullState | undefined): Promise<Set<string>> {
  const open = (prior?.findings ?? []).filter((p) => p.status === "open" && p.commentId !== undefined);
  if (open.length === 0) return new Set();
  const comments = new Set((await gh.reviewComments()).map((c) => c.id));
  const threads = new Map((await gh.reviewThreads()).flatMap((t) => (t.commentId !== null ? [[t.commentId, t] as const] : [])));
  const out = new Set<string>();
  for (const p of open) {
    const thread = threads.get(p.commentId ?? -1);
    if (!comments.has(p.commentId ?? -1) || thread?.isResolved) out.add(p.id);
  }
  return out;
}

async function newCommentIds(gh: GitHubClient, reviewId: number): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const c of await gh.reviewComments()) {
    if (c.pull_request_review_id !== reviewId) continue;
    for (const id of dependencyFindingIds(c.body)) ids.set(id, c.id);
  }
  return ids;
}

function log(slug: string, message: string): void {
  console.info(`dependency review ${slug}: ${message}`);
}
