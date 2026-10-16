import { describe, expect, it } from "vitest";
import type { DeriveContext, NormalizedEvent } from "@valet/engine";
import { checksCompleted } from "./derived.js";

// Spec: docs/specs/2026-10-15-event-wakeups-design.md, Part B1 and the B2
// vectors. A stub `fetch` serves fixture JSON; no test reaches the network.

const HEAD = "aaaa000000000000000000000000000000000001";
const OLD = "bbbb000000000000000000000000000000000002";
const API = "https://api.github.com";
const PR_SUBJECT = "github:acme/lean-proofs#42";

interface CheckRun { status: string; conclusion: string | null }
interface Fixture {
  head?: string;
  /** Check-run pages, in order. */
  pages?: CheckRun[][];
  combined?: { state: string; statuses: { state: string }[] };
  /** A path that answers with this HTTP status instead of fixture JSON. */
  failPath?: { path: string; status: number };
}

function stubFetch(fixture: Fixture): { fetch: typeof fetch; calls: string[]; signals: (AbortSignal | null | undefined)[]; auth: (string | null)[] } {
  const calls: string[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const auth: (string | null)[] = [];
  const pages = fixture.pages ?? [[]];
  const total = pages.reduce((n, p) => n + p.length, 0);
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const pathAndQuery = `${url.pathname}${url.search}`;
    calls.push(pathAndQuery);
    signals.push(init?.signal);
    auth.push(new Headers(init?.headers).get("authorization"));
    if (fixture.failPath && url.pathname === fixture.failPath.path) {
      return new Response("bad gateway", { status: fixture.failPath.status });
    }
    if (url.pathname === "/repos/acme/lean-proofs/pulls/42") {
      return Response.json({ number: 42, html_url: "https://github.com/acme/lean-proofs/pull/42", head: { sha: fixture.head ?? HEAD } });
    }
    const runs = url.pathname.match(/^\/repos\/acme\/lean-proofs\/commits\/([0-9a-f]+)\/check-runs$/);
    if (runs) {
      const page = Number(url.searchParams.get("page") ?? "1");
      return Response.json({ total_count: total, check_runs: pages[page - 1] ?? [] });
    }
    if (url.pathname.match(/^\/repos\/acme\/lean-proofs\/commits\/[0-9a-f]+\/status$/)) {
      return Response.json(fixture.combined ?? { state: "pending", statuses: [] });
    }
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

const ok = (n: number): CheckRun[] => Array.from({ length: n }, () => ({ status: "completed", conclusion: "success" }));

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
    });

    it("returns status success when all runs succeed and there are no statuses", async () => {
      const stub = stubFetch({ pages: [ok(3)], combined: { state: "pending", statuses: [] } });
      const event = await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD));
      expect(event?.status).toBe("success");
      expect(event?.key).toBe("github.pull_request.checks_completed");
      expect(event?.dedupeKey).toBe(`derived:checks_completed:acme/lean-proofs@${HEAD}:success`);
    });

    it("returns status failure when all runs complete and one fails", async () => {
      const stub = stubFetch({ pages: [[...ok(2), { status: "completed", conclusion: "failure" }]], combined: { state: "pending", statuses: [] } });
      const event = await checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD));
      expect(event?.status).toBe("failure");
      expect(event?.dedupeKey).toBe(`derived:checks_completed:acme/lean-proofs@${HEAD}:failure`);
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
    expect(stub.calls).toContain(`/repos/acme/lean-proofs/commits/${HEAD}/status`);
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
    expect(stub.calls.length).toBe(3);
    expect(stub.auth.every((a) => a === "Bearer ghs_test")).toBe(true);
    expect(stub.signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it("throws on a non-2xx answer", async () => {
    const stub = stubFetch({ pages: [ok(1)], failPath: { path: `/repos/acme/lean-proofs/commits/${HEAD}/status`, status: 502 } });
    await expect(checksCompleted.derive(ctxWith(stub.fetch), PR_SUBJECT, source(HEAD))).rejects.toThrow(/502/);
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
