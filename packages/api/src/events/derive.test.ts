import { describe, expect, it } from "vitest";
import { DeriveRetryError, type DeriveContext, type EventMatchDigest, type ValetPlugin } from "@valet/engine";
import githubPlugin from "@valet/plugin-github/plugin";
import { catalogForService, allCatalogEntries } from "./ingest.js";
import { listEventTypes } from "../workflows/trigger-service.js";
import { githubDeriveContext, runDerive } from "./derive.js";

// Spec: docs/specs/2026-10-15-event-wakeups-design.md, Part B, INV-E9,
// Part J (`valet_event_waiter_derive_total`).

const HEAD = "aaaa000000000000000000000000000000000001";
const PR_SUBJECT = "github:acme/lean-proofs#42";
const KEY = "github.pull_request.checks_completed";

function digest(overrides: Partial<EventMatchDigest> = {}): EventMatchDigest {
  return {
    key: "github.check_run.completed",
    subjects: ["github:acme", "github:acme/lean-proofs", PR_SUBJECT, `github:acme/lean-proofs@${HEAD}`],
    summary: "check run completed",
    occurredAt: "2026-10-15T12:00:00.000Z",
    dedupeKey: "delivery-1",
    status: "failure",
    derive: KEY,
    ...overrides,
  };
}

interface Stub { fetch: typeof fetch; calls: string[] }

function githubFixture(opts: { conclusion?: string; statusCode?: number } = {}): Stub {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${url.pathname}${url.search}`);
    if (opts.statusCode && url.pathname.endsWith("/status")) return new Response("bad gateway", { status: opts.statusCode });
    if (url.pathname === "/repos/acme/lean-proofs/pulls/42") {
      return Response.json({ number: 42, html_url: "https://github.com/acme/lean-proofs/pull/42", head: { sha: HEAD } });
    }
    if (url.pathname.endsWith("/check-runs")) {
      return Response.json({ total_count: 1, check_runs: [{ status: "completed", conclusion: opts.conclusion ?? "failure", completed_at: "2026-10-15T12:00:00Z" }] });
    }
    if (url.pathname.endsWith("/status")) return Response.json({ state: "pending", statuses: [] });
    if (url.pathname.endsWith("/check-suites")) return Response.json({ check_suites: [] });
    if (url.pathname.endsWith("/actions/runs")) return Response.json({ workflow_runs: [] });
    return new Response("not found", { status: 404 });
  };
  return { fetch: impl, calls };
}

function ctx(f: typeof fetch): DeriveContext {
  return { orgId: "org-1", appToken: async () => "ghs_test", fetch: f };
}

function recorder() {
  const points: { key: string; result: string }[] = [];
  return { points, record: (key: string, result: "event" | "null" | "error") => { points.push({ key, result }); } };
}

describe("runDerive", () => {
  it("returns the derived digest with the derived dedupeKey and no derive mark", async () => {
    const stub = githubFixture();
    const rec = recorder();
    const out = await runDerive([githubPlugin], "org-1", digest(), PR_SUBJECT, ctx(stub.fetch), rec.record);
    expect(out.result).toBe("event");
    if (out.result !== "event") return;
    expect(out.digest.key).toBe(KEY);
    expect(out.digest.status).toBe("failure");
    expect(out.digest.dedupeKey).toBe(`derived:checks_completed:acme/lean-proofs@${HEAD}:failure:2026-10-15T12:00:00.000Z`);
    expect(out.digest.url).toBe("https://github.com/acme/lean-proofs/pull/42");
    expect(out.digest.derive).toBeUndefined();
    expect(out.digest.head_sha).toBe(HEAD);
    expect(rec.points).toEqual([{ key: KEY, result: "event" }]);
  });

  it("preserves the progress hint on a retryable provider outcome", async () => {
    const plugin: ValetPlugin = { ...githubPlugin, derivedEvents: [{ key: KEY, description: "Checks completed", sources: ["github.status"], derive: async () => { throw new DeriveRetryError("GitHub job details are still loading.", 1_000, true); } }] };
    const stub = githubFixture();
    expect(await runDerive([plugin], "org-1", digest(), PR_SUBJECT, ctx(stub.fetch))).toMatchObject({ result: "error", retryAfterMs: 1_000, madeProgress: true });
  });

  it("returns null when the condition does not hold yet", async () => {
    const stub = githubFixture();
    const rec = recorder();
    const out = await runDerive([githubPlugin], "org-1", digest({ subjects: [PR_SUBJECT, "github:acme/lean-proofs@bbbb000000000000000000000000000000000002"] }), PR_SUBJECT, ctx(stub.fetch), rec.record);
    expect(out).toEqual({ result: "null" });
    expect(rec.points).toEqual([{ key: KEY, result: "null" }]);
  });

  it.each([403])("marks HTTP %s permission errors for source consumption", async (statusCode) => {
    const stub = githubFixture({ statusCode });
    expect(await runDerive([githubPlugin], "org-1", digest(), PR_SUBJECT, ctx(stub.fetch))).toMatchObject({ result: "error", consumeSource: true });
  });

  it("refreshes a stale installation token after a 401 and keeps the source if it still fails", async () => {
    const stub = githubFixture({ statusCode: 401 });
    const refreshes: (boolean | undefined)[] = [];
    const context = { ...ctx(stub.fetch), appToken: async (refresh?: boolean) => { refreshes.push(refresh); return refresh ? "fresh" : "stale"; } };
    const out = await runDerive([githubPlugin], "org-1", digest(), PR_SUBJECT, context);
    expect(out).toMatchObject({ result: "error", retryAfterMs: 1000 });
    expect(out.result === "error" && out.consumeSource).not.toBe(true);
    expect(refreshes).toEqual([undefined, true]);
  });

  it("retains secondary-limit 403 sources without Retry-After or primary-limit exhaustion", async () => {
    const limited: typeof fetch = async () => Response.json({ message: "You have exceeded a secondary rate limit" }, { status: 403, headers: { "x-ratelimit-remaining": "4999" } });
    const out = await runDerive([githubPlugin], "org-1", digest(), PR_SUBJECT, ctx(limited));
    expect(out).toMatchObject({ result: "error", retryAfterMs: 60_000 });
    expect(out.result === "error" && out.consumeSource).not.toBe(true);
  });

  it("retains rate-limited sources for retry instead of consuming them as permission errors", async () => {
    const limited: typeof fetch = async () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    const out = await runDerive([githubPlugin], "org-1", digest(), PR_SUBJECT, ctx(limited));
    expect(out).toMatchObject({ result: "error" });
    expect(out.result === "error" && out.consumeSource).not.toBe(true);
  });

  it("maps a 502 to an error result (keep the digest)", async () => {
    const stub = githubFixture({ statusCode: 502 });
    const rec = recorder();
    const out = await runDerive([githubPlugin], "org-1", digest(), PR_SUBJECT, ctx(stub.fetch), rec.record);
    expect(out.result).toBe("error");
    if (out.result === "error") expect(String(out.error)).toContain("502");
    expect(rec.points).toEqual([{ key: KEY, result: "error" }]);
  });

  it("maps a timeout to an error result", async () => {
    const hang: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
    const rec = recorder();
    const fast: DeriveContext = { orgId: "org-1", appToken: async () => "ghs_test", fetch: (input, init) => hang(input, { ...init, signal: AbortSignal.timeout(10) }) };
    const out = await runDerive([githubPlugin], "org-1", digest(), PR_SUBJECT, fast, rec.record);
    expect(out.result).toBe("error");
  });

  it("returns error for a digest whose derive key no plugin declares", async () => {
    const stub = githubFixture();
    const rec = recorder();
    const out = await runDerive([githubPlugin], "org-1", digest({ derive: "github.nope" }), PR_SUBJECT, ctx(stub.fetch), rec.record);
    expect(out.result).toBe("error");
    expect(stub.calls).toEqual([]);
    expect(rec.points).toEqual([{ key: "github.nope", result: "error" }]);
  });

  it("makes zero API calls for a digest without a derive mark (INV-E9)", async () => {
    const stub = githubFixture();
    const rec = recorder();
    const out = await runDerive([githubPlugin], "org-1", digest({ derive: undefined }), PR_SUBJECT, ctx(stub.fetch), rec.record);
    expect(out.result).toBe("error");
    expect(stub.calls).toEqual([]);
  });
});

describe("githubDeriveContext", () => {
  it("binds the app token to the subject's owner", async () => {
    const owners: (string | undefined)[] = [];
    const c = githubDeriveContext("org-1", PR_SUBJECT, async (orgId, owner) => { owners.push(owner); return orgId === "org-1" ? "ghs_x" : null; });
    expect(c.orgId).toBe("org-1");
    expect(await c.appToken()).toBe("ghs_x");
    expect(owners).toEqual(["acme"]);
  });
});

describe("derived keys in the catalog", () => {
  it("lists the derived key with derived: true", () => {
    const entry = catalogForService([githubPlugin], "github").find((e) => e.key === KEY);
    expect(entry?.derived).toBe(true);
    expect(allCatalogEntries([githubPlugin]).some((e) => e.key === KEY && e.derived === true)).toBe(true);
    expect(catalogForService([githubPlugin], "slack").some((e) => e.key === KEY)).toBe(false);
  });

  it("marks the derived key in workflows.list_event_types", () => {
    const github = listEventTypes([githubPlugin]).find((s) => s.service === "github");
    const entry = github?.entries.find((e) => e.key === KEY);
    expect(entry?.derived).toBe(true);
    const plain = github?.entries.find((e) => e.key === "github.pull_request.opened");
    expect(plain?.derived).toBeUndefined();
  });

  it("does not list a derived key for a plugin with no trigger for its service", () => {
    const orphan: ValetPlugin = { ...githubPlugin, triggers: [] };
    expect(allCatalogEntries([orphan]).some((e) => e.key === KEY)).toBe(false);
  });
});
