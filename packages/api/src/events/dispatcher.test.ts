/**
 * EventDispatcher unit tests (event-system plan Task 6): real PGlite rows
 * for events/subscriptions/deliveries, recording fakes at the two seams
 * (`RunHost`, `deliverToAssistant`). The tests call `pollOnce()` directly,
 * with no timers and no sleeps.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import githubPlugin from "@valet/plugin-github/plugin";
import { eq, sql } from "drizzle-orm";
import type { ChannelOrigin, EventClause, Wakeup } from "@valet/engine";
import type { RunHost, WorkflowTriggerPayload } from "@valet/workflow";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { PgWorkflowStore } from "../workflows/pg-store.js";
import { findFollowedThread, upsertFollowedThread } from "./followed-threads.js";
import {
  teams,
  teamMembers,
  orgMembers,
  userIdentityLinks,
  eventDeliveries,
  eventReceipts,
  events,
  eventSubscriptions,
  workflowDefinitions,
  workflowRuns,
  workflowSignals,
  agentSessions,
  assistants,
  assistantExecutions,
  sessionThreads,
  threadPullRequests,
} from "../schema/index.js";
import { OWN_WRITE_SETTLE_MS, recordChannelMessage } from "../services/channel-messages.js";
import { deliveryThreadPolicy, EventDispatcher, recordSkippedDelivery, type AssistantDeliverFn } from "./dispatcher.js";
import { PinUnavailableError } from "./assistant-delivery.js";

const recordDeliveryDestination = vi.hoisted(() => vi.fn());
vi.mock("../observability/delivery-metrics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../observability/delivery-metrics.js")>()),
  recordDeliveryDestination,
}));

const ORG = "org-1";
/** The thread a recording delivery fake reports it landed in. */
const LANDED = { sessionId: "sess-landed", threadId: "thr-landed" };

function fakeRunHost(overrides: Partial<RunHost> = {}): RunHost {
  return {
    start: vi.fn(async () => {}),
    wake: vi.fn(async () => {}),
    scheduleWake: vi.fn(async () => {}),
    terminate: vi.fn(async () => {}),
    startHost: vi.fn(),
    stopHost: vi.fn(async () => {}),
    ...overrides,
  };
}

interface SeedOpts {
  target: unknown;
  ownerType?: "user" | "team" | "org";
  attempts?: number;
  status?: "pending" | "failed";
  eventKey?: string;
  ownerId?: string;
  service?: string;
  eventKeys?: string[];
  refs?: Record<string, string>;
  summary?: string;
  payload?: unknown;
  actor?: unknown;
  subjects?: string[];
}

describe("EventDispatcher", () => {
  let tdb: TestPgDb;

  beforeEach(async () => {
    tdb = await freshTestPgDb();
  });

  /** Seeds one event + subscription + due delivery; returns their ids. */
  async function seedDelivery(opts: SeedOpts) {
    const db = tdb.appDb;
    const now = Date.now();
    const eventId = randomUUID();
    const subscriptionId = randomUUID();
    const deliveryId = randomUUID();
    await db.insert(events).values({
      id: eventId,
      orgId: ORG,
      service: opts.service ?? "github",
      eventKey: opts.eventKey ?? "github.issues.opened",
      dedupeKey: randomUUID(),
      actor: opts.actor ?? null,
      refs: opts.refs ?? { repo: "acme/site", installation_id: "42" },
      summary: opts.summary ?? "Issue #7 opened: broken build",
      payload: opts.payload ?? { action: "opened", issue: { number: 7 } },
      occurredAt: now - 5_000,
      receivedAt: now,
      subjects: opts.subjects ?? null,
    });
    await db.insert(eventSubscriptions).values({
      id: subscriptionId,
      orgId: ORG,
      ownerType: opts.ownerType ?? "user",
      ownerId: opts.ownerId ?? "user-1",
      name: "test sub",
      eventKeys: opts.eventKeys ?? ["github.issues.*"],
      filters: [],
      target: opts.target,
      enabled: true,
      createdBy: "user-1",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(eventDeliveries).values({
      id: deliveryId,
      eventId,
      subscriptionId,
      status: opts.status ?? "pending",
      attempts: opts.attempts ?? 0,
      nextAttemptAt: now - 1_000,
      createdAt: now,
    });
    return { eventId, subscriptionId, deliveryId };
  }

  async function getDelivery(id: string) {
    const rows = await tdb.appDb.select().from(eventDeliveries).where(eq(eventDeliveries.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new Error(`delivery ${id} vanished`);
    return row;
  }

  it.each([
    { policy: "always", member: true, enabled: true, sameOrg: true, expected: "delivered" },
    { policy: "ignoreIfMyTeamSubscribed", member: true, enabled: true, sameOrg: true, expected: "skipped" },
    { policy: "ignoreIfMyTeamSubscribed", member: false, enabled: true, sameOrg: true, expected: "delivered" },
    { policy: "ignoreIfAnyTeamSubscribed", member: false, enabled: true, sameOrg: true, expected: "skipped" },
    { policy: "ignoreIfAnyTeamSubscribed", member: true, enabled: false, sameOrg: true, expected: "delivered" },
    { policy: "ignoreIfAnyTeamSubscribed", member: true, enabled: true, sameOrg: false, expected: "delivered" },
  ])("evaluates current team coverage: $policy member=$member enabled=$enabled sameOrg=$sameOrg", async ({ policy, member, enabled, sameOrg, expected }) => {
    const db = tdb.appDb;
    const { deliveryId, subscriptionId } = await seedDelivery({ target: { kind: "orchestrator", deliveryPolicy: policy, pauseOnOverlap: true } });
    const teamOrg = sameOrg ? ORG : "other-org";
    await db.insert(teams).values({ id: "coverage-team", orgId: teamOrg, name: "Coverage", createdAt: Date.now() });
    if (member) await db.insert(teamMembers).values({ teamId: "coverage-team", userId: "user-1", role: "member" });
    await db.insert(eventSubscriptions).values({
      id: "coverage-rule", orgId: teamOrg, ownerType: "team", ownerId: "coverage-team", name: "Team coverage",
      eventKeys: ["github.issues.*"], filters: [], target: { kind: "orchestrator", orchestrator: "team", teamId: "coverage-team" },
      enabled, createdBy: "user-1", createdAt: Date.now(), updatedAt: Date.now(),
    });
    const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
    const dispatcher = new EventDispatcher({ db, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToAssistant: deliver, plugins: [githubPlugin] });
    await dispatcher.pollOnce();
    expect((await getDelivery(deliveryId)).status).toBe(expected);
    expect(deliver).toHaveBeenCalledTimes(expected === "delivered" ? 1 : 0);
    const [personal] = await db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, subscriptionId));
    expect(personal!.enabled).toBe(expected !== "skipped");
    await dispatcher.pollOnce();
    expect(deliver).toHaveBeenCalledTimes(expected === "delivered" ? 1 : 0);
  });

  it("a team subscription's matching subject filter suppresses delivery under ignoreIfMyTeamSubscribed (spec Part G)", async () => {
    const db = tdb.appDb;
    const subjects = ["github:acme", "github:acme/site", "github:acme/site#7"];
    const { deliveryId } = await seedDelivery({ target: { kind: "orchestrator", deliveryPolicy: "ignoreIfMyTeamSubscribed" }, subjects });
    await db.insert(teams).values({ id: "subject-team", orgId: ORG, name: "Subject", createdAt: Date.now() });
    await db.insert(teamMembers).values({ teamId: "subject-team", userId: "user-1", role: "member" });
    await db.insert(eventSubscriptions).values({
      id: "subject-rule", orgId: ORG, ownerType: "team", ownerId: "subject-team", name: "Team coverage",
      eventKeys: ["github.issues.*"], filters: [{ field: "subject", op: "eq", value: "github:acme/site#7" }],
      target: { kind: "orchestrator", orchestrator: "team", teamId: "subject-team" },
      enabled: true, createdBy: "user-1", createdAt: Date.now(), updatedAt: Date.now(),
    });
    const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
    const dispatcher = new EventDispatcher({ db, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToAssistant: deliver, plugins: [githubPlugin] });
    await dispatcher.pollOnce();
    expect((await getDelivery(deliveryId)).status).toBe("skipped");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("a team subscription's non-matching subject filter does not suppress delivery (spec Part G)", async () => {
    const db = tdb.appDb;
    const subjects = ["github:acme", "github:acme/site", "github:acme/site#7"];
    const { deliveryId } = await seedDelivery({ target: { kind: "orchestrator", deliveryPolicy: "ignoreIfMyTeamSubscribed" }, subjects });
    await db.insert(teams).values({ id: "subject-team-2", orgId: ORG, name: "Subject2", createdAt: Date.now() });
    await db.insert(teamMembers).values({ teamId: "subject-team-2", userId: "user-1", role: "member" });
    await db.insert(eventSubscriptions).values({
      id: "subject-rule-2", orgId: ORG, ownerType: "team", ownerId: "subject-team-2", name: "Team coverage",
      // Names a different issue on the same repo — the key matches, the subject does not.
      eventKeys: ["github.issues.*"], filters: [{ field: "subject", op: "eq", value: "github:acme/site#999" }],
      target: { kind: "orchestrator", orchestrator: "team", teamId: "subject-team-2" },
      enabled: true, createdBy: "user-1", createdAt: Date.now(), updatedAt: Date.now(),
    });
    const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
    const dispatcher = new EventDispatcher({ db, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToAssistant: deliver, plugins: [githubPlugin] });
    await dispatcher.pollOnce();
    expect((await getDelivery(deliveryId)).status).toBe("delivered");
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("skips only matching events without pausing and respects a later disabled team rule on retry", async () => {
    const db = tdb.appDb;
    const { deliveryId, subscriptionId } = await seedDelivery({ target: { kind: "orchestrator", deliveryPolicy: "ignoreIfAnyTeamSubscribed" }, status: "failed", attempts: 1 });
    await db.insert(teams).values({ id: "retry-team", orgId: ORG, name: "Retry", createdAt: Date.now() });
    await db.insert(eventSubscriptions).values({ id: "retry-rule", orgId: ORG, ownerType: "team", ownerId: "retry-team", name: "Coverage", eventKeys: ["github.issues.*"], filters: [], target: { kind: "orchestrator", orchestrator: "team", teamId: "retry-team" }, enabled: true, createdBy: "user-1", createdAt: Date.now(), updatedAt: Date.now() });
    const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
    const dispatcher = new EventDispatcher({ db, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToAssistant: deliver, plugins: [githubPlugin] });
    await dispatcher.pollOnce();
    expect((await getDelivery(deliveryId)).status).toBe("skipped");
    const [personal] = await db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, subscriptionId));
    expect(personal!.enabled).toBe(true);
    await db.update(eventSubscriptions).set({ enabled: false }).where(eq(eventSubscriptions.id, "retry-rule"));
    // A deliberately redelivered event re-evaluates current coverage.
    await db.update(eventDeliveries).set({ status: "pending", nextAttemptAt: 0 }).where(eq(eventDeliveries.id, deliveryId));
    await dispatcher.pollOnce();
    expect((await getDelivery(deliveryId)).status).toBe("delivered");
  });

  it.each(["user", "team", "org"] as const)("delivers a workflow-target delivery: RunHost.start gets the event trigger payload; row -> delivered", async (ownerType) => {
    const db = tdb.appDb;
    const now = Date.now();
    const definition = { nodes: [], edges: [] };
    await db.insert(workflowDefinitions).values({
      id: "wf-1",
      orgId: ORG,
      ownerType,
      ownerId: "user-1",
      name: "on issue",
      definition,
      createdAt: now,
      updatedAt: now,
    });
    const { eventId, subscriptionId, deliveryId } = await seedDelivery({
      target: { kind: "workflow", workflowId: "wf-1", presence: { displayName: "Event Hestia" } },
    });

    const runHost = fakeRunHost();
    const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
    const dispatcher = new EventDispatcher({
      db,
      workflowRunHost: runHost,
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToAssistant: deliver,
    });
    await dispatcher.pollOnce();

    expect(runHost.start).toHaveBeenCalledTimes(1);
    const [runId, params, def, owner] = vi.mocked(runHost.start).mock.calls[0];
    // Derived, not minted: retried claims must resolve to the same run.
    expect(runId).toBe(`wfrun_evt_${deliveryId}`);
    expect(def).toEqual(definition);
    // The workflow owner determines shared automation identity.
    expect(owner).toEqual({ ownerType, ownerId: "user-1", actorUserId: ownerType === "user" ? "user-1" : `${ownerType}:user-1` });
    expect(params.presence).toEqual({ displayName: "Event Hestia" });
    expect(params.workflowId).toBe("wf-1");
    expect(params.triggerId).toBe(subscriptionId);
    const trigger = params.input as WorkflowTriggerPayload;
    expect(trigger.type).toBe("event");
    expect(trigger.triggerId).toBe(subscriptionId);
    expect(trigger.data).toEqual({
      key: "github.issues.opened",
      summary: "Issue #7 opened: broken build",
      refs: { repo: "acme/site", installation_id: "42" },
      payload: { action: "opened", issue: { number: 7 } },
    });
    expect(trigger.metadata).toEqual({ eventId, service: "github" });

    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(1);
    expect(row.deliveredAt).not.toBeNull();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("retried workflow delivery is idempotent: an already-started run is not started twice", async () => {
    // Simulates the partial-failure retry: a prior attempt started the run
    // but crashed before the delivered-status UPDATE, the claim lease lapsed,
    // and the poll re-claimed the row. The derived runId already exists, so
    // the retry must mark the delivery delivered WITHOUT a second start.
    const db = tdb.appDb;
    const now = Date.now();
    const definition = { nodes: [], edges: [] };
    await db.insert(workflowDefinitions).values({
      id: "wf-1",
      orgId: ORG,
      ownerType: "user",
      ownerId: "user-1",
      name: "on issue",
      definition,
      createdAt: now,
      updatedAt: now,
    });
    const { deliveryId } = await seedDelivery({ target: { kind: "workflow", workflowId: "wf-1" } });
    await db.insert(workflowRuns).values({
      id: `wfrun_evt_${deliveryId}`,
      workflowId: "wf-1",
      definitionVersionId: "v-whatever",
      definition,
      params: {},
      status: "running",
      ownerType: "user",
      ownerId: "user-1",
      createdAt: now,
      updatedAt: now,
    });

    const runHost = fakeRunHost();
    const dispatcher = new EventDispatcher({
      db,
      workflowRunHost: runHost,
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToAssistant: vi.fn<AssistantDeliverFn>(async () => LANDED),
    });
    await dispatcher.pollOnce();

    expect(runHost.start).not.toHaveBeenCalled();
    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("delivered");
  });

  it("holds a fresh pull request comment until Valet's own write is recorded, then suppresses it even if its source is unavailable", async () => {
    const db = tdb.appDb;
    const url = "https://github.com/acme/app/pull/12";
    await db.insert(assistants).values({ id: "asst-1", orgId: ORG, ownerType: "user", ownerId: "user-1", sessionId: "sess-1", createdAt: 1 });
    await db.insert(agentSessions).values({ id: "sess-1", orgId: ORG, userId: "user-1", ownerType: "user", ownerId: "user-1", workspace: "/workspace", createdAt: 1, updatedAt: 1 });
    await db.execute(sql`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at)
      VALUES ('thr-1', 'sess-1', 'web:pr-thread', 'idle', 'steer', 1, 1)`);
    await db.insert(threadPullRequests).values({
      sessionId: "sess-1", threadId: "thr-1", url, repo: "acme/app", number: 12, state: "open", createdAt: 1, updatedAt: 1, checkedAt: 1,
    });
    const postedAt = Date.now();
    const { deliveryId } = await seedDelivery({
      target: { kind: "orchestrator" }, eventKey: "github.issue_comment.created", eventKeys: ["github.issue_comment.*"],
      payload: { issue: { pull_request: { html_url: url } }, comment: { id: 501, body: "Done.", created_at: new Date(postedAt).toISOString(), user: { login: "me", type: "User" } } },
    });
    const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
    const dispatcher = new EventDispatcher({
      db, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToAssistant: deliver,
    });

    await db.delete(threadPullRequests).where(eq(threadPullRequests.url, url));
    // The webhook beat the write record and has no source: it still waits.
    await dispatcher.pollOnce();
    expect(deliver).not.toHaveBeenCalled();
    const held = await getDelivery(deliveryId);
    expect(held).toMatchObject({ status: "pending", attempts: 0, nextAttemptAt: postedAt + OWN_WRITE_SETTLE_MS });

    // The record lands; its missing source must not route the write to shared events.
    await recordChannelMessage(db, {
      orgId: ORG, sessionId: "sess-1", threadId: "thr-1", channelKey: "github:acme/app#12", conversationKey: "github:acme/app#12",
      providerMessageId: "501", direction: "out", text: "Done.",
    });
    await db.update(eventDeliveries).set({ nextAttemptAt: Date.now() - 1 }).where(eq(eventDeliveries.id, deliveryId));
    await dispatcher.pollOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(await getDelivery(deliveryId)).toMatchObject({ status: "skipped" });
  });

  it("keeps a pull request comment attended only when it reaches the thread that opened the pull request", async () => {
    const db = tdb.appDb;
    const opened = "https://github.com/acme/app/pull/21";
    const foreign = "https://github.com/acme/app/pull/22";
    await db.insert(assistants).values({ id: "asst-21", orgId: ORG, ownerType: "user", ownerId: "user-1", sessionId: "sess-21", createdAt: 1 });
    await db.insert(agentSessions).values({ id: "sess-21", orgId: ORG, userId: "user-1", ownerType: "user", ownerId: "user-1", workspace: "/workspace", createdAt: 1, updatedAt: 1 });
    await db.execute(sql`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at)
      VALUES ('thr-21', 'sess-21', 'web:pr-21', 'idle', 'steer', 1, 1)`);
    await db.insert(threadPullRequests).values({
      sessionId: "sess-21", threadId: "thr-21", url: opened, repo: "acme/app", number: 21, state: "open", createdAt: 1, updatedAt: 1, checkedAt: 1,
    });
    const comment = (url: string, id: number) => ({
      issue: { pull_request: { html_url: url } },
      comment: { id, body: "Can you rebase this?", created_at: "2026-01-01T00:00:00Z", user: { login: "reviewer", type: "User" } },
    });
    for (const [url, id] of [[opened, 701], [foreign, 702]] as const) {
      await seedDelivery({ target: { kind: "orchestrator" }, eventKey: "github.issue_comment.created", eventKeys: ["github.issue_comment.*"], payload: comment(url, id) });
    }
    const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
    await new EventDispatcher({ db, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToAssistant: deliver }).pollOnce();

    const calls = deliver.mock.calls.map(([args]) => args);
    expect(calls).toHaveLength(2);
    const onOpened = calls.find(args => args.destination.kind === "target" && args.destination.threadId === "thr-21");
    const onForeign = calls.find(args => args.destination.kind !== "target");
    // The reviewer can answer on the pull request's own thread.
    expect(onOpened?.unattended).toBeUndefined();
    // A comment on a pull request no thread opened falls back to the rule's policy thread, where no one answers.
    expect(onForeign?.unattended).toBe(true);
  });

  it("lands a Slack event with no thread to reply into by the rule's policy", async () => {
    // A reaction in a channel has no Slack thread to answer. With no policy
    // set, the rule's own thread holds it (spec 2026-10-16: delivery
    // threads, Part A step 3).
    const { subscriptionId } = await seedDelivery({
      target: { kind: "orchestrator" }, ownerType: "org",
      service: "slack", eventKey: "slack.reaction_added", eventKeys: ["slack.reaction_added"],
      refs: { channel: "CPRIV" }, summary: "reaction :eyes: added in CPRIV by U9",
      payload: { type: "reaction_added", item: { channel: "CPRIV", ts: "1.2" }, user: "U9", reaction: "eyes" },
    });
    const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
    await new EventDispatcher({ db: tdb.appDb, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToAssistant: deliver }).pollOnce();
    // The shared events thread is gone: the rule's own thread holds it.
    expect(deliver.mock.calls[0]?.[0].destination).toEqual({ kind: "key", key: `sub:${subscriptionId}`, title: "test sub", reason: "policy_own" });
  });

  it("delivers an assistant-target delivery: seam gets SignalContent with signalType = event key; row -> delivered", async () => {
    const { eventId, deliveryId } = await seedDelivery({ target: { kind: "orchestrator" }, ownerType: "org" });

    const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
    const dispatcher = new EventDispatcher({
      db: tdb.appDb,
      workflowRunHost: fakeRunHost(),
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToAssistant: deliver,
    });
    await dispatcher.pollOnce();

    expect(deliver).toHaveBeenCalledTimes(1);
    const args = deliver.mock.calls[0][0];
    expect(args.orgId).toBe(ORG);
    expect(args.ownerType).toBe("org");
    expect(args.ownerId).toBe("user-1");
    expect(args.dispatchId).toBe(`event:${deliveryId}`);
    expect(args.signal.kind).toBe("signal");
    expect(args.signal.signalType).toBe("github.issues.opened");
    // jsonb round-trips reorder object keys, so parse the excerpt instead
    // of comparing the serialized string byte-for-byte.
    const [summary, excerpt] = args.signal.body.split("\n\n");
    expect(summary).toBe("Issue #7 opened: broken build");
    expect(JSON.parse(excerpt)).toEqual({ action: "opened", issue: { number: 7 } });
    expect(args.signal.attributes).toEqual({
      repo: "acme/site",
      installation_id: "42",
      eventId,
      service: "github",
    });

    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(1);
  });

  async function seedMentionMember(teamId: string) {
    await tdb.appDb.insert(teams).values({ id: teamId, orgId: ORG, name: "Team", createdAt: Date.now() });
    await tdb.appDb.insert(teamMembers).values({ teamId, userId: "member-9", role: "member" });
    await tdb.appDb.insert(orgMembers).values({ orgId: ORG, userId: "member-9", role: "member" });
    await tdb.appDb.insert(userIdentityLinks).values({ id: "link-9", provider: "slack", externalId: "U9", userId: "member-9", createdAt: Date.now() });
  }

  it("channel-origin orchestrator delivery: readable body + origin + sender, no raw JSON", async () => {
    await seedMentionMember("team-x");
    const { deliveryId } = await seedDelivery({
      target: { kind: "orchestrator" },
      ownerType: "team",
      ownerId: "team-x",
      service: "slack",
      eventKey: "slack.app_mention",
      eventKeys: ["slack.app_mention"],
      refs: { channel: "C1", user: "U9" },
      summary: "Mention in #deploys",
      payload: { type: "app_mention", channel: "C1", user: "U9", text: "who are you", ts: "1.2" },
      actor: { externalId: "U9" },
    });

    const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
    const dispatcher = new EventDispatcher({
      db: tdb.appDb,
      workflowRunHost: fakeRunHost(),
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToAssistant: deliver,
      resolveChannelOrigin: (service) =>
        service === "slack" ? { channelType: "slack", threadKey: "slack:C1:1.2" } : null,
    });
    await dispatcher.pollOnce();

    expect(deliver).toHaveBeenCalledTimes(1);
    const args = deliver.mock.calls[0][0];
    expect(args.signal.origin).toEqual({ channelType: "slack", threadKey: "slack:C1:1.2" });
    expect(args.signal.body).toContain("who are you");
    expect(args.signal.body).not.toContain("{"); // no raw JSON dump
    expect(args.signal.attributes?.sender).toBe("U9");
    // A person mentioned Valet and can answer a question in the thread.
    expect(args.unattended).toBeUndefined();

    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("delivered");
  });

  /**
   * Prompt templates on an orchestrator target (TKAI-491). The rendering is
   * the pure part (`prompt-template.test.ts`); these cover the wiring: which
   * event fields reach the renderer, and that a rule with no template
   * delivers the same body it always did.
   */
  describe("orchestrator prompt templates", () => {
    const PAYLOAD = {
      action: "opened",
      issue: { number: 7 },
      repository: { full_name: "acme/site" },
      sender: { login: "octocat" },
    };

    function dispatcherWith(deliver: AssistantDeliverFn): EventDispatcher {
      return new EventDispatcher({
        db: tdb.appDb,
        workflowRunHost: fakeRunHost(),
        workflowStore: new PgWorkflowStore(tdb.pgdb),
        deliverToAssistant: deliver,
        plugins: [githubPlugin],
      });
    }

    it("renders the user prompt template in place of the default body", async () => {
      await seedDelivery({
        target: {
          kind: "orchestrator",
          userPromptTemplate: "{{payload.sender}} opened {{payload.repo}} ({{refs.installation_id}}): {{event.key}}",
        },
        payload: PAYLOAD,
      });
      const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
      await dispatcherWith(deliver).pollOnce();

      expect(deliver.mock.calls[0][0].signal.body).toBe(
        "octocat opened acme/site (42): github.issues.opened",
      );
      // No person waits on a GitHub event, so its turn cannot park on a question.
      expect(deliver.mock.calls[0][0].unattended).toBe(true);
    });

    it("renders the system prompt above the body the rule would have delivered", async () => {
      await seedDelivery({
        target: { kind: "orchestrator", systemPrompt: "Triage {{event.key}}. Answer in one sentence." },
        payload: PAYLOAD,
      });
      const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
      await dispatcherWith(deliver).pollOnce();

      const body = deliver.mock.calls[0][0].signal.body;
      expect(body).toContain("Triage github.issues.opened. Answer in one sentence.");
      // The default body still follows the instructions, excerpt and all.
      expect(body).toContain("Issue #7 opened: broken build");
      expect(body).toContain('"full_name":"acme/site"');
    });

    it("keeps a channel message readable through {{event.body}}", async () => {
      await seedMentionMember("team-y");
      await seedDelivery({
        target: { kind: "orchestrator", userPromptTemplate: "In #deploys: {{event.body}}" },
        ownerType: "team",
        ownerId: "team-y",
        service: "slack",
        eventKey: "slack.app_mention",
        eventKeys: ["slack.app_mention"],
        refs: { channel: "C1", user: "U9" },
        summary: "Mention in #deploys",
        payload: { type: "app_mention", channel: "C1", user: "U9", text: "who are you", ts: "1.2" },
        actor: { externalId: "U9" },
      });
      const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
      const dispatcher = new EventDispatcher({
        db: tdb.appDb,
        workflowRunHost: fakeRunHost(),
        workflowStore: new PgWorkflowStore(tdb.pgdb),
        deliverToAssistant: deliver,
        resolveChannelOrigin: (service) =>
          service === "slack" ? { channelType: "slack", threadKey: "slack:C1:1.2" } : null,
        plugins: [githubPlugin],
      });
      await dispatcher.pollOnce();

      expect(deliver.mock.calls[0][0].signal.body).toBe("In #deploys: who are you");
    });

    it("delivers the default body untouched when the rule configures no template", async () => {
      await seedDelivery({ target: { kind: "orchestrator" }, payload: PAYLOAD });
      const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
      await dispatcherWith(deliver).pollOnce();

      const [summary, excerpt] = deliver.mock.calls[0][0].signal.body.split("\n\n");
      expect(summary).toBe("Issue #7 opened: broken build");
      expect(JSON.parse(excerpt)).toEqual(PAYLOAD);
    });
  });

  it("records a followed thread for a follow-enabled channel mention; none when follow is off", async () => {
    await seedMentionMember("team-x");
    async function dispatchMention(follow: boolean) {
      await seedDelivery({
        target: { kind: "orchestrator", follow },
        ownerType: "team",
        ownerId: "team-x",
        service: "slack",
        eventKey: "slack.app_mention",
        eventKeys: ["slack.app_mention"],
        refs: { channel: "C1" },
        summary: "Mention",
        payload: { type: "app_mention", channel: "C1", user: "U9", text: "hi", ts: "1.2" },
      });
      const dispatcher = new EventDispatcher({
        db: tdb.appDb,
        workflowRunHost: fakeRunHost(),
        workflowStore: new PgWorkflowStore(tdb.pgdb),
        deliverToAssistant: vi.fn<AssistantDeliverFn>(async () => LANDED),
        resolveChannelOrigin: (service) =>
          service === "slack" ? { channelType: "slack", threadKey: "slack:C1:1.2" } : null,
      });
      await dispatcher.pollOnce();
    }

    await dispatchMention(false);
    const key = { orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2" };
    expect(await findFollowedThread(tdb.appDb, key)).toBeNull();

    await dispatchMention(true);
    const row = await findFollowedThread(tdb.appDb, key);
    expect(row?.ownerType).toBe("team");
    expect(row?.ownerId).toBe("team-x");
    expect(row?.createdBy).toBe("member-9");
  });

  it("retains the subscription for personal follow presence", async () => {
    const { subscriptionId } = await seedDelivery({
      target: { kind: "orchestrator", follow: true, presence: { displayName: "Personal helper" } },
      service: "slack", eventKey: "slack.app_mention", eventKeys: ["slack.app_mention"],
      payload: { type: "app_mention", channel: "C1", user: "U9", text: "hi", ts: "1.2" },
    });
    const dispatcher = new EventDispatcher({
      db: tdb.appDb, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToAssistant: vi.fn<AssistantDeliverFn>(async () => LANDED),
      resolveChannelOrigin: () => ({ channelType: "slack", threadKey: "slack:C1:1.2" }),
    });
    await dispatcher.pollOnce();
    expect(await findFollowedThread(tdb.appDb, { orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2" }))
      .toMatchObject({ ownerType: "user", ownerId: "user-1", subscriptionId });
  });

  it("does not create a second follow path for a message subscription", async () => {
    const { deliveryId } = await seedDelivery({
      target: { kind: "orchestrator", follow: true }, service: "slack",
      eventKey: "slack.message", eventKeys: ["slack.message"],
      refs: { channel: "C1" }, summary: "Reply",
      payload: { type: "message", channel: "C1", user: "U9", text: "reply", ts: "1.3", thread_ts: "1.2" },
    });
    const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
    const dispatcher = new EventDispatcher({
      db: tdb.appDb, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToAssistant: deliver,
      resolveChannelOrigin: () => ({ channelType: "slack", threadKey: "slack:C1:1.2" }),
    });
    await dispatcher.pollOnce();
    expect(deliver).toHaveBeenCalledOnce();
    expect((await getDelivery(deliveryId)).status).toBe("delivered");
    expect(await findFollowedThread(tdb.appDb, { orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2" })).toBeNull();
  });

  /**
   * Incident mention routing (spec 2026-10-15: incident mention routing).
   * The waiter rows come from a fake `findEventWaiters`; the sessions they
   * name are real `agent_sessions` (+ `assistants` / `assistant_executions` /
   * `engine_threads`) rows, so the owner filter AND the deliverability gate
   * (`isDeliverableTarget`, shared with `assistant-delivery.ts`) run for real.
   */
  describe("incident mention routing", () => {
    const CHANNEL_SUBJECT = "slack:T001/C1";

    function waiter(id: string, sessionId: string, opts: {
      createdAt: number; once?: boolean; subjects?: string[]; status?: Wakeup["status"];
      clauses?: EventClause[]; primarySubject?: string;
    }): Wakeup {
      return {
        id, sessionId, threadId: `thr-${id}`, kind: "event", status: opts.status ?? "running", reason: "Incident",
        logOffset: 0, logTail: "", eventCount: 0, createdAt: opts.createdAt, updatedAt: opts.createdAt,
        subjects: opts.subjects ?? [CHANNEL_SUBJECT],
        eventMatch: {
          clauses: opts.clauses ?? [{ key: "slack.message" }], once: opts.once ?? false, self: [],
          ...(opts.primarySubject ? { primarySubject: opts.primarySubject } : {}),
        },
      };
    }

    /**
     * A store whose `findEventWaiters` returns every seeded row and ignores
     * the queried subjects. A real store filters by subject overlap
     * (`subjects && $1`). That overlap never excludes a row that
     * `findWatchingWaiter` keeps. Returning every row sends a waiter on a
     * thread subject alone through `findWatchingWaiter`'s own subject
     * filter, so the test checks that filter and not the fake.
     */
    function fakeStore(rows: Wakeup[]) {
      const lookups: string[][] = [];
      return {
        lookups,
        store: {
          async findEventWaiters(subjects: readonly string[]): Promise<Wakeup[]> {
            lookups.push([...subjects]);
            return rows;
          },
        },
      };
    }

    /** One root assistant + governing thread per (owner, org), reused across
     * every execution session of that owner (idempotent: `assistants` has a
     * unique index per org/owner, so a second seed of the same owner is a
     * no-op). */
    async function seedAssistant(ownerType: "user" | "team", ownerId: string, orgId: string) {
      const assistantId = `asst-${orgId}-${ownerType}-${ownerId}`;
      const rootSessionId = `root-${assistantId}`;
      const governingThreadId = `gov-${assistantId}`;
      await tdb.appDb.insert(agentSessions).values({
        id: rootSessionId, orgId, userId: "member-9", ownerType, ownerId, workspace: "/workspace", createdAt: 1, updatedAt: 1,
      }).onConflictDoNothing();
      await tdb.appDb.insert(assistants).values({
        id: assistantId, orgId, ownerType, ownerId, sessionId: rootSessionId, createdAt: 1,
      }).onConflictDoNothing();
      await tdb.appDb.execute(sql`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at)
        VALUES (${governingThreadId}, ${rootSessionId}, ${governingThreadId}, 'idle', 'steer', 1, 1)
        ON CONFLICT (id) DO NOTHING`);
      return { assistantId, governingThreadId };
    }

    /** A deliverable watching-waiter session: a real execution of the
     * owner's assistant, with its own thread. `deliverToAssistantThread`
     * requires this shape for an explicit target. */
    async function seedSession(id: string, ownerType: "user" | "team", ownerId: string, threadId: string, orgId = ORG) {
      const { assistantId, governingThreadId } = await seedAssistant(ownerType, ownerId, orgId);
      await tdb.appDb.insert(agentSessions).values({ id, orgId, userId: "member-9", ownerType, ownerId, workspace: "/workspace", createdAt: 1, updatedAt: 1 });
      await tdb.appDb.insert(assistantExecutions).values({
        sessionId: id, assistantId, conversationKey: `conv-${id}`, governingThreadId, createdAt: 1,
      });
      await tdb.appDb.execute(sql`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at)
        VALUES (${threadId}, ${id}, ${threadId}, 'idle', 'steer', 1, 1)`);
    }

    /** A session with no `assistants` or `assistant_executions` row: a
     * team-owned child or plain session. Delivery to it dead-letters, so
     * `findWatchingWaiter` skips it (Part A step 5). */
    async function seedPlainSession(id: string, ownerType: "user" | "team", ownerId: string, orgId = ORG) {
      await tdb.appDb.insert(agentSessions).values({ id, orgId, userId: "member-9", ownerType, ownerId, workspace: "/workspace", createdAt: 1, updatedAt: 1 });
    }

    /** Marks a session's thread archived (display-state only, `session_threads`). */
    async function archiveThread(sessionId: string, threadId: string) {
      await tdb.appDb.insert(sessionThreads).values({ id: threadId, sessionId, createdAt: 1, archivedAt: Date.now() });
    }

    async function dispatchMention(rows: Wakeup[], opts: { subjects?: string[]; payload?: Record<string, unknown>; origin?: ChannelOrigin } = {}) {
      const { deliveryId } = await seedDelivery({
        target: { kind: "orchestrator", follow: true },
        ownerType: "team", ownerId: "team-x", service: "slack",
        eventKey: "slack.app_mention", eventKeys: ["slack.app_mention"],
        refs: { channel: "C1", user: "U9" }, summary: "Mention",
        payload: opts.payload ?? { type: "app_mention", channel: "C1", user: "U9", text: "<@U-BOT> status?", ts: "1.2" },
        actor: { externalId: "U9" },
        subjects: opts.subjects ?? ["slack:T001", CHANNEL_SUBJECT, "slack:T001/C1/1.2"],
      });
      const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
      const fake = fakeStore(rows);
      await new EventDispatcher({
        db: tdb.appDb, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb),
        deliverToAssistant: deliver,
        resolveChannelOrigin: () => opts.origin ?? { channelType: "slack", threadKey: "slack:C1:1.2", messageTs: "1.2" },
        engineStore: fake.store,
      }).pollOnce();
      return { deliver, deliveryId, lookups: fake.lookups };
    }

    const followKey = { orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2" };

    it("routes the mention to the newest watching waiter of the owner and binds no follow (Part A, Part B)", async () => {
      await seedMentionMember("team-x");
      await seedSession("sess-old", "team", "team-x", "thr-old");
      await seedSession("sess-new", "team", "team-x", "thr-new");
      const { deliver, deliveryId, lookups } = await dispatchMention([
        waiter("old", "sess-old", { createdAt: 100 }),
        waiter("new", "sess-new", { createdAt: 200 }),
      ]);
      expect(lookups).toEqual([[CHANNEL_SUBJECT]]);
      expect(deliver).toHaveBeenCalledOnce();
      const args = deliver.mock.calls[0][0];
      expect(args.destination).toEqual({ kind: "target", sessionId: "sess-new", threadId: "thr-new", reason: "claim_redirect" });
      // The routed delivery keeps the subscription delivery's dispatch id and the Slack origin.
      expect(args.dispatchId).toBe(`event:${deliveryId}`);
      expect(args.signal.origin).toEqual({ channelType: "slack", threadKey: "slack:C1:1.2", messageTs: "1.2" });
      expect((await getDelivery(deliveryId)).status).toBe("delivered");
      expect(await findFollowedThread(tdb.appDb, followKey)).toBeNull();
    });

    it("never routes across owners or orgs (INV-M3)", async () => {
      await seedMentionMember("team-x");
      await tdb.appDb.insert(teams).values({ id: "team-z", orgId: ORG, name: "Other", createdAt: Date.now() });
      await seedSession("sess-mine", "team", "team-x", "thr-mine");
      await seedSession("sess-other-team", "team", "team-z", "thr-other-team");
      await seedSession("sess-other-org", "team", "team-x", "thr-other-org", "org-2");
      await seedSession("sess-personal", "user", "member-9", "thr-personal");
      const { deliver } = await dispatchMention([
        waiter("mine", "sess-mine", { createdAt: 100 }),
        waiter("other-team", "sess-other-team", { createdAt: 400 }),
        waiter("other-org", "sess-other-org", { createdAt: 300 }),
        waiter("personal", "sess-personal", { createdAt: 200 }),
      ]);
      expect(deliver.mock.calls[0][0].destination).toEqual({ kind: "target", sessionId: "sess-mine", threadId: "thr-mine", reason: "claim_redirect" });
    });

    it("keeps today's delivery and follow when no waiter watches the channel itself (Part A steps 4 and 7)", async () => {
      await seedMentionMember("team-x");
      await seedSession("sess-1", "team", "team-x", "thr-sess-1");
      await seedSession("sess-2", "team", "team-z", "thr-sess-2");
      const { deliver } = await dispatchMention([
        // A once-mode waiter waits for one reply, not a channel.
        waiter("once", "sess-1", { createdAt: 100, once: true }),
        // A waiter on a thread subject alone does not watch the channel.
        waiter("thread", "sess-1", { createdAt: 200, subjects: ["slack:T001/C1/1.2"] }),
        // A waiter that is no longer running.
        waiter("done", "sess-1", { createdAt: 300, status: "done" }),
        // Another owner's waiter.
        waiter("other", "sess-2", { createdAt: 400 }),
      ]);
      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0][0].destination).toMatchObject({ kind: "key", reason: "policy_new" });
      expect(await findFollowedThread(tdb.appDb, followKey)).toMatchObject({ ownerType: "team", ownerId: "team-x" });
    });

    it("finds the Slack team from the payload when the event row has no subjects", async () => {
      await seedMentionMember("team-x");
      await seedSession("sess-1", "team", "team-x", "thr-w");
      const { deliver, lookups } = await dispatchMention([waiter("w", "sess-1", { createdAt: 100 })], {
        subjects: [],
        payload: { type: "app_mention", channel: "C1", user: "U9", text: "hi", ts: "1.2", team: "T001" },
      });
      expect(lookups).toEqual([[CHANNEL_SUBJECT]]);
      expect(deliver.mock.calls[0][0].destination).toEqual({ kind: "target", sessionId: "sess-1", threadId: "thr-w", reason: "claim_redirect" });
    });

    it("does not route a refused sender (Part C)", async () => {
      // No identity link for U9: the team mention gate refuses the sender.
      await tdb.appDb.insert(teams).values({ id: "team-x", orgId: ORG, name: "Team", createdAt: Date.now() });
      await seedSession("sess-1", "team", "team-x", "thr-w");
      const { deliver, deliveryId, lookups } = await dispatchMention([waiter("w", "sess-1", { createdAt: 100 })]);
      expect(deliver).not.toHaveBeenCalled();
      expect(lookups).toEqual([]);
      expect((await getDelivery(deliveryId)).status).toBe("dead");
    });

    // Part A step 5: `findWatchingWaiter` picks only a candidate that
    // `deliverToAssistantThread` accepts. It reuses that function's own gate
    // (`isDeliverableTarget`).
    it("a newer waiter in a non-assistant session loses to an older assistant one", async () => {
      await seedMentionMember("team-x");
      // A plain `agent_sessions` row with no assistant wiring. Delivery
      // with an explicit target to this session dead-letters.
      await seedPlainSession("sess-plain", "team", "team-x");
      await seedSession("sess-asst", "team", "team-x", "thr-asst");
      const { deliver, deliveryId } = await dispatchMention([
        waiter("plain", "sess-plain", { createdAt: 500 }),
        waiter("asst", "sess-asst", { createdAt: 100 }),
      ]);
      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0][0].destination).toEqual({ kind: "target", sessionId: "sess-asst", threadId: "thr-asst", reason: "claim_redirect" });
      expect((await getDelivery(deliveryId)).status).toBe("delivered");
      expect(await findFollowedThread(tdb.appDb, followKey)).toBeNull();
    });

    it("skips a waiter on an archived thread and falls back to today's behavior", async () => {
      await seedMentionMember("team-x");
      await seedSession("sess-archived", "team", "team-x", "thr-archived");
      await archiveThread("sess-archived", "thr-archived");
      const { deliver, deliveryId } = await dispatchMention([
        waiter("archived", "sess-archived", { createdAt: 100 }),
      ]);
      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0][0].destination).toMatchObject({ kind: "key", reason: "policy_new" });
      expect((await getDelivery(deliveryId)).status).toBe("delivered");
      expect(await findFollowedThread(tdb.appDb, followKey)).toMatchObject({ ownerType: "team", ownerId: "team-x" });
    });

    it("keeps a threaded mention in a Slack thread the same owner already follows (Part A step 1)", async () => {
      await seedMentionMember("team-x");
      await seedSession("sess-1", "team", "team-x", "thr-w");
      // The mention is a reply in Slack thread 1.1, which team-x already follows.
      await upsertFollowedThread(tdb.appDb, {
        orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.1",
        ownerType: "team", ownerId: "team-x", createdBy: "member-9",
      });
      const { deliver, lookups } = await dispatchMention([waiter("w", "sess-1", { createdAt: 100 })], {
        payload: { type: "app_mention", channel: "C1", user: "U9", text: "<@U-BOT> status?", ts: "1.2", thread_ts: "1.1" },
        origin: { channelType: "slack", threadKey: "slack:C1:1.1", messageTs: "1.2" },
      });
      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0][0].destination).toMatchObject({ kind: "key", key: "slack:C1:1.1", reason: "conversation_follow" });
      expect(lookups).toEqual([]);
    });

    it("routes a threaded mention when another owner follows its Slack thread", async () => {
      await seedMentionMember("team-x");
      await tdb.appDb.insert(teams).values({ id: "team-z", orgId: ORG, name: "Other", createdAt: Date.now() });
      await seedSession("sess-1", "team", "team-x", "thr-w");
      await upsertFollowedThread(tdb.appDb, {
        orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.1",
        ownerType: "team", ownerId: "team-z", createdBy: "member-9",
      });
      const { deliver } = await dispatchMention([waiter("w", "sess-1", { createdAt: 100 })], {
        payload: { type: "app_mention", channel: "C1", user: "U9", text: "<@U-BOT> status?", ts: "1.2", thread_ts: "1.1" },
        origin: { channelType: "slack", threadKey: "slack:C1:1.1", messageTs: "1.2" },
      });
      expect(deliver.mock.calls[0][0].destination).toEqual({ kind: "target", sessionId: "sess-1", threadId: "thr-w", reason: "claim_redirect" });
    });

    it("skips a waiter that would not receive every later channel message (Part A step 4)", async () => {
      await seedMentionMember("team-x");
      // Each waiter sits in its own deliverable session, so only the clause
      // check can exclude it.
      for (const id of ["other-key", "one-sender", "status", "primary"]) {
        await seedSession(`sess-${id}`, "team", "team-x", `thr-${id}`);
      }
      const { deliver } = await dispatchMention([
        // No slack.message clause at all.
        waiter("other-key", "sess-other-key", { createdAt: 400, clauses: [{ key: "slack.reaction_added" }] }),
        // A sender restriction.
        waiter("one-sender", "sess-one-sender", { createdAt: 300, clauses: [{ key: "slack.message", actor: "U7" }] }),
        // A status filter, which a Slack message never satisfies.
        waiter("status", "sess-status", { createdAt: 200, clauses: [{ key: "slack.message", status: ["open"] }] }),
        // A primary subject other than the channel.
        waiter("primary", "sess-primary", { createdAt: 150, primarySubject: "slack:T001/C1/9.9" }),
      ]);
      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0][0].destination).toMatchObject({ kind: "key", reason: "policy_new" });
      expect(await findFollowedThread(tdb.appDb, followKey)).toMatchObject({ ownerType: "team", ownerId: "team-x" });
    });

    it("accepts a waiter whose open slack.message clause sits beside narrower clauses", async () => {
      await seedMentionMember("team-x");
      await seedSession("sess-1", "team", "team-x", "thr-mixed");
      const { deliver } = await dispatchMention([
        waiter("mixed", "sess-1", { createdAt: 100, clauses: [{ key: "slack.message", actor: "U7" }, { key: "slack.message", bots: false }] }),
      ]);
      expect(deliver.mock.calls[0][0].destination).toEqual({ kind: "target", sessionId: "sess-1", threadId: "thr-mixed", reason: "claim_redirect" });
    });

    it("falls back to today's behavior and binds the follow when only invalid candidates watch the channel", async () => {
      await seedMentionMember("team-x");
      await seedPlainSession("sess-plain", "team", "team-x");
      await seedSession("sess-archived", "team", "team-x", "thr-archived-2");
      await archiveThread("sess-archived", "thr-archived-2");
      const { deliver, deliveryId } = await dispatchMention([
        waiter("plain", "sess-plain", { createdAt: 300 }),
        waiter("archived", "sess-archived", { createdAt: 200 }),
      ]);
      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0][0].destination).toMatchObject({ kind: "key", reason: "policy_new" });
      expect((await getDelivery(deliveryId)).status).toBe("delivered");
      expect(await findFollowedThread(tdb.appDb, followKey)).toMatchObject({ ownerType: "team", ownerId: "team-x" });
    });

    it("binds the follow to the thread the mention landed in, and the binding wins the next mention (Part B step 5)", async () => {
      await seedMentionMember("team-x");
      const { deliver, deliveryId } = await dispatchMention([]);
      // A follow rule with no policy opens a thread per mention (Part A step 3).
      expect(deliver.mock.calls[0]?.[0].destination).toMatchObject({ kind: "key", reason: "policy_new" });
      expect(deliver.mock.calls[0]?.[0].destination).toHaveProperty("key", expect.stringMatching(new RegExp(`:${deliveryId}$`)));
      // The thread records the content's channel for its read gate.
      expect(deliver.mock.calls[0]?.[0].slackChannel).toBe("C1");
      expect(await findFollowedThread(tdb.appDb, followKey)).toMatchObject({ sessionId: LANDED.sessionId, threadId: LANDED.threadId });

      // Point the follow at a live thread, then mention again inside the Slack thread.
      await seedSession("sess-bound", "team", "team-x", "thr-bound");
      await tdb.appDb.execute(sql`UPDATE followed_threads SET session_id = 'sess-bound', thread_id = 'thr-bound'`);
      const second = await dispatchMention([], {
        payload: { type: "app_mention", channel: "C1", user: "U9", text: "<@U-BOT> again", ts: "1.3", thread_ts: "1.2" },
        origin: { channelType: "slack", threadKey: "slack:C1:1.2", messageTs: "1.3" },
      });
      expect(second.deliver.mock.calls[0]?.[0].destination).toEqual({ kind: "target", sessionId: "sess-bound", threadId: "thr-bound", reason: "conversation_follow" });
    });

    it("ignores a follow binding whose thread was archived and lets the policy decide", async () => {
      await seedMentionMember("team-x");
      await seedSession("sess-bound", "team", "team-x", "thr-bound");
      await archiveThread("sess-bound", "thr-bound");
      await upsertFollowedThread(tdb.appDb, {
        orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.1",
        ownerType: "team", ownerId: "team-x", createdBy: "member-9", target: { sessionId: "sess-bound", threadId: "thr-bound" },
      });
      const { deliver } = await dispatchMention([], {
        payload: { type: "app_mention", channel: "C1", user: "U9", text: "<@U-BOT> status?", ts: "1.2", thread_ts: "1.1" },
        origin: { channelType: "slack", threadKey: "slack:C1:1.1", messageTs: "1.2" },
      });
      expect(deliver.mock.calls[0]?.[0].destination).toMatchObject({ kind: "key", reason: "policy_new" });
    });
  });

  it("signal target: inserts workflow_signals for org runs parked on event:<key> and wakes them", async () => {
    const db = tdb.appDb;
    const now = Date.now();
    const signalType = "event:github.issues.opened";
    // Definition rows carry the org scoping; run-2 belongs to another org
    // and must NOT be signalled despite an identical wait condition.
    for (const [defId, orgId] of [
      ["wf-a", ORG],
      ["wf-b", "other-org"],
    ] as const) {
      await db.insert(workflowDefinitions).values({
        id: defId,
        orgId,
        ownerType: "user",
        ownerId: "user-1",
        name: defId,
        definition: { nodes: [] },
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const [runId, workflowId] of [
      ["run-1", "wf-a"],
      ["run-2", "wf-b"],
    ] as const) {
      await db.insert(workflowRuns).values({
        id: runId,
        workflowId,
        definitionVersionId: "v1",
        definition: { nodes: [] },
        params: { workflowId, definitionVersionId: "v1" },
        status: "parked",
        waitingOn: [{ kind: "signal", nodeId: "wait-1", signalType, timeoutAt: now + 3_600_000 }],
        createdAt: now,
        updatedAt: now,
      });
    }
    const { eventId, deliveryId } = await seedDelivery({ target: { kind: "signal" } });

    const runHost = fakeRunHost();
    const dispatcher = new EventDispatcher({
      db,
      workflowRunHost: runHost,
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToAssistant: vi.fn<AssistantDeliverFn>(async () => LANDED),
    });
    await dispatcher.pollOnce();

    const signals = await db.select().from(workflowSignals);
    expect(signals).toHaveLength(1);
    expect(signals[0].runId).toBe("run-1");
    expect(signals[0].signalId).toBe(`event:${eventId}:run-1`);
    expect(signals[0].signalType).toBe(signalType);
    expect(signals[0].payload).toEqual({
      key: "github.issues.opened",
      summary: "Issue #7 opened: broken build",
      refs: { repo: "acme/site", installation_id: "42" },
      payload: { action: "opened", issue: { number: 7 } },
    });
    expect(runHost.wake).toHaveBeenCalledTimes(1);
    expect(runHost.wake).toHaveBeenCalledWith("run-1");

    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("delivered");
  });

  it("failure increments attempts, sets next_attempt_at per backoff, records last_error", async () => {
    const { deliveryId } = await seedDelivery({ target: { kind: "orchestrator" } });
    const deliver = vi.fn<AssistantDeliverFn>(async () => {
      throw new Error("orchestrator boom");
    });
    const dispatcher = new EventDispatcher({
      db: tdb.appDb,
      workflowRunHost: fakeRunHost(),
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToAssistant: deliver,
    });

    // Attempt 1 → 30s backoff.
    let before = Date.now();
    await dispatcher.pollOnce();
    let row = await getDelivery(deliveryId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("orchestrator boom");
    expect(row.nextAttemptAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(row.nextAttemptAt).toBeLessThanOrEqual(Date.now() + 30_000);

    // Make it due again; attempt 2 → 2m backoff.
    await tdb.appDb
      .update(eventDeliveries)
      .set({ nextAttemptAt: Date.now() - 1 })
      .where(eq(eventDeliveries.id, deliveryId));
    before = Date.now();
    await dispatcher.pollOnce();
    row = await getDelivery(deliveryId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(2);
    expect(row.nextAttemptAt).toBeGreaterThanOrEqual(before + 120_000);
    expect(row.nextAttemptAt).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it("marks the delivery dead on the 5th failure", async () => {
    const { deliveryId } = await seedDelivery({
      target: { kind: "orchestrator" },
      status: "failed",
      attempts: 4,
    });
    const dispatcher = new EventDispatcher({
      db: tdb.appDb,
      workflowRunHost: fakeRunHost(),
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToAssistant: vi.fn<AssistantDeliverFn>(async () => {
        throw new Error("still broken");
      }),
    });
    await dispatcher.pollOnce();

    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("dead");
    expect(row.attempts).toBe(5);
    expect(row.lastError).toContain("still broken");

    // A dead row is never claimed again.
    await dispatcher.pollOnce();
    expect((await getDelivery(deliveryId)).attempts).toBe(5);
  });

  it("dispatches events while ingress waits without starting overlapping ingress drains", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ingress = vi.fn(() => gate);
    const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
    const dispatcher = new EventDispatcher({ db: tdb.appDb, workflowRunHost: fakeRunHost(),
      workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToAssistant: deliver });
    dispatcher.setIngressDrain(ingress);
    try {
      for (let i = 0; i < 2; i++) {
        const { deliveryId } = await seedDelivery({ target: { kind: "orchestrator" } });
        await dispatcher.pollOnce();
        expect((await getDelivery(deliveryId)).status).toBe("delivered");
      }
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(ingress).toHaveBeenCalledTimes(1);
    } finally { release(); await dispatcher.stop(); }
  });

  it("claimed rows are skipped by a concurrent pollOnce", async () => {
    const { deliveryId } = await seedDelivery({ target: { kind: "orchestrator" } });
    // PGlite is single-connection, so the claim UPDATEs serialize and a
    // true cross-connection EvalPlanQual interleave can't be reproduced
    // here. This test only covers the sequential shape (d2 polls after
    // d1's claim committed). In-process, the `draining` guard fires before
    // d2's claim ever reaches the DB; the real cross-process fence is the
    // due conditions repeated on the outer UPDATE qual (EPQ recheck fails
    // once the winner bumps next_attempt_at) — see the dispatcher's file
    // doc comment.
    // The slow seam holds the first dispatcher's delivery open while the
    // second polls; the atomic claim must keep the row invisible to it.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const deliver = vi.fn<AssistantDeliverFn>(async () => {
      await gate;
      return LANDED;
    });
    const mkDispatcher = () =>
      new EventDispatcher({
        db: tdb.appDb,
        workflowRunHost: fakeRunHost(),
        workflowStore: new PgWorkflowStore(tdb.pgdb),
        deliverToAssistant: deliver,
      });
    const d1 = mkDispatcher();
    const d2 = mkDispatcher();

    const p1 = d1.pollOnce();
    // Give d1's claim a macrotask to land before d2 polls.
    await new Promise((r) => setImmediate(r));
    const p2 = d2.pollOnce();
    await p2; // d2 must complete without touching the claimed row
    expect(deliver).toHaveBeenCalledTimes(1);
    release();
    await p1;

    expect(deliver).toHaveBeenCalledTimes(1);
    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(1);
  });
  /** Thread policy plumbing (spec 2026-10-16: delivery threads, Part B and Part E). */
  describe("thread policy destinations", () => {
    const PR_SUBJECTS = ["github:acme/site", "github:acme/site#7"];

    function dispatcherWith(deliver: AssistantDeliverFn): EventDispatcher {
      return new EventDispatcher({
        db: tdb.appDb, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb),
        deliverToAssistant: deliver, plugins: [githubPlugin],
      });
    }

    it("own: keys on the rule and titles the thread by the rule name", async () => {
      const { subscriptionId } = await seedDelivery({ target: { kind: "orchestrator", thread: { mode: "own" } } });
      const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
      await dispatcherWith(deliver).pollOnce();
      expect(deliver.mock.calls[0]?.[0].destination).toEqual({ kind: "key", key: `sub:${subscriptionId}`, title: "test sub", reason: "policy_own" });
    });

    it("new: keys on the delivery id, so a retry reuses the same key", async () => {
      const { subscriptionId, deliveryId } = await seedDelivery({ target: { kind: "orchestrator", thread: { mode: "new" } } });
      let calls = 0;
      const deliver = vi.fn<AssistantDeliverFn>(async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
        return LANDED;
      });
      const dispatcher = dispatcherWith(deliver);
      await dispatcher.pollOnce();
      expect((await getDelivery(deliveryId)).status).toBe("failed");
      await tdb.appDb.update(eventDeliveries).set({ nextAttemptAt: Date.now() - 1 }).where(eq(eventDeliveries.id, deliveryId));
      await dispatcher.pollOnce();
      expect((await getDelivery(deliveryId)).status).toBe("delivered");
      const keys = deliver.mock.calls.map(([args]) => args.destination);
      const expected = { kind: "key", key: `sub:${subscriptionId}:${deliveryId}`, title: "Issue #7 opened: broken build", reason: "policy_new" };
      expect(keys).toEqual([expected, expected]);
    });

    it("subject: two rules of one owner on one pull request share one key (INV-D8)", async () => {
      const { eventId, subscriptionId } = await seedDelivery({ target: { kind: "orchestrator", thread: { mode: "subject" } }, subjects: PR_SUBJECTS });
      const secondSub = randomUUID();
      const now = Date.now();
      await tdb.appDb.insert(eventSubscriptions).values({
        id: secondSub, orgId: ORG, ownerType: "user", ownerId: "user-1", name: "second rule", eventKeys: ["github.issues.*"],
        filters: [], target: { kind: "orchestrator", thread: { mode: "subject" } }, enabled: true, createdBy: "user-1", createdAt: now, updatedAt: now,
      });
      await tdb.appDb.insert(eventDeliveries).values({ id: randomUUID(), eventId, subscriptionId: secondSub, status: "pending", attempts: 0, nextAttemptAt: now - 1_000, createdAt: now });
      const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
      await dispatcherWith(deliver).pollOnce();
      expect(subscriptionId).not.toBe(secondSub);
      const destinations = deliver.mock.calls.map(([args]) => args.destination);
      const expected = { kind: "key", key: "subject:github:acme/site#7", title: "acme/site#7", reason: "policy_subject" };
      expect(destinations).toEqual([expected, expected]);
    });

    it("existing: a pin that cannot receive deliveries dead-letters with the fix text", async () => {
      const pin = { mode: "existing", sessionId: "sess-pin", threadId: "thr-pin" };
      const { deliveryId } = await seedDelivery({ target: { kind: "orchestrator", thread: pin } });
      const deliver = vi.fn<AssistantDeliverFn>(async () => { throw new PinUnavailableError(); });
      recordDeliveryDestination.mockClear();
      await dispatcherWith(deliver).pollOnce();
      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0]?.[0].destination).toEqual({ kind: "target", sessionId: "sess-pin", threadId: "thr-pin", reason: "policy_existing" });
      expect(await getDelivery(deliveryId)).toMatchObject({ status: "dead", attempts: 1, lastError: "Pick another thread for this rule in Presence." });
      expect(recordDeliveryDestination.mock.calls).toEqual([["pin_unavailable"]]);
    });

    it("records the destination stage on the event's receipt and counts the reason", async () => {
      const { eventId, subscriptionId, deliveryId } = await seedDelivery({ target: { kind: "orchestrator" } });
      await tdb.appDb.insert(eventReceipts).values({
        id: "rcpt-1", orgId: ORG, service: "github", metadata: {}, stages: [], subscriptions: [], eventId, createdAt: 1, updatedAt: 1,
      });
      recordDeliveryDestination.mockClear();
      await dispatcherWith(vi.fn<AssistantDeliverFn>(async () => LANDED)).pollOnce();
      const [receipt] = await tdb.appDb.select().from(eventReceipts).where(eq(eventReceipts.id, "rcpt-1"));
      expect(receipt?.stages).toEqual([expect.objectContaining({
        stage: "destination", outcome: "policy_own",
        detail: `Subscription ${subscriptionId}, delivery ${deliveryId}: thread key sub:${subscriptionId}.`,
      })]);
      expect(recordDeliveryDestination.mock.calls).toEqual([["policy_own"]]);
    });

    it("a claim on an ambient event skips the delivery and never calls the seam (M4)", async () => {
      const { deliveryId } = await seedDelivery({ target: { kind: "orchestrator" } });
      const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
      const claimFor = vi.fn(async () => ({ sessionId: "sess-w", threadId: "thr-w", waiterId: "w-1" }));
      recordDeliveryDestination.mockClear();
      await new EventDispatcher({
        db: tdb.appDb, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb),
        deliverToAssistant: deliver, plugins: [githubPlugin], claimFor,
      }).pollOnce();
      expect(claimFor).toHaveBeenCalledOnce();
      expect(deliver).not.toHaveBeenCalled();
      expect(await getDelivery(deliveryId)).toMatchObject({ status: "skipped", lastError: "Skipped, claimed by thread thr-w." });
      expect(recordDeliveryDestination.mock.calls).toEqual([["claim_skip"]]);
    });

    it("defaults an absent policy per delivery: new with a channel origin, own without one", async () => {
      // A mention rule that does not follow still opens a thread per Slack conversation.
      const mention = await seedDelivery({
        target: { kind: "orchestrator" }, service: "slack", eventKey: "slack.app_mention", eventKeys: ["slack.app_mention"],
        payload: { type: "app_mention", channel: "C1", user: "U9", text: "hi", ts: "1.2" },
      });
      // A follow rule's event with no channel origin keeps the rule's thread.
      const reaction = await seedDelivery({
        target: { kind: "orchestrator", follow: true }, service: "slack", eventKey: "slack.reaction_added", eventKeys: ["slack.reaction_added"],
        payload: { type: "reaction_added", item: { channel: "C1", ts: "1.2" }, user: "U9", reaction: "eyes" },
      });
      const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
      await new EventDispatcher({
        db: tdb.appDb, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToAssistant: deliver,
        resolveChannelOrigin: (_service, eventKey) => eventKey === "slack.app_mention" ? { channelType: "slack", threadKey: "slack:C1:1.2", messageTs: "1.2" } : null,
      }).pollOnce();
      const byDispatch = new Map(deliver.mock.calls.map(([args]) => [args.dispatchId, args.destination]));
      expect(byDispatch.get(`event:${mention.deliveryId}`)).toMatchObject({ kind: "key", key: `sub:${mention.subscriptionId}:${mention.deliveryId}`, reason: "policy_new" });
      expect(byDispatch.get(`event:${reaction.deliveryId}`)).toMatchObject({ kind: "key", key: `sub:${reaction.subscriptionId}`, reason: "policy_own" });
    });

    it("records the destination stage and the counter once when a retry recovers an admitted dispatch (M6)", async () => {
      const { eventId, deliveryId } = await seedDelivery({ target: { kind: "orchestrator" } });
      await tdb.appDb.insert(eventReceipts).values({
        id: "rcpt-retry", orgId: ORG, service: "github", metadata: {}, stages: [], subscriptions: [], eventId, createdAt: 1, updatedAt: 1,
      });
      recordDeliveryDestination.mockClear();
      await dispatcherWith(vi.fn<AssistantDeliverFn>(async () => LANDED)).pollOnce();
      // The status write was lost: the delivery runs again and recovers its admission.
      await tdb.appDb.update(eventDeliveries).set({ status: "pending", nextAttemptAt: Date.now() - 1 }).where(eq(eventDeliveries.id, deliveryId));
      await dispatcherWith(vi.fn<AssistantDeliverFn>(async () => ({ ...LANDED, recovered: true }))).pollOnce();
      const [receipt] = await tdb.appDb.select().from(eventReceipts).where(eq(eventReceipts.id, "rcpt-retry"));
      expect(receipt?.stages).toHaveLength(1);
      expect(recordDeliveryDestination.mock.calls).toEqual([["policy_own"]]);
    });

    it("does not count a recovered retry again when the event has no receipt", async () => {
      const { deliveryId } = await seedDelivery({ target: { kind: "orchestrator" } });
      recordDeliveryDestination.mockClear();
      await dispatcherWith(vi.fn<AssistantDeliverFn>(async () => LANDED)).pollOnce();
      await tdb.appDb.update(eventDeliveries).set({ status: "pending", nextAttemptAt: Date.now() - 1 }).where(eq(eventDeliveries.id, deliveryId));
      await dispatcherWith(vi.fn<AssistantDeliverFn>(async () => ({ ...LANDED, recovered: true }))).pollOnce();
      expect(recordDeliveryDestination.mock.calls).toEqual([["policy_own"]]);
    });

    it("a skip marks the delivery skipped and creates no thread (INV-D3)", async () => {
      const { eventId, subscriptionId, deliveryId } = await seedDelivery({ target: { kind: "orchestrator" } });
      recordDeliveryDestination.mockClear();
      await recordSkippedDelivery(tdb.appDb, {
        deliveryId, subscriptionId, attempts: 0, orgId: ORG, eventId, destination: { kind: "skip", reason: "claimed by thread thr-w" },
      });
      expect(await getDelivery(deliveryId)).toMatchObject({ status: "skipped", attempts: 1, lastError: "Skipped, claimed by thread thr-w." });
      expect(recordDeliveryDestination.mock.calls).toEqual([["claim_skip"]]);
      const threads = await tdb.appDb.execute(sql`SELECT count(*)::int AS n FROM engine_threads`) as { rows: Array<{ n: number }> };
      expect(threads.rows[0]?.n).toBe(0);
    });
  });
});

/**
 * A team-owned subscription must reach the TEAM's default assistant. The
 * dispatcher is owner-agnostic — it forwards the subscription's principal
 * straight through — so these pin the two values that are easy to get wrong.
 *
 * Machine deliveries use a synthetic team or organization actor. A saved
 * rule creator is attribution, not permission to use their personal share.
 */
describe("EventDispatcher — team-owned subscriptions", () => {
  let tdb: TestPgDb;

  beforeEach(async () => {
    tdb = await freshTestPgDb();
  });

  async function deliverWith(ownerType: "user" | "team" | "org", ownerId: string) {
    const db = tdb.appDb;
    const now = Date.now();
    const subscriptionId = randomUUID();
    const eventId = randomUUID();
    const deliveryId = randomUUID();
    await db.insert(events).values({
      id: eventId,
      orgId: ORG,
      service: "github",
      eventKey: "github.issues.opened",
      dedupeKey: randomUUID(),
      refs: { repo: "acme/site" },
      summary: "Issue #7 opened",
      payload: { action: "opened" },
      occurredAt: now - 5_000,
      receivedAt: now,
    });
    await db.insert(eventSubscriptions).values({
      id: subscriptionId,
      orgId: ORG,
      ownerType,
      ownerId,
      name: "test sub",
      eventKeys: ["github.issues.*"],
      filters: [],
      target: { kind: "orchestrator" },
      enabled: true,
      createdBy: "author-user",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(eventDeliveries).values({
      id: deliveryId,
      eventId,
      subscriptionId,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now - 1_000,
      createdAt: now,
    });

    const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
    await new EventDispatcher({
      db,
      workflowRunHost: fakeRunHost(),
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToAssistant: deliver,
    }).pollOnce();
    return deliver;
  }

  it("forwards the team principal unchanged", async () => {
    const deliver = await deliverWith("team", "team_1");
    expect(deliver).toHaveBeenCalledTimes(1);
    const args = deliver.mock.calls[0][0];
    expect(args.ownerType).toBe("team");
    expect(args.ownerId).toBe("team_1");
  });

  it("uses a team actor instead of the subscription creator", async () => {
    const deliver = await deliverWith("team", "team_1");
    const args = deliver.mock.calls[0][0];
    expect(args.actorUserId).toBe("team:team_1");
  });

  it("uses an organization actor instead of the subscription creator", async () => {
    const deliver = await deliverWith("org", ORG);
    const args = deliver.mock.calls[0][0];
    expect(args.actorUserId).toBe(`org:${ORG}`);
  });

  it("still acts as the owner on a personal subscription, where owner and author are the same person", async () => {
    const deliver = await deliverWith("user", "author-user");
    const args = deliver.mock.calls[0][0];
    expect(args.ownerId).toBe("author-user");
    expect(args.actorUserId).toBe("author-user");
  });

});

describe("deliveryThreadPolicy", () => {
  it("defaults a delivery with a channel origin to its own thread per conversation, else the rule's thread", () => {
    expect(deliveryThreadPolicy({}, { channelOrigin: true })).toEqual({ mode: "new" });
    expect(deliveryThreadPolicy({ thread: null }, { channelOrigin: true })).toEqual({ mode: "new" });
    expect(deliveryThreadPolicy({}, { channelOrigin: false })).toEqual({ mode: "own" });
    // A stored policy wins over the default.
    expect(deliveryThreadPolicy({ thread: { mode: "own" } }, { channelOrigin: true })).toEqual({ mode: "own" });
    expect(deliveryThreadPolicy({ thread: { mode: "new" } }, { channelOrigin: false })).toEqual({ mode: "new" });
  });
});
