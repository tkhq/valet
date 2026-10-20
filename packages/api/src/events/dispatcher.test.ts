/**
 * EventDispatcher unit tests (event-system plan Task 6): real PGlite rows
 * for events/subscriptions/deliveries, recording fakes at the two seams
 * (`RunHost`, `deliverToAssistant`). The tests call `pollOnce()` directly,
 * with no timers and no sleeps.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import githubPlugin from "@valet/plugin-github/plugin";
import slackPlugin from "@valet/plugin-slack/plugin";
import { eq, sql } from "drizzle-orm";
import type { ChannelOrigin, ValetPlugin } from "@valet/engine";
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
import { deliveryThreadPolicy, EventDispatcher, recordSkippedDelivery, type AssistantDeliverFn, type EventDispatcherDeps } from "./dispatcher.js";
import { PinUnavailableError, pinNarrowsMessage } from "./assistant-delivery.js";
import { waiterMatchDeps } from "./waiters.js";
import { PgSessionStore } from "@valet/store-postgres";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import type { DestinationRecorder } from "../observability/delivery-metrics.js";

/** Records the destination counter's reasons. The dispatcher takes it as a
 * dependency, so the tests need no module mock. */
const recordDestination = vi.fn<DestinationRecorder>();

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
  /** The destination stamp ingest wrote (spec Part C step 6). */
  destination?: unknown;
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
      destination: opts.destination ?? null,
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
    const { deliveryId, subscriptionId } = await seedDelivery({ target: { kind: "assistant", deliveryPolicy: policy, pauseOnOverlap: true } });
    const teamOrg = sameOrg ? ORG : "other-org";
    await db.insert(teams).values({ id: "coverage-team", orgId: teamOrg, name: "Coverage", createdAt: Date.now() });
    if (member) await db.insert(teamMembers).values({ teamId: "coverage-team", userId: "user-1", role: "member" });
    await db.insert(eventSubscriptions).values({
      id: "coverage-rule", orgId: teamOrg, ownerType: "team", ownerId: "coverage-team", name: "Team coverage",
      eventKeys: ["github.issues.*"], filters: [], target: { kind: "assistant", assistant: "team", teamId: "coverage-team" },
      enabled, createdBy: "user-1", createdAt: Date.now(), updatedAt: Date.now(),
    });
    const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
    const dispatcher = new EventDispatcher({ db, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToAssistant: deliver, plugins: [githubPlugin] });
    await dispatcher.pollOnce();
    expect((await getDelivery(deliveryId)).status).toBe(expected);
    // The skip names the cause without a dash; the web prefixes "skipped: ".
    if (expected === "skipped") expect((await getDelivery(deliveryId)).lastError).toBe("The team already listens for this. This personal line is paused.");
    expect(deliver).toHaveBeenCalledTimes(expected === "delivered" ? 1 : 0);
    const [personal] = await db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, subscriptionId));
    expect(personal!.enabled).toBe(expected !== "skipped");
    await dispatcher.pollOnce();
    expect(deliver).toHaveBeenCalledTimes(expected === "delivered" ? 1 : 0);
  });

  it("a team subscription's matching subject filter suppresses delivery under ignoreIfMyTeamSubscribed (spec Part G)", async () => {
    const db = tdb.appDb;
    const subjects = ["github:acme", "github:acme/site", "github:acme/site#7"];
    const { deliveryId } = await seedDelivery({ target: { kind: "assistant", deliveryPolicy: "ignoreIfMyTeamSubscribed" }, subjects });
    await db.insert(teams).values({ id: "subject-team", orgId: ORG, name: "Subject", createdAt: Date.now() });
    await db.insert(teamMembers).values({ teamId: "subject-team", userId: "user-1", role: "member" });
    await db.insert(eventSubscriptions).values({
      id: "subject-rule", orgId: ORG, ownerType: "team", ownerId: "subject-team", name: "Team coverage",
      eventKeys: ["github.issues.*"], filters: [{ field: "subject", op: "eq", value: "github:acme/site#7" }],
      target: { kind: "assistant", assistant: "team", teamId: "subject-team" },
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
    const { deliveryId } = await seedDelivery({ target: { kind: "assistant", deliveryPolicy: "ignoreIfMyTeamSubscribed" }, subjects });
    await db.insert(teams).values({ id: "subject-team-2", orgId: ORG, name: "Subject2", createdAt: Date.now() });
    await db.insert(teamMembers).values({ teamId: "subject-team-2", userId: "user-1", role: "member" });
    await db.insert(eventSubscriptions).values({
      id: "subject-rule-2", orgId: ORG, ownerType: "team", ownerId: "subject-team-2", name: "Team coverage",
      // Names a different issue on the same repo — the key matches, the subject does not.
      eventKeys: ["github.issues.*"], filters: [{ field: "subject", op: "eq", value: "github:acme/site#999" }],
      target: { kind: "assistant", assistant: "team", teamId: "subject-team-2" },
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
    const { deliveryId, subscriptionId } = await seedDelivery({ target: { kind: "assistant", deliveryPolicy: "ignoreIfAnyTeamSubscribed" }, status: "failed", attempts: 1 });
    await db.insert(teams).values({ id: "retry-team", orgId: ORG, name: "Retry", createdAt: Date.now() });
    await db.insert(eventSubscriptions).values({ id: "retry-rule", orgId: ORG, ownerType: "team", ownerId: "retry-team", name: "Coverage", eventKeys: ["github.issues.*"], filters: [], target: { kind: "assistant", assistant: "team", teamId: "retry-team" }, enabled: true, createdBy: "user-1", createdAt: Date.now(), updatedAt: Date.now() });
    const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
    const dispatcher = new EventDispatcher({ db, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToAssistant: deliver, plugins: [githubPlugin] });
    await dispatcher.pollOnce();
    expect(await getDelivery(deliveryId)).toMatchObject({ status: "skipped", lastError: "The team already listens for this." });
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
      target: { kind: "workflow", workflowId: "wf-1", appearance: { displayName: "Event Hestia" } },
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
      target: { kind: "assistant" }, eventKey: "github.issue_comment.created", eventKeys: ["github.issue_comment.*"],
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

  it("lands a Slack event with no thread to reply into in its channel's thread", async () => {
    // A reaction in a channel has no Slack thread to answer. With no policy
    // set, the channel's subject thread holds it, so channels never share a
    // thread (spec 2026-10-16: delivery threads, Part A step 3).
    const { subscriptionId } = await seedDelivery({
      target: { kind: "assistant" }, ownerType: "org",
      service: "slack", eventKey: "slack.reaction_added", eventKeys: ["slack.reaction_added"],
      refs: { channel: "CPRIV" }, summary: "reaction :eyes: added in CPRIV by U9", subjects: ["slack:T1/CPRIV"],
      payload: { type: "reaction_added", item: { channel: "CPRIV", ts: "1.2" }, user: "U9", reaction: "eyes" },
    });
    const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
    await new EventDispatcher({ db: tdb.appDb, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToAssistant: deliver, plugins: [slackPlugin] }).pollOnce();
    expect(deliver.mock.calls[0]?.[0].destination).toEqual({ kind: "key", key: "subject:slack:T1/CPRIV", title: "CPRIV", reason: "policy_subject" });
  });

  it("delivers an assistant-target delivery: seam gets SignalContent with signalType = event key; row -> delivered", async () => {
    const { eventId, deliveryId } = await seedDelivery({ target: { kind: "assistant" }, ownerType: "org" });

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
      target: { kind: "assistant" },
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
          kind: "assistant",
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
        target: { kind: "assistant", systemPrompt: "Triage {{event.key}}. Answer in one sentence." },
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
        target: { kind: "assistant", userPromptTemplate: "In #deploys: {{event.body}}" },
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
      await seedDelivery({ target: { kind: "assistant" }, payload: PAYLOAD });
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
        target: { kind: "assistant", follow },
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
      target: { kind: "assistant", follow: true, presence: { displayName: "Personal helper" } },
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

  // Spec 2026-10-16 presence hub, Part H step 3: no backfill runs, so a
  // stored row with the old names must still deliver.
  it("delivers a stored row with the old names to the assistant with its appearance", async () => {
    await seedDelivery({
      target: { kind: "orchestrator", orchestrator: "user", presence: { displayName: "Legacy helper" } },
      service: "slack", eventKey: "slack.app_mention", eventKeys: ["slack.app_mention"],
      payload: { type: "app_mention", channel: "C1", user: "U9", text: "hi", ts: "1.2" },
    });
    const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
    const dispatcher = new EventDispatcher({
      db: tdb.appDb, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToAssistant: deliver,
      resolveChannelOrigin: () => ({ channelType: "slack", threadKey: "slack:C1:1.2" }),
    });
    await dispatcher.pollOnce();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![0].appearance).toEqual({ displayName: "Legacy helper" });
  });

  it("does not create a second follow path for a message subscription", async () => {
    const { deliveryId } = await seedDelivery({
      target: { kind: "assistant", follow: true }, service: "slack",
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
   * Stamp execution (spec 2026-10-16: delivery threads and claims, Part C
   * steps 5 to 7). Ingest stamps the destination that a claim or a binding
   * decided. The dispatcher executes the stamp and never consults waiters.
   * An unstamped row resolves from the binding and the policy only.
   */
  describe("stamped destinations", () => {
    async function dispatchMention(opts: {
      destination?: unknown; payload?: Record<string, unknown>; origin?: ChannelOrigin;
      deliver?: AssistantDeliverFn;
      endMatchedWaiter?: EventDispatcherDeps["endMatchedWaiter"];
    } = {}) {
      const { deliveryId, eventId } = await seedDelivery({
        target: { kind: "assistant", follow: true },
        ownerType: "team", ownerId: "team-x", service: "slack",
        eventKey: "slack.app_mention", eventKeys: ["slack.app_mention"],
        refs: { channel: "C1", user: "U9" }, summary: "Mention",
        payload: opts.payload ?? { type: "app_mention", channel: "C1", user: "U9", text: "<@U-BOT> status?", ts: "1.2" },
        actor: { externalId: "U9" },
        subjects: ["slack:T001", "slack:T001/C1", "slack:T001/C1/1.2"],
        destination: opts.destination,
      });
      const deliver = vi.fn<AssistantDeliverFn>(opts.deliver ?? (async () => LANDED));
      await new EventDispatcher({
        db: tdb.appDb, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb),
        deliverToAssistant: deliver, recordDestination,
        resolveChannelOrigin: () => opts.origin ?? { channelType: "slack", threadKey: "slack:C1:1.2", messageTs: "1.2" },
        ...(opts.endMatchedWaiter ? { endMatchedWaiter: opts.endMatchedWaiter } : {}),
      }).pollOnce();
      return { deliver, deliveryId, eventId };
    }

    /** One root assistant and governing thread per owner, reused by every
     * execution session of that owner. */
    async function seedAssistant(ownerType: "user" | "team", ownerId: string) {
      const assistantId = `asst-${ownerType}-${ownerId}`;
      const rootSessionId = `root-${assistantId}`;
      const governingThreadId = `gov-${assistantId}`;
      await tdb.appDb.insert(agentSessions).values({
        id: rootSessionId, orgId: ORG, userId: "member-9", ownerType, ownerId, workspace: "/workspace", createdAt: 1, updatedAt: 1,
      }).onConflictDoNothing();
      await tdb.appDb.insert(assistants).values({ id: assistantId, orgId: ORG, ownerType, ownerId, sessionId: rootSessionId, createdAt: 1 })
        .onConflictDoNothing();
      await tdb.appDb.execute(sql`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at)
        VALUES (${governingThreadId}, ${rootSessionId}, ${governingThreadId}, 'idle', 'steer', 1, 1)
        ON CONFLICT (id) DO NOTHING`);
      return { assistantId, governingThreadId };
    }

    /** A deliverable thread: a real execution session of the owner's
     * assistant, so `isDeliverableTarget` runs for real. */
    async function seedSession(id: string, ownerType: "user" | "team", ownerId: string, threadId: string) {
      const { assistantId, governingThreadId } = await seedAssistant(ownerType, ownerId);
      await tdb.appDb.insert(agentSessions).values({ id, orgId: ORG, userId: "member-9", ownerType, ownerId, workspace: "/workspace", createdAt: 1, updatedAt: 1 });
      await tdb.appDb.insert(assistantExecutions).values({ sessionId: id, assistantId, conversationKey: `conv-${id}`, governingThreadId, createdAt: 1 });
      await tdb.appDb.execute(sql`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at)
        VALUES (${threadId}, ${id}, ${threadId}, 'idle', 'steer', 1, 1)`);
    }

    const followKey = { orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2" };
    const redirect = { kind: "target", sessionId: "sess-inc", threadId: "thr-inc", reason: "claim_redirect" };

    beforeEach(() => { recordDestination.mockClear(); });

    it("a skip stamp marks the row skipped with its reason and never calls the seam (C1, INV-D3)", async () => {
      const { deliveryId } = await seedDelivery({
        target: { kind: "assistant" }, destination: { kind: "skip", reason: "claimed by thread thr-w" },
      });
      const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
      await new EventDispatcher({
        db: tdb.appDb, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb),
        deliverToAssistant: deliver, plugins: [githubPlugin], recordDestination,
      }).pollOnce();
      expect(deliver).not.toHaveBeenCalled();
      expect(await getDelivery(deliveryId)).toMatchObject({ status: "skipped", attempts: 1, lastError: "Skipped, claimed by thread thr-w." });
      expect(recordDestination.mock.calls).toEqual([["claim_skip"]]);
      const threads = await tdb.appDb.execute(sql`SELECT count(*)::int AS n FROM engine_threads`) as { rows: Array<{ n: number }> };
      expect(threads.rows[0]?.n).toBe(0);
    });

    it("a target stamp delivers to its thread with the Slack origin and binds the follow (C2)", async () => {
      await seedMentionMember("team-x");
      await seedSession("sess-inc", "team", "team-x", "thr-inc");
      const landed = { sessionId: "sess-inc", threadId: "thr-inc" };
      const { deliver, deliveryId } = await dispatchMention({ destination: redirect, deliver: async () => landed });
      expect(deliver).toHaveBeenCalledOnce();
      const args = deliver.mock.calls[0]![0];
      expect(args.destination).toEqual(redirect);
      expect(args.dispatchId).toBe(`event:${deliveryId}`);
      expect(args.signal.origin).toEqual({ channelType: "slack", threadKey: "slack:C1:1.2", messageTs: "1.2" });
      expect(args.inbound).toBeDefined();
      expect((await getDelivery(deliveryId)).status).toBe("delivered");
      expect(await findFollowedThread(tdb.appDb, followKey)).toMatchObject({ ownerType: "team", ownerId: "team-x", ...landed });
      expect(recordDestination.mock.calls).toEqual([["claim_redirect"]]);
    });

    it("a once-mode redirect target ends after its delivery lands, once per delivery (Part C step 5)", async () => {
      await seedMentionMember("team-x");
      await seedSession("sess-inc", "team", "team-x", "thr-inc");
      const order: string[] = [];
      const endMatchedWaiter = vi.fn(async () => { order.push("end"); return true; });
      const { deliveryId } = await seedDelivery({
        target: { kind: "assistant", follow: true }, ownerType: "team", ownerId: "team-x", service: "slack",
        eventKey: "slack.app_mention", eventKeys: ["slack.app_mention"], refs: { channel: "C1", user: "U9" }, summary: "Mention",
        payload: { type: "app_mention", channel: "C1", user: "U9", text: "<@U-BOT> status?", ts: "1.2" }, actor: { externalId: "U9" },
        destination: { ...redirect, matchedWaiterId: "w-once" },
      });
      const deliver = vi.fn<AssistantDeliverFn>(async () => { order.push("deliver"); return { sessionId: "sess-inc", threadId: "thr-inc" }; });
      await new EventDispatcher({
        db: tdb.appDb, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToAssistant: deliver, recordDestination,
        resolveChannelOrigin: () => ({ channelType: "slack", threadKey: "slack:C1:1.2", messageTs: "1.2" }), endMatchedWaiter,
      }).pollOnce();
      expect(order).toEqual(["deliver", "end"]);
      expect(endMatchedWaiter).toHaveBeenCalledWith({ waiterId: "w-once", sessionId: "sess-inc", threadId: "thr-inc" });
      expect((await getDelivery(deliveryId)).status).toBe("delivered");
    });

    it("a failed delivery does not end the waiter, and a failed end does not fail the delivery", async () => {
      await seedMentionMember("team-x");
      await seedSession("sess-inc", "team", "team-x", "thr-inc");
      const endMatchedWaiter = vi.fn(async (): Promise<boolean> => { throw new Error("store down"); });
      const destination = { ...redirect, matchedWaiterId: "w-once" };
      const failing = await dispatchMention({ destination, endMatchedWaiter, deliver: async () => { throw new Error("transient"); } });
      expect((await getDelivery(failing.deliveryId)).status).toBe("failed");
      expect(endMatchedWaiter).not.toHaveBeenCalled();
      const { deliveryId } = await dispatchMention({
        destination, endMatchedWaiter, deliver: async () => ({ sessionId: "sess-inc", threadId: "thr-inc" }),
        payload: { type: "app_mention", channel: "C1", user: "U9", text: "<@U-BOT> again?", ts: "1.3" },
        origin: { channelType: "slack", threadKey: "slack:C1:1.3", messageTs: "1.3" },
      });
      expect(endMatchedWaiter).toHaveBeenCalledOnce();
      expect((await getDelivery(deliveryId)).status).toBe("delivered");
    });

    /** A `slack.message` reply in Slack thread 1.2 by `user`, stamped to the follow binding's thread. */
    async function dispatchFollowedReply(user: string, text: string, plugins: ValetPlugin[] = [],
      opts: { ts?: string; slackBotUserId?: EventDispatcherDeps["slackBotUserId"] } = {}) {
      const stamp = { kind: "target", sessionId: "sess-inc", threadId: "thr-inc", reason: "conversation_follow", suppressedWaiterIds: ["w-inc"] };
      const { deliveryId } = await seedDelivery({
        target: { kind: "assistant" }, ownerType: "team", ownerId: "team-x", service: "slack",
        eventKey: "slack.message", eventKeys: ["slack.message"], refs: { channel: "C1" }, summary: "Reply",
        payload: { type: "message", channel: "C1", user, text, ts: opts.ts ?? "1.700000", thread_ts: "1.2" }, actor: { externalId: user },
        destination: stamp,
      });
      const deliver = vi.fn<AssistantDeliverFn>(async () => ({ sessionId: "sess-inc", threadId: "thr-inc" }));
      await new EventDispatcher({
        db: tdb.appDb, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToAssistant: deliver, recordDestination,
        resolveChannelOrigin: () => ({ channelType: "slack", threadKey: "slack:C1:1.2", messageTs: "1.5" }),
        slackBotUserId: opts.slackBotUserId ?? (async () => "U-BOT"), plugins,
      }).pollOnce();
      return { deliver, deliveryId };
    }

    /** A follow binding to thr-inc. `lastSeenTs` is the router's cursor: by default the router passed the reply. */
    async function seedFollowToInc(lastSeenTs: string | null = "1.700000") {
      await seedMentionMember("team-x");
      await seedSession("sess-inc", "team", "team-x", "thr-inc");
      await upsertFollowedThread(tdb.appDb, {
        orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2",
        ownerType: "team", ownerId: "team-x", createdBy: "member-9", target: { sessionId: "sess-inc", threadId: "thr-inc" },
        ...(lastSeenTs !== null ? { lastSeenTs } : {}),
      });
    }

    it("skips a followed reply that the follow router delivered: one owner (C3b, follow_routed)", async () => {
      // The router delivered the reply and advanced its cursor to the reply's ts.
      await seedFollowToInc("1.700000");
      const { deliver, deliveryId } = await dispatchFollowedReply("U9", "on it");
      expect(deliver).not.toHaveBeenCalled();
      expect(await getDelivery(deliveryId)).toMatchObject({ status: "skipped", lastError: "Skipped, the followed thread delivers this reply." });
      expect(recordDestination.mock.calls).toEqual([["follow_routed"]]);
    });

    it("delivers a followed reply that came before the binding: the router dropped it (C3b, router-before-binding)", async () => {
      // The mention's delivery bound the thread after the router ran, so the
      // cursor is the mention's ts, before the reply.
      await seedFollowToInc("1.200000");
      const { deliver, deliveryId } = await dispatchFollowedReply("U9", "on it");
      expect(deliver).toHaveBeenCalledOnce();
      expect((await getDelivery(deliveryId)).status).toBe("delivered");
      expect(recordDestination.mock.calls).toEqual([["conversation_follow"]]);
    });

    it("delivers a followed reply when the binding has no router cursor", async () => {
      await seedFollowToInc(null);
      const { deliver, deliveryId } = await dispatchFollowedReply("U9", "on it");
      expect(deliver).toHaveBeenCalledOnce();
      expect((await getDelivery(deliveryId)).status).toBe("delivered");
    });

    it("treats a post that addresses a bot id resolved only from the token as a mention (C5)", async () => {
      // A legacy installation: the credential has no `botUserId` metadata, so
      // the id comes from auth.test, the same path the follow router's drain uses.
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        Response.json({ ok: true, team_id: "T-LEGACY", bot_id: "B-BOT", user_id: "U-BOT" }));
      try {
        const credentials = new PgCredentialStore(tdb.pgdb, deriveSecretKey("test-key"));
        await credentials.save({ type: "org", id: ORG }, "slack", { type: "bot_token", accessToken: "xoxb-legacy", metadata: { teamId: "T-LEGACY" } });
        const matchers = waiterMatchDeps({ db: tdb.appDb, engineStore: new PgSessionStore(tdb.pgdb), engineCredentials: credentials, plugins: [slackPlugin] });
        await seedFollowToInc("1.200000");
        const now = Date.now();
        await tdb.appDb.insert(eventSubscriptions).values({
          id: "rule-m", orgId: ORG, ownerType: "team", ownerId: "team-x", name: "Mentions", eventKeys: ["slack.app_mention"], filters: [],
          target: { kind: "assistant", follow: true }, enabled: true, createdBy: "member-9", createdAt: now, updatedAt: now,
        });
        const { deliver, deliveryId } = await dispatchFollowedReply("U9", "<@U-BOT> rollback ready?", [slackPlugin],
          { slackBotUserId: (orgId) => matchers.slackBotUserId(orgId) });
        expect(deliver).not.toHaveBeenCalled();
        expect(await getDelivery(deliveryId)).toMatchObject({ status: "skipped", lastError: "Skipped, the mention delivers this post." });
        expect(recordDestination.mock.calls).toEqual([["mention_covered"]]);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("skips the message half of a mention that a rule of the owner delivers (C5, mention_covered)", async () => {
      await seedFollowToInc();
      const now = Date.now();
      await tdb.appDb.insert(eventSubscriptions).values({
        id: "rule-m", orgId: ORG, ownerType: "team", ownerId: "team-x", name: "Mentions", eventKeys: ["slack.app_mention"], filters: [],
        target: { kind: "assistant", follow: true }, enabled: true, createdBy: "member-9", createdAt: now, updatedAt: now,
      });
      const { deliver, deliveryId } = await dispatchFollowedReply("U9", "<@U-BOT> rollback ready?", [slackPlugin]);
      expect(deliver).not.toHaveBeenCalled();
      expect(await getDelivery(deliveryId)).toMatchObject({ status: "skipped", lastError: "Skipped, the mention delivers this post." });
      expect(recordDestination.mock.calls).toEqual([["mention_covered"]]);
    });

    it("delivers the message half when no rule of the owner delivers the mention", async () => {
      await seedFollowToInc();
      const { deliver } = await dispatchFollowedReply("U9", "<@U-BOT> anyone?", [slackPlugin]);
      expect(deliver).toHaveBeenCalledOnce();
    });

    it("delivers a followed reply that the follow router refuses (C3, unlinked sender)", async () => {
      await seedFollowToInc();
      const { deliver, deliveryId } = await dispatchFollowedReply("U-unlinked", "replica caught up");
      expect(deliver).toHaveBeenCalledOnce();
      expect((await getDelivery(deliveryId)).status).toBe("delivered");
      expect(recordDestination.mock.calls).toEqual([["conversation_follow"]]);
    });

    it("a refused sender dead-letters before a target stamp runs", async () => {
      // No identity link for U9: the team mention gate refuses the sender.
      await tdb.appDb.insert(teams).values({ id: "team-x", orgId: ORG, name: "Team", createdAt: Date.now() });
      const { deliver, deliveryId } = await dispatchMention({ destination: redirect });
      expect(deliver).not.toHaveBeenCalled();
      expect((await getDelivery(deliveryId)).status).toBe("dead");
    });

    it("a stamped redirect whose thread was archived after ingest lands in the rule's own thread (Review Focus 5, INV-D6)", async () => {
      await seedMentionMember("team-x");
      await seedSession("sess-inc", "team", "team-x", "thr-inc");
      // The agent archives the claim thread after ingest stamped it.
      await tdb.appDb.insert(sessionThreads).values({ id: "thr-inc", sessionId: "sess-inc", createdAt: 1, archivedAt: Date.now() });
      const { deliveryId, eventId, subscriptionId } = await seedDelivery({
        target: { kind: "assistant", follow: true, thread: { mode: "own" } }, ownerType: "team", ownerId: "team-x", service: "slack",
        eventKey: "slack.app_mention", eventKeys: ["slack.app_mention"], refs: { channel: "C1", user: "U9" }, summary: "Mention",
        payload: { type: "app_mention", channel: "C1", user: "U9", text: "<@U-BOT> status?", ts: "1.2" }, actor: { externalId: "U9" },
        destination: { ...redirect, matchedWaiterId: "w-once" },
      });
      await tdb.appDb.insert(eventReceipts).values({
        id: "rcpt-claim", orgId: ORG, service: "slack", metadata: {}, stages: [], subscriptions: [], eventId, createdAt: 1, updatedAt: 1,
      });
      const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
      const endMatchedWaiter = vi.fn(async () => true);
      await new EventDispatcher({
        db: tdb.appDb, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToAssistant: deliver, recordDestination,
        resolveChannelOrigin: () => ({ channelType: "slack", threadKey: "slack:C1:1.2", messageTs: "1.2" }), endMatchedWaiter,
      }).pollOnce();
      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0]![0].destination).toEqual({ kind: "key", key: `sub:${subscriptionId}`, title: "test sub", reason: "policy_own" });
      expect((await getDelivery(deliveryId)).status).toBe("delivered");
      const [receipt] = await tdb.appDb.select().from(eventReceipts).where(eq(eventReceipts.eventId, eventId));
      expect(receipt?.stages).toEqual([expect.objectContaining({ stage: "destination", outcome: "claim_fallback" })]);
      expect(recordDestination.mock.calls).toEqual([["claim_fallback"]]);
      // The fallback is not the claimed waiter's match, so it does not end it.
      expect(endMatchedWaiter).not.toHaveBeenCalled();
      expect(await findFollowedThread(tdb.appDb, followKey)).toMatchObject({ sessionId: LANDED.sessionId, threadId: LANDED.threadId });
    });

    it("a stamped pull request binding still builds the inbound comment after the own-write and settle checks (C9)", async () => {
      await seedSession("sess-pr", "user", "user-1", "thr-pr");
      const url = "https://github.com/acme/app/pull/14";
      const postedAt = Date.now() - OWN_WRITE_SETTLE_MS - 1_000;
      const stamp = { kind: "target", sessionId: "sess-pr", threadId: "thr-pr", reason: "conversation_pull_request" };
      const comment = (id: number, at: number) => ({
        issue: { pull_request: { html_url: url } }, comment: { id, body: "Please rename it.", created_at: new Date(at).toISOString(), user: { login: "reviewer", type: "User" } },
      });
      const { deliveryId } = await seedDelivery({
        target: { kind: "assistant" }, eventKey: "github.issue_comment.created", eventKeys: ["github.issue_comment.*"],
        payload: comment(601, postedAt), destination: stamp,
      });
      // A fresh comment still waits for the own-write record, stamp or not.
      const fresh = await seedDelivery({
        target: { kind: "assistant" }, eventKey: "github.issue_comment.created", eventKeys: ["github.issue_comment.*"],
        payload: comment(602, Date.now()), destination: stamp,
      });
      const deliver = vi.fn<AssistantDeliverFn>(async () => ({ sessionId: "sess-pr", threadId: "thr-pr" }));
      await new EventDispatcher({
        db: tdb.appDb, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToAssistant: deliver, recordDestination,
      }).pollOnce();
      expect(deliver).toHaveBeenCalledOnce();
      const args = deliver.mock.calls[0]![0];
      expect(args.destination).toEqual(stamp);
      expect(args.inbound).toMatchObject({ providerMessageId: "601", text: "Please rename it." });
      expect((await getDelivery(deliveryId)).status).toBe("delivered");
      expect(await getDelivery(fresh.deliveryId)).toMatchObject({ status: "pending", attempts: 0 });
    });

    it("an unstamped row lands by policy and never by a waiter (Part C step 7, INV-D6)", async () => {
      await seedMentionMember("team-x");
      const { deliver, deliveryId } = await dispatchMention();
      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0]![0].destination).toEqual({
        kind: "key", key: expect.stringMatching(new RegExp(`:${deliveryId}$`)), title: "Mention", reason: "policy_new",
      });
      expect(await findFollowedThread(tdb.appDb, followKey)).toMatchObject({ sessionId: LANDED.sessionId, threadId: LANDED.threadId });
      expect(recordDestination.mock.calls).toEqual([["policy_new"]]);
    });

    it("a stamp of the wrong shape reads as no stamp and lands by policy", async () => {
      await seedMentionMember("team-x");
      const { deliver } = await dispatchMention({ destination: { kind: "target", sessionId: "sess-inc" } });
      expect(deliver.mock.calls[0]![0].destination).toMatchObject({ kind: "key", reason: "policy_new" });
    });

    it("a key stamp delivers by its key", async () => {
      await seedMentionMember("team-x");
      const stamp = { kind: "key", key: "subject:slack:T001/C1", title: "#incidents", reason: "policy_subject" };
      const { deliver } = await dispatchMention({ destination: stamp });
      expect(deliver.mock.calls[0]![0].destination).toEqual(stamp);
    });

    it("keeps a threaded mention in a Slack thread the same owner already follows (legacy follow, no stamp)", async () => {
      await seedMentionMember("team-x");
      await upsertFollowedThread(tdb.appDb, {
        orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.1",
        ownerType: "team", ownerId: "team-x", createdBy: "member-9",
      });
      const { deliver } = await dispatchMention({
        payload: { type: "app_mention", channel: "C1", user: "U9", text: "<@U-BOT> status?", ts: "1.2", thread_ts: "1.1" },
        origin: { channelType: "slack", threadKey: "slack:C1:1.1", messageTs: "1.2" },
      });
      expect(deliver.mock.calls[0]![0].destination).toMatchObject({ kind: "key", key: "slack:C1:1.1", reason: "conversation_follow" });
    });

    it("ignores a follow binding whose thread was archived and lets the policy decide", async () => {
      await seedMentionMember("team-x");
      await tdb.appDb.insert(agentSessions).values({ id: "sess-bound", orgId: ORG, userId: "member-9", ownerType: "team", ownerId: "team-x", workspace: "/workspace", createdAt: 1, updatedAt: 1 });
      await tdb.appDb.insert(sessionThreads).values({ id: "thr-bound", sessionId: "sess-bound", createdAt: 1, archivedAt: Date.now() });
      await upsertFollowedThread(tdb.appDb, {
        orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.1",
        ownerType: "team", ownerId: "team-x", createdBy: "member-9", target: { sessionId: "sess-bound", threadId: "thr-bound" },
      });
      const { deliver } = await dispatchMention({
        payload: { type: "app_mention", channel: "C1", user: "U9", text: "<@U-BOT> status?", ts: "1.2", thread_ts: "1.1" },
        origin: { channelType: "slack", threadKey: "slack:C1:1.1", messageTs: "1.2" },
      });
      expect(deliver.mock.calls[0]?.[0].destination).toMatchObject({ kind: "key", reason: "policy_new" });
      // The kept binding moves to the thread this mention landed in, so later replies resume.
      expect(await findFollowedThread(tdb.appDb, { ...followKey, threadTs: "1.1" }))
        .toMatchObject({ createdBy: "member-9", sessionId: LANDED.sessionId, threadId: LANDED.threadId });
    });

    it("a redirect skipped as team-covered after ingest gives its waiter the digest once (claim_recovered)", async () => {
      const db = tdb.appDb;
      const stamp = { ...redirect, matchedWaiterId: "w-once" };
      const { deliveryId } = await seedDelivery({
        target: { kind: "assistant", deliveryPolicy: "ignoreIfAnyTeamSubscribed" }, destination: stamp,
      });
      await db.insert(teams).values({ id: "coverage-team", orgId: ORG, name: "Coverage", createdAt: Date.now() });
      await db.insert(eventSubscriptions).values({
        id: "coverage-rule", orgId: ORG, ownerType: "team", ownerId: "coverage-team", name: "Team coverage",
        eventKeys: ["github.issues.*"], filters: [], target: { kind: "assistant", assistant: "team", teamId: "coverage-team" },
        enabled: true, createdBy: "user-1", createdAt: Date.now(), updatedAt: Date.now(),
      });
      const appended = new Set<string>();
      const recover = vi.fn(async (args: { waiterId: string; event: { dedupeKey: string } }) => {
        const key = `${args.waiterId}:${args.event.dedupeKey}`;
        if (appended.has(key)) return false;
        appended.add(key);
        return true;
      });
      const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
      const dispatcher = new EventDispatcher({
        db, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb),
        deliverToAssistant: deliver, plugins: [githubPlugin], recordDestination, recoverClaimedDigest: recover,
      });
      await dispatcher.pollOnce();
      expect(deliver).not.toHaveBeenCalled();
      expect((await getDelivery(deliveryId)).status).toBe("skipped");
      expect(recover).toHaveBeenCalledOnce();
      expect(recover.mock.calls[0]![0]).toMatchObject({ waiterId: "w-once", orgId: ORG, service: "github" });
      expect(recordDestination.mock.calls).toEqual([["claim_recovered"]]);
      // A skipped row never runs again, so the waiter gets the digest once.
      await db.update(eventDeliveries).set({ nextAttemptAt: Date.now() - 1 }).where(eq(eventDeliveries.id, deliveryId));
      await dispatcher.pollOnce();
      expect(recover).toHaveBeenCalledOnce();
      expect(appended.size).toBe(1);
    });

    it("a binding stamp skipped as team-covered gives its suppressed waiter the digest once, before the skipped write", async () => {
      const db = tdb.appDb;
      const stamp = { kind: "target", sessionId: "sess-inc", threadId: "thr-inc", reason: "conversation_follow", suppressedWaiterIds: ["w-stream"] };
      const { deliveryId } = await seedDelivery({ target: { kind: "assistant", deliveryPolicy: "ignoreIfAnyTeamSubscribed" }, destination: stamp });
      await db.insert(teams).values({ id: "coverage-team", orgId: ORG, name: "Coverage", createdAt: Date.now() });
      await db.insert(eventSubscriptions).values({
        id: "coverage-rule", orgId: ORG, ownerType: "team", ownerId: "coverage-team", name: "Team coverage",
        eventKeys: ["github.issues.*"], filters: [], target: { kind: "assistant", assistant: "team", teamId: "coverage-team" },
        enabled: true, createdBy: "user-1", createdAt: Date.now(), updatedAt: Date.now(),
      });
      const statusAtRecover: string[] = [];
      const recover = vi.fn(async () => {
        statusAtRecover.push((await getDelivery(deliveryId)).status);
        return true;
      });
      const endMatchedWaiter = vi.fn(async () => true);
      const dispatcher = new EventDispatcher({
        db, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToAssistant: vi.fn<AssistantDeliverFn>(async () => LANDED),
        plugins: [githubPlugin], recordDestination, recoverClaimedDigest: recover, endMatchedWaiter,
      });
      await dispatcher.pollOnce();
      // The recovery runs while the row is still pending, so a crash before
      // the skipped write retries the recovery instead of losing it.
      expect(statusAtRecover).toEqual(["pending"]);
      expect(recover).toHaveBeenCalledOnce();
      expect(recover.mock.calls[0]).toEqual([expect.objectContaining({ waiterId: "w-stream" })]);
      expect((await getDelivery(deliveryId)).status).toBe("skipped");
      expect(recordDestination.mock.calls).toEqual([["claim_recovered"]]);
      expect(endMatchedWaiter).not.toHaveBeenCalled();
    });

    it("a binding delivery never ends a waiter it suppressed", async () => {
      await seedMentionMember("team-x");
      await seedSession("sess-inc", "team", "team-x", "thr-inc");
      const endMatchedWaiter = vi.fn(async () => true);
      const { deliveryId } = await dispatchMention({
        destination: { kind: "target", sessionId: "sess-inc", threadId: "thr-inc", reason: "conversation_follow", suppressedWaiterIds: ["w-once"] },
        deliver: async () => ({ sessionId: "sess-inc", threadId: "thr-inc" }), endMatchedWaiter,
      });
      expect((await getDelivery(deliveryId)).status).toBe("delivered");
      expect(endMatchedWaiter).not.toHaveBeenCalled();
    });

    describe("terminal paths recover suppressed digests (INV-D6)", () => {
      const stamp = { ...redirect, matchedWaiterId: "w-inc" };

      function dispatcherWith(recover: EventDispatcherDeps["recoverClaimedDigest"], deliver: AssistantDeliverFn = async () => LANDED) {
        return new EventDispatcher({
          db: tdb.appDb, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToAssistant: vi.fn(deliver),
          recordDestination, recoverClaimedDigest: recover,
          resolveChannelOrigin: () => ({ channelType: "slack", threadKey: "slack:C1:1.2", messageTs: "1.2" }),
        });
      }

      function mentionDelivery() {
        return seedDelivery({
          target: { kind: "assistant", follow: true }, ownerType: "team", ownerId: "team-x", service: "slack",
          eventKey: "slack.app_mention", eventKeys: ["slack.app_mention"], refs: { channel: "C1", user: "U9" }, summary: "Mention",
          payload: { type: "app_mention", channel: "C1", user: "U9", text: "<@U-BOT> status?", ts: "1.2" }, actor: { externalId: "U9" },
          destination: stamp,
        });
      }

      it("a deleted rule", async () => {
        const { deliveryId, subscriptionId } = await mentionDelivery();
        await tdb.appDb.delete(eventSubscriptions).where(eq(eventSubscriptions.id, subscriptionId));
        const recover = vi.fn(async () => true);
        await dispatcherWith(recover).pollOnce();
        expect(await getDelivery(deliveryId)).toMatchObject({ status: "dead", lastError: "The event or its line was deleted. Nothing is left to send." });
        expect(recover).toHaveBeenCalledOnce();
        expect(recover.mock.calls[0]).toEqual([expect.objectContaining({ waiterId: "w-inc" })]);
      });

      it("a sender gate denial at dispatch", async () => {
        // No identity link for U9: the team mention gate refuses the sender.
        await tdb.appDb.insert(teams).values({ id: "team-x", orgId: ORG, name: "Team", createdAt: Date.now() });
        const { deliveryId } = await mentionDelivery();
        const recover = vi.fn(async () => true);
        await dispatcherWith(recover).pollOnce();
        expect((await getDelivery(deliveryId)).status).toBe("dead");
        expect(recover).toHaveBeenCalledOnce();
      });

      it("the last failed attempt, and not an earlier one", async () => {
        await seedMentionMember("team-x");
        await seedSession("sess-inc", "team", "team-x", "thr-inc");
        const { deliveryId } = await mentionDelivery();
        const recover = vi.fn(async () => true);
        const failing = async (): Promise<never> => { throw new Error("transient"); };
        await dispatcherWith(recover, failing).pollOnce();
        expect((await getDelivery(deliveryId)).status).toBe("failed");
        expect(recover).not.toHaveBeenCalled();
        await tdb.appDb.update(eventDeliveries).set({ attempts: 4, nextAttemptAt: Date.now() - 1 }).where(eq(eventDeliveries.id, deliveryId));
        await dispatcherWith(recover, failing).pollOnce();
        expect((await getDelivery(deliveryId)).status).toBe("dead");
        expect(recover).toHaveBeenCalledOnce();
      });
    });

    it("a skip for a reason decided after ingest recovers nothing without a matched waiter", async () => {
      const { deliveryId } = await seedDelivery({ target: { kind: "assistant" }, destination: redirect });
      await tdb.appDb.update(eventSubscriptions).set({ enabled: false });
      const recover = vi.fn(async () => true);
      await new EventDispatcher({
        db: tdb.appDb, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb),
        deliverToAssistant: vi.fn<AssistantDeliverFn>(async () => LANDED), recordDestination, recoverClaimedDigest: recover,
      }).pollOnce();
      expect(await getDelivery(deliveryId)).toMatchObject({ status: "skipped", lastError: "This line is off. Turn it on to receive these events." });
      expect(recover).not.toHaveBeenCalled();
      expect(recordDestination).not.toHaveBeenCalled();
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
    const { deliveryId } = await seedDelivery({ target: { kind: "assistant" } });
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
      target: { kind: "assistant" },
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
        const { deliveryId } = await seedDelivery({ target: { kind: "assistant" } });
        await dispatcher.pollOnce();
        expect((await getDelivery(deliveryId)).status).toBe("delivered");
      }
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(ingress).toHaveBeenCalledTimes(1);
    } finally { release(); await dispatcher.stop(); }
  });

  it("claimed rows are skipped by a concurrent pollOnce", async () => {
    const { deliveryId } = await seedDelivery({ target: { kind: "assistant" } });
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
        deliverToAssistant: deliver, plugins: [githubPlugin], recordDestination,
      });
    }

    it("own: keys on the rule and titles the thread by the rule name", async () => {
      const { subscriptionId } = await seedDelivery({ target: { kind: "assistant", thread: { mode: "own" } } });
      const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
      await dispatcherWith(deliver).pollOnce();
      expect(deliver.mock.calls[0]?.[0].destination).toEqual({ kind: "key", key: `sub:${subscriptionId}`, title: "test sub", reason: "policy_own" });
    });

    it("new: keys on the delivery id, so a retry reuses the same key", async () => {
      const { subscriptionId, deliveryId } = await seedDelivery({ target: { kind: "assistant", thread: { mode: "new" } } });
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
      const { eventId, subscriptionId } = await seedDelivery({ target: { kind: "assistant", thread: { mode: "subject" } }, subjects: PR_SUBJECTS });
      const secondSub = randomUUID();
      const now = Date.now();
      await tdb.appDb.insert(eventSubscriptions).values({
        id: secondSub, orgId: ORG, ownerType: "user", ownerId: "user-1", name: "second rule", eventKeys: ["github.issues.*"],
        filters: [], target: { kind: "assistant", thread: { mode: "subject" } }, enabled: true, createdBy: "user-1", createdAt: now, updatedAt: now,
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
      const { deliveryId } = await seedDelivery({ target: { kind: "assistant", thread: pin } });
      const deliver = vi.fn<AssistantDeliverFn>(async () => { throw new PinUnavailableError(); });
      recordDestination.mockClear();
      await dispatcherWith(deliver).pollOnce();
      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0]?.[0].destination).toEqual({ kind: "target", sessionId: "sess-pin", threadId: "thr-pin", reason: "policy_existing" });
      expect(await getDelivery(deliveryId)).toMatchObject({ status: "dead", attempts: 1, lastError: "Pick another thread in Presence." });
      expect(recordDestination.mock.calls).toEqual([["pin_unavailable"]]);
    });

    it("existing: a delivery that would narrow a shared pin dead-letters with its own text", async () => {
      const pin = { mode: "existing", sessionId: "sess-pin", threadId: "thr-pin" };
      const { deliveryId } = await seedDelivery({ target: { kind: "orchestrator", thread: pin } });
      const text = pinNarrowsMessage("CPRIV");
      const deliver = vi.fn<AssistantDeliverFn>(async () => { throw new PinUnavailableError(text); });
      recordDestination.mockClear();
      await dispatcherWith(deliver).pollOnce();
      expect(await getDelivery(deliveryId)).toMatchObject({
        status: "dead", attempts: 1, lastError: "This thread is shared with people who cannot see #CPRIV. Pick another thread in Presence.",
      });
      expect(recordDestination.mock.calls).toEqual([["pin_unavailable"]]);
    });

    it("records the destination stage on the event's receipt and counts the reason", async () => {
      const { eventId, subscriptionId, deliveryId } = await seedDelivery({ target: { kind: "assistant" } });
      await tdb.appDb.insert(eventReceipts).values({
        id: "rcpt-1", orgId: ORG, service: "github", metadata: {}, stages: [], subscriptions: [], eventId, createdAt: 1, updatedAt: 1,
      });
      recordDestination.mockClear();
      await dispatcherWith(vi.fn<AssistantDeliverFn>(async () => LANDED)).pollOnce();
      const [receipt] = await tdb.appDb.select().from(eventReceipts).where(eq(eventReceipts.id, "rcpt-1"));
      expect(receipt?.stages).toEqual([expect.objectContaining({
        stage: "destination", outcome: "policy_own",
        detail: `Line ${subscriptionId}, handoff ${deliveryId}: thread key sub:${subscriptionId}.`,
      })]);
      expect(recordDestination.mock.calls).toEqual([["policy_own"]]);
    });

    it("defaults an absent policy per delivery: new with a channel origin, never a shared thread for channel content", async () => {
      // A mention rule that does not follow still opens a thread per Slack conversation.
      const mention = await seedDelivery({
        target: { kind: "assistant" }, service: "slack", eventKey: "slack.app_mention", eventKeys: ["slack.app_mention"],
        payload: { type: "app_mention", channel: "C1", user: "U9", text: "hi", ts: "1.2" },
      });
      // A follow rule's Slack event with no channel origin and no subject gets
      // its own thread, so it never mixes with another channel's content.
      const reaction = await seedDelivery({
        target: { kind: "assistant", follow: true }, service: "slack", eventKey: "slack.reaction_added", eventKeys: ["slack.reaction_added"],
        payload: { type: "reaction_added", item: { channel: "C1", ts: "1.2" }, user: "U9", reaction: "eyes" },
      });
      const deliver = vi.fn<AssistantDeliverFn>(async () => LANDED);
      await new EventDispatcher({
        db: tdb.appDb, workflowRunHost: fakeRunHost(), workflowStore: new PgWorkflowStore(tdb.pgdb), deliverToAssistant: deliver,
        resolveChannelOrigin: (_service, eventKey) => eventKey === "slack.app_mention" ? { channelType: "slack", threadKey: "slack:C1:1.2", messageTs: "1.2" } : null,
      }).pollOnce();
      const byDispatch = new Map(deliver.mock.calls.map(([args]) => [args.dispatchId, args.destination]));
      expect(byDispatch.get(`event:${mention.deliveryId}`)).toMatchObject({ kind: "key", key: `sub:${mention.subscriptionId}:${mention.deliveryId}`, reason: "policy_new" });
      expect(byDispatch.get(`event:${reaction.deliveryId}`)).toMatchObject({ kind: "key", key: `sub:${reaction.subscriptionId}:${reaction.deliveryId}`, reason: "policy_new" });
    });

    it("records the destination stage and the counter once when a retry recovers an admitted dispatch (M6)", async () => {
      const { eventId, deliveryId } = await seedDelivery({ target: { kind: "assistant" } });
      await tdb.appDb.insert(eventReceipts).values({
        id: "rcpt-retry", orgId: ORG, service: "github", metadata: {}, stages: [], subscriptions: [], eventId, createdAt: 1, updatedAt: 1,
      });
      recordDestination.mockClear();
      await dispatcherWith(vi.fn<AssistantDeliverFn>(async () => LANDED)).pollOnce();
      // The status write was lost: the delivery runs again and recovers its admission.
      await tdb.appDb.update(eventDeliveries).set({ status: "pending", nextAttemptAt: Date.now() - 1 }).where(eq(eventDeliveries.id, deliveryId));
      await dispatcherWith(vi.fn<AssistantDeliverFn>(async () => ({ ...LANDED, recovered: true }))).pollOnce();
      const [receipt] = await tdb.appDb.select().from(eventReceipts).where(eq(eventReceipts.id, "rcpt-retry"));
      expect(receipt?.stages).toHaveLength(1);
      expect(recordDestination.mock.calls).toEqual([["policy_own"]]);
    });

    it("does not count a recovered retry again when the event has no receipt", async () => {
      const { deliveryId } = await seedDelivery({ target: { kind: "assistant" } });
      recordDestination.mockClear();
      await dispatcherWith(vi.fn<AssistantDeliverFn>(async () => LANDED)).pollOnce();
      await tdb.appDb.update(eventDeliveries).set({ status: "pending", nextAttemptAt: Date.now() - 1 }).where(eq(eventDeliveries.id, deliveryId));
      await dispatcherWith(vi.fn<AssistantDeliverFn>(async () => ({ ...LANDED, recovered: true }))).pollOnce();
      expect(recordDestination.mock.calls).toEqual([["policy_own"]]);
    });

    it("a skip marks the delivery skipped and creates no thread (INV-D3)", async () => {
      const { eventId, subscriptionId, deliveryId } = await seedDelivery({ target: { kind: "assistant" } });
      recordDestination.mockClear();
      await recordSkippedDelivery(tdb.appDb, {
        deliveryId, subscriptionId, attempts: 0, orgId: ORG, eventId, destination: { kind: "skip", reason: "claimed by thread thr-w" },
      }, recordDestination);
      expect(await getDelivery(deliveryId)).toMatchObject({ status: "skipped", attempts: 1, lastError: "Skipped, claimed by thread thr-w." });
      expect(recordDestination.mock.calls).toEqual([["claim_skip"]]);
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
      target: { kind: "assistant" },
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
    // A Slack channel event with no reply origin keeps one thread per channel,
    // or its own thread when no subject names the channel.
    expect(deliveryThreadPolicy({}, { channelOrigin: false, slackChannel: true, naturalSubject: true })).toEqual({ mode: "subject" });
    expect(deliveryThreadPolicy({}, { channelOrigin: false, slackChannel: true, naturalSubject: false })).toEqual({ mode: "new" });
    expect(deliveryThreadPolicy({}, { channelOrigin: true, slackChannel: true, naturalSubject: true })).toEqual({ mode: "new" });
    expect(deliveryThreadPolicy({ thread: { mode: "own" } }, { channelOrigin: false, slackChannel: true, naturalSubject: true })).toEqual({ mode: "own" });
    // A stored policy wins over the default.
    expect(deliveryThreadPolicy({ thread: { mode: "own" } }, { channelOrigin: true })).toEqual({ mode: "own" });
    expect(deliveryThreadPolicy({ thread: { mode: "new" } }, { channelOrigin: false })).toEqual({ mode: "new" });
  });
});
