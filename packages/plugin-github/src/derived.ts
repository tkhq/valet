/**
 * GitHub derived events (spec: docs/specs/2026-10-15-event-wakeups-design.md,
 * Part B). Ingest never calls `derive`. Only the WakeWatcher does, for a match
 * digest that a clause on the derived key produced (INV-E9).
 */
import { DerivePermissionError, DeriveRetryError, type DeriveContext, type DerivedEventDef, type NormalizedEvent } from "@valet/engine";
import { resolveGithubApiUrl } from "./actions/api.js";

export const CHECKS_COMPLETED_KEY = "github.pull_request.checks_completed";

/** Each GitHub request aborts after this long, so a hung API cannot stall a WakeWatcher tick. */
export const DERIVE_REQUEST_TIMEOUT_MS = 5_000;

const CHECK_RUNS_PER_PAGE = 100;
/** 20 pages of 100 runs. A head SHA with more runs is refused, not silently cut. */
const CHECK_RUNS_MAX_PAGES = 20;

/** Check-run conclusions that make the derived status `failure` (B1 step 4). */
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
/** Commit status contexts that make the derived status `failure` (B1 step 4). */
const FAILED_STATUS_STATES = new Set(["failure", "error"]);

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** `github:<owner>/<repo>#<number>`, or null for any other subject. */
export function parsePullRequestSubject(subject: string): { owner: string; repo: string; number: number } | null {
  const m = /^github:([^/#@\s]+)\/([^/#@\s]+)#(\d+)$/.exec(subject);
  if (!m) return null;
  return { owner: m[1].toLowerCase(), repo: m[2].toLowerCase(), number: Number(m[3]) };
}

/** The SHA of the source event's `github:<owner>/<repo>@<sha>` subject, when it has one. */
function sourceSha(source: NormalizedEvent, ownerRepo: string): string | undefined {
  const prefix = `github:${ownerRepo}@`;
  const subject = (source.subjects ?? []).find((s) => s.startsWith(prefix));
  return subject ? subject.slice(prefix.length).toLowerCase() : undefined;
}

/** Includes head/check/workflow/status reads and a possible token-refresh retry. */
export const DERIVE_MAX_REQUESTS = 32;
const JOB_REQUESTS_PER_DERIVE = 16;
const JOB_READ_CONCURRENCY = 4;
const JOB_READ_BUDGET_MS = 8_000;
const JOB_CACHE_TTL_MS = 30 * 60_000;
// One maximum workflow snapshot fits without evicting its own early pages.
const JOB_CACHE_MAX_RUNS = 2048;
class DeriveReadBudgetError extends Error {}
interface DeriveAuth { token: string; refreshed: boolean; requests: number }
interface JobMembership { checkId: number; attempt: number }
interface JobCacheEntry { jobs: JobMembership[]; nextPage: number; complete: boolean; touchedAt: number; loading?: Promise<void> }
const jobCache = new Map<string, JobCacheEntry>();

async function getJson(ctx: DeriveContext, auth: DeriveAuth, path: string, deadline?: number): Promise<unknown> {
  if (auth.requests >= DERIVE_MAX_REQUESTS || (deadline !== undefined && Date.now() >= deadline)) throw new DeriveReadBudgetError("GitHub derive read budget reached. Retry the event wait or wait on github.check_run.completed.");
  auth.requests++;
  const res = await ctx.fetch(`${resolveGithubApiUrl()}${path}`, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Valet/1.0",
    },
    signal: AbortSignal.timeout(Math.max(1, Math.min(DERIVE_REQUEST_TIMEOUT_MS, deadline === undefined ? DERIVE_REQUEST_TIMEOUT_MS : deadline - Date.now()))),
  });
  if (res.status === 401 && !res.headers.has("retry-after")) {
    if (!auth.refreshed) {
      auth.refreshed = true;
      const fresh = await ctx.appToken(true);
      if (fresh) { auth.token = fresh; return getJson(ctx, auth, path, deadline); }
    }
    throw new DeriveRetryError(`GitHub GET ${path} rejected the installation token. Retry with a refreshed token.`, 1_000);
  }
  if (!res.ok) {
    const body = await res.text();
    if (res.headers.has("retry-after") || res.status === 429 || (res.status === 403 && (
        res.headers.get("x-ratelimit-remaining") === "0" || /secondary[ -]rate[ -]limit|abuse/i.test(body)))) {
      const retryAfter = res.headers.get("retry-after");
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter ?? "") - Date.now();
      const reset = res.headers.get("x-ratelimit-remaining") === "0" ? Number(res.headers.get("x-ratelimit-reset")) * 1000 - Date.now() : 0;
      const retryAfterMs = Math.max(60_000, Number.isFinite(delay) ? delay : 0, Number.isFinite(reset) ? reset : 0);
      ctx.rateLimited?.(retryAfterMs);
      throw new DeriveRetryError(`GitHub GET ${path} is rate limited. Retry after the cooldown.`, retryAfterMs);
    }
    if (res.status === 403) {
      const endpoint = path.split("?")[0];
      const permission = /\/actions\/runs(?:\/\d+\/jobs)?$/.test(endpoint) ? "actions" : /\/(check-runs|check-suites)$/.test(endpoint) ? "checks" : /\/status$/.test(endpoint) ? "statuses" : "pull_requests";
      throw new DerivePermissionError(`GitHub GET ${path} needs ${permission}: read. Ask an org owner to approve that permission.`);
    }
    throw new Error(`GitHub GET ${path} answered HTTP ${res.status}.`);
  }
  return res.json();
}

interface CheckRunState extends Record<string, unknown> { status: string; conclusion: string | null; completedAt?: string }

async function listCheckRuns(ctx: DeriveContext, token: DeriveAuth, base: string, sha: string, pending: (run: Record<string, unknown>) => Promise<boolean>): Promise<CheckRunState[] | null> {
  const runs: CheckRunState[] = [];
  for (let page = 1; page <= CHECK_RUNS_MAX_PAGES; page++) {
    const body = rec(await getJson(ctx, token, `${base}/commits/${sha}/check-runs?filter=latest&per_page=${CHECK_RUNS_PER_PAGE}&page=${page}`));
    const items = Array.isArray(body?.check_runs) ? body.check_runs : [];
    for (const item of items) {
      const run = rec(item);
      if (!run) throw new Error("GitHub returned an invalid check run. Retry the event wait.");
      if (run.status !== "completed" && await pending(run)) return null;
      const completedAt = str(run?.completed_at);
      runs.push({ ...run, status: str(run?.status) ?? "", conclusion: str(run?.conclusion) ?? null, ...(completedAt ? { completedAt } : {}) });
    }
    const total = typeof body?.total_count === "number" ? body.total_count : runs.length;
    if (items.length < CHECK_RUNS_PER_PAGE || runs.length >= total) return runs;
  }
  throw new Error(`Commit ${sha} has more than ${CHECK_RUNS_PER_PAGE * CHECK_RUNS_MAX_PAGES} check runs. Wait on github.check_suite.completed instead.`);
}

/** Read every visible page. Refuse an incomplete snapshot at the safety limit. */
async function listStates(ctx: DeriveContext, token: DeriveAuth, path: string, field: string, nonterminal: (state: Record<string, unknown>) => boolean): Promise<Record<string, unknown>[] | null> {
  const states: Record<string, unknown>[] = [];
  for (let page = 1; page <= CHECK_RUNS_MAX_PAGES; page++) {
    const body = rec(await getJson(ctx, token, `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`));
    const items = body?.[field];
    if (!Array.isArray(items)) throw new Error(`GitHub did not return ${field}. Retry the event wait.`);
    for (const item of items) {
      const state = rec(item);
      if (!state) throw new Error(`GitHub returned an invalid ${field} entry. Retry the event wait.`);
      if (nonterminal(state)) return null;
      states.push(state);
    }
    const total = typeof body?.total_count === "number" ? body.total_count : undefined;
    if (items.length < 100 || (total !== undefined && states.length >= total)) return states;
  }
  throw new Error(`GitHub returned too many ${field} pages. Wait on github.check_run.completed or github.status for this commit instead.`);
}

function workflowKey(run: Record<string, unknown>): string | undefined {
  return typeof run.workflow_id === "number" && typeof run.event === "string" ? `${run.workflow_id}:${run.event}` : undefined;
}

/** Only these event types are unrelated to PR-head check completion. */
function excludedWorkflow(run: Record<string, unknown>): boolean {
  return run.event === "schedule" || run.event === "workflow_dispatch";
}

/** GitHub job ids usually match check ids; reporter integrations can expose the check URL instead. */
function jobCheckId(job: Record<string, unknown>): number | undefined {
  if (typeof job.check_run_url === "string") {
    try {
      const tail = new URL(job.check_run_url).pathname.split("/").filter(Boolean).at(-1);
      if (tail && /^\d+$/.test(tail) && Number.isSafeInteger(Number(tail))) return Number(tail);
    } catch { /* An absent or malformed URL falls back to the job id. */ }
  }
  return typeof job.id === "number" ? job.id : undefined;
}

/** Bounded page workers retain completed pages across retries of immutable finished runs. */
async function readJobMembership(ctx: DeriveContext, auth: DeriveAuth, base: string, runs: Record<string, unknown>[]): Promise<Map<number, { run: Record<string, unknown>; attempt: number }>> {
  const now = Date.now();
  for (const [key, entry] of jobCache) if (entry.touchedAt + JOB_CACHE_TTL_MS <= now) jobCache.delete(key);
  const work = runs.map((run) => {
    if (typeof run.id !== "number") throw new Error("GitHub returned a workflow without its run id. Retry the event wait.");
    const key = JSON.stringify([ctx.orgId, resolveGithubApiUrl(), base, run.id, run.run_attempt ?? 1]);
    const cached = run.status === "completed" ? jobCache.get(key) : undefined;
    const entry: JobCacheEntry = cached ?? { jobs: [], nextPage: 1, complete: false, touchedAt: now };
    entry.touchedAt = now;
    if (run.status === "completed") {
      jobCache.delete(key);
      if (jobCache.size >= JOB_CACHE_MAX_RUNS) jobCache.delete(jobCache.keys().next().value ?? "");
      jobCache.set(key, entry);
    }
    return { run, entry };
  });
  const queue = work.filter(({ entry }) => !entry.complete);
  let remaining = Math.min(JOB_REQUESTS_PER_DERIVE, Math.max(0, DERIVE_MAX_REQUESTS - auth.requests - 4));
  const deadline = now + JOB_READ_BUDGET_MS;
  const worker = async () => {
    while (queue.length > 0 && remaining > 0 && Date.now() < deadline) {
      const item = queue.shift();
      if (!item) break;
      const { run, entry } = item;
      if (!entry.loading) {
        remaining--;
        entry.loading = (async () => {
          const body = rec(await getJson(ctx, auth, `${base}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${entry.nextPage}`, deadline));
          if (!Array.isArray(body?.jobs)) throw new Error("GitHub did not return jobs. Retry the event wait.");
          const page: JobMembership[] = body.jobs.map((value) => {
            const job = rec(value);
            const checkId = job ? jobCheckId(job) : undefined;
            if (checkId === undefined || typeof job?.run_attempt !== "number") throw new Error("GitHub returned a job without its check id or run_attempt. Retry the event wait.");
            return { checkId, attempt: job.run_attempt };
          });
          entry.jobs.push(...page);
          entry.nextPage++;
          entry.complete = page.length < 100 || (typeof body.total_count === "number" && entry.jobs.length >= body.total_count);
        })();
      }
      try { await entry.loading; } catch (error) {
        if (error instanceof DeriveReadBudgetError || Date.now() >= deadline) break;
        throw error;
      } finally { entry.loading = undefined; }
      if (!entry.complete) queue.push(item);
    }
  };
  await Promise.all(Array.from({ length: JOB_READ_CONCURRENCY }, worker));
  const membership = new Map<number, { run: Record<string, unknown>; attempt: number }>();
  for (const { run, entry } of work) for (const job of entry.jobs) membership.set(job.checkId, { run, attempt: job.attempt });
  return membership;
}

/** Superseded runs and suites cannot change the latest attempt's result. */
function latestBy<T extends Record<string, unknown>>(states: T[], identity: (state: T) => string | undefined, newer?: (left: T, right: T) => boolean): T[] {
  const latest = new Map<string, T>();
  const unidentified: T[] = [];
  const order = (state: Record<string, unknown>) => [
    typeof state.run_number === "number" ? state.run_number : 0,
    typeof state.id === "number" ? state.id : 0,
    typeof state.run_attempt === "number" ? state.run_attempt : 0,
    Date.parse(str(state.created_at) ?? "") || 0,
  ];
  for (const state of states) {
    const key = identity(state);
    if (key === undefined) { unidentified.push(state); continue; }
    const previous = latest.get(key);
    const left = order(state);
    const right = previous ? order(previous) : [];
    const difference = left.findIndex((value, index) => value !== right[index]);
    if (!previous || (newer ? newer(state, previous) : difference >= 0 && left[difference]! > right[difference]!)) latest.set(key, state);
  }
  return [...latest.values(), ...unidentified];
}

/** Completion time orders finished checks. Missing times, including pending jobs, fall back to id. */
function newerCheck(left: CheckRunState, right: CheckRunState): boolean {
  const leftTime = Date.parse(left.completedAt ?? "");
  const rightTime = Date.parse(right.completedAt ?? "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime > rightTime;
  return (typeof left.id === "number" ? left.id : 0) > (typeof right.id === "number" ? right.id : 0);
}

/**
 * The latest finish time among the check runs (`completed_at`) and the
 * commit statuses (`updated_at`), as ISO 8601, or `0` when none reports
 * one. A re-run on the same SHA finishes later, so its derived event gets
 * a new dedupe key (spec B1 step 5).
 */
export function latestCompletedAt(runs: readonly { completedAt?: string }[], statuses: readonly unknown[]): string {
  let latest = Number.NEGATIVE_INFINITY;
  const consider = (value: string | undefined) => {
    const ms = value === undefined ? Number.NaN : Date.parse(value);
    if (Number.isFinite(ms) && ms > latest) latest = ms;
  };
  for (const run of runs) consider(run.completedAt);
  for (const status of statuses) consider(str(rec(status)?.updated_at));
  return Number.isFinite(latest) ? new Date(latest).toISOString() : "0";
}

/**
 * `github.pull_request.checks_completed` (spec B1): each selected check run on the
 * pull request's head SHA and each latest commit status is terminal.
 * Suite and workflow conclusions never determine the result.
 */
export const checksCompleted: DerivedEventDef = {
  key: CHECKS_COMPLETED_KEY,
  description:
    "Selected check runs and latest commit status contexts on a pull request's head commit finished. Status is failure when a selected check or status failed, else success. Suite and workflow conclusions do not determine the result. Use it with wait_for_event only; subscriptions do not accept it.",
  sources: [
    "github.check_run.completed",
    "github.check_suite.completed",
    "github.workflow_run.completed",
    "github.status",
  ],
  async derive(ctx, subject, source) {
    const pr = parsePullRequestSubject(subject);
    if (!pr) {
      throw new Error(`${CHECKS_COMPLETED_KEY} needs a pull request subject such as github:owner/repo#42, not "${subject}".`);
    }
    const ownerRepo = `${pr.owner}/${pr.repo}`;
    const sha = sourceSha(source, ownerRepo);
    // A source with no commit of this repository cannot settle the head SHA.
    if (!sha) return null;

    const initialToken = await ctx.appToken();
    if (!initialToken) {
      throw new Error(`No GitHub App installation token for ${pr.owner}. Install the Valet GitHub App on ${pr.owner} in Settings.`);
    }
    const token: DeriveAuth = { token: initialToken, refreshed: false, requests: 0 };
    const base = `/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}`;

    // Step 1: an event for an old head says nothing about the current head.
    const pull = rec(await getJson(ctx, token, `${base}/pulls/${pr.number}`));
    const headSha = str(rec(pull?.head)?.sha)?.toLowerCase();
    if (headSha !== sha) return null;

    // Pending current jobs can stop after head, checks, and workflow reads.
    // This is only a conservative early exit, never evidence for dropping a check.
    let workflowRead: Promise<Record<string, unknown>[] | null> | undefined;
    const readWorkflows = () => workflowRead ??= listStates(ctx, token, `${base}/actions/runs?head_sha=${sha}`, "workflow_runs", () => false);
    const isActions = (check: Record<string, unknown>) => rec(check.app)?.slug === "github-actions";
    const allRuns = await listCheckRuns(ctx, token, base, sha, async (check) => {
      if (!isActions(check)) return false;
      return latestBy(await readWorkflows() ?? [], workflowKey).some((run) =>
        !excludedWorkflow(run) && run.status !== "completed" && run.check_suite_id === rec(check.check_suite)?.id);
    });
    if (allRuns === null) return null;
    const allWorkflows = await readWorkflows();
    if (allWorkflows === null) return null;
    const selected = new Set(latestBy(allWorkflows, workflowKey));
    const candidates = allWorkflows.filter((run) => !selected.has(run) || excludedWorkflow(run) ||
      (typeof run.run_attempt === "number" && run.run_attempt > 1));
    const safeSuites = new Set(allWorkflows.filter((run) => !candidates.includes(run)).map((run) => run.check_suite_id));
    const needsMembership = allRuns.some((check) => isActions(check) &&
      (check.status !== "completed" || !["success", "neutral", "skipped"].includes(String(check.conclusion))) &&
      !safeSuites.has(rec(check.check_suite)?.id));
    // Current attempt-1 jobs all participate. Only potentially droppable checks need classification.
    // At the read budget, unmapped checks stay rather than using incomplete evidence to drop them.
    const membership = await readJobMembership(ctx, token, base, needsMembership ? candidates : []);
    const actions = allRuns.filter((check) => {
      if (!isActions(check)) return false;
      const job = typeof check.id === "number" ? membership.get(check.id) : undefined;
      // Unmapped Checks-API reporters always participate, even in excluded or old suites.
      return !job || (!excludedWorkflow(job.run) && selected.has(job.run) &&
        job.attempt >= (typeof job.run.run_attempt === "number" ? job.run.run_attempt : 1));
    });
    const otherChecks = latestBy(allRuns.filter((check) => !isActions(check)), (check) => {
      const app = rec(check.app);
      return typeof app?.id === "number" && typeof check.name === "string" ? `${app.id}:${check.name}` : undefined;
    }, newerCheck);
    const runs = [...actions, ...otherChecks];
    if (runs.some((run) => run.status !== "completed")) return null;
    // Suites and workflow conclusions are not check results. A zero-run queued suite adds no work.
    const statuses = await listStates(ctx, token, `${base}/commits/${sha}/status`, "statuses", (state) => !["success", "failure", "error"].includes(String(state.state)));
    if (statuses === null || (runs.length === 0 && statuses.length === 0)) return null;

    const failed = runs.some((run) => typeof run.conclusion === "string" && FAILED_CONCLUSIONS.has(run.conclusion)) ||
      statuses.some((state) => typeof state.state === "string" && FAILED_STATUS_STATES.has(state.state));
    const status = failed ? "failure" : "success";
    const label = `${ownerRepo}#${pr.number}`;
    const htmlUrl = str(pull?.html_url);

    // The checks above describe only this SHA. A concurrent push invalidates that snapshot.
    const current = rec(await getJson(ctx, token, `${base}/pulls/${pr.number}`));
    if (str(rec(current?.head)?.sha)?.toLowerCase() !== sha) return null;

    return {
      key: CHECKS_COMPLETED_KEY,
      // Step 5.
      dedupeKey: `derived:checks_completed:${ownerRepo}@${sha}:${status}:${latestCompletedAt(runs, statuses)}`,
      occurredAt: source.occurredAt,
      refs: { repo: ownerRepo, pull_request: String(pr.number), head_sha: sha },
      summary: failed ? `Checks failed on ${label}` : `All checks passed on ${label}`,
      payload: { ...(htmlUrl ? { html_url: htmlUrl } : {}), head_sha: sha, number: pr.number },
      subjects: [`github:${pr.owner}`, `github:${ownerRepo}`, `github:${ownerRepo}#${pr.number}`, `github:${ownerRepo}@${sha}`],
      status,
    };
  },
};

export const githubDerivedEvents: DerivedEventDef[] = [checksCompleted];
