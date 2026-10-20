import { describe, expect, it, vi } from "vitest";
import { InMemorySessionStore, type ArmEventRequest, type NormalizedEvent, type PromptContent, type PromptOptions } from "@valet/engine";
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

async function harness() {
  const store = new InMemorySessionStore();
  await store.saveSession({ id: "s", userId: "u", orgId: "org", owner: { type: "user", id: "u" }, workspace: "/",
    purpose: "interactive", status: "running", createdAt: NOW, updatedAt: NOW });
  const state = { pending: false, error: false, openPr: false, closed: false, merged: false, now: NOW };
  const http = vi.fn<typeof fetch>(async (input) => {
    if (state.error) throw new Error("fixture read failed");
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/pulls/42")) return Response.json({ head: { sha: SHA }, html_url: "https://github.com/acme/app/pull/42" });
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
  const watcher = new WakeWatcher({ engineStore: store, engineHost: { sessionFor: async () => session, liveSession: () => null },
    loadSession: async () => session, provider: { restore: async () => { throw new Error("Event waiters do not restore a sandbox"); } }, limits, deriveEvent: derive, now: () => state.now });
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
  const seam = buildWakeupsSeam({ engineStore: store, limits, now: () => state.now, evaluateEvent: derive,
    checkArm: (threadId, req) => checkArm(armDeps, { sessionId: "s", threadId, orgId: "org" }, req),
  }, "s", () => undefined);
  const matchDeps: WaiterMatchDeps = { engineStore: store, plugins: [githubPlugin],
    sessionOrg: async () => ({ orgId: "org", ownerType: "user", ownerId: "u" }),
    slackStillVisible: async () => true, resolvePreviousStatus: async () => null, slackBotUserId: async () => undefined, now: () => state.now };
  async function ingest(event: NormalizedEvent) {
    await appendWaiterDigests(matchDeps, "github", await evaluateWaiterCandidates(matchDeps, "org", "github", event));
    await watcher.sweep(state.now);
  }
  async function arm(over: Partial<ArmEventRequest> = {}) {
    const result = await seam.armEvent!("t", { subject: "https://github.com/acme/app/pull/42", on: [{ key: CHECKS }], once: true,
      reason: "CI", maxHours: 6, ...over });
    if ("refused" in result) throw new Error(result.refused);
    return result.wakeup.id;
  }
  return { store, state, http, prompt, watcher, ingest, arm, seam, armDeps };
}

function event(type: "pull_request" | "check_run", action: string, options: { fork?: boolean; number?: number; merged?: boolean; branch?: boolean } = {}): NormalizedEvent {
  const payload = { repository: { full_name: "acme/app" }, action,
    ...(type === "pull_request" ? { pull_request: { number: options.number ?? 42, merged: options.merged ?? false, merge_commit_sha: MERGE,
      head: { ref: "feat/nested", sha: SHA, repo: { full_name: options.fork ? "fork/app" : "acme/app" } } } }
      : { check_run: { head_sha: SHA, conclusion: action === "failure" ? "failure" : "success", pull_requests: [{ number: options.number ?? 42 }],
        ...(options.branch ? { check_suite: { head_branch: "feat/nested" } } : {}) } }),
  };
  const trigger = githubPlugin.triggers?.find((entry) => entry.id === `github.${type}`);
  if (!trigger) throw new Error("Missing GitHub fixture normalizer");
  const normalized = trigger.toEvent({ eventType: type, deliveryId: "fixture", payload });
  return { key: `github.${type}.${type === "check_run" ? "completed" : action}`, dedupeKey: `${type}:${action}:${options.number ?? 42}`,
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
    expect((await h.store.getWakeup(id))?.eventBuffer?.[0]).toMatchObject({ key: CHECKS, status: "success", head_sha: SHA });
    await h.watcher.sweep(NOW);
    expect((await h.store.getWakeup(id))?.cause).toBe("fired");
    expect(signals(h)[0]?.body).toContain("checks_completed · success");
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
      expect(log).toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it("binds an existing open PR after storing the branch waiter and evaluates it", async () => {
    const h = await harness(); h.state.openPr = true;
    const id = await h.arm({ subject: "https://github.com/acme/app/tree/feat/nested" });
    expect((await h.store.getWakeup(id))?.subjects).toEqual([PR, BRANCH, "github:acme/app"]);
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
    expect((await h.store.getWakeup(id))?.subjects).toEqual([PR, BRANCH, "github:acme/app"]);
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

  it("ends a branch-bound waiter on close without merge", async () => {
    const h = await harness(); h.state.openPr = true; h.state.pending = true;
    const id = await h.arm({ subject: "https://github.com/acme/app/tree/feat/nested", once: false });
    await h.ingest(event("pull_request", "closed"));
    expect((await h.store.getWakeup(id))?.cause).toBe("subject_closed");
    expect(signals(h)[0]?.body).toContain("pull_request.closed · closed");
    expect(signals(h)[1]?.body).toContain("PR was closed");
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
