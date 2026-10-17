/**
 * The acceptance scenarios of the event wakeups spec
 * (`docs/specs/2026-10-15-event-wakeups-design.md`, "Acceptance scenarios"),
 * one `it` per scenario, each from a clean database.
 *
 * What runs for real: the api app (`bootTestApi`), signed webhooks into the
 * GitHub App, Slack Events, and Linear ingest routes, the Postgres store,
 * the `wait_for_event` and `wakeup_cancel` tools in real agent turns, the
 * arm checks, the matcher, and a WakeWatcher with the production derive
 * step. What is stubbed: the model (a scripted faux provider that calls the
 * tools a step names), the GitHub API (`startGithubFixture`), and the Slack
 * and Linear APIs (a `fetch` stub for `slack.com` and `api.linear.app`).
 *
 * The WakeWatcher runs on a fake clock and the test calls `sweep()` by
 * hand, so the min-interval steps need no real waits. The spec's "within
 * 5 seconds" and "within 10 seconds" windows become "after the next pass".
 *
 * Universe mapping: org `acme` is the harness org `local-org`, and user
 * `u-001` is `local-user`. The external ids (GitHub `ada` 1001, Slack
 * `U001`, Linear `lin-u1`) are the spec's.
 *
 * Step A2 needs a sandbox that hibernates. Here it asserts that the waiter
 * stays running with no lease across three idle minutes; the kubernetes
 * check of the plan covers the pod itself.
 */
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { resolveWakeupLimits } from "../providers/sandbox-backend.js";
import { eventSubscriptions } from "../schema/index.js";
import {
  APP_ID,
  INSTALLATION,
  PR_URL,
  PR_SUBJECT,
  HEAD_SHA,
  REPO_SUBJECT,
  SLACK_TEAM,
  BOT_ID,
  BOT_USER,
  THREAD_ROOT,
  SLACK_PERMALINK,
  PENDING_FAILURES,
  asRecord,
  teardownUniverse,
  bootUniverse,
  poll,
  signals,
  prompt,
  awaitSignals,
  expectNoNewSignal,
  rowsOf,
  leaseCount,
  queuedWith,
  queuedSignals,
  eventWaiters,
  waiterIdFrom,
  postGithub,
  checkRunCompleted,
  postSlack,
  nextSlackTs,
  slackMessage,
  postLinear,
  linearIssue,
  TEAM,
  ruleRow,
  createIncidentTeam,
  armIncident,
} from "./_event-universe.js";

afterEach(teardownUniverse);

// ── The scenarios ───────────────────────────────────────────────────────

describe("api integration: event wakeups acceptance scenarios", () => {
  it("Scenario A: CI on a pull request", async () => {
    const u = await bootUniverse();
    const p = u.api.providers;
    const limits = resolveWakeupLimits(process.env);

    // A1: the agent arms the CI wait.
    u.agent.on(/STEP A1/, [{
      name: "wait_for_event",
      args: {
        subject: PR_URL,
        on: [{ key: "github.check_run.completed", status: PENDING_FAILURES }, { key: "github.pull_request.checks_completed" }],
        once: false, reason: "CI on #42", max_hours: 6,
      },
    }]);
    const [armed] = await prompt(u, "STEP A1", 1);
    expect(armed?.toolName).toBe("wait_for_event");
    expect(armed?.text.startsWith("waiting wk_")).toBe(true);
    expect(armed?.text).toContain(PR_SUBJECT);
    const waiterId = waiterIdFrom(armed?.text ?? "");
    const [row] = await eventWaiters(u);
    // A derived clause indexes the waiter by the repository too, for commit
    // statuses; direct clauses still need the pull request subject.
    expect(row).toMatchObject({ id: waiterId, kind: "event", status: "running", subjects: [PR_SUBJECT, REPO_SUBJECT] });
    expect(row?.eventMatch?.primarySubject).toBe(PR_SUBJECT);
    // self: ada's link, the actor behind her token, and the App bot user.
    expect([...(row?.eventMatch?.self ?? [])].sort()).toEqual(["1001", APP_ID]);
    expect(await eventWaiters(u)).toHaveLength(1);
    expect(await leaseCount(u)).toBe(0);

    // A2: the turn ends and three idle minutes pass. The waiter keeps
    // running and holds no lease, so nothing pins the sandbox.
    u.clock.now += 3 * 60_000;
    await u.watcher.sweep(u.clock.now);
    expect(await p.engineStore.getWakeup(waiterId)).toMatchObject({ status: "running" });
    expect(await leaseCount(u)).toBe(0);

    // A3: lint passes while test still runs. The derived clause reads one
    // pending run, so no signal.
    u.runs.current = [
      { name: "lint", status: "completed", conclusion: "success" },
      { name: "test", status: "in_progress", conclusion: null },
    ];
    await postGithub(u, "check_run", "gh-a3", checkRunCompleted("lint", "success", 1));
    u.clock.now += 1_000;
    await u.watcher.sweep(u.clock.now);
    await expectNoNewSignal(u, "event.matched", 0);
    expect((await p.engineStore.getWakeup(waiterId))?.eventBuffer ?? []).toEqual([]);
    // The derive step read the pull request and its check runs.
    expect(u.github.calls.some((c) => c.path === "/repos/acme/lean-proofs/pulls/42")).toBe(true);
    expect(u.github.calls.some((c) => c.path === `/repos/acme/lean-proofs/commits/${HEAD_SHA}/check-runs`)).toBe(true);

    // A4: test fails while build still runs. The failure clause matches.
    u.runs.current = [
      { name: "lint", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "failure" },
      { name: "build", status: "in_progress", conclusion: null },
    ];
    await postGithub(u, "check_run", "gh-a4", checkRunCompleted("test", "failure", 2));
    u.clock.now += 1_000;
    await u.watcher.sweep(u.clock.now);
    const [a4] = await awaitSignals(u, "event.matched", 1);
    expect(a4?.content).toContain("github.check_run.completed · failure");
    // The failure also fed the derived clause; build still runs, so its
    // derive digest was dropped with no signal.
    expect((await p.engineStore.getWakeup(waiterId))?.eventSeen).toContain("derive:github.pull_request.checks_completed:gh-a4");
    await expectNoNewSignal(u, "event.matched", 1);

    // A5: build passes and no run is pending. The derived event reports the
    // failure. It arrives after the min interval, so the next pass sends it.
    u.runs.current = [
      { name: "lint", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "failure" },
      { name: "build", status: "completed", conclusion: "success" },
    ];
    u.clock.now += limits.watchMinIntervalMs;
    await postGithub(u, "check_run", "gh-a5", checkRunCompleted("build", "success", 3));
    await u.watcher.sweep(u.clock.now);
    const a5 = await awaitSignals(u, "event.matched", 2);
    expect(a5).toHaveLength(2);
    expect(a5[1]?.content).toContain("github.pull_request.checks_completed · failure");

    // A6: the agent cancels the wait. No signal follows.
    u.agent.on(/STEP A6/, [{ name: "wakeup_cancel", args: { id: waiterId } }]);
    const [cancelled] = await prompt(u, "STEP A6", 1);
    expect(cancelled?.text).toBe(`cancelled ${waiterId}`);
    expect(await p.engineStore.getWakeup(waiterId)).toMatchObject({ status: "cancelled" });
    await postGithub(u, "check_run", "gh-a6", checkRunCompleted("build", "failure", 4));
    u.clock.now += limits.watchMinIntervalMs;
    await u.watcher.sweep(u.clock.now);
    await expectNoNewSignal(u, "event.matched", 2);
    expect(await signals(u, "event.ended")).toHaveLength(0);
  }, 60_000);

  it("Scenario A errata: a commit status completes the checks of a pull request (final review, item 3)", async () => {
    const u = await bootUniverse();
    const p = u.api.providers;
    u.agent.on(/STEP AS1/, [{
      name: "wait_for_event",
      args: {
        subject: PR_URL,
        on: [{ key: "github.check_run.completed", status: PENDING_FAILURES }, { key: "github.pull_request.checks_completed" }],
        once: true, reason: "CI on #42", max_hours: 6,
      },
    }]);
    const [armed] = await prompt(u, "STEP AS1", 1);
    const waiterId = waiterIdFrom(armed?.text ?? "");
    u.runs.current = [{ name: "lint", status: "completed", conclusion: "success" }];
    u.runs.combined = { state: "pending", statuses: [{ state: "pending", context: "ci/legacy", updated_at: new Date().toISOString() }] };

    // A check run on another pull request of the repository fails. No
    // direct clause matches it, and its SHA is not the head of #42.
    const other = checkRunCompleted("test", "failure", 7);
    const otherRun = asRecord(other.check_run) ?? {};
    other.check_run = { ...otherRun, head_sha: "bbbb000000000000000000000000000000000002", pull_requests: [{ number: 7, head: { sha: "bbbb000000000000000000000000000000000002" } }] };
    await postGithub(u, "check_run", "gh-as2", other);
    u.clock.now += 1_000;
    await u.watcher.sweep(u.clock.now);
    await expectNoNewSignal(u, "event.matched", 0);
    expect(await p.engineStore.getWakeup(waiterId)).toMatchObject({ status: "running", eventBuffer: [] });

    // The legacy commit status passes. It names no pull request, only the
    // repository and the commit, and it completes the last check.
    u.runs.combined = { state: "success", statuses: [{ state: "success", context: "ci/legacy", updated_at: new Date().toISOString() }] };
    await postGithub(u, "status", "gh-as3", {
      sha: HEAD_SHA, state: "success", context: "ci/legacy",
      repository: { full_name: "acme/lean-proofs", name: "lean-proofs", owner: { login: "acme" } },
      installation: { id: INSTALLATION },
      sender: { id: 1002, login: "ci-bot", type: "User" },
    });
    u.clock.now += 1_000;
    await u.watcher.sweep(u.clock.now);
    const [fired] = await awaitSignals(u, "event.matched", 1);
    expect(fired?.content).toContain("github.pull_request.checks_completed · success");
    expect(await p.engineStore.getWakeup(waiterId)).toMatchObject({ status: "done", cause: "fired" });
  }, 60_000);

  it("Scenario B: a Slack thread reply", async () => {
    const u = await bootUniverse();
    const p = u.api.providers;

    // B1: the agent waits on the thread's permalink.
    u.agent.on(/STEP B1/, [{
      name: "wait_for_event",
      args: { subject: SLACK_PERMALINK, on: [{ key: "slack.message", bots: false }], reason: "Reply from Grace", max_hours: 24 },
    }]);
    const [armed] = await prompt(u, "STEP B1", 1);
    const waiterId = waiterIdFrom(armed?.text ?? "");
    const armedRow = await p.engineStore.getWakeup(waiterId);
    expect(armedRow).toMatchObject({ subjects: [`slack:${SLACK_TEAM}/C001/${THREAD_ROOT}`] });
    expect([...(armedRow?.eventMatch?.self ?? [])].sort()).toEqual([BOT_USER, "U001"].sort());

    // B2: the bot B9 replies in the thread. No signal.
    await postSlack(u, slackMessage("C001", BOT_USER, "I am on it", THREAD_ROOT, { subtype: "bot_message", bot_id: BOT_ID }));
    u.clock.now += 1_000;
    await u.watcher.sweep(u.clock.now);
    await expectNoNewSignal(u, "event.matched", 0);

    // B3: U002 replies. One signal with the text; the waiter ends as fired.
    await postSlack(u, slackMessage("C001", "U002", "Looks good, ship it", THREAD_ROOT));
    u.clock.now += 1_000;
    await u.watcher.sweep(u.clock.now);
    const [b3] = await awaitSignals(u, "event.matched", 1);
    expect(b3?.content).toContain("Looks good, ship it");
    expect(await p.engineStore.getWakeup(waiterId)).toMatchObject({ status: "done", cause: "fired" });

    // B4: another reply. No signal.
    await postSlack(u, slackMessage("C001", "U002", "Shipped", THREAD_ROOT));
    u.clock.now += 1_000;
    await u.watcher.sweep(u.clock.now);
    await expectNoNewSignal(u, "event.matched", 1);
  }, 60_000);

  it("Scenario C: a Linear triage shift", async () => {
    const u = await bootUniverse();
    const p = u.api.providers;
    const limits = resolveWakeupLimits(process.env);

    // C1: the agent waits on the ENG triage view.
    u.agent.on(/STEP C1/, [{
      name: "wait_for_event",
      args: {
        subject: "https://linear.app/acme/team/ENG/triage",
        on: [
          { key: "linear.issue.create", status: ["triage"] },
          { key: "linear.issue.update", status: ["triage"], from_status: ["backlog", "unstarted", "started", "completed", "canceled"] },
        ],
        once: false, reason: "ENG triage shift", max_hours: 8,
      },
    }]);
    const [armed] = await prompt(u, "STEP C1", 1);
    const waiterId = waiterIdFrom(armed?.text ?? "");
    const armedRow = await p.engineStore.getWakeup(waiterId);
    expect(armedRow).toMatchObject({ subjects: ["linear:team/ENG"] });
    expect([...(armedRow?.eventMatch?.self ?? [])].sort()).toEqual(["app-1", "lin-u1"]);

    // C2: a person creates ENG-8 in triage.
    await postLinear(u, { action: "create", ...linearIssue("ENG-8", "triage") });
    u.clock.now += 1_000;
    await u.watcher.sweep(u.clock.now);
    const [c2] = await awaitSignals(u, "event.matched", 1);
    expect(c2?.content).toContain("ENG-8");
    const c2At = u.clock.now;

    // C3: a title-only update to ENG-8. No signal.
    await postLinear(u, { action: "update", ...linearIssue("ENG-8", "triage"), updatedFrom: { title: "Old title" } });
    u.clock.now += 1_000;
    await u.watcher.sweep(u.clock.now);
    await expectNoNewSignal(u, "event.matched", 1);

    // C4: ENG-9 moves from backlog to triage. It waits for the min interval.
    await postLinear(u, { action: "update", ...linearIssue("ENG-9", "triage"), updatedFrom: { stateId: "st-backlog" } });
    u.clock.now = c2At + limits.watchMinIntervalMs - 1_000;
    await u.watcher.sweep(u.clock.now);
    await expectNoNewSignal(u, "event.matched", 1);
    u.clock.now = c2At + limits.watchMinIntervalMs;
    await u.watcher.sweep(u.clock.now);
    const c4 = await awaitSignals(u, "event.matched", 2);
    expect(c4[1]?.content).toContain("ENG-9");
    expect(c4[1]?.content).not.toContain("ENG-8");

    // C5: the app actor comments on ENG-8. No signal (self).
    await postLinear(u, {
      action: "create", type: "Comment",
      data: { id: "cm-1", body: "Triaged by Valet", issue: { identifier: "ENG-8", team: { key: "ENG" } } },
      actor: { id: "app-1", type: "application", name: "Valet" },
    });
    u.clock.now += limits.watchMinIntervalMs;
    await u.watcher.sweep(u.clock.now);
    await expectNoNewSignal(u, "event.matched", 2);
    expect(await p.engineStore.getWakeup(waiterId)).toMatchObject({ status: "running", eventBuffer: [] });
  }, 60_000);

  it("Scenario D: refusals at arm", async () => {
    const u = await bootUniverse();

    // D1: an owner the installation does not cover.
    u.agent.on(/STEP D1/, [{
      name: "wait_for_event",
      args: { subject: "https://github.com/umbrella/proofs/pull/1", on: [{ key: "github.check_run.completed" }], reason: "CI", max_hours: 1 },
    }]);
    const [d1] = await prompt(u, "STEP D1", 1);
    expect(d1?.text).toBe(
      "[wait_for_event] The GitHub App installation does not cover umbrella/proofs. Install the app on that repository, then wait again.",
    );
    expect(await eventWaiters(u)).toHaveLength(0);

    // D2: a Slack channel without the bot.
    u.agent.on(/STEP D2/, [{
      name: "wait_for_event",
      args: { subject: "https://acme.slack.com/archives/C002/p1712345678000100", on: [{ key: "slack.message" }], reason: "Reply", max_hours: 1 },
    }]);
    const [d2] = await prompt(u, "STEP D2", 1);
    expect(d2?.text).toBe(
      "[wait_for_event] Valet is not in #random-2, so it does not receive its messages. Invite @Valet to the channel, then wait again.",
    );

    // D3: a key no catalog lists.
    u.agent.on(/STEP D3/, [{
      name: "wait_for_event",
      args: { subject: PR_URL, on: [{ key: "github.check_suite.done" }], reason: "CI", max_hours: 1 },
    }]);
    const [d3] = await prompt(u, "STEP D3", 1);
    expect(d3?.text).toBe("[wait_for_event] github.check_suite.done is not an event key for github. Call workflows.list_event_types for the keys.");
    expect(await eventWaiters(u)).toHaveLength(0);
    expect(await leaseCount(u)).toBe(0);
  }, 60_000);

  it("Scenario E: an incident channel", async () => {
    const u = await bootUniverse();
    const p = u.api.providers;
    await createIncidentTeam(u);
    // The mention rule follows its threads (Scenario E universe).
    await p.db.insert(eventSubscriptions).values(
      ruleRow("sub-mentions", { type: "team", id: TEAM }, ["slack.app_mention"], [], { kind: "assistant", follow: true }),
    );

    // E1 and E2: the channel opens t-inc, and the agent arms the stream wait.
    const { tInc, waiterId } = await armIncident(u);

    // E3: three messages arrive before the next pass. One signal lists all three.
    await postSlack(u, slackMessage("C900", "U002", "db latency p99 is 4s"));
    await postSlack(u, slackMessage("C900", "U003", "replica lag on db-2"));
    await postSlack(u, slackMessage("C900", "U002", "failing over now"));
    u.clock.now += 1_000;
    await u.watcher.sweep(u.clock.now);
    const [e3] = await awaitSignals(u, "event.matched", 1, tInc.sessionId, tInc.threadId);
    for (const text of ["db latency p99 is 4s", "replica lag on db-2", "failing over now"]) expect(e3?.content).toContain(text);
    expect(e3?.signal?.attributes?.matchCount).toBe("3");
    const e3At = u.clock.now;

    // E4: one more message 20 seconds later. It goes out 30 seconds after E3's signal.
    u.clock.now = e3At + 20_000;
    await postSlack(u, slackMessage("C900", "U003", "failover done"));
    await u.watcher.sweep(u.clock.now);
    await expectNoNewSignal(u, "event.matched", 1, tInc.sessionId, tInc.threadId);
    u.clock.now = e3At + 29_000;
    await u.watcher.sweep(u.clock.now);
    await expectNoNewSignal(u, "event.matched", 1, tInc.sessionId, tInc.threadId);
    u.clock.now = e3At + 30_000;
    await u.watcher.sweep(u.clock.now);
    const e4 = await awaitSignals(u, "event.matched", 2, tInc.sessionId, tInc.threadId);
    expect(e4[1]?.content).toContain("failover done");

    // E5: a mention of the bot in the watched channel. The mention rule
    // delivers it once, to t-inc, and the waiter appends no digest for it.
    // Scenario C of the claims spec (`event-claims.test.ts`) covers the rest.
    const mentionTs = nextSlackTs();
    const mentionText = `<@${BOT_USER}> status?`;
    await postSlack(u, { ...slackMessage("C900", "U001", mentionText), ts: mentionTs });
    await postSlack(u, { type: "app_mention", channel: "C900", user: "U001", text: mentionText, ts: mentionTs, team: SLACK_TEAM, event_ts: mentionTs });
    await p.eventDispatcher.pollOnce();
    const mentions = await poll(() => queuedSignals(u, "slack.app_mention"), (rows) => rows.length > 0, "the app_mention delivery");
    u.clock.now += 60_000;
    await u.watcher.sweep(u.clock.now);
    await expectNoNewSignal(u, "event.matched", 2, tInc.sessionId, tInc.threadId);
    expect(await p.engineStore.getWakeup(waiterId)).toMatchObject({ status: "running", eventBuffer: [] });
    // Exactly one turn carries the post, it comes from the subscription, and it is in t-inc.
    const turns = await queuedWith(u, "status?");
    expect(turns).toHaveLength(1);
    expect(mentions).toHaveLength(1);
    expect(turns[0]?.id).toBe(mentions[0]?.id);
    expect(turns[0]).toMatchObject(tInc);
    // No new assistant thread exists for the mention's Slack post.
    const mentionThreads = rowsOf(await p.db.execute(sql`SELECT id FROM engine_threads WHERE key = ${`slack:C900:${mentionTs}`}`));
    expect(mentionThreads).toHaveLength(0);
  }, 90_000);
});
