import { describe, expect, it, vi } from "vitest";
import type { DeriveContext, NormalizedEvent } from "@valet/engine";
import { checksCompleted, latestCompletedAt } from "./derived.js";

// Spec: docs/specs/2026-10-15-event-wakeups-design.md, Part B1 and the B2
// vectors. A stub `fetch` serves fixture JSON; no test reaches the network.

const HEAD = "aaaa000000000000000000000000000000000001";
const OLD = "bbbb000000000000000000000000000000000002";
const PR_SUBJECT = "github:acme/lean-proofs#42";

interface CheckRun {
  status: string; conclusion: string | null; completed_at?: string;
  id?: number; name?: string; check_suite?: { id: number }; app?: { id: number; slug?: string };
}
interface SuiteState {
  status: string;
  latest_check_runs_count?: number;
  id?: number;
  conclusion?: string | null;
  app?: { id?: number; slug?: string };
}
interface WorkflowState {
  status: string;
  event?: string;
  conclusion?: string | null;
  workflow_id?: number;
  id?: number;
  run_number?: number;
  run_attempt?: number;
  check_suite_id?: number;
  head_sha?: string;
}
interface Fixture {
  head?: string;
  finalHead?: string;
  suites?: SuiteState[];
  workflows?: WorkflowState[];
  workflowPages?: WorkflowState[][];
  statusPages?: { state: string }[][];
  /** Check-run pages, in order. */
  pages?: CheckRun[][];
  jobs?: Record<number, { id: number; name: string; run_attempt: number; check_run_url?: string }[]>;
  combined?: { state: string; statuses: { state: string; updated_at?: string }[] };
  /** A path that answers with this HTTP status instead of fixture JSON. */
  failPath?: { path: string; status: number; body?: string; headers?: Record<string, string> };
}

function stubFetch(fixture: Fixture): { fetch: typeof fetch; calls: string[]; signals: (AbortSignal | null | undefined)[]; auth: (string | null)[] } {
  const calls: string[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const auth: (string | null)[] = [];
  const allChecks = (fixture.pages ?? [[]]).flat();
  for (const check of allChecks) {
    expect(check).toMatchObject({ id: expect.any(Number), name: expect.any(String), app: { id: expect.any(Number) }, check_suite: { id: expect.any(Number) } });
  }
  const listedWorkflows = fixture.workflowPages?.flat() ?? fixture.workflows ?? [];
  expect(new Set(listedWorkflows.map((run) => run.id)).size).toBe(listedWorkflows.length);
  let headReads = 0;
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const pathAndQuery = `${url.pathname}${url.search}`;
    calls.push(pathAndQuery);
    signals.push(init?.signal);
    auth.push(new Headers(init?.headers).get("authorization"));
    if (fixture.failPath && url.pathname === fixture.failPath.path) {
      return new Response(fixture.failPath.body ?? "bad gateway", { status: fixture.failPath.status, headers: fixture.failPath.headers });
    }
    if (url.pathname === "/repos/acme/lean-proofs/pulls/42") {
      return Response.json({ number: 42, html_url: "https://github.com/acme/lean-proofs/pull/42", head: { sha: ++headReads > 1 ? fixture.finalHead ?? fixture.head ?? HEAD : fixture.head ?? HEAD } });
    }
    const runs = url.pathname.match(/^\/repos\/acme\/lean-proofs\/commits\/([0-9a-f]+)\/check-runs$/);
    if (runs) {
      const page = Number(url.searchParams.get("page") ?? "1");
      let checks = runs[1] === (fixture.head ?? HEAD) ? allChecks : [];
      if (url.searchParams.get("filter") === "latest") {
        const latest = new Map<string, CheckRun>();
        for (const check of checks) {
          const key = `${check.app?.id}:${check.check_suite?.id}:${check.name}`;
          const previous = latest.get(key);
          if (!previous || (check.id ?? 0) > (previous.id ?? 0)) latest.set(key, check);
        }
        checks = [...latest.values()];
      }
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      return Response.json({ total_count: checks.length, check_runs: checks.slice((page - 1) * perPage, page * perPage) });
    }
    if (url.pathname.match(/^\/repos\/acme\/lean-proofs\/commits\/[0-9a-f]+\/status$/)) {
      return Response.json(fixture.statusPages ? { statuses: fixture.statusPages[Number(url.searchParams.get("page")) - 1] ?? [] } : fixture.combined ?? { state: "pending", statuses: [] });
    }
    if (url.pathname.endsWith("/check-suites")) return Response.json({ check_suites: fixture.suites ?? [] });
    const jobs = url.pathname.match(/\/actions\/runs\/(\d+)\/jobs$/);
    if (jobs) {
      const items = fixture.jobs?.[Number(jobs[1])] ?? [];
      const page = Number(url.searchParams.get("page") ?? "1");
      return Response.json({ total_count: items.length, jobs: items.slice((page - 1) * 100, page * 100).map((job) => ({ ...job, ...(!("check_run_url" in job) ? { check_run_url: `https://api.github.com/repos/acme/lean-proofs/check-runs/${job.id}` } : {}) })) });
    }
    if (url.pathname.endsWith("/actions/runs")) {
      const workflows = fixture.workflowPages?.[Number(url.searchParams.get("page")) - 1] ?? fixture.workflows ?? [];
      return Response.json({ workflow_runs: workflows.filter((run) => !url.searchParams.has("head_sha") || (run.head_sha ?? HEAD) === url.searchParams.get("head_sha")) });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch: impl, calls, signals, auth };
}

let nextFixtureOrg = 0;
const fixtureOrgs = new WeakMap<typeof fetch, string>();
function ctxWith(f: typeof fetch, token: string | null = "ghs_test"): DeriveContext {
  let orgId = fixtureOrgs.get(f);
  if (!orgId) { orgId = `fixture-${++nextFixtureOrg}`; fixtureOrgs.set(f, orgId); }
  return { orgId, appToken: async () => token, fetch: f };
}

function source(sha: string, key = "github.check_run.completed"): NormalizedEvent {
  return {
    key,
    dedupeKey: "delivery-1",
    occurredAt: "2026-10-15T12:00:00.000Z",
    refs: {},
    summary: "check run completed",
    payload: null,
    subjects: ["github:acme", "github:acme/lean-proofs", PR_SUBJECT, `github:acme/lean-proofs@${sha}`],
    status: "success",
  };
}

const DONE_AT = "2026-10-15T12:00:00.000Z";
const ok = (n: number): CheckRun[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `job-${i}`, app: { id: 2, slug: "ci" }, check_suite: { id: 1 }, status: "completed", conclusion: "success", completed_at: DONE_AT }));
const actionJob = (suite: number, status = "completed", conclusion: string | null = "success"): CheckRun => ({
  completed_at: status === "completed" ? DONE_AT : undefined,
  id: suite * 10, name: "test", app: { id: 1, slug: "github-actions" }, check_suite: { id: suite }, status, conclusion,
});
const workflow = (id: number, event = "pull_request", status = "completed", conclusion = "success"): WorkflowState => ({
  head_sha: HEAD, id, run_number: id, run_attempt: 1, workflow_id: 1, check_suite_id: id, event, status, conclusion: status === "completed" ? conclusion : null,
});

describe("checksCompleted (spec B1)", () => {
  it("declares the derived key and its sources", () => {
    expect(checksCompleted.key).toBe("github.pull_request.checks_completed");
    expect(checksCompleted.sources).toEqual([
      "github.check_run.completed",
      "github.check_suite.completed",
      "github.workflow_run.completed",
      "github.status",
    ]);
  });

  describe("B2 vectors", () => {
    it("returns null when the source SHA is an old head", async () => {
      const stub = stubFetch({ head: HEAD, pages: [ok(2)], combined: { state: "success", statuses: [] } });
      expect(await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(OLD))).toBeNull();
      // Step 1 stops before any check-run read.
      expect(stub.calls).toEqual(["/repos/acme/lean-proofs/pulls/42"]);
    });

    it("returns null while one check run is in_progress", async () => {
      const stub = stubFetch({ pages: [[...ok(2), actionJob(10, "in_progress", null)]], workflows: [workflow(10, "pull_request", "in_progress")], combined: { state: "pending", statuses: [] } });
      expect(await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).toBeNull();
      expect(stub.calls).toHaveLength(3);
      expect(stub.calls[1]).toContain("/check-runs?");
    });

    it("returns status success when all runs succeed and there are no statuses", async () => {
      const stub = stubFetch({ pages: [ok(3)], combined: { state: "pending", statuses: [] } });
      const event = await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD));
      expect(event?.status).toBe("success");
      expect(event?.key).toBe("github.pull_request.checks_completed");
      expect(event?.dedupeKey).toBe(`derived:checks_completed:acme/lean-proofs@${HEAD}:success:${DONE_AT}`);
    });

    it("returns status failure when all runs complete and one fails", async () => {
      const stub = stubFetch({ pages: [[...ok(2), { ...ok(1)[0], id: 201, name: "failed-job", status: "completed", conclusion: "failure", completed_at: "2026-10-15T12:05:00Z" }]], combined: { state: "pending", statuses: [] } });
      const event = await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD));
      expect(event?.status).toBe("failure");
      expect(event?.dedupeKey).toBe(`derived:checks_completed:acme/lean-proofs@${HEAD}:failure:2026-10-15T12:05:00.000Z`);
    });

    it("returns null when all runs succeed but the combined status is pending with one status", async () => {
      const stub = stubFetch({ pages: [ok(2)], combined: { state: "pending", statuses: [{ state: "pending" }] } });
      expect(await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).toBeNull();
    });
  });

  it.each(["timed_out", "cancelled", "action_required", "startup_failure"])("treats conclusion %s as failure", async (conclusion) => {
    const stub = stubFetch({ pages: [[...ok(1), { ...ok(1)[0], id: 201, name: "failed-job", status: "completed", conclusion }]], combined: { state: "pending", statuses: [] } });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("failure");
  });

  it.each(["failure", "error"])("treats combined status %s as failure", async (state) => {
    const stub = stubFetch({ pages: [ok(1)], combined: { state, statuses: [{ state }] } });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("failure");
  });

  it.each(["queued", "in_progress", "requested", "waiting", "pending"])("does not infer pending work from a %s suite before a check exists", async (status) => {
    const early = stubFetch({ pages: [ok(1)], suites: [{ id: 10, app: { id: 2, slug: "ci" }, status, latest_check_runs_count: 1 }] });
    expect((await checksCompleted.derive(ctxWith(early.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
    const later = stubFetch({ pages: [[...ok(1), actionJob(11, "queued", null)]], workflows: [workflow(11, "pull_request", "queued")] });
    expect(await checksCompleted.derive(ctxWith(later.fetch), PR_SUBJECT, source(HEAD))).toBeNull();
  });

  it("ignores a zero-run queued App suite", async () => {
    const stub = stubFetch({ pages: [ok(1)], suites: [{ id: 10, app: { id: 2, slug: "ci" }, status: "queued", latest_check_runs_count: 0 }] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("ignores an Actions suite when filters skip every workflow", async () => {
    const stub = stubFetch({ pages: [ok(1)], suites: [{ id: 10, status: "queued", latest_check_runs_count: 0, app: { id: 1, slug: "github-actions" } }] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("does not infer pending work from an approval-gated workflow without checks", async () => {
    const stub = stubFetch({ pages: [ok(1)], workflows: [workflow(10, "push", "waiting")] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("stops on a current Actions job before reading suites or statuses", async () => {
    const stub = stubFetch({ pages: [[actionJob(10, "queued", null), ...ok(99)], ok(1)], workflows: [workflow(10, "pull_request", "queued")] });
    expect(await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).toBeNull();
    expect(stub.calls).toHaveLength(3);
    expect(stub.calls.some((path) => path.includes("page=2"))).toBe(false);
  });

  it("returns null for pending statuses after selecting checks", async () => {
    const stub = stubFetch({ pages: [ok(1)], combined: { state: "pending", statuses: [{ state: "pending" }] } });
    expect(await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).toBeNull();
    expect(stub.calls).toHaveLength(4);
  });

  it("does not infer pending work from a workflow without checks", async () => {
    const stub = stubFetch({ pages: [ok(1)], workflows: [workflow(10, "pull_request", "queued")] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("reads every workflow page when selecting job membership", async () => {
    const stub = stubFetch({ pages: [[actionJob(10, "completed", "failure"), ...ok(1)]], workflowPages: [Array.from({ length: 100 }, (_, i) => ({ ...workflow(i + 1), workflow_id: i + 1, run_attempt: 2 })), [{ ...workflow(101), run_attempt: 2 }]], jobs: { 10: [{ id: 100, name: "test", run_attempt: 1 }] } });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
    expect(stub.calls).toContain(`/repos/acme/lean-proofs/actions/runs?head_sha=${HEAD}&per_page=100&page=2`);
    expect(stub.calls.filter((path) => path.includes("/jobs?"))).toHaveLength(16);
  });

  it("refuses a partial status snapshot at the pagination safety limit", async () => {
    const stub = stubFetch({ pages: [ok(1)], statusPages: Array.from({ length: 20 }, () => Array.from({ length: 100 }, () => ({ state: "success" }))) });
    await expect(checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).rejects.toThrow("too many statuses pages");
  });

  it("ignores cancelled jobs from a superseded Actions suite on the same SHA", async () => {
    const stub = stubFetch({ jobs: { 1: [{ id: 1, name: "test", run_attempt: 1 }] }, pages: [[
      { id: 1, name: "test", app: { id: 1, slug: "github-actions" }, check_suite: { id: 10 }, completed_at: DONE_AT, status: "completed", conclusion: "cancelled" },
      { id: 2, name: "test", app: { id: 1, slug: "github-actions" }, check_suite: { id: 20 }, completed_at: DONE_AT, status: "completed", conclusion: "success" },
    ]], suites: [
      { id: 10, app: { id: 1, slug: "github-actions" }, latest_check_runs_count: 1, status: "completed", conclusion: "cancelled" },
      { id: 20, app: { id: 1, slug: "github-actions" }, latest_check_runs_count: 1, status: "completed", conclusion: "success" },
    ], workflows: [
      { id: 1, workflow_id: 1, check_suite_id: 10, event: "pull_request", status: "completed", conclusion: "cancelled" },
      { id: 2, workflow_id: 1, check_suite_id: 20, event: "pull_request", status: "completed", conclusion: "success" },
    ] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it.each(["superseded", "workflow_dispatch"])("keeps a failed reporter sharing a %s Actions suite", async (kind) => {
    const ignored = workflow(10, kind === "superseded" ? "pull_request" : "workflow_dispatch");
    const reporter = { ...actionJob(10, "completed", "failure"), id: 999, name: "JUnit reporter" };
    const stub = stubFetch({ pages: [[reporter, actionJob(20)]], workflows: [ignored, workflow(20)], jobs: {
      10: [{ id: 101, name: "JUnit reporter", run_attempt: 1 }],
    }, suites: [
      { id: 10, app: { id: 1, slug: "github-actions" }, status: "completed", conclusion: "success", latest_check_runs_count: 1 },
      { id: 20, app: { id: 1, slug: "github-actions" }, status: "completed", conclusion: "success", latest_check_runs_count: 1 },
    ] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("failure");
    expect(stub.calls.filter((path) => path.includes("/jobs?"))).toEqual(["/repos/acme/lean-proofs/actions/runs/10/jobs?filter=all&per_page=100&page=1"]);
  });

  it("does not supersede an unmapped same-name Actions reporter by App and name", async () => {
    const stub = stubFetch({ pages: [[actionJob(10, "completed", "failure"), actionJob(20)]], workflows: [workflow(10), workflow(20)], jobs: { 10: [{ id: 999, name: "test", run_attempt: 1 }], 20: [{ id: 200, name: "test", run_attempt: 1 }] } });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("failure");
  });

  it("keeps a failed check when an ignored suite's jobs do not prove membership", async () => {
    const stub = stubFetch({ pages: [[actionJob(10, "completed", "failure"), actionJob(20)]], workflows: [workflow(10, "workflow_dispatch"), workflow(20)] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("failure");
  });

  it("uses a job id even when its check name differs", async () => {
    const stub = stubFetch({ pages: [[actionJob(10, "completed", "failure"), actionJob(20)]], workflows: [workflow(10, "workflow_dispatch"), workflow(20)], jobs: { 10: [{ id: 100, name: "renamed build", run_attempt: 1 }] } });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("shares one jobs read for multiple non-passing checks in an ignored suite", async () => {
    const stub = stubFetch({ pages: [[actionJob(10, "completed", "failure"), { ...actionJob(10, "completed", "failure"), id: 101, name: "JUnit reporter" }, actionJob(20)]], workflows: [workflow(10, "workflow_dispatch"), workflow(20)], jobs: { 10: [{ id: 100, name: "test", run_attempt: 1 }] } });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("failure");
    expect(stub.calls.filter((path) => path.includes("/jobs?"))).toHaveLength(1);
  });

  it("does not fetch jobs for an all-green PR, including excluded suites", async () => {
    const stub = stubFetch({ pages: [[actionJob(10), actionJob(20)]], workflows: [workflow(10, "workflow_dispatch"), workflow(20)] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
    expect(stub.calls.some((path) => path.includes("/jobs?"))).toBe(false);
  });

  it("reads every jobs page before proving a non-passing check is excluded", async () => {
    const stub = stubFetch({ pages: [[actionJob(10, "completed", "failure"), actionJob(20)]], workflows: [workflow(10, "workflow_dispatch"), workflow(20)], jobs: { 10: [...Array.from({ length: 100 }, (_, i) => ({ id: i, name: `other-${i}`, run_attempt: 1 })), { id: 100, name: "test", run_attempt: 1 }] } });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
    expect(stub.calls).toContain("/repos/acme/lean-proofs/actions/runs/10/jobs?filter=all&per_page=100&page=2");
  });

  it("names Actions read access when job membership cannot be read", async () => {
    const stub = stubFetch({ pages: [[actionJob(10, "completed", "failure"), actionJob(20)]], workflows: [workflow(10, "workflow_dispatch"), workflow(20)], failPath: { path: "/repos/acme/lean-proofs/actions/runs/10/jobs", status: 403 } });
    await expect(checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).rejects.toThrow("actions: read");
  });

  it("prefers the check_run_url id to the Actions job id", async () => {
    const stub = stubFetch({ pages: [[actionJob(10, "completed", "failure"), actionJob(20)]], workflows: [workflow(10, "workflow_dispatch"), workflow(20)], jobs: { 10: [{ id: 9999, name: "test", run_attempt: 1, check_run_url: "https://api.github.com/repos/acme/lean-proofs/check-runs/100" }] } });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it.each([undefined, "not a URL"])("falls back to the job id for check_run_url %s", async (url) => {
    const stub = stubFetch({ pages: [[actionJob(10, "completed", "failure"), actionJob(20)]], workflows: [workflow(10, "workflow_dispatch"), workflow(20)], jobs: { 10: [{ id: 100, name: "test", run_attempt: 1, check_run_url: url }] } });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("resumes a large matrix from cached pages under the total request cap", async () => {
    const old = { ...actionJob(10, "completed", "failure"), id: 10000, name: "old matrix job" };
    const stub = stubFetch({ pages: [[old, actionJob(20)]], workflows: [{ ...workflow(10), run_attempt: 2 }], jobs: { 10: [
      ...Array.from({ length: 2500 }, (_, i) => ({ id: i + 100000, name: `matrix-${i}`, run_attempt: 2 })),
      { id: 10000, name: "old matrix job", run_attempt: 1 },
    ] } });
    const ctx = ctxWith(stub.fetch);
    expect((await checksCompleted.derive(ctx, PR_SUBJECT, source(HEAD)))?.status).toBe("failure"); // Conservative until membership is known.
    expect(stub.calls.filter((path) => path.includes("/jobs?"))).toHaveLength(16);
    expect(stub.calls.length).toBeLessThanOrEqual(32);
    const before = stub.calls.length;
    expect((await checksCompleted.derive(ctx, PR_SUBJECT, source(HEAD)))?.status).toBe("success");
    const retry = stub.calls.slice(before);
    expect(retry.some((path) => path.endsWith("page=17"))).toBe(true);
    expect(retry.some((path) => path.includes("/jobs?") && path.endsWith("page=1"))).toBe(false);
    expect(retry.length).toBeLessThanOrEqual(32);
    const complete = stub.calls.length;
    expect((await checksCompleted.derive(ctx, PR_SUBJECT, source(HEAD)))?.status).toBe("success");
    expect(stub.calls.slice(complete).some((path) => path.includes("/jobs?"))).toBe(false);
  });

  it("invalidates finished-job membership when the run attempt changes", async () => {
    const run = { ...workflow(10), run_attempt: 2 };
    const stub = stubFetch({ pages: [[actionJob(10, "completed", "failure"), actionJob(20)]], workflows: [run], jobs: { 10: [{ id: 100, name: "test", run_attempt: 1 }] } });
    const ctx = ctxWith(stub.fetch);
    expect((await checksCompleted.derive(ctx, PR_SUBJECT, source(HEAD)))?.status).toBe("success");
    run.run_attempt = 3;
    expect((await checksCompleted.derive(ctx, PR_SUBJECT, source(HEAD)))?.status).toBe("success");
    expect(stub.calls.filter((path) => path.includes("/jobs?") && path.endsWith("page=1"))).toHaveLength(2);
  });

  it("keeps a running PR run when a newer push run of the same workflow passed (A)", async () => {
    const stub = stubFetch({ pages: [[actionJob(10, "in_progress", null), actionJob(11)]], workflows: [workflow(10, "pull_request", "in_progress"), workflow(11, "push")] });
    expect(await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).toBeNull();
    expect(stub.calls).toHaveLength(3);
  });

  it("keeps a failed push run when the PR run of the same workflow passed (B)", async () => {
    const stub = stubFetch({ pages: [[actionJob(10, "completed", "failure"), actionJob(11)]], workflows: [workflow(10, "push", "completed", "failure"), workflow(11)] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("failure");
  });

  it("bot repro 1: a failed PR run survives a newer successful push run and suite", async () => {
    const stub = stubFetch({ pages: [[actionJob(5, "completed", "failure"), actionJob(6)]], workflows: [workflow(5, "pull_request", "completed", "failure"), workflow(6, "push")], suites: [
      { id: 5, app: { id: 1, slug: "github-actions" }, status: "completed", conclusion: "failure", latest_check_runs_count: 1 },
      { id: 6, app: { id: 1, slug: "github-actions" }, status: "completed", conclusion: "success", latest_check_runs_count: 1 },
    ] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("failure");
  });

  it("counts a failed pull_request_review workflow alongside a passed pull_request run", async () => {
    const stub = stubFetch({ pages: [[actionJob(10, "completed", "failure"), actionJob(11)]], workflows: [workflow(10, "pull_request_review", "completed", "failure"), workflow(11)] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("failure");
  });

  it("waits for an in-progress pull_request_target run on the head SHA", async () => {
    const stub = stubFetch({ pages: [[actionJob(10, "in_progress", null), actionJob(11)]], workflows: [workflow(10, "pull_request_target", "in_progress"), workflow(11), { ...workflow(12, "pull_request_target"), head_sha: OLD }] });
    expect(await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).toBeNull();
  });

  it.each(["failure", null])("keeps an unmapped Checks-API reporter job (%s)", async (conclusion) => {
    const reporter = { ...actionJob(99, conclusion ? "completed" : "in_progress", conclusion), name: "test reporter" };
    const stub = stubFetch({ pages: [[actionJob(10), reporter]], workflows: [workflow(10)], suites: [
      { id: 99, app: { id: 1, slug: "github-actions" }, status: reporter.status, conclusion, latest_check_runs_count: 1 },
    ] });
    const event = await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD));
    if (conclusion) expect(event?.status).toBe("failure");
    else expect(event).toBeNull();
  });

  it("uses the latest labeled PR run even when it skips all jobs after a synchronize failure", async () => {
    const stub = stubFetch({ jobs: { 10: [{ id: 100, name: "test", run_attempt: 1 }] }, pages: [[actionJob(10, "completed", "failure")]], workflows: [workflow(10, "pull_request", "completed", "failure"), workflow(11, "pull_request", "completed", "skipped")], suites: [
      { id: 10, app: { id: 1, slug: "github-actions" }, status: "completed", conclusion: "failure", latest_check_runs_count: 1 },
      { id: 11, app: { id: 1, slug: "github-actions" }, status: "completed", conclusion: "skipped", latest_check_runs_count: 0 },
    ] });
    expect(await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).toBeNull(); // No selected checks remain.
    const withOtherCheck = stubFetch({ jobs: { 10: [{ id: 100, name: "test", run_attempt: 1 }] }, pages: [[actionJob(10, "completed", "failure"), ...ok(1)]], workflows: [workflow(10, "pull_request", "completed", "failure"), workflow(11, "pull_request", "completed", "skipped")] });
    expect((await checksCompleted.derive(ctxWith(withOtherCheck.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it.each(["schedule", "workflow_dispatch"])("does not let an unrelated %s run hide PR checks", async (event) => {
    const stub = stubFetch({ pages: [[actionJob(10, "in_progress", null), actionJob(11)]], workflows: [workflow(10, "pull_request", "in_progress"), workflow(11, event)] });
    expect(await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).toBeNull();
  });

  it.each(["schedule", "workflow_dispatch"])("ignores waiting %s checks when PR checks passed", async (event) => {
    const stub = stubFetch({ jobs: { 11: [{ id: 110, name: "test", run_attempt: 1 }] }, pages: [[actionJob(10), actionJob(11, "waiting", null)]], workflows: [workflow(10), workflow(11, event, "waiting")], suites: [
      { id: 11, app: { id: 1, slug: "github-actions" }, status: "waiting", conclusion: null, latest_check_runs_count: 1 },
    ] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it.each(["schedule", "workflow_dispatch"])("ignores failed %s checks when PR checks passed", async (event) => {
    const stub = stubFetch({ jobs: { 11: [{ id: 110, name: "test", run_attempt: 1 }] }, pages: [[actionJob(10), actionJob(11, "completed", "failure")]], workflows: [workflow(10), workflow(11, event, "completed", "failure")], suites: [
      { id: 11, app: { id: 1, slug: "github-actions" }, status: "completed", conclusion: "failure", latest_check_runs_count: 1 },
    ] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("blocks on a waiting deployment that creates current push checks", async () => {
    const stub = stubFetch({ pages: [[actionJob(10), actionJob(11, "waiting", null)]], workflows: [workflow(10), workflow(11, "push", "waiting")] });
    expect(await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).toBeNull();
    expect(stub.calls).toHaveLength(3);
  });

  it("defensive: selects rerun attempts even if a provider changes suite ids", async () => {
    const stub = stubFetch({ pages: [[actionJob(10, "completed", "failure"), actionJob(20)]],
      workflows: [{ ...workflow(10), check_suite_id: 20, run_attempt: 2 }],
      jobs: { 10: [{ id: 100, name: "test", run_attempt: 1 }, { id: 200, name: "test", run_attempt: 2 }] },
      suites: [
        { id: 10, app: { id: 1, slug: "github-actions" }, latest_check_runs_count: 1, status: "completed", conclusion: "failure" },
        { id: 20, app: { id: 1, slug: "github-actions" }, latest_check_runs_count: 1, status: "completed", conclusion: "success" },
      ],
    });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("defensive: an old pending attempt in a different suite cannot block completion", async () => {
    const stub = stubFetch({ pages: [[actionJob(10, "queued", null), actionJob(20)]],
      workflows: [{ ...workflow(10), check_suite_id: 20, run_attempt: 2 }],
      jobs: { 10: [{ id: 100, name: "test", run_attempt: 1 }, { id: 200, name: "test", run_attempt: 2 }] },
    });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("matches GitHub reruns: same suite id and filter=latest hides the old attempt", async () => {
    const stub = stubFetch({ pages: [[{ ...actionJob(10, "completed", "failure"), id: 100 }, { ...actionJob(10), id: 101 }]], workflows: [{ ...workflow(10), run_attempt: 2 }], suites: [
      { id: 10, app: { id: 1, slug: "github-actions" }, latest_check_runs_count: 1, status: "completed", conclusion: "success" },
    ] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
    expect(stub.calls.some((path) => path.includes("/jobs?"))).toBe(false);
  });

  it("does not infer failure from independent Actions suites", async () => {
    const stub = stubFetch({ pages: [ok(1)], suites: [
      { id: 10, app: { id: 1, slug: "github-actions" }, latest_check_runs_count: 1, status: "completed", conclusion: "failure" },
      { id: 20, app: { id: 1, slug: "github-actions" }, latest_check_runs_count: 1, status: "completed", conclusion: "success" },
    ], workflows: [
      { id: 1, workflow_id: 1, check_suite_id: 10, event: "pull_request", status: "completed", conclusion: "success" },
      { id: 2, workflow_id: 2, check_suite_id: 20, event: "pull_request", status: "completed", conclusion: "success" },
    ] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("selects the latest job per App and name across remaining suites", async () => {
    const stub = stubFetch({ pages: [[
      { id: 1, name: "test", app: { id: 1 }, check_suite: { id: 10 }, completed_at: DONE_AT, status: "completed", conclusion: "cancelled" },
      { id: 2, name: "test", app: { id: 1 }, check_suite: { id: 20 }, completed_at: DONE_AT, status: "completed", conclusion: "success" },
    ]] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("keeps a failed lint in an older non-Actions suite when a newer suite's different check passed", async () => {
    const app = { id: 2, slug: "ci" };
    const stub = stubFetch({ pages: [[
      { id: 100, name: "lint", app, check_suite: { id: 10 }, status: "completed", conclusion: "failure", completed_at: "2026-10-15T12:00:00Z" },
      { id: 200, name: "test", app, check_suite: { id: 20 }, status: "completed", conclusion: "success", completed_at: "2026-10-15T12:05:00Z" },
    ]], suites: [
      { id: 10, app, latest_check_runs_count: 1, status: "completed", conclusion: "failure" },
      { id: 20, app, latest_check_runs_count: 1, status: "completed", conclusion: "success" },
    ] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("failure");
  });

  it("supersedes non-Actions checks only by App and name, using completion time before id", async () => {
    const app = { id: 2, slug: "ci" };
    const stub = stubFetch({ pages: [[
      { id: 200, name: "lint", app, check_suite: { id: 20 }, status: "completed", conclusion: "failure", completed_at: "2026-10-15T12:00:00Z" },
      { id: 100, name: "lint", app, check_suite: { id: 10 }, status: "completed", conclusion: "success", completed_at: "2026-10-15T12:05:00Z" },
    ]], suites: [
      { id: 10, app, latest_check_runs_count: 1, status: "completed", conclusion: "success" },
      { id: 20, app, latest_check_runs_count: 1, status: "completed", conclusion: "success" },
    ] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it.each([false, true])("ignores superseded cancelled runs and suites regardless of response order (reverse=%s)", async (reverse) => {
    const workflows: WorkflowState[] = [
      { check_suite_id: 10, workflow_id: 1, id: 10, run_number: 1, run_attempt: 1, event: "pull_request", status: "completed", conclusion: "cancelled" },
      { check_suite_id: 20, workflow_id: 1, id: 20, run_number: 2, run_attempt: 1, event: "pull_request", status: "completed", conclusion: "success" },
    ];
    const suites: SuiteState[] = [
      { app: { id: 1 }, id: 10, latest_check_runs_count: 1, status: "completed", conclusion: "cancelled" },
      { app: { id: 1 }, id: 20, latest_check_runs_count: 1, status: "completed", conclusion: "success" },
    ];
    const stub = stubFetch({ pages: [ok(1)], workflows: reverse ? workflows.reverse() : workflows, suites: reverse ? suites.reverse() : suites });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("defensive: lists one latest attempt even with a different old suite id", async () => {
    const stub = stubFetch({ pages: [[actionJob(10, "completed", "failure"), actionJob(20)]], workflows: [{ ...workflow(20), run_attempt: 2 }], jobs: { 20: [{ id: 100, name: "test", run_attempt: 1 }, { id: 200, name: "test", run_attempt: 2 }] } });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("keeps failures of the latest run of another workflow", async () => {
    const stub = stubFetch({ pages: [[actionJob(10, "completed", "failure"), actionJob(20)]], workflows: [
      { check_suite_id: 10, workflow_id: 1, id: 10, event: "pull_request", status: "completed", conclusion: "failure" },
      { check_suite_id: 20, workflow_id: 2, id: 20, event: "pull_request", status: "completed", conclusion: "success" },
    ] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("failure");
  });

  it("does not infer failure from a different App suite", async () => {
    const stub = stubFetch({ pages: [ok(1)], suites: [
      { app: { id: 1 }, id: 10, latest_check_runs_count: 1, status: "completed", conclusion: "failure" },
      { app: { id: 2 }, id: 20, latest_check_runs_count: 1, status: "completed", conclusion: "success" },
    ] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("selects workflow membership across every page", async () => {
    const old = { app: { id: 1 }, check_suite_id: 10, workflow_id: 1, id: 10, event: "pull_request", status: "queued", latest_check_runs_count: 1 };
    const current = { ...old, check_suite_id: 20, id: 20, run_number: 2, status: "completed", conclusion: "success" };
    const stub = stubFetch({ pages: [ok(1)], workflowPages: [Array.from({ length: 100 }, (_, i) => ({ ...old, id: i + 100, run_number: 1 })), [current]] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("drops a completion when the head changes during the reads", async () => {
    const stub = stubFetch({ pages: [ok(1)], finalHead: OLD });
    expect(await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).toBeNull();
    expect(stub.calls.at(-1)).toBe("/repos/acme/lean-proofs/pulls/42");
  });

  it("waits for pending contexts even when the combined result is failure", async () => {
    const stub = stubFetch({ pages: [ok(1)], combined: { state: "failure", statuses: [{ state: "failure" }, { state: "pending" }] } });
    expect(await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).toBeNull();
  });

  it("reads pending contexts beyond the first status page", async () => {
    const stub = stubFetch({ pages: [ok(1)], statusPages: [Array.from({ length: 100 }, () => ({ state: "failure" })), [{ state: "pending" }]] });
    expect(await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).toBeNull();
    expect(stub.calls).toContain(`/repos/acme/lean-proofs/commits/${HEAD}/status?per_page=100&page=2`);
  });

  it("gives a CI re-run on the same SHA a new dedupe key (B1 step 5)", async () => {
    const first = stubFetch({ pages: [[{ ...ok(1)[0], id: 201, name: "failed-job", status: "completed", conclusion: "failure", completed_at: "2026-10-15T12:05:00Z" }]], combined: { state: "pending", statuses: [] } });
    const rerun = stubFetch({ pages: [[{ ...ok(1)[0], status: "completed", conclusion: "failure", completed_at: "2026-10-15T13:40:00Z" }]], combined: { state: "pending", statuses: [] } });
    const a = await checksCompleted.derive(ctxWith(first.fetch), PR_SUBJECT, source(HEAD));
    const b = await checksCompleted.derive(ctxWith(rerun.fetch), PR_SUBJECT, source(HEAD));
    expect(a?.dedupeKey).toBe(`derived:checks_completed:acme/lean-proofs@${HEAD}:failure:2026-10-15T12:05:00.000Z`);
    expect(b?.dedupeKey).toBe(`derived:checks_completed:acme/lean-proofs@${HEAD}:failure:2026-10-15T13:40:00.000Z`);
  });

  it("latestCompletedAt takes the newest check-run or status time, or 0 when none reports one", () => {
    expect(latestCompletedAt([{ completedAt: "2026-10-15T12:00:00Z" }], [{ updated_at: "2026-10-15T12:30:00Z" }])).toBe("2026-10-15T12:30:00.000Z");
    expect(latestCompletedAt([{ completedAt: "2026-10-15T14:00:00Z" }, {}], [{ state: "success" }])).toBe("2026-10-15T14:00:00.000Z");
    expect(latestCompletedAt([{}], [])).toBe("0");
  });

  it("returns null for a pull request with no checks", async () => {
    const stub = stubFetch({ pages: [[]], combined: { state: "pending", statuses: [] } });
    expect(await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).toBeNull();
  });

  it("reads every check-run page", async () => {
    const stub = stubFetch({ pages: [ok(100), [{ ...ok(1)[0], id: 201, name: "page-two", status: "completed", conclusion: "failure" }]], combined: { state: "pending", statuses: [] } });
    const event = await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD));
    expect(event?.status).toBe("failure");
    expect(stub.calls).toContain(`/repos/acme/lean-proofs/commits/${HEAD}/check-runs?filter=latest&per_page=100&page=1`);
    expect(stub.calls).toContain(`/repos/acme/lean-proofs/commits/${HEAD}/check-runs?filter=latest&per_page=100&page=2`);
    expect(stub.calls).toContain(`/repos/acme/lean-proofs/commits/${HEAD}/status?per_page=100&page=1`);
  });

  it("builds the derived event's subjects, summary, and url payload", async () => {
    const stub = stubFetch({ pages: [ok(1)], combined: { state: "success", statuses: [{ state: "success" }] } });
    const event = await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD));
    expect(event?.subjects).toEqual(["github:acme", "github:acme/lean-proofs", PR_SUBJECT, `github:acme/lean-proofs@${HEAD}`]);
    expect(event?.occurredAt).toBe("2026-10-15T12:00:00.000Z");
    expect(event?.summary).toBe("All checks passed on acme/lean-proofs#42");
    expect(event?.payload).toEqual({ html_url: "https://github.com/acme/lean-proofs/pull/42", head_sha: HEAD, number: 42 });
  });

  it("sends the app token and a timeout signal on every request", async () => {
    const stub = stubFetch({ pages: [ok(1)], combined: { state: "pending", statuses: [] } });
    await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD));
    expect(stub.calls.length).toBe(5);
    expect(stub.auth.every((a) => a === "Bearer ghs_test")).toBe(true);
    expect(stub.signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it("throws on a non-2xx answer", async () => {
    const stub = stubFetch({ pages: [ok(1)], failPath: { path: `/repos/acme/lean-proofs/commits/${HEAD}/status`, status: 502 } });
    await expect(checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).rejects.toThrow(/502/);
  });

  it.each([
    ["/pulls/42", "pull_requests"], [`/commits/${HEAD}/status`, "statuses"],
    [`/commits/${HEAD}/check-runs`, "checks"], ["/actions/runs", "actions"],
  ])("names the endpoint and permission for a denied %s read", async (endpoint, permission) => {
    const path = `/repos/acme/lean-proofs${endpoint}`;
    const stub = stubFetch({ pages: [ok(1)], failPath: { path, status: 403 } });
    await expect(checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).rejects.toThrow(`GitHub GET ${path}`);
    await expect(checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).rejects.toThrow(`${permission}: read`);
  });

  it("refreshes once on 401 and uses the new token for later reads", async () => {
    const stub = stubFetch({ pages: [ok(1)] });
    let denied = false;
    const http: typeof fetch = async (input, init) => {
      if (!denied) { denied = true; return new Response("{}", { status: 401 }); }
      return stub.fetch(input, init);
    };
    const refreshes: (boolean | undefined)[] = [];
    const context: DeriveContext = { orgId: "org-1", fetch: http, appToken: async (refresh) => { refreshes.push(refresh); return refresh ? "fresh" : "stale"; } };
    expect((await checksCompleted.derive(context, PR_SUBJECT, source(HEAD)))?.status).toBe("success");
    expect(refreshes).toEqual([undefined, true]);
    expect(stub.auth.every((auth) => auth === "Bearer fresh")).toBe(true);
  });

  it("honors the primary rate-limit reset time", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const stub = stubFetch({ failPath: { path: "/repos/acme/lean-proofs/pulls/42", status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "4600" } } });
      await expect(checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).rejects.toMatchObject({ retryAfterMs: 3_600_000 });
    } finally { now.mockRestore(); }
  });

  it("does not infer permission names from repository names", async () => {
    const http: typeof fetch = async () => new Response("{}", { status: 403 });
    await expect(checksCompleted.derive(ctxWith(http), "github:status/check-runs#42", source(HEAD))).resolves.toBeNull();
    const statusSource = { ...source(HEAD), subjects: [`github:status/check-runs@${HEAD}`] };
    await expect(checksCompleted.derive(ctxWith(http), "github:status/check-runs#42", statusSource)).rejects.toThrow("pull_requests: read");
  });

  it("throws with the fix when the org has no app token", async () => {
    const stub = stubFetch({});
    await expect(checksCompleted.derive(ctxWith(stub.fetch, null), PR_SUBJECT, source(HEAD))).rejects.toThrow(/Install the Valet GitHub App/);
    expect(stub.calls).toEqual([]);
  });

  it("throws when the subject is not a pull request subject", async () => {
    const stub = stubFetch({});
    await expect(checksCompleted.derive(ctxWith(stub.fetch), "github:acme/lean-proofs", source(HEAD))).rejects.toThrow(/pull request subject/);
  });

  it("returns null when the source event names no commit of the repository", async () => {
    const stub = stubFetch({});
    const noSha: NormalizedEvent = { ...source(HEAD), subjects: ["github:acme", "github:acme/lean-proofs", PR_SUBJECT] };
    expect(await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, noSha)).toBeNull();
    expect(stub.calls).toEqual([]);
  });
});
