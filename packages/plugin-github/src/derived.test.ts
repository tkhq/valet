import { describe, expect, it } from "vitest";
import type { DeriveContext, NormalizedEvent } from "@valet/engine";
import { checksCompleted, latestCompletedAt } from "./derived.js";

// Spec: docs/specs/2026-10-15-event-wakeups-design.md, Part B1 and the B2
// vectors. A stub `fetch` serves fixture JSON; no test reaches the network.

const HEAD = "aaaa000000000000000000000000000000000001";
const OLD = "bbbb000000000000000000000000000000000002";
const PR_SUBJECT = "github:acme/lean-proofs#42";

interface CheckRun {
  status: string; conclusion: string | null; completed_at?: string;
  id?: number; name?: string; check_suite?: { id: number }; app?: { id: number };
}
interface SuiteState {
  status: string;
  latest_check_runs_count?: number;
  id?: number;
  conclusion?: string;
  app?: { id?: number; slug?: string };
}
interface WorkflowState {
  status: string;
  event?: string;
  conclusion?: string;
  workflow_id?: number;
  id?: number;
  run_number?: number;
  run_attempt?: number;
  check_suite_id?: number;
}
interface Fixture {
  head?: string;
  finalHead?: string;
  suites?: SuiteState[];
  workflows?: WorkflowState[];
  suitePages?: SuiteState[][];
  workflowPages?: WorkflowState[][];
  statusPages?: { state: string }[][];
  /** Check-run pages, in order. */
  pages?: CheckRun[][];
  combined?: { state: string; statuses: { state: string; updated_at?: string }[] };
  /** A path that answers with this HTTP status instead of fixture JSON. */
  failPath?: { path: string; status: number; body?: string; headers?: Record<string, string> };
}

function stubFetch(fixture: Fixture): { fetch: typeof fetch; calls: string[]; signals: (AbortSignal | null | undefined)[]; auth: (string | null)[] } {
  const calls: string[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const auth: (string | null)[] = [];
  const pages = fixture.pages ?? [[]];
  const total = pages.reduce((n, p) => n + p.length, 0);
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
      return Response.json({ total_count: total, check_runs: pages[page - 1] ?? [] });
    }
    if (url.pathname.match(/^\/repos\/acme\/lean-proofs\/commits\/[0-9a-f]+\/status$/)) {
      return Response.json(fixture.statusPages ? { statuses: fixture.statusPages[Number(url.searchParams.get("page")) - 1] ?? [] } : fixture.combined ?? { state: "pending", statuses: [] });
    }
    if (url.pathname.endsWith("/check-suites")) return Response.json({ check_suites: fixture.suitePages?.[Number(url.searchParams.get("page")) - 1] ?? fixture.suites ?? [] });
    if (url.pathname.endsWith("/actions/runs")) return Response.json({ workflow_runs: fixture.workflowPages?.[Number(url.searchParams.get("page")) - 1] ?? fixture.workflows ?? [] });
    return new Response("not found", { status: 404 });
  };
  return { fetch: impl, calls, signals, auth };
}

function ctxWith(f: typeof fetch, token: string | null = "ghs_test"): DeriveContext {
  return { orgId: "org-1", appToken: async () => token, fetch: f };
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
const ok = (n: number): CheckRun[] => Array.from({ length: n }, () => ({ status: "completed", conclusion: "success", completed_at: DONE_AT }));

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
      const stub = stubFetch({ pages: [[...ok(2), { status: "in_progress", conclusion: null }]], combined: { state: "pending", statuses: [] } });
      expect(await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).toBeNull();
      expect(stub.calls).toHaveLength(2);
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
      const stub = stubFetch({ pages: [[...ok(2), { status: "completed", conclusion: "failure", completed_at: "2026-10-15T12:05:00Z" }]], combined: { state: "pending", statuses: [] } });
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
    const stub = stubFetch({ pages: [[...ok(1), { status: "completed", conclusion }]], combined: { state: "pending", statuses: [] } });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("failure");
  });

  it.each(["failure", "error"])("treats combined status %s as failure", async (state) => {
    const stub = stubFetch({ pages: [ok(1)], combined: { state, statuses: [{ state }] } });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("failure");
  });

  it.each(["queued", "in_progress", "requested", "waiting", "pending"])("waits for %s suites before a later check exists", async (status) => {
    const early = stubFetch({ pages: [ok(1)], suites: [{ status, latest_check_runs_count: 1 }] });
    expect(await checksCompleted.derive(ctxWith(early.fetch), PR_SUBJECT, source(HEAD))).toBeNull();
    const later = stubFetch({ pages: [[...ok(1), { status: "queued", conclusion: null }]] });
    expect(await checksCompleted.derive(ctxWith(later.fetch), PR_SUBJECT, source(HEAD))).toBeNull();
  });

  it("ignores a zero-run queued App suite", async () => {
    const stub = stubFetch({ pages: [ok(1)], suites: [{ status: "queued", latest_check_runs_count: 0 }] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("ignores an Actions suite when filters skip every workflow", async () => {
    const stub = stubFetch({ pages: [ok(1)], suites: [{ status: "queued", latest_check_runs_count: 0, app: { slug: "github-actions" } }] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("ignores an unrelated push deploy waiting for environment approval", async () => {
    const stub = stubFetch({ pages: [ok(1)], workflows: [{ status: "waiting", event: "push" }] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("stops on a pending run before reading another page", async () => {
    const stub = stubFetch({ pages: [[{ status: "queued", conclusion: null }, ...ok(99)], ok(1)] });
    expect(await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).toBeNull();
    expect(stub.calls).toHaveLength(2);
  });

  it("stops on pending statuses before suites and workflows", async () => {
    const stub = stubFetch({ pages: [ok(1)], combined: { state: "pending", statuses: [{ state: "pending" }] } });
    expect(await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).toBeNull();
    expect(stub.calls).toHaveLength(3);
  });

  it("waits for a workflow that has not created its checks", async () => {
    const stub = stubFetch({ pages: [ok(1)], workflows: [{ status: "queued", event: "pull_request" }] });
    expect(await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).toBeNull();
  });

  it.each(["suitePages", "workflowPages"] as const)("reads pending work on later %s pages", async (field) => {
    const stub = stubFetch({ pages: [ok(1)], [field]: [Array.from({ length: 100 }, () => ({ status: "completed", event: "pull_request" })), [{ status: "waiting", event: "pull_request" }]] });
    expect(await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).toBeNull();
    expect(stub.calls.some((path) => path.includes(field === "suitePages" ? "check-suites?" : "actions/runs?") && path.endsWith("page=2"))).toBe(true);
  });

  it("refuses a partial status snapshot at the pagination safety limit", async () => {
    const stub = stubFetch({ pages: [ok(1)], statusPages: Array.from({ length: 20 }, () => Array.from({ length: 100 }, () => ({ state: "success" }))) });
    await expect(checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).rejects.toThrow("too many statuses pages");
  });

  it("ignores cancelled jobs from a superseded Actions suite on the same SHA", async () => {
    const stub = stubFetch({ pages: [[
      { id: 1, name: "test", app: { id: 1 }, check_suite: { id: 10 }, status: "completed", conclusion: "cancelled" },
      { id: 2, name: "test", app: { id: 1 }, check_suite: { id: 20 }, status: "completed", conclusion: "success" },
    ]], suites: [
      { id: 10, app: { id: 1, slug: "github-actions" }, latest_check_runs_count: 1, status: "completed", conclusion: "cancelled" },
      { id: 20, app: { id: 1, slug: "github-actions" }, latest_check_runs_count: 1, status: "completed", conclusion: "success" },
    ], workflows: [
      { id: 1, workflow_id: 1, check_suite_id: 10, event: "pull_request", status: "completed", conclusion: "cancelled" },
      { id: 2, workflow_id: 1, check_suite_id: 20, event: "pull_request", status: "completed", conclusion: "success" },
    ] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("does not merge independent Actions workflows into one suite", async () => {
    const stub = stubFetch({ pages: [ok(1)], suites: [
      { id: 10, app: { id: 1, slug: "github-actions" }, latest_check_runs_count: 1, status: "completed", conclusion: "failure" },
      { id: 20, app: { id: 1, slug: "github-actions" }, latest_check_runs_count: 1, status: "completed", conclusion: "success" },
    ], workflows: [
      { id: 1, workflow_id: 1, check_suite_id: 10, event: "pull_request", status: "completed", conclusion: "failure" },
      { id: 2, workflow_id: 2, check_suite_id: 20, event: "pull_request", status: "completed", conclusion: "success" },
    ] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("failure");
  });

  it("selects the latest job per App and name across remaining suites", async () => {
    const stub = stubFetch({ pages: [[
      { id: 1, name: "test", app: { id: 1 }, check_suite: { id: 10 }, status: "completed", conclusion: "cancelled" },
      { id: 2, name: "test", app: { id: 1 }, check_suite: { id: 20 }, status: "completed", conclusion: "success" },
    ]] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it.each([false, true])("ignores superseded cancelled runs and suites regardless of response order (reverse=%s)", async (reverse) => {
    const workflows: WorkflowState[] = [
      { workflow_id: 1, id: 10, run_number: 1, run_attempt: 1, event: "pull_request", status: "completed", conclusion: "cancelled" },
      { workflow_id: 1, id: 20, run_number: 2, run_attempt: 1, event: "pull_request", status: "completed", conclusion: "success" },
    ];
    const suites: SuiteState[] = [
      { app: { id: 1 }, id: 10, latest_check_runs_count: 1, status: "completed", conclusion: "cancelled" },
      { app: { id: 1 }, id: 20, latest_check_runs_count: 1, status: "completed", conclusion: "success" },
    ];
    const stub = stubFetch({ pages: [ok(1)], workflows: reverse ? workflows.reverse() : workflows, suites: reverse ? suites.reverse() : suites });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("uses the newest attempt of a rerun with the same workflow run id", async () => {
    const stub = stubFetch({ pages: [ok(1)], workflows: [
      { workflow_id: 1, id: 20, run_number: 2, run_attempt: 1, event: "pull_request", status: "completed", conclusion: "cancelled" },
      { workflow_id: 1, id: 20, run_number: 2, run_attempt: 2, event: "pull_request", status: "completed", conclusion: "success" },
    ] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("success");
  });

  it("keeps failures of the latest run of another workflow", async () => {
    const stub = stubFetch({ pages: [ok(1)], workflows: [
      { workflow_id: 1, id: 10, event: "pull_request", status: "completed", conclusion: "failure" },
      { workflow_id: 2, id: 20, event: "pull_request", status: "completed", conclusion: "success" },
    ] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("failure");
  });

  it("keeps the latest suite failure of a different App", async () => {
    const stub = stubFetch({ pages: [ok(1)], suites: [
      { app: { id: 1 }, id: 10, latest_check_runs_count: 1, status: "completed", conclusion: "failure" },
      { app: { id: 2 }, id: 20, latest_check_runs_count: 1, status: "completed", conclusion: "success" },
    ] });
    expect((await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD)))?.status).toBe("failure");
  });

  it.each(["suitePages", "workflowPages"] as const)("selects the latest record across %s before deciding terminality", async (field) => {
    const old = { app: { id: 1 }, workflow_id: 1, id: 10, event: "pull_request", status: "queued", latest_check_runs_count: 1 };
    const current = { ...old, id: 20, status: "completed", conclusion: "success" };
    const stub = stubFetch({ pages: [ok(1)], [field]: [Array.from({ length: 100 }, () => old), [current]] });
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
    const first = stubFetch({ pages: [[{ status: "completed", conclusion: "failure", completed_at: "2026-10-15T12:05:00Z" }]], combined: { state: "pending", statuses: [] } });
    const rerun = stubFetch({ pages: [[{ status: "completed", conclusion: "failure", completed_at: "2026-10-15T13:40:00Z" }]], combined: { state: "pending", statuses: [] } });
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
    const stub = stubFetch({ pages: [ok(100), [{ status: "completed", conclusion: "failure" }]], combined: { state: "pending", statuses: [] } });
    const event = await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD));
    expect(event?.status).toBe("failure");
    expect(stub.calls).toContain(`/repos/acme/lean-proofs/commits/${HEAD}/check-runs?per_page=100&page=1`);
    expect(stub.calls).toContain(`/repos/acme/lean-proofs/commits/${HEAD}/check-runs?per_page=100&page=2`);
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
    expect(stub.calls.length).toBe(6);
    expect(stub.auth.every((a) => a === "Bearer ghs_test")).toBe(true);
    expect(stub.signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it("throws on a non-2xx answer", async () => {
    const stub = stubFetch({ pages: [ok(1)], failPath: { path: `/repos/acme/lean-proofs/commits/${HEAD}/status`, status: 502 } });
    await expect(checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).rejects.toThrow(/502/);
  });

  it.each([
    ["/pulls/42", "pull_requests"], [`/commits/${HEAD}/status`, "statuses"],
    [`/commits/${HEAD}/check-runs`, "checks"], [`/commits/${HEAD}/check-suites`, "checks"], ["/actions/runs", "actions"],
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
