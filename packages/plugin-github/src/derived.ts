/**
 * GitHub derived events (spec: docs/specs/2026-10-15-event-wakeups-design.md,
 * Part B). Ingest never calls `derive`. Only the WakeWatcher does, for a match
 * digest that a clause on the derived key produced (INV-E9).
 */
import type { DeriveContext, DerivedEventDef, NormalizedEvent } from "@valet/engine";
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

async function getJson(ctx: DeriveContext, token: string, path: string): Promise<unknown> {
  const res = await ctx.fetch(`${resolveGithubApiUrl()}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Valet/1.0",
    },
    signal: AbortSignal.timeout(DERIVE_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`GitHub GET ${path} answered HTTP ${res.status}.`);
  }
  return res.json();
}

interface CheckRunState { status: string; conclusion: string | null; completedAt?: string }

async function listCheckRuns(ctx: DeriveContext, token: string, base: string, sha: string): Promise<CheckRunState[]> {
  const runs: CheckRunState[] = [];
  for (let page = 1; page <= CHECK_RUNS_MAX_PAGES; page++) {
    const body = rec(await getJson(ctx, token, `${base}/commits/${sha}/check-runs?per_page=${CHECK_RUNS_PER_PAGE}&page=${page}`));
    const items = Array.isArray(body?.check_runs) ? body.check_runs : [];
    for (const item of items) {
      const run = rec(item);
      const completedAt = str(run?.completed_at);
      runs.push({ status: str(run?.status) ?? "", conclusion: str(run?.conclusion) ?? null, ...(completedAt ? { completedAt } : {}) });
    }
    const total = typeof body?.total_count === "number" ? body.total_count : runs.length;
    if (items.length < CHECK_RUNS_PER_PAGE || runs.length >= total) return runs;
  }
  throw new Error(`Commit ${sha} has more than ${CHECK_RUNS_PER_PAGE * CHECK_RUNS_MAX_PAGES} check runs. Wait on github.check_suite.completed instead.`);
}

/** Read every visible page. Refuse an incomplete snapshot at the safety limit. */
async function listStates(ctx: DeriveContext, token: string, path: string, field: string): Promise<Record<string, unknown>[]> {
  const states: Record<string, unknown>[] = [];
  for (let page = 1; page <= CHECK_RUNS_MAX_PAGES; page++) {
    const body = rec(await getJson(ctx, token, `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`));
    const items = body?.[field];
    if (!Array.isArray(items)) throw new Error(`GitHub did not return ${field}. Retry the event wait.`);
    for (const item of items) {
      const state = rec(item);
      if (!state) throw new Error(`GitHub returned an invalid ${field} entry. Retry the event wait.`);
      states.push(state);
    }
    const total = typeof body?.total_count === "number" ? body.total_count : undefined;
    if (items.length < 100 || (total !== undefined && states.length >= total)) return states;
  }
  throw new Error(`GitHub returned too many ${field} pages. Narrow the event wait.`);
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
 * `github.pull_request.checks_completed` (spec B1): every check run on the
 * pull request's head SHA is complete and every visible suite, workflow,
 * and latest commit status is terminal. `null` while that does not hold yet.
 */
export const checksCompleted: DerivedEventDef = {
  key: CHECKS_COMPLETED_KEY,
  description:
    "All visible check runs, check suites, workflow runs, and latest commit status contexts on a pull request's head commit finished. Status is failure when any of them failed, else success. Use it with wait_for_event only; subscriptions do not accept it.",
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

    const token = await ctx.appToken();
    if (!token) {
      throw new Error(`No GitHub App installation token for ${pr.owner}. Install the Valet GitHub App on ${pr.owner} in Settings.`);
    }
    const base = `/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}`;

    // Step 1: an event for an old head says nothing about the current head.
    const pull = rec(await getJson(ctx, token, `${base}/pulls/${pr.number}`));
    const headSha = str(rec(pull?.head)?.sha)?.toLowerCase();
    if (headSha !== sha) return null;

    // Step 2.
    const runs = await listCheckRuns(ctx, token, base, sha);
    const statuses = await listStates(ctx, token, `${base}/commits/${sha}/status`, "statuses");
    const suites = await listStates(ctx, token, `${base}/commits/${sha}/check-suites`, "check_suites");
    const workflows = await listStates(ctx, token, `${base}/actions/runs?head_sha=${sha}`, "workflow_runs");

    // Terminality is independent of failure. A failed context can coexist with a pending context.
    if (runs.length === 0 && statuses.length === 0) return null;
    if ([...runs, ...suites, ...workflows].some((r) => r.status !== "completed")) return null;
    if (statuses.some((s) => !["success", "failure", "error"].includes(String(s.state)))) return null;

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
