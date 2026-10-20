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
  if (res.status === 401) {
    if (!auth.refreshed) {
      auth.refreshed = true;
      const fresh = await ctx.appToken(true);
      if (fresh) { auth.token = fresh; return getJson(ctx, auth, path); }
    }
    throw new DeriveRetryError(`GitHub GET ${path} rejected the installation token. Retry with a refreshed token.`, 1_000);
  }
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429 || (res.status === 403 && (res.headers.has("retry-after") ||
        res.headers.get("x-ratelimit-remaining") === "0" || /secondary[ -]rate[ -]limit|abuse/i.test(body)))) {
      const retryAfter = res.headers.get("retry-after");
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter ?? "") - Date.now();
      throw new DeriveRetryError(`GitHub GET ${path} is rate limited. Retry after the cooldown.`, Math.max(60_000, Number.isFinite(delay) ? delay : 0));
    }
    if (res.status === 403) {
      const permission = path.includes("/actions/runs") ? "actions" : path.includes("/check-") ? "checks" : path.includes("/status") ? "statuses" : "pull_requests";
      throw new DerivePermissionError(`GitHub GET ${path} needs ${permission}: read. Ask an org owner to approve that permission.`);
    }
    throw new Error(`GitHub GET ${path} answered HTTP ${res.status}.`);
  }
  return res.json();
}

interface CheckRunState extends Record<string, unknown> { status: string; conclusion: string | null; completedAt?: string }

async function listCheckRuns(ctx: DeriveContext, token: DeriveAuth, base: string, sha: string): Promise<CheckRunState[] | null> {
  const runs: CheckRunState[] = [];
  for (let page = 1; page <= CHECK_RUNS_MAX_PAGES; page++) {
    const body = rec(await getJson(ctx, token, `${base}/commits/${sha}/check-runs?per_page=${CHECK_RUNS_PER_PAGE}&page=${page}`));
    const items = Array.isArray(body?.check_runs) ? body.check_runs : [];
    for (const item of items) {
      const run = rec(item);
      if (!run) throw new Error("GitHub returned an invalid check run. Retry the event wait.");
      // Unidentified pending checks cannot be superseded safely. Identified checks
      // need workflow/suite selection before their terminality can be decided.
      if (run.status !== "completed" && typeof rec(run.check_suite)?.id !== "number") return null;
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

/** Superseded runs and suites cannot change the latest attempt's result. */
function latestBy<T extends Record<string, unknown>>(states: T[], identity: (state: T) => string | undefined): T[] {
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
    if (!previous || (difference >= 0 && left[difference]! > right[difference]!)) latest.set(key, state);
  }
  return [...latest.values(), ...unidentified];
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
 * pull request's head SHA is complete and each current suite with runs, PR-triggered workflow,
 * and latest commit status is terminal. `null` while that does not hold yet.
 */
export const checksCompleted: DerivedEventDef = {
  key: CHECKS_COMPLETED_KEY,
  description:
    "Current check runs, suites with runs, PR-triggered workflow runs, and latest commit status contexts on a pull request's head commit finished. Status is failure when any of them failed, else success. Use it with wait_for_event only; subscriptions do not accept it.",
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

    // Check runs are the common pending case. Stop before the broader reads.
    const allRuns = await listCheckRuns(ctx, token, base, sha);
    if (allRuns === null) return null;
    const statuses = await listStates(ctx, token, `${base}/commits/${sha}/status`, "statuses", (s) => !["success", "failure", "error"].includes(String(s.state)));
    if (statuses === null) return null;
    if (allRuns.length === 0 && statuses.length === 0) return null;
    // GitHub creates suites even when an App or filtered workflow starts no runs.
    const allSuites = await listStates(ctx, token, `${base}/commits/${sha}/check-suites`, "check_suites", () => false);
    if (allSuites === null) return null;
    const allWorkflows = await listStates(ctx, token, `${base}/actions/runs?head_sha=${sha}`, "workflow_runs", () => false);
    if (allWorkflows === null) return null;
    const latestWorkflows = latestBy(allWorkflows, (run) => typeof run.workflow_id === "number" ? String(run.workflow_id) : undefined);
    const superseded = new Set<number>();
    const latestWorkflowSuites = new Set(latestWorkflows.map((run) => run.check_suite_id));
    const suiteWorkflows = new Map(allWorkflows.filter((run) => typeof run.check_suite_id === "number")
      .map((run) => [run.check_suite_id, run.workflow_id]));
    for (const run of allWorkflows) {
      if (typeof run.check_suite_id === "number" && !latestWorkflowSuites.has(run.check_suite_id)) superseded.add(run.check_suite_id);
    }
    // Actions has a suite per workflow run, not one suite per App.
    const selectedSuites = latestBy(allSuites.filter((suite) => !superseded.has(Number(suite.id))), (suite) => {
      const workflow = suiteWorkflows.get(suite.id);
      if (typeof workflow === "number") return `workflow:${workflow}`;
      const app = rec(suite.app);
      if (app?.slug === "github-actions") return undefined;
      return typeof app?.id === "number" ? `app:${app.id}` : str(app?.slug);
    });
    const selectedIds = new Set(selectedSuites.map((suite) => suite.id));
    for (const suite of allSuites) {
      if (typeof suite.id === "number" && !selectedIds.has(suite.id)) superseded.add(suite.id);
    }
    const suites = selectedSuites.filter((suite) => suite.latest_check_runs_count !== 0);
    if (suites.some((suite) => suite.status !== "completed")) return null;
    const runs = latestBy(allRuns.filter((run) => !superseded.has(Number(rec(run.check_suite)?.id))), (run) => {
      const app = rec(run.app);
      return typeof app?.id === "number" && typeof run.name === "string" ? `${app.id}:${run.name}` : undefined;
    });
    if (runs.some((run) => run.status !== "completed")) return null;
    if (runs.length === 0 && statuses.length === 0) return null;
    const workflows = latestWorkflows.filter((run) => run.event === "pull_request");
    if (workflows.some((run) => run.status !== "completed")) return null;

    const failed =
      [...runs, ...suites, ...workflows].some((r) => typeof r.conclusion === "string" && FAILED_CONCLUSIONS.has(r.conclusion)) ||
      statuses.some((s) => typeof s.state === "string" && FAILED_STATUS_STATES.has(s.state));
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
