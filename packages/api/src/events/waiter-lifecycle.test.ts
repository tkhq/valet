import { describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PgSessionStore, pgDbFromPglite, applyEngineMigrations } from "@valet/store-postgres";
import { InMemorySessionStore, type SessionStore, type ArmEventRequest, type NormalizedEvent, type PromptContent, type PromptOptions } from "@valet/engine";
import githubPlugin from "@valet/plugin-github/plugin";
import { buildWakeupsSeam } from "../engine/wakeups-seam.js";
import { WakeWatcher, type WakeWatcherSession } from "../engine/wake-watcher.js";
import { eventWaiterDeriver } from "./derive.js";
import { checkArm, type ArmDeps } from "./waiter-arm.js";
import { appendWaiterDigests, evaluateWaiterCandidates, type WaiterMatchDeps } from "./waiters.js";

const PR = "github:acme/app#42";
const BRANCH = "github:acme/app:branch/feat/nested";
const SHA = "a".repeat(40);
const MERGE = "b".repeat(40);
const CHECKS = "github.pull_request.checks_completed";
const NOW = Date.parse("2026-10-20T00:00:00Z");
const limits = { leaseMaxHours: 72, timerMaxHours: 720, perSession: 20, watchMaxEventsPerHour: 120 };

async function harness(store: SessionStore = new InMemorySessionStore()) {
  await store.saveSession({ id: "s", userId: "u", orgId: "org", owner: { type: "user", id: "u" }, workspace: "/",
    purpose: "interactive", status: "running", createdAt: NOW, updatedAt: NOW });
  const state = { pending: false, error: false, openPr: false, closed: false, merged: false, sha: SHA, now: NOW };
  const http = vi.fn<typeof fetch>(async (input) => {
    if (state.error) throw new Error("fixture read failed");
    const path = new URL(String(input)).pathname;
    if (/\/pulls\/\d+$/.test(path)) return Response.json({ head: { sha: state.sha }, html_url: `https://github.com/acme/app/pull/${path.split("/").at(-1)}` });
    if (path.endsWith("/check-runs")) return Response.json({ total_count: 1, check_runs: [{ status: state.pending ? "in_progress" : "completed", conclusion: "success", completed_at: "2026-10-20T00:00:00Z" }] });
    if (path.endsWith("/status")) return Response.json({ statuses: [] });
    if (path.endsWith("/check-suites")) return Response.json({ check_suites: [] });
    if (path.endsWith("/actions/runs")) return Response.json({ workflow_runs: [] });
    throw new Error(`Unexpected fixture request: ${path}`);
  });
  const derive = eventWaiterDeriver({ plugins: [githubPlugin], sessionOrg: async () => "org",
    contextFor: (orgId) => ({ orgId, fetch: http, appToken: async () => "fixture-token" }) });
  const prompt = vi.fn(async (_content: PromptContent, _opts: PromptOptions) => ({}));
  const session: WakeWatcherSession = { prompt, threadById: (id) => ({ id }), attachment: { current: () => null } };
  const watcherDeps = { engineStore: store, engineHost: { sessionFor: async () => session, liveSession: () => null },
    loadSession: async () => session, provider: { restore: async () => { throw new Error("Event waiters do not restore a sandbox"); } }, limits, deriveEvent: derive, evaluateKeys: [CHECKS], lookupBranch: async () => {
      try { return { pullRequest: await armDeps.findGithubPullRequest?.({ owner: "acme", repo: "app", branch: "feat/nested" }) ?? null, failed: false }; }
      catch { return { pullRequest: null, failed: true }; }
    }, now: () => state.now };
  const watcher = new WakeWatcher(watcherDeps);
  const armDeps: ArmDeps = {
    plugins: [githubPlugin], serviceConnected: async () => true, githubInstallationCovers: async () => true,
    githubIngressConfig: async () => ({ events: ["check_run", "check_suite", "workflow_run", "status", "pull_request"],
      permissions: { checks: "read", actions: "read", statuses: "read", pull_requests: "read" } }),
    readGithub: async (target) => ({ readable: true, pullRequest: true, ...(state.closed && target.number !== undefined ? { state: "closed", merged: state.merged, mergeSha: MERGE } : {}) }),
    findGithubPullRequest: async () => state.openPr ? PR : null,
    slackTeamId: async () => null, readSlackChannel: async () => ({ ok: false, reason: "error" }),
    sessionMayReadSlackChannel: async () => false, readLinear: async () => false,
    followsSlackThread: async () => false, selfIds: async () => [],
  };
  const seam = buildWakeupsSeam({ engineStore: store, limits, now: () => state.now, evaluateKeys: [CHECKS], nudge: (ids) => watcher.nudge(ids),
    checkArm: (threadId, req) => checkArm(armDeps, { sessionId: "s", threadId, orgId: "org" }, req, { timeoutMs: 10 }),
  }, "s", () => undefined);
  const matchDeps: WaiterMatchDeps = { engineStore: store, plugins: [githubPlugin],
    sessionOrg: async () => ({ orgId: "org", ownerType: "user", ownerId: "u" }),
    slackStillVisible: async () => true, resolvePreviousStatus: async () => null, slackBotUserId: async () => undefined, now: () => state.now };
  async function ingest(event: NormalizedEvent, flush = true, suppress = false) {
    const candidates = await evaluateWaiterCandidates(matchDeps, "org", "github", event);
    await appendWaiterDigests(matchDeps, "github", candidates, suppress ? new Map(candidates.map((c) => [c.waiter.id, "suppress" as const])) : undefined);
    if (flush) await watcher.sweep(state.now);
  }
  async function arm(over: Partial<ArmEventRequest> = {}) {
    const result = await seam.armEvent!("t", { subject: "https://github.com/acme/app/pull/42", on: [{ key: CHECKS }], once: true,
      reason: "CI", maxHours: 6, ...over });
    if ("refused" in result) throw new Error(result.refused);
    await new Promise<void>((resolve) => setImmediate(resolve));
    return result.wakeup.id;
  }
  return { store, state, http, prompt, watcher, newWatcher: () => new WakeWatcher(watcherDeps), ingest, arm, seam, armDeps };
}

function event(type: "pull_request" | "check_run", action: string, options: { fork?: boolean; number?: number; merged?: boolean; prePr?: boolean; sha?: string } = {}): NormalizedEvent {
  const payload = { repository: { full_name: "acme/app" }, action,
    ...(type === "pull_request" ? { pull_request: { number: options.number ?? 42, merged: options.merged ?? false, merge_commit_sha: MERGE,
      head: { ref: "feat/nested", sha: SHA, repo: { full_name: options.fork ? "fork/app" : "acme/app" } } } }
      : { check_run: { head_sha: options.sha ?? SHA, conclusion: action === "failure" ? "failure" : "success", pull_requests: options.prePr ? [] : [{ number: options.number ?? 42, head: { repo: { full_name: options.fork ? "fork/app" : "acme/app" } } }],
        check_suite: { head_branch: "feat/nested" } } }),
  };
  const trigger = githubPlugin.triggers?.find((entry) => entry.id === `github.${type}`);
  if (!trigger) throw new Error("Missing GitHub fixture normalizer");
  const normalized = trigger.toEvent({ eventType: type, deliveryId: "fixture", payload });
  return { key: `github.${type}.${type === "check_run" ? "completed" : action}`, dedupeKey: `${type}:${action}:${options.number ?? 42}:${options.sha ?? SHA}`,
    occurredAt: new Date(NOW).toISOString(), refs: {}, summary: `${type} ${action}`, payload,
    subjects: normalized.subjects, status: normalized.status };
}

function signals(h: Awaited<ReturnType<typeof harness>>) {
  return h.prompt.mock.calls.map(([content]) => {
    if (typeof content === "string" || !("signalType" in content)) throw new Error("Expected a signal");
    return content;
  });
}

describe("event waiter arm state and PR lifecycle", () => {
  it("delivers completed checks at arm and terminates once mode", async () => {
    const h = await harness();
    const id = await h.arm();
    expect(h.http).not.toHaveBeenCalled();
    expect((await h.store.getWakeup(id))?.eventBuffer?.[0]).toMatchObject({ derive: CHECKS, evaluateCurrent: true });
    await h.watcher.sweep(NOW);
    expect((await h.store.getWakeup(id))?.cause).toBe("fired");
    expect(signals(h)[0]?.body).toContain("checks_completed · success");
  });

  it("returns before a live watcher's current-state reads start", async () => {
    const h = await harness();
    h.watcher.start();
    try {
      const result = await h.seam.armEvent!("t", { subject: "https://github.com/acme/app/pull/42", on: [{ key: CHECKS }], once: true, reason: "CI", maxHours: 6 });
      expect("wakeup" in result).toBe(true);
      expect(h.http).not.toHaveBeenCalled();
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally { await h.watcher.stop(); }
    expect(h.http).toHaveBeenCalled();
  });

  it("keeps a pending wait armed and delivers a later webhook", async () => {
    const h = await harness(); h.state.pending = true;
    const id = await h.arm(); await h.watcher.sweep(NOW);
    expect(signals(h)).toHaveLength(0);
    h.state.pending = false;
    await h.ingest(event("check_run", "success"));
    expect(signals(h)).toHaveLength(1);
    expect((await h.store.getWakeup(id))?.cause).toBe("fired");
  });

  it("dedupes a later completion against the arm-time output in stream mode", async () => {
    const h = await harness(); const id = await h.arm({ once: false });
    await h.watcher.sweep(NOW);
    h.state.now += 60_000;
    await h.ingest(event("check_run", "success"));
    expect(signals(h)).toHaveLength(1);
    expect((await h.store.getWakeup(id))?.eventSeen).toHaveLength(1);
  });

  it("keeps the wait armed when its status filter excludes the current result", async () => {
    const h = await harness(); const id = await h.arm({ on: [{ key: CHECKS, status: ["failure"] }] });
    await h.watcher.sweep(NOW);
    expect(signals(h)).toHaveLength(0);
    expect((await h.store.getWakeup(id))?.status).toBe("running");
  });

  it("skips evaluation with evaluate_current false", async () => {
    const h = await harness(); await h.arm({ evaluateCurrent: false });
    expect(h.http).not.toHaveBeenCalled();
  });

  it("logs a read error and keeps the wait armed", async () => {
    const h = await harness(); h.state.error = true;
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const id = await h.arm();
      expect((await h.store.getWakeup(id))?.status).toBe("running");
      await h.watcher.sweep(NOW);
      expect(log).toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it("binds an existing open PR after storing the branch waiter and evaluates it", async () => {
    const h = await harness(); h.state.openPr = true;
    const id = await h.arm({ subject: "https://github.com/acme/app/tree/feat/nested" });
    expect((await h.store.getWakeup(id))?.subjects).toEqual([PR, BRANCH]);
    await h.watcher.sweep(NOW);
    expect(signals(h)).toHaveLength(1);
  });

  it("binds on open without an opened clause, then wakes for failure and completion", async () => {
    const h = await harness(); h.state.pending = true;
    const id = await h.arm({ subject: "https://github.com/acme/app/tree/feat/nested", once: false, minIntervalMs: 30_000,
      on: [{ key: "github.check_run.completed", status: ["failure"] }, { key: CHECKS }] });
    expect(h.http).not.toHaveBeenCalled();
    await h.ingest(event("pull_request", "opened"));
    await h.ingest(event("pull_request", "opened"));
    expect((await h.store.getWakeup(id))?.subjects).toEqual([PR, BRANCH]);
    expect(signals(h)).toHaveLength(0);
    await h.ingest(event("check_run", "failure"));
    expect(signals(h)[0]?.body).toContain("check_run.completed · failure");
    h.state.pending = false; h.state.now += 60_000;
    await h.ingest(event("check_run", "success"));
    expect(signals(h)[1]?.body).toContain("checks_completed · success");
  });

  it("ignores fork PRs on the same branch and binds on reopened", async () => {
    const h = await harness();
    const id = await h.arm({ subject: "https://github.com/acme/app/tree/feat/nested" });
    await h.ingest(event("pull_request", "opened", { fork: true }));
    await h.ingest(event("pull_request", "closed"));
    expect((await h.store.getWakeup(id))?.subjects).toEqual([BRANCH]);
    await h.ingest(event("pull_request", "reopened"));
    expect((await h.store.getWakeup(id))?.subjects?.[0]).toBe(PR);
  });

  it.each([true, false])("ends a pending once=%s waiter on merge with a final digest and merge SHA", async (once) => {
    const h = await harness(); h.state.pending = true;
    const id = await h.arm({ once });
    await h.ingest(event("pull_request", "closed", { merged: true }));
    expect((await h.store.getWakeup(id))).toMatchObject({ status: "done", cause: "subject_closed" });
    expect(signals(h).map((signal) => signal.signalType)).toEqual(["event.matched", "event.ended"]);
    expect(JSON.parse(signals(h)[0]!.attributes!.digests!)).toEqual([expect.objectContaining({ key: "github.pull_request.closed", status: "merged", merge_commit_sha: MERGE })]);
    expect(signals(h)[1]?.body).toContain(`merged at ${MERGE}`);
    expect(signals(h)[1]?.body).toContain("Later pushes to that branch will not be watched");
    await h.ingest(event("pull_request", "reopened"));
    expect(signals(h)).toHaveLength(2);
  });

  it.each([undefined, false])("keeps branch identity through a second PR with endOnClose=%s", async (endOnClose) => {
    const h = await harness(); h.state.openPr = true; h.state.pending = true;
    const id = await h.arm({ subject: "https://github.com/acme/app/tree/feat/nested", once: false, endOnClose, minIntervalMs: 30_000 });
    await h.ingest(event("pull_request", "closed"));
    expect(await h.store.getWakeup(id)).toMatchObject({ status: "running", eventMatch: { primarySubject: BRANCH } });
    expect((await h.store.getWakeup(id))?.eventMatch?.boundPullRequest).toBeUndefined();
    await h.ingest(event("pull_request", "opened", { number: 7 }));
    expect((await h.store.getWakeup(id))?.eventMatch?.boundPullRequest).toBe("github:acme/app#7");
    expect((await h.store.getWakeup(id))?.subjects).not.toContain(PR);
    await h.ingest(event("check_run", "failure", { number: 42 }));
    expect(signals(h)).toHaveLength(1);
    expect(signals(h)[0]?.body).toContain("branch wait stays armed");
    h.state.pending = false; h.state.now += 60_000;
    await h.ingest(event("check_run", "success", { number: 7 }));
    expect(signals(h)[1]?.body).toContain("All checks passed on acme/app#7");
    await h.ingest(event("pull_request", "closed", { number: 42 }));
    expect((await h.store.getWakeup(id))?.eventMatch?.boundPullRequest).toBe("github:acme/app#7");
  });

  it("flushes buffered matches before the close, despite the stream interval and subscription suppression", async () => {
    const h = await harness();
    const id = await h.arm({ once: false, evaluateCurrent: false, minIntervalMs: 3600_000,
      on: [{ key: "github.check_run.completed" }] });
    await h.ingest(event("check_run", "failure"));
    await h.ingest(event("check_run", "success"));
    expect(signals(h)).toHaveLength(1);
    await h.ingest(event("pull_request", "closed", { merged: true }), true, true);
    expect(signals(h).map((s) => s.signalType)).toEqual(["event.matched", "event.matched", "event.ended"]);
    expect(JSON.parse(signals(h)[1]!.attributes!.digests!).map((d: { key: string }) => d.key))
      .toEqual(["github.check_run.completed", "github.pull_request.closed"]);
    expect(await h.store.getWakeup(id)).toMatchObject({ status: "done", eventCount: 2 });
  });

  it("resolves pending CI once before delivering the close last", async () => {
    const h = await harness();
    const id = await h.arm({ evaluateCurrent: false, once: false });
    await h.ingest(event("check_run", "success"), false);
    await h.ingest(event("pull_request", "closed", { merged: true }));
    expect(JSON.parse(signals(h)[0]!.attributes!.digests!).map((d: { key: string }) => d.key)).toEqual([CHECKS, "github.pull_request.closed"]);
    expect((await h.store.getWakeup(id))?.cause).toBe("subject_closed");
  });

  it.each(["opened", "reopened"])("evaluates completed CI after %s binds, not during ingest", async (action) => {
    const h = await harness();
    await h.arm({ subject: "https://github.com/acme/app/tree/feat/nested" });
    await h.ingest(event("pull_request", action), false);
    expect(h.http).not.toHaveBeenCalled();
    await h.watcher.eventPass(NOW);
    expect(signals(h)[0]?.body).toContain("checks_completed · success");
    expect(h.http.mock.calls.filter(([input]) => String(input).endsWith("/pulls/42"))).toHaveLength(2);
  });

  it("warns on a branch lookup timeout and retries after 30 seconds", async () => {
    const h = await harness();
    const lookup = vi.fn<NonNullable<ArmDeps["findGithubPullRequest"]>>()
      .mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(PR);
    h.armDeps.findGithubPullRequest = lookup;
    const result = await h.seam.armEvent!("t", { subject: "https://github.com/acme/app/tree/feat/nested", on: [{ key: CHECKS }], once: false, reason: "CI", maxHours: 6 });
    if ("refused" in result) throw new Error(result.refused);
    expect(result.warning).toContain("lookup failed or timed out");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(h.http).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await h.watcher.eventPass(NOW);
    expect(lookup).toHaveBeenCalledTimes(1);
    h.state.now += 30_000;
    await h.watcher.sweep(h.state.now);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await h.watcher.eventPass(h.state.now);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect((await h.store.getWakeup(result.wakeup.id))?.eventMatch?.boundPullRequest).toBe(PR);
    expect(signals(h)[0]?.body).toContain("checks_completed · success");
  });

  it("persists lookup backoff and keeps slow retries until deadline", async () => {
    const h = await harness();
    const lookup = vi.fn<NonNullable<ArmDeps["findGithubPullRequest"]>>().mockRejectedValue(new Error("fixture lookup failed"));
    h.armDeps.findGithubPullRequest = lookup;
    const id = await h.arm({ subject: "https://github.com/acme/app/tree/feat/nested" });
    for (const gap of [30_000, 120_000, 600_000, 600_000]) {
      await h.watcher.sweep(h.state.now);
      const calls = lookup.mock.calls.length;
      h.state.now += gap;
      await h.watcher.sweep(h.state.now);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(lookup).toHaveBeenCalledTimes(calls + 1);
      expect((await h.store.getWakeup(id))?.eventMatch?.branchLookupAt).toBeGreaterThan(h.state.now);
    }
    expect(lookup).toHaveBeenCalledTimes(5);
  });

  it("recovers a persisted branch lookup after restart without blocking the sweep", async () => {
    const h = await harness();
    const id = await h.arm({ subject: "https://github.com/acme/app/tree/feat/nested" });
    await h.watcher.stop();
    const resumed = h.newWatcher();
    let release: (pr: string) => void = () => {};
    const lookup = vi.fn<NonNullable<ArmDeps["findGithubPullRequest"]>>(() => new Promise((resolve) => { release = resolve; }));
    h.armDeps.findGithubPullRequest = lookup;
    h.state.now += 600_000;
    await resumed.sweep(h.state.now);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect((await h.store.getWakeup(id))?.eventMatch?.branchLookupAt).toBeGreaterThan(h.state.now);
    // The sweep returned even though GitHub has not answered.
    release(PR);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await resumed.eventPass(h.state.now);
    expect((await h.store.getWakeup(id))?.cause).toBe("fired");
    await resumed.stop();
  });

  it("arms before a push without firing on the already-successful old head", async () => {
    const h = await harness();
    const id = await h.arm({ evaluateCurrent: false });
    await h.watcher.sweep(NOW);
    expect(signals(h)).toHaveLength(0);
    expect(h.http).not.toHaveBeenCalled();
    h.state.pending = true;
    h.state.sha = "c".repeat(40);
    await h.ingest(event("check_run", "success", { sha: h.state.sha }));
    expect((await h.store.getWakeup(id))?.status).toBe("running");
    h.state.pending = false;
    await h.ingest(event("check_run", "failure", { sha: h.state.sha }));
    expect((await h.store.getWakeup(id))?.cause).toBe("fired");
  });

  it("always evaluates a later binding with a full buffer and arm evaluation disabled", async () => {
    const h = await harness();
    const id = await h.arm({ subject: "https://github.com/acme/app/tree/feat/nested", evaluateCurrent: false });
    for (let n = 0; n < 200; n++) await h.store.appendEventMatch(id, {
      key: "github.issue_comment.created", subjects: [BRANCH], dedupeKey: `full-${n}`, summary: "Earlier match", occurredAt: new Date(NOW).toISOString(),
    }, NOW);
    await h.ingest(event("pull_request", "opened"));
    expect(h.http).toHaveBeenCalled();
    expect((await h.store.getWakeup(id))?.cause).toBe("fired");
    expect(signals(h)[0]?.body).toContain("checks_completed · success");
  });

  it("does not buffer a repo-wide flood after branch closure", async () => {
    const h = await harness(); h.state.openPr = true; h.state.pending = true;
    const id = await h.arm({ subject: "https://github.com/acme/app/tree/feat/nested", once: false });
    await h.ingest(event("pull_request", "closed"));
    expect((await h.store.getWakeup(id))?.subjects).toEqual([BRANCH]);
    for (let n = 0; n < 205; n++) {
      const source = event("check_run", "success");
      await h.ingest({ ...source, dedupeKey: `other-${n}`, subjects: ["github:acme/app", "github:acme/app:branch/other", `github:acme/app@${SHA}`] }, false);
    }
    expect((await h.store.getWakeup(id))?.eventBuffer).toEqual([]);
  });

  it("keeps verified pre-PR workflow completions buffered until binding", async () => {
    const h = await harness();
    const id = await h.arm({ subject: "https://github.com/acme/app/tree/feat/nested" });
    const payload = { repository: { full_name: "acme/app" }, action: "completed", workflow_run: {
      head_sha: SHA, head_branch: "feat/nested", head_repository: { full_name: "acme/app" }, conclusion: "success", pull_requests: [],
    } };
    const normalized = githubPlugin.triggers!.find((t) => t.id === "github.workflow_run")!.toEvent({ eventType: "workflow_run", deliveryId: "pre-pr", payload });
    await h.ingest({ key: "github.workflow_run.completed", dedupeKey: "pre-pr", occurredAt: new Date(NOW).toISOString(),
      summary: "Workflow completed", refs: {}, payload, subjects: normalized.subjects, status: "success" });
    expect((await h.store.getWakeup(id))?.eventBuffer).toEqual([expect.objectContaining({ dedupeKey: "derive:github.pull_request.checks_completed:pre-pr" })]);
    expect(h.http).not.toHaveBeenCalled();
    await h.ingest(event("pull_request", "opened"));
    expect((await h.store.getWakeup(id))?.cause).toBe("fired");
    expect(signals(h)[0]?.body).toContain("checks_completed · success");
  });

  it("evaluates completed CI after binding when a realistic pre-PR check run has no branch subject", async () => {
    const h = await harness();
    const id = await h.arm({ subject: "https://github.com/acme/app/tree/feat/nested" });
    await h.ingest(event("check_run", "success", { prePr: true }));
    const unbound = await h.store.getWakeup(id);
    expect(unbound?.eventBuffer).toEqual([]);
    expect(h.http).not.toHaveBeenCalled();
    await h.ingest(event("pull_request", "opened"));
    expect((await h.store.getWakeup(id))?.cause).toBe("fired");
    expect(signals(h)[0]?.body).toContain("checks_completed · success");
  });

  it("records a merge during the open-PR lookup and refuses the stale binding", async () => {
    const h = await harness();
    let release: (pr: string) => void = () => {};
    let began: () => void = () => {};
    const started = new Promise<void>((resolve) => { began = resolve; });
    h.armDeps.findGithubPullRequest = () => { began(); return new Promise((resolve) => { release = resolve; }); };
    const arm = h.arm({ subject: "https://github.com/acme/app/tree/feat/nested" });
    await started;
    await h.ingest(event("pull_request", "closed", { merged: true }), false);
    release(PR);
    const id = await arm;
    await h.watcher.eventPass(NOW);
    expect(await h.store.getWakeup(id)).toMatchObject({ status: "running", eventMatch: { closedPullRequests: [PR] } });
    expect((await h.store.getWakeup(id))?.eventMatch?.boundPullRequest).toBeUndefined();
    expect(signals(h)[0]?.body).toContain("pull_request.closed · merged");
    expect(signals(h)[0]?.body).toContain(MERGE);
    expect(signals(h)[0]?.body).toContain("branch wait stays armed");
  });

  it("rechecks the lookup candidate's state before binding", async () => {
    const h = await harness(); h.state.openPr = true; h.state.closed = true; h.state.merged = true;
    const id = await h.arm({ subject: "https://github.com/acme/app/tree/feat/nested" });
    await h.watcher.eventPass(NOW);
    expect((await h.store.getWakeup(id))?.eventMatch?.boundPullRequest).toBeUndefined();
    expect(signals(h)[0]?.body).toContain("pull_request.closed · merged");
  });

  it.each(["memory", "pglite"])("re-decides a stale fired CAS after a merge on %s", async (backend) => {
    const db = backend === "pglite" ? pgDbFromPglite(new PGlite()) : undefined;
    if (db) await applyEngineMigrations(db);
    try {
      const h = await harness(db ? new PgSessionStore(db) : new InMemorySessionStore());
      const id = await h.arm({ evaluateCurrent: false, on: [{ key: "github.check_run.completed" }] });
      await h.ingest(event("check_run", "success"), false);
      const original = h.store.transitionWakeup.bind(h.store);
      const transition = vi.spyOn(h.store, "transitionWakeup").mockImplementationOnce(async (...args) => {
        expect(args[3].cause).toBe("fired");
        await h.ingest(event("pull_request", "closed", { merged: true }), false);
        return original(...args);
      });
      await h.watcher.sweep(NOW);
      expect(transition).toHaveBeenCalledTimes(1);
      await h.watcher.sweep(NOW);
      expect(transition).toHaveBeenCalledTimes(1);
      h.state.now += 1000;
      await h.watcher.sweep(h.state.now);
      expect(transition).toHaveBeenCalledTimes(2);
      expect(await h.store.getWakeup(id)).toMatchObject({ status: "done", cause: "subject_closed", eventCount: 1 });
      expect(signals(h).map((s) => s.signalType)).toEqual(["event.matched", "event.ended"]);
      const digests: { key: string; merge_commit_sha?: string }[] = JSON.parse(signals(h)[0]!.attributes!.digests!);
      expect(digests.map((d) => d.key)).toEqual(["github.check_run.completed", "github.pull_request.closed"]);
      expect(digests[1]?.merge_commit_sha).toBe(MERGE);
    } finally { await db?.close(); }
  });

  it("keeps the waiter running with end_on_close false", async () => {
    const h = await harness(); h.state.pending = true;
    const id = await h.arm({ endOnClose: false });
    await h.ingest(event("pull_request", "closed", { merged: true }));
    expect((await h.store.getWakeup(id))?.status).toBe("running");
    expect(signals(h)).toHaveLength(0);
  });

  it("ignores a close for a different PR", async () => {
    const h = await harness(); h.state.pending = true;
    const id = await h.arm();
    await h.ingest(event("pull_request", "closed", { number: 7, merged: true }));
    expect((await h.store.getWakeup(id))?.status).toBe("running");
    expect(signals(h)).toHaveLength(0);
  });

  it("keeps a branch armed when its only earlier PR is closed", async () => {
    const h = await harness(); h.state.closed = true;
    const id = await h.arm({ subject: "https://github.com/acme/app/tree/feat/nested" });
    expect((await h.store.getWakeup(id))?.subjects).toEqual([BRANCH]);
    expect(signals(h)).toHaveLength(0);
  });

  it("refuses an already closed PR without a merge", async () => {
    const h = await harness(); h.state.closed = true;
    const result = await h.seam.armEvent!("t", { subject: "https://github.com/acme/app/pull/42", on: [{ key: CHECKS }], once: true, reason: "CI", maxHours: 6 });
    expect(result).toEqual({ refused: "[wait_for_event] This PR is closed. Arm on the branch or on a new PR instead." });
  });

  it("refuses an already merged PR with its merge SHA", async () => {
    const h = await harness(); h.state.closed = true; h.state.merged = true;
    const result = await h.seam.armEvent!("t", { subject: "https://github.com/acme/app/pull/42", on: [{ key: CHECKS }], once: true, reason: "CI", maxHours: 6 });
    expect(result).toEqual({ refused: `[wait_for_event] This PR is merged at ${MERGE}. Arm on the branch or on a new PR instead.` });
    expect(await h.store.listWakeups("s")).toEqual([]);
  });
});
