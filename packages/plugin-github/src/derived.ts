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

interface DeriveAuth { token: string; refreshed: boolean }

async function getJson(ctx: DeriveContext, auth: DeriveAuth, path: string): Promise<unknown> {
  const res = await ctx.fetch(`${resolveGithubApiUrl()}${path}`, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Valet/1.0",
    },
    signal: AbortSignal.timeout(DERIVE_REQUEST_TIMEOUT_MS),
  });
  if (res.status === 401 && !res.headers.has("retry-after")) {
    if (!auth.refreshed) {
      auth.refreshed = true;
      const fresh = await ctx.appToken(true);
      if (fresh) { auth.token = fresh; return getJson(ctx, auth, path); }
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
 * pull request's head SHA is complete and each current suite with runs, PR-relevant workflow,
 * and latest commit status is terminal. `null` while that does not hold yet.
 */
export const checksCompleted: DerivedEventDef = {
  key: CHECKS_COMPLETED_KEY,
  description:
    "Current check runs, suites with runs, PR-relevant workflow runs, and latest commit status contexts on a pull request's head commit finished. Status is failure when any of them failed, else success. Use it with wait_for_event only; subscriptions do not accept it.",
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
    const token: DeriveAuth = { token: initialToken, refreshed: false };
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
    const membership = new Map<number, { run: Record<string, unknown>; attempt: number }>();
    if (allRuns.some((check) => isActions(check) && (check.status !== "completed" ||
        !["success", "neutral", "skipped"].includes(String(check.conclusion))))) {
      // filter=all carries every attempt. Job ids, not names or suite ids, are check-run ids.
      for (const run of allWorkflows) {
        if (typeof run.id !== "number") throw new Error("GitHub returned a workflow without its run id. Retry the event wait.");
        const jobs = await listStates(ctx, token, `${base}/actions/runs/${run.id}/jobs?filter=all`, "jobs", () => false);
        for (const job of jobs ?? []) {
          if (typeof job.id !== "number" || typeof job.run_attempt !== "number") {
            throw new Error("GitHub returned a job without its id or run_attempt. Retry the event wait.");
          }
          membership.set(job.id, { run, attempt: job.run_attempt });
        }
      }
    }
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
