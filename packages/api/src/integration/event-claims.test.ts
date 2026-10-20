/**
 * Scenario C of the delivery threads and claims spec
 * (`docs/specs/2026-10-16-delivery-threads-and-claims-design.md`,
 * "Acceptance scenarios"): steps C1 to C12 in one run, from a clean
 * database.
 *
 * The universe is the event wakeups spec's Scenario E after step E2
 * (`_event-universe.ts`, `armIncident`). What runs for real: the api app,
 * signed webhooks into the GitHub App, Slack Events, and Linear ingest
 * routes, claim resolution at ingest, the event dispatcher, the follow
 * router, the assistant delivery path, and a WakeWatcher with the
 * production derive step. What is stubbed: the model (a scripted faux
 * provider), the GitHub API (`startGithubFixture`), and the Slack and Linear
 * APIs (a `fetch` stub).
 *
 * Universe mapping:
 * - Team `sre` is the harness team `team-acme`, and `platform` is
 *   `team-platform`. Org `acme` is `local-org`, and `u-001` is `local-user`.
 * - Channel `C900` is `#inc-db-latency`, the Scenario E channel. A
 *   `slack.message` event does not name its channel, so C7's subject thread
 *   title is the channel id `C900` (spec Part D, Deviations).
 * - The review rules name the catalog key `github.pull_request_review.submitted`
 *   (spec Deviations, "Scenario T uses the GitHub catalog's real keys").
 * - Thread `t-s` is opened and bound by a mention in Slack thread `X2`
 *   before E2, so no waiter exists to claim that mention.
 * - `t-pr` opened `#14` through Valet: the test writes its
 *   `thread_pull_requests` row.
 */
import type { JsonObject } from "@earendil-works/pi-ai/compat";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { findFollowedThread } from "../events/followed-threads.js";
import type { SubscriptionFilter } from "../events/match.js";
import {
  eventDeliveries,
  eventSubscriptions,
  teamMembers,
  teams,
  threadPullRequests,
  workflowDefinitions,
  workflowRuns,
} from "../schema/index.js";
import type { CreateThreadResponse } from "../wire/types.js";
import {
  API_HEADS,
  BOT_USER,
  INSTALLATION,
  ORG,
  SLACK_TEAM,
  TEAM,
  USER,
  armIncident,
  asRecord,
  awaitSignals,
  bootUniverse,
  createIncidentTeam,
  eventWaiters,
  expectNoNewSignal,
  linearIssue,
  nextSlackTs,
  poll,
  postGithub,
  postLinear,
  postSlack,
  prompt,
  queuedSignals,
  queuedWith,
  rowsOf,
  ruleRow,
  slackMessage,
  teardownUniverse,
  waiterIdFrom,
  type Universe,
} from "./_event-universe.js";

afterEach(teardownUniverse);

const PLATFORM = "team-platform";
const SRE = { type: "team", id: TEAM } as const;
const U001_OWNER = { type: "user", id: USER } as const;
const IN_C900: SubscriptionFilter[] = [{ field: "channel", op: "eq", value: "C900" }];
const IN_API: SubscriptionFilter[] = [{ field: "repo", op: "eq", value: "acme/api" }];
const WORKFLOW_ID = "wf-review-audit";

interface ThreadRef {
  sessionId: string;
  threadId: string;
}

// ── Steps ───────────────────────────────────────────────────────────────

/** Advances the fake clock past every min interval and runs one WakeWatcher pass. */
async function tick(u: Universe): Promise<void> {
  u.clock.now += 10 * 60_000;
  await u.watcher.sweep(u.clock.now);
}

/** Posts both halves of one bot mention in `C900`, the message first, and returns its ts. */
async function mention(u: Universe, user: string, text: string, threadTs?: string): Promise<string> {
  const ts = nextSlackTs();
  await postSlack(u, { ...slackMessage("C900", user, text, threadTs), ts });
  await postSlack(u, {
    type: "app_mention", channel: "C900", user, text, ts, team: SLACK_TEAM, event_ts: ts, ...(threadTs ? { thread_ts: threadTs } : {}),
  });
  return ts;
}

type DeliveryRow = typeof eventDeliveries.$inferSelect;

async function deliveriesOf(u: Universe, subscriptionId: string): Promise<DeliveryRow[]> {
  return u.api.providers.db.select().from(eventDeliveries)
    .where(eq(eventDeliveries.subscriptionId, subscriptionId)).orderBy(eventDeliveries.createdAt);
}

const SETTLED = new Set(["delivered", "dead", "skipped"]);

/** Drives the dispatcher until `subscriptionId` holds `count` settled deliveries, then returns the last one. */
async function settled(u: Universe, subscriptionId: string, count: number): Promise<DeliveryRow> {
  const rows = await poll(async () => {
    await u.api.providers.eventDispatcher.pollOnce();
    return deliveriesOf(u, subscriptionId);
  }, (r) => r.length >= count && r.every((d) => SETTLED.has(d.status)), `${count} settled deliveries of ${subscriptionId}`);
  expect(rows).toHaveLength(count);
  const last = rows[count - 1];
  if (!last) throw new Error(`no delivery ${count} of ${subscriptionId}`);
  return last;
}

/** The thread each admitted turn of one delivery landed in. */
async function landings(u: Universe, deliveryId: string): Promise<ThreadRef[]> {
  const rows = rowsOf(await u.api.providers.db.execute(
    sql`SELECT session_id, thread_id FROM engine_queue_items WHERE dispatch_id = ${`event:${deliveryId}`} ORDER BY created_at`,
  ));
  return rows.map((row) => {
    const rec = asRecord(row) ?? {};
    return { sessionId: String(rec.session_id), threadId: String(rec.thread_id) };
  });
}

/** The engine threads with exactly `key`, with their titles. */
async function threadsKeyed(u: Universe, key: string): Promise<Array<{ id: string; sessionId: string; title: string | null }>> {
  const rows = rowsOf(await u.api.providers.db.execute(sql`
    SELECT t.id, t.session_id, st.title FROM engine_threads t
    LEFT JOIN session_threads st ON st.id = t.id AND st.session_id = t.session_id
    WHERE t.key = ${key}`));
  return rows.map((row) => {
    const rec = asRecord(row) ?? {};
    return { id: String(rec.id), sessionId: String(rec.session_id), title: typeof rec.title === "string" ? rec.title : null };
  });
}

async function threadKey(u: Universe, at: ThreadRef): Promise<string | undefined> {
  return (await u.api.providers.engineStore.getThread(at.sessionId, at.threadId))?.key;
}

function skippedFor(thread: ThreadRef): Partial<DeliveryRow> {
  return { status: "skipped", lastError: `Skipped, claimed by thread ${thread.threadId}.` };
}

/** One `u-001` assistant thread, created through the REST API. */
async function createThread(u: Universe, title: string): Promise<ThreadRef> {
  const res = await fetch(`${u.api.baseUrl}/api/threads`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const thread = (await res.json()) as CreateThreadResponse;
  return { sessionId: thread.sessionId, threadId: thread.id };
}

/** Arms one stream waiter in `at` through a real `wait_for_event` turn and returns its id. */
async function armWaiter(u: Universe, at: ThreadRef, step: string, args: JsonObject): Promise<string> {
  u.agent.on(new RegExp(step), [{ name: "wait_for_event", args: { once: false, max_hours: 24, ...args } }]);
  const [armed] = await prompt(u, step, 1, at);
  expect(armed?.text.startsWith("waiting wk_"), armed?.text).toBe(true);
  return waiterIdFrom(armed?.text ?? "");
}

// ── GitHub payloads on acme/api ─────────────────────────────────────────

let githubSeq = 0;
const PAST = () => new Date(Date.now() - 60_000).toISOString();
const REPOSITORY = { full_name: "acme/api", name: "api", owner: { login: "acme" } };
const GRACE = { login: "grace", id: 1002, type: "User" };

function pullUrl(pr: number): string {
  return `https://github.com/acme/api/pull/${pr}`;
}

/** A human review. It was submitted a minute ago, so the dispatcher's settle wait has passed. */
function review(pr: number, body: string): Record<string, unknown> {
  return {
    action: "submitted",
    review: { id: 5000 + ++githubSeq, state: "commented", body, user: GRACE, submitted_at: PAST() },
    pull_request: { number: pr, html_url: pullUrl(pr), head: { sha: API_HEADS[pr] }, user: { login: "ada", id: 1001 } },
    repository: REPOSITORY, installation: { id: INSTALLATION }, sender: GRACE,
  };
}

function issueComment(pr: number, body: string): Record<string, unknown> {
  return {
    action: "created",
    issue: { number: pr, html_url: pullUrl(pr), pull_request: { html_url: pullUrl(pr), url: `https://api.github.com/repos/acme/api/pulls/${pr}` } },
    comment: { id: 6000 + ++githubSeq, body, user: GRACE, created_at: PAST() },
    repository: REPOSITORY, installation: { id: INSTALLATION }, sender: GRACE,
  };
}

function checkRun(pr: number, name: string): Record<string, unknown> {
  const id = 7000 + ++githubSeq;
  const sha = API_HEADS[pr];
  return {
    action: "completed",
    check_run: {
      id, name, status: "completed", conclusion: "failure", head_sha: sha,
      html_url: `https://github.com/acme/api/runs/${id}`, pull_requests: [{ number: pr, head: { sha } }], completed_at: PAST(),
    },
    repository: REPOSITORY, installation: { id: INSTALLATION }, sender: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
  };
}

// ── The scenario ────────────────────────────────────────────────────────

describe("api integration: claims acceptance scenario", () => {
  it("Scenario C: claims", async () => {
    const u = await bootUniverse();
    const p = u.api.providers;

    // ── Universe ──
    // Team sre and its rule M: mentions in C900, a thread per mention, follow.
    await createIncidentTeam(u);
    await p.db.insert(eventSubscriptions).values(
      ruleRow("M", SRE, ["slack.app_mention"], IN_C900, { kind: "assistant", follow: true, thread: { mode: "new" } }),
    );
    // t-s: a mention in Slack thread X2 before E2 opens an sre thread and binds X2 to it.
    const x2 = await mention(u, "U001", `<@${BOT_USER}> what is the rollback plan?`);
    const bound = await settled(u, "M", 1);
    const [tS] = await landings(u, bound.id);
    if (!tS) throw new Error("the X2 mention landed nowhere");
    expect(await findFollowedThread(p.db, { orgId: ORG, channelType: "slack", channelId: "C900", threadTs: x2 }))
      .toMatchObject({ ownerType: "team", ownerId: TEAM, sessionId: tS.sessionId, threadId: tS.threadId });

    // E1 and E2: the channel opens t-inc, and its agent arms the stream wait.
    const { tInc, waiterId } = await armIncident(u);
    expect(tS.threadId).not.toBe(tInc.threadId);
    // Rule P: channel messages in C900, grouped by the channel.
    await p.db.insert(eventSubscriptions).values(
      ruleRow("P", SRE, ["slack.message"], IN_C900, { kind: "assistant", thread: { mode: "subject" } }),
    );

    // u-001: t-pr waits on #12 and #14 and opened #14; t-tri waits on ENG-42.
    const tPr = await createThread(u, "t-pr");
    const tTri = await createThread(u, "t-tri");
    await armWaiter(u, tPr, "ARM PR12", {
      subject: pullUrl(12), on: [{ key: "github.pull_request_review.submitted" }, { key: "github.pull_request.checks_completed" }], reason: "Reviews and CI on #12",
    });
    await armWaiter(u, tPr, "ARM PR14", {
      subject: pullUrl(14), on: [{ key: "github.check_run.completed" }, { key: "github.issue_comment.created" }], reason: "CI and comments on #14",
    });
    const now = Date.now();
    await p.db.insert(threadPullRequests).values({
      sessionId: tPr.sessionId, threadId: tPr.threadId, url: pullUrl(14), repo: "acme/api", number: 14, state: "open",
      createdAt: now, updatedAt: now, checkedAt: now,
    });
    await armWaiter(u, tTri, "ARM ENG42", { subject: "https://linear.app/acme/issue/ENG-42", on: [{ key: "linear.issue.update" }], reason: "ENG-42" });
    await p.db.insert(workflowDefinitions).values({
      id: WORKFLOW_ID, orgId: ORG, ownerType: "user", ownerId: USER, name: "Review audit",
      definition: { version: "dag/v1", nodes: [], edges: [] }, createdAt: now, updatedAt: now,
    });
    await p.db.insert(eventSubscriptions).values([
      ruleRow("R1", U001_OWNER, ["github.pull_request_review.submitted", "github.check_run.completed"], IN_API, { kind: "assistant", thread: { mode: "subject" } }),
      ruleRow("R3", U001_OWNER, ["linear.issue.update"], [{ field: "team", op: "eq", value: "ENG" }], { kind: "assistant", thread: { mode: "own" } }),
      ruleRow("R5", U001_OWNER, ["github.issue_comment.created"], IN_API, { kind: "assistant", thread: { mode: "subject" } }),
      ruleRow("W", U001_OWNER, ["github.pull_request_review.submitted"], IN_API, { kind: "workflow", workflowId: WORKFLOW_ID }),
    ]);

    // C1: a top-level message with no mention. t-inc claims it and gets one
    // digest; P skips and opens no channel thread. t-inc is itself the
    // channel's subject thread (delivery threads, Part A step 3), so the
    // check is that no thread joins it under that key.
    const channelKey = `subject:slack:${SLACK_TEAM}/C900`;
    const channelThreads = (await threadsKeyed(u, channelKey)).map((thread) => thread.id).sort();
    await postSlack(u, slackMessage("C900", "U001", "checking the dashboards"));
    expect(await settled(u, "P", 1)).toMatchObject(skippedFor(tInc));
    await tick(u);
    const [c1] = await awaitSignals(u, "event.matched", 1, tInc.sessionId, tInc.threadId);
    expect(c1?.content).toContain("checking the dashboards");
    expect((await threadsKeyed(u, channelKey)).map((thread) => thread.id).sort()).toEqual(channelThreads);

    // C2: a mention in a new Slack thread X. M redirects it to t-inc as one
    // inbound turn with the Slack origin, the waiter appends no digest, and a
    // follow binds X to t-inc.
    const c2Text = `<@${BOT_USER}> status?`;
    const x = await mention(u, "U001", c2Text);
    const c2 = await settled(u, "M", 2);
    expect(c2).toMatchObject({ status: "delivered", destination: { kind: "target", ...tInc, reason: "claim_redirect", matchedWaiterId: waiterId } });
    expect(await landings(u, c2.id)).toEqual([tInc]);
    expect(await queuedWith(u, "status?")).toEqual([expect.objectContaining(tInc)]);
    // P's half of the post is ambient: t-inc's claim skips it.
    expect(await settled(u, "P", 2)).toMatchObject(skippedFor(tInc));
    await tick(u);
    await expectNoNewSignal(u, "event.matched", 1, tInc.sessionId, tInc.threadId);
    expect(await p.engineStore.getWakeup(waiterId)).toMatchObject({ status: "running", eventBuffer: [] });
    expect(await findFollowedThread(p.db, { orgId: ORG, channelType: "slack", channelId: "C900", threadTs: x }))
      .toMatchObject({ ownerType: "team", ownerId: TEAM, ...tInc });
    // The reply route is the Slack origin: the agent's answer posts in X.
    const answer = await poll(
      async () => u.stub.slackCalls.find((c) => c.method === "chat.postMessage" && c.params.channel === "C900" && c.params.thread_ts === x),
      (call) => call !== undefined,
      "the answer in Slack thread X",
    );
    expect(answer?.params.text).toContain("noted");

    // C3: U003 replies in X. P delivers the reply to t-inc once, through the
    // follow binding, and the waiter appends no digest for it.
    const c3Text = "replica caught up";
    await postSlack(u, slackMessage("C900", "U003", c3Text, x));
    const c3 = await settled(u, "P", 3);
    expect(c3).toMatchObject({ status: "delivered", destination: { kind: "target", ...tInc, reason: "conversation_follow" } });
    expect(await landings(u, c3.id)).toEqual([tInc]);
    await tick(u);
    await expectNoNewSignal(u, "event.matched", 1, tInc.sessionId, tInc.threadId);
    expect(await p.engineStore.getWakeup(waiterId)).toMatchObject({ status: "running", eventBuffer: [] });
    expect(await queuedWith(u, c3Text)).toEqual([expect.objectContaining(tInc)]);

    // C3b: U001, a linked member, replies in X. The follow router admits the
    // sender and delivers the reply to t-inc. The router owns a followed
    // reply, so P skips it and the waiter appends no digest: one turn.
    const c3bText = "failover finished";
    await postSlack(u, slackMessage("C900", "U001", c3bText, x));
    expect(await settled(u, "P", 4)).toMatchObject({ status: "skipped", lastError: "Skipped, the followed thread delivers this reply." });
    await poll(() => queuedWith(u, c3bText), (rows) => rows.length > 0, "the routed reply");
    await tick(u);
    await expectNoNewSignal(u, "event.matched", 1, tInc.sessionId, tInc.threadId);
    expect(await p.engineStore.getWakeup(waiterId)).toMatchObject({ status: "running", eventBuffer: [] });
    expect(await queuedWith(u, c3bText)).toEqual([expect.objectContaining(tInc)]);

    // C3b without rule P: no rule matches the reply, and the follow router
    // still delivers it to t-inc. The router owns the reply, so the waiter
    // appends no digest: one turn.
    await p.db.update(eventSubscriptions).set({ enabled: false }).where(eq(eventSubscriptions.id, "P"));
    const c3cText = "write path drained";
    await postSlack(u, slackMessage("C900", "U001", c3cText, x));
    await poll(() => queuedWith(u, c3cText), (rows) => rows.length > 0, "the routed reply without rule P");
    await tick(u);
    await expectNoNewSignal(u, "event.matched", 1, tInc.sessionId, tInc.threadId);
    expect(await p.engineStore.getWakeup(waiterId)).toMatchObject({ status: "running", eventBuffer: [] });
    expect(await queuedWith(u, c3cText)).toEqual([expect.objectContaining(tInc)]);
    expect(await deliveriesOf(u, "P")).toHaveLength(4);
    await p.db.update(eventSubscriptions).set({ enabled: true }).where(eq(eventSubscriptions.id, "P"));

    // C4: U002 links to no Valet user. The team gate refuses the mention, so
    // M delivers nothing and t-inc receives the post as one digest.
    const c4Text = `<@${BOT_USER}> is the replica healthy?`;
    await mention(u, "U002", c4Text);
    expect(await settled(u, "P", 5)).toMatchObject(skippedFor(tInc));
    expect((await deliveriesOf(u, "M")).filter((d) => d.status !== "dead")).toHaveLength(2);
    await tick(u);
    const c4 = await awaitSignals(u, "event.matched", 2, tInc.sessionId, tInc.threadId);
    expect(c4[1]?.content).toContain("is the replica healthy?");
    expect(await queuedWith(u, "is the replica healthy?")).toEqual([expect.objectContaining(tInc)]);
    expect(await queuedSignals(u, "slack.app_mention")).toHaveLength(2);

    // C5: a mention in X2. t-s receives it through its binding as one turn,
    // and t-inc, which is not the bound thread, appends the channel
    // message's digest.
    const c5Text = `<@${BOT_USER}> rollback ready?`;
    await mention(u, "U001", c5Text, x2);
    const c5 = await settled(u, "M", 3);
    expect(c5).toMatchObject({ status: "delivered", destination: { kind: "target", ...tS, reason: "conversation_follow" } });
    expect(await landings(u, c5.id)).toEqual([tS]);
    // P's message half follows the X2 binding too, but the mention delivers
    // the post, so P skips it (mention_covered).
    expect(await settled(u, "P", 6)).toMatchObject({ status: "skipped", lastError: "Skipped, the mention delivers this post." });
    await tick(u);
    const c5Digests = await awaitSignals(u, "event.matched", 3, tInc.sessionId, tInc.threadId);
    expect(c5Digests[2]?.content).toContain("rollback ready?");
    const c5Turns = await queuedWith(u, "rollback ready?");
    expect(c5Turns.filter((t) => t.threadId === tInc.threadId)).toHaveLength(1);
    expect(c5Turns.filter((t) => t.threadId === tS.threadId)).toHaveLength(1);
    expect(c5Turns).toHaveLength(2);

    // C6: team platform has its own mention rule and no waiter. A member of
    // both teams mentions the bot: each team receives the mention once.
    await p.db.insert(teams).values({ id: PLATFORM, orgId: ORG, name: "Platform", createdAt: Date.now() });
    await p.db.insert(teamMembers).values({ teamId: PLATFORM, userId: USER, role: "member" });
    await p.db.insert(eventSubscriptions).values(
      ruleRow("M-platform", { type: "team", id: PLATFORM }, ["slack.app_mention"], IN_C900, { kind: "assistant", follow: true, thread: { mode: "new" } }),
    );
    const c6Text = `<@${BOT_USER}> who owns db-2?`;
    await mention(u, "U001", c6Text);
    const c6Sre = await settled(u, "M", 4);
    expect(c6Sre).toMatchObject({ status: "delivered", destination: { kind: "target", ...tInc, reason: "claim_redirect" } });
    const c6Platform = await settled(u, "M-platform", 1);
    expect(c6Platform.status).toBe("delivered");
    const [platformThread] = await landings(u, c6Platform.id);
    if (!platformThread) throw new Error("platform's mention landed nowhere");
    expect(await threadKey(u, platformThread)).toBe(`sub:M-platform:${c6Platform.id}`);
    const c6Turns = await queuedWith(u, "who owns db-2?");
    expect(c6Turns).toHaveLength(2);
    expect(c6Turns).toEqual(expect.arrayContaining([expect.objectContaining(tInc), expect.objectContaining(platformThread)]));
    expect(await settled(u, "P", 7)).toMatchObject(skippedFor(tInc));
    await tick(u);
    await expectNoNewSignal(u, "event.matched", 3, tInc.sessionId, tInc.threadId);

    // C2b: C2 with the halves in the other order. The app_mention arrives
    // and is dispatched first, so its follow binds Slack thread Y to t-inc
    // before the slack.message half arrives. The message half then follows
    // that binding, and P skips it because the mention delivered the post.
    const c2bText = `<@${BOT_USER}> any errors left?`;
    const y = nextSlackTs();
    await postSlack(u, { type: "app_mention", channel: "C900", user: "U001", text: c2bText, ts: y, team: SLACK_TEAM, event_ts: y });
    expect(await settled(u, "M", 5)).toMatchObject({ status: "delivered", destination: { kind: "target", ...tInc, reason: "claim_redirect" } });
    await postSlack(u, { ...slackMessage("C900", "U001", c2bText), ts: y });
    expect(await settled(u, "P", 8)).toMatchObject({ status: "skipped", lastError: "Skipped, the mention delivers this post." });
    await tick(u);
    await expectNoNewSignal(u, "event.matched", 3, tInc.sessionId, tInc.threadId);
    // Team platform's own mention rule (C6) gives platform its own turn.
    const c2bTurns = await queuedWith(u, "any errors left?");
    expect(c2bTurns.filter((t) => t.threadId === tInc.threadId)).toHaveLength(1);
    expect(await settled(u, "M-platform", 2)).toMatchObject({ status: "delivered" });
    expect(c2bTurns).toHaveLength(2);

    // C7: the agent in t-inc cancels its waiter. P then delivers a channel
    // message to the channel's subject thread. t-inc is that thread
    // (delivery threads, Part A step 3), so the post lands there as a
    // delivery, not a claim.
    u.agent.on(/incident closed, stop watching/, [{ name: "wakeup_cancel", args: { id: waiterId } }]);
    await postSlack(u, slackMessage("C900", "U001", "incident closed, stop watching"));
    expect(await settled(u, "P", 9)).toMatchObject(skippedFor(tInc));
    await tick(u);
    await poll(() => p.engineStore.getWakeup(waiterId), (w) => w?.status !== "running", "the agent to cancel the waiter");
    expect(await p.engineStore.getWakeup(waiterId)).toMatchObject({ status: "cancelled" });
    await postSlack(u, slackMessage("C900", "U001", "postmortem at 15:00"));
    const c7 = await settled(u, "P", 10);
    expect(c7.status).toBe("delivered");
    const [channelThread] = await landings(u, c7.id);
    if (!channelThread) throw new Error("P's delivery landed nowhere");
    // A team thread's governing thread in the assistant session shares the
    // key with the execution thread the delivery landed on.
    expect((await threadsKeyed(u, `subject:slack:${SLACK_TEAM}/C900`)).map((thread) => thread.id)).toContain(channelThread.threadId);

    // C8: a human review on #12. t-pr claims it and gets one digest; R1
    // skips and opens no subject thread; W starts a workflow run.
    await postGithub(u, "pull_request_review", "gh-c8", review(12, "please rename the flag"));
    expect(await settled(u, "R1", 1)).toMatchObject(skippedFor(tPr));
    expect((await settled(u, "W", 1)).status).toBe("delivered");
    await tick(u);
    const [c8] = await awaitSignals(u, "event.matched", 1, tPr.sessionId, tPr.threadId);
    expect(c8?.content).toContain("please rename the flag");
    expect(await threadsKeyed(u, "subject:github:acme/api#12")).toEqual([]);

    // C9: a human comment on #14, which t-pr opened. R5 delivers it to t-pr
    // as an inbound turn through the pull request binding; no digest.
    const c9Text = "can we split this migration?";
    await postGithub(u, "issue_comment", "gh-c9", issueComment(14, c9Text));
    const c9 = await settled(u, "R5", 1);
    expect(c9).toMatchObject({ status: "delivered", destination: { kind: "target", ...tPr, reason: "conversation_pull_request" } });
    expect(await landings(u, c9.id)).toEqual([tPr]);
    await tick(u);
    await expectNoNewSignal(u, "event.matched", 1, tPr.sessionId, tPr.threadId);
    expect(await queuedWith(u, c9Text)).toEqual([expect.objectContaining(tPr)]);
    expect(await threadsKeyed(u, "subject:github:acme/api#14")).toEqual([]);

    // C10: a check run completes on #14. t-pr claims it and gets one digest.
    await postGithub(u, "check_run", "gh-c10", checkRun(14, "integration"));
    expect(await settled(u, "R1", 2)).toMatchObject(skippedFor(tPr));
    await tick(u);
    const c10 = await awaitSignals(u, "event.matched", 2, tPr.sessionId, tPr.threadId);
    expect(c10[1]?.content).toContain("github.check_run.completed · failure");
    await tick(u);
    await expectNoNewSignal(u, "event.matched", 2, tPr.sessionId, tPr.threadId);

    // C11: an update on ENG-42. t-tri claims it and gets one digest.
    await postLinear(u, { action: "update", ...linearIssue("ENG-42", "started"), updatedFrom: { stateId: "st-backlog" } });
    expect(await settled(u, "R3", 1)).toMatchObject(skippedFor(tTri));
    await tick(u);
    const [c11] = await awaitSignals(u, "event.matched", 1, tTri.sessionId, tTri.threadId);
    expect(c11?.content).toContain("ENG-42");

    // C12: another review on #12 while t-pr waits. The workflow rule never
    // yields to a claim (INV-D7): W starts a second run, and t-pr gets its digest.
    await postGithub(u, "pull_request_review", "gh-c12", review(12, "the flag name is fine now"));
    expect(await settled(u, "R1", 3)).toMatchObject(skippedFor(tPr));
    expect((await settled(u, "W", 2)).status).toBe("delivered");
    expect(await p.db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.workflowId, WORKFLOW_ID))).toHaveLength(2);
    await tick(u);
    const c12 = await awaitSignals(u, "event.matched", 3, tPr.sessionId, tPr.threadId);
    expect(c12[2]?.content).toContain("the flag name is fine now");
    expect(await eventWaiters(u, tPr.sessionId)).toEqual(expect.arrayContaining([expect.objectContaining({ status: "running" })]));
    expect(await p.db.select().from(eventDeliveries).where(and(eq(eventDeliveries.subscriptionId, "W"), eq(eventDeliveries.status, "skipped")))).toEqual([]);
  }, 180_000);
});
