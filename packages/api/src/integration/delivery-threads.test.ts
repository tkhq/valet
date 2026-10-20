/**
 * Scenario T of the delivery threads spec
 * (`docs/specs/2026-10-16-delivery-threads-and-claims-design.md`,
 * "Acceptance scenarios"): steps T1 to T11 in one run, from a clean
 * database.
 *
 * What runs for real: the api app (`bootTestApi`), the REST routes that
 * create and patch rules, schedules, and threads, signed webhooks into the
 * GitHub App, Slack Events, and Linear ingest routes, the event dispatcher,
 * the workflow scheduler, and the assistant delivery path into Postgres.
 * What is stubbed: the model (a faux provider that answers "noted"), the
 * GitHub API (`startGithubFixture`), and the Slack and Linear APIs (a
 * `fetch` stub for `slack.com` and `api.linear.app`).
 *
 * Universe mapping: org `acme` is the harness org `local-org`, user `u-001`
 * is `local-user`, and "another user" in T11 is `test-member`.
 *
 * Two mappings to the catalog: the review rule names the catalog key
 * `github.pull_request_review.submitted`, and the catalog has no conclusion
 * filter for `github.check_run.completed`, so R4 filters on the repository
 * and the step sends only failures.
 */
import { createHmac, generateKeyPairSync } from "node:crypto";
import { fauxAssistantMessage, registerFauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/compat";
import githubPlugin from "@valet/plugin-github/plugin";
import linearPlugin from "@valet/plugin-linear/plugin";
import slackPlugin from "@valet/plugin-slack/plugin";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linkIdentity } from "../channels/identity-links.js";
import { __resetSlackWebhookThrottle } from "../channels/slack-inbox.js";
import { summaryTitle } from "../events/destination.js";
import { findFollowedThread } from "../events/followed-threads.js";
import {
  eventDeliveries,
  eventSubscriptions,
  events,
  githubInstallations,
  linearInstallations,
  slackChannelPrivacy,
  slackWebhookInbox,
  workflowSchedules,
} from "../schema/index.js";
import { saveAppConfig, type GithubAppConfig } from "../services/github-app.js";
import { addMember, createTeam } from "../services/teams.js";
import { storedThreadRef, threadVisibility } from "../services/thread-access.js";
import { startGithubFixture, type GithubFixtureResponse } from "../test-helpers/github-fixture.js";
import type {
  CreateEventSubscriptionResponse,
  CreateThreadResponse,
  GetEventResponse,
  WorkflowScheduleResponse,
} from "../wire/types.js";
import { bootTestApi, type TestApi } from "./_setup.js";

const ORG = "local-org";
const USER = "local-user";
const OTHER_USER = "test-member";

const PIN_UNAVAILABLE = "Pick another thread for this rule in Presence.";
const CROSS_OWNER = "This thread belongs to another owner. Pick a thread in your workspace.";

// GitHub universe.
const APP_ID = "9001";
const APP_SLUG = "valet-app";
const INSTALLATION = 77;
const REPO = "acme/api";
const HEAD_SHA = "cccc000000000000000000000000000000000001";
const GITHUB_WEBHOOK_SECRET = "gh-webhook-secret";
const { privateKey: APP_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const APP_CONFIG: GithubAppConfig = {
  appId: APP_ID,
  appSlug: APP_SLUG,
  oauthClientId: "Iv1.acme",
  htmlUrl: `https://github.com/apps/${APP_SLUG}`,
  oauthClientSecret: "client-secret",
  webhookSecret: GITHUB_WEBHOOK_SECRET,
  privateKeyPem: APP_PEM,
};

// Slack universe.
const SLACK_TEAM = "T001";
const SLACK_SECRET = "slack-signing-secret";
const BOT_TOKEN = "xoxb-acme-bot";
const BOT_ID = "B9";
const BOT_USER = "U-BOT";

// Linear universe.
const LINEAR_WORKSPACE = "lin-org-acme";
const LINEAR_SECRET = "linear-webhook-secret";
const LINEAR_APP_TOKEN = "lin-app-token";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const rows = asRecord(result)?.rows;
  if (!Array.isArray(rows)) throw new Error("db.execute returned no rows array");
  return rows.map((row) => asRecord(row) ?? {});
}

async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (ok(value)) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ── Provider stubs ──────────────────────────────────────────────────────

async function paramsOf(request: Request): Promise<Record<string, string>> {
  const params: Record<string, string> = Object.fromEntries(new URL(request.url).searchParams);
  if (request.method !== "POST") return params;
  const text = await request.text();
  if (!text) return params;
  if ((request.headers.get("content-type") ?? "").includes("json")) {
    for (const [k, v] of Object.entries(asRecord(JSON.parse(text)) ?? {})) params[k] = typeof v === "string" ? v : JSON.stringify(v);
  } else {
    for (const [k, v] of new URLSearchParams(text)) params[k] = v;
  }
  return params;
}

function slackAnswer(method: string, params: Record<string, string>, bot: boolean): unknown {
  switch (method) {
    case "auth.test":
      return { ok: true, team_id: SLACK_TEAM, user_id: bot ? BOT_USER : "U001", bot_id: bot ? BOT_ID : undefined };
    case "conversations.info":
      return params.channel === "C900"
        ? { ok: true, channel: { id: "C900", name: "incidents", is_private: false, is_member: bot } }
        : { ok: false, error: "channel_not_found" };
    case "chat.postMessage":
      return { ok: true, channel: params.channel, ts: "1712399999.000100" };
    case "users.info":
      return { ok: true, user: { id: params.user, name: params.user, real_name: params.user, profile: {} } };
    default:
      return { ok: true };
  }
}

function linearAnswer(query: string): unknown {
  if (query.includes("viewer")) return { data: { viewer: { id: "app-1" } } };
  if (query.includes("teams(")) return { data: { teams: { nodes: [{ id: "team-eng" }] } } };
  return { data: {} };
}

/** Routes `slack.com` and `api.linear.app` to the stub; everything else reaches the network as usual. */
function stubProviders(): void {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "slack.com") {
      const bot = request.headers.get("authorization") === `Bearer ${BOT_TOKEN}`;
      return Response.json(slackAnswer(url.pathname.replace(/^\/api\//, ""), await paramsOf(request), bot));
    }
    if (url.hostname === "api.linear.app") {
      const body = asRecord(await request.json()) ?? {};
      return Response.json(linearAnswer(typeof body.query === "string" ? body.query : ""));
    }
    return realFetch(input, init);
  });
}

// ── Universe ────────────────────────────────────────────────────────────

let cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function bootUniverse(): Promise<TestApi> {
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key");
  vi.stubEnv("VALET_PUBLIC_URL", "https://valet.acme.test");
  __resetSlackWebhookThrottle();
  const notFound: GithubFixtureResponse = { status: 404, body: { message: "Not Found" } };
  const github = startGithubFixture({
    getApp: () => ({ body: { id: Number(APP_ID), slug: APP_SLUG, owner: { login: "acme", id: 5000, type: "Organization" } } }),
    createInstallationToken: (id) => ({ body: { token: `inst-${id}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() } }),
    getUser: () => ({ body: { login: "ada", id: 1001 } }),
    getUserByLogin: (login) => (login === `${APP_SLUG}[bot]` ? { body: { login, id: Number(APP_ID), type: "Bot" } } : notFound),
  });
  cleanups.push(() => github.close());
  vi.stubEnv("GITHUB_API_URL", github.url);
  stubProviders();
  // Every turn a delivery starts gets a short reply; no step reads it.
  const faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
  const reply: FauxResponseFactory = () => fauxAssistantMessage("noted");
  faux.setResponses(Array.from({ length: 200 }, () => reply));
  cleanups.push(() => faux.unregister());

  const api = await bootTestApi({ plugins: [githubPlugin, slackPlugin, linearPlugin], githubApiUrl: github.url });
  cleanups.push(() => api.cleanup());
  const p = api.providers;
  const now = Date.now();

  await saveAppConfig({ credentials: p.engineCredentials }, ORG, APP_CONFIG);
  await p.db.insert(githubInstallations).values({
    id: `ghi_${INSTALLATION}`, orgId: ORG, installationId: INSTALLATION, accountLogin: "acme", accountType: "Organization",
    repositorySelection: "selected", suspended: false, cachedToken: null, cachedTokenExpiresAt: null, createdAt: now, updatedAt: now,
  });
  await p.engineCredentials.save({ type: "user", id: USER }, "github", { type: "oauth2", accessToken: "gho-ada", metadata: { login: "ada" } });

  await p.engineCredentials.save({ type: "org", id: ORG }, "slack", {
    type: "bot_token", accessToken: BOT_TOKEN,
    metadata: { webhookSecret: SLACK_SECRET, teamId: SLACK_TEAM, botUserId: BOT_USER, botId: BOT_ID },
  });
  await p.engineCredentials.save({ type: "user", id: USER }, "slack", { type: "oauth2", accessToken: "xoxp-u001" });
  await p.channelHost.start();

  await p.engineCredentials.save({ type: "org", id: ORG }, "linear", {
    type: "oauth2", accessToken: LINEAR_APP_TOKEN, metadata: { webhookSecret: LINEAR_SECRET, grant: "client_credentials" },
  });
  await p.db.insert(linearInstallations).values({
    id: "li_acme", orgId: ORG, workspaceId: LINEAR_WORKSPACE, workspaceName: "Acme", connectedBy: USER, createdAt: now, updatedAt: now,
  });

  await linkIdentity(p.db, { provider: "github", externalId: "1001", userId: USER });
  await linkIdentity(p.db, { provider: "slack", externalId: "U001", userId: USER });
  await linkIdentity(p.db, { provider: "linear", externalId: "lin-u1", userId: USER });
  return api;
}

// ── REST helpers ────────────────────────────────────────────────────────

async function call(api: TestApi, method: string, path: string, body?: unknown, asUser?: string): Promise<Response> {
  return fetch(`${api.baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(asUser ? { "x-valet-test-user-id": asUser } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function createRule(api: TestApi, body: Record<string, unknown>): Promise<string> {
  const res = await call(api, "POST", "/api/event-subscriptions", { ...body, allowCollision: true });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as CreateEventSubscriptionResponse).id;
}

async function patchRule(api: TestApi, id: string, body: Record<string, unknown>): Promise<Response> {
  return call(api, "PATCH", `/api/event-subscriptions/${id}`, body);
}

async function createThread(api: TestApi, title: string, asUser?: string): Promise<{ sessionId: string; threadId: string }> {
  const res = await call(api, "POST", "/api/threads", { title }, asUser);
  expect(res.status, await res.clone().text()).toBe(201);
  const thread = (await res.json()) as CreateThreadResponse;
  return { sessionId: thread.sessionId, threadId: thread.id };
}

async function archiveThread(api: TestApi, threadId: string): Promise<void> {
  const res = await call(api, "PATCH", `/api/threads/${threadId}`, { archived: true });
  expect(res.status, await res.clone().text()).toBe(200);
}

// ── Database reads ──────────────────────────────────────────────────────

interface ThreadRow {
  id: string;
  sessionId: string;
  key: string;
  title: string | null;
  archivedAt: number | null;
}

function toThreadRow(row: Record<string, unknown>): ThreadRow {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    key: String(row.key),
    title: typeof row.title === "string" ? row.title : null,
    archivedAt: row.archived_at === null || row.archived_at === undefined ? null : Number(row.archived_at),
  };
}

/** Every engine thread whose key matches `pattern` (SQL LIKE), with its title and archive state. */
async function threadsLike(api: TestApi, pattern: string): Promise<ThreadRow[]> {
  const rows = rowsOf(await api.providers.db.execute(sql`
    SELECT t.id, t.session_id, t.key, st.title, st.archived_at
    FROM engine_threads t LEFT JOIN session_threads st ON st.id = t.id AND st.session_id = t.session_id
    WHERE t.key LIKE ${pattern} ORDER BY t.created_at`));
  return rows.map(toThreadRow);
}

async function threadById(api: TestApi, threadId: string): Promise<ThreadRow> {
  const rows = rowsOf(await api.providers.db.execute(sql`
    SELECT t.id, t.session_id, t.key, st.title, st.archived_at
    FROM engine_threads t LEFT JOIN session_threads st ON st.id = t.id AND st.session_id = t.session_id
    WHERE t.id = ${threadId}`));
  if (!rows[0]) throw new Error(`no thread ${threadId}`);
  return toThreadRow(rows[0]);
}

async function threadCount(api: TestApi): Promise<number> {
  const rows = rowsOf(await api.providers.db.execute(sql`SELECT count(*)::int AS n FROM engine_threads`));
  return Number(rows[0]?.n ?? -1);
}

/** The thread each admitted submission with `dispatchId` landed in. */
async function landings(api: TestApi, dispatchId: string): Promise<Array<{ sessionId: string; threadId: string }>> {
  const rows = rowsOf(await api.providers.db.execute(
    sql`SELECT session_id, thread_id FROM engine_queue_items WHERE dispatch_id = ${dispatchId} ORDER BY created_at`,
  ));
  return rows.map((row) => ({ sessionId: String(row.session_id), threadId: String(row.thread_id) }));
}

type DeliveryRow = typeof eventDeliveries.$inferSelect;

async function deliveriesOf(api: TestApi, subscriptionId: string): Promise<DeliveryRow[]> {
  return api.providers.db.select().from(eventDeliveries)
    .where(eq(eventDeliveries.subscriptionId, subscriptionId)).orderBy(eventDeliveries.createdAt);
}

const SETTLED = new Set(["delivered", "dead", "skipped"]);

/** Drives the dispatcher until `subscriptionId` holds `count` settled deliveries, then returns them. */
async function settled(api: TestApi, subscriptionId: string, count: number): Promise<DeliveryRow[]> {
  return poll(async () => {
    await api.providers.eventDispatcher.pollOnce();
    return deliveriesOf(api, subscriptionId);
  }, (rows) => rows.length >= count && rows.every((r) => SETTLED.has(r.status)), `${count} settled deliveries of ${subscriptionId}`);
}

/** The thread one delivered assistant delivery landed in. */
async function landingOf(api: TestApi, delivery: DeliveryRow | undefined): Promise<ThreadRow> {
  if (!delivery) throw new Error("no delivery");
  expect(delivery.status).toBe("delivered");
  const landed = await landings(api, `event:${delivery.id}`);
  expect(landed).toHaveLength(1);
  return threadById(api, landed[0]?.threadId ?? "");
}

// ── Webhooks ────────────────────────────────────────────────────────────

let githubSeq = 0;

async function postGithub(api: TestApi, event: string, payload: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify({
    ...payload,
    repository: { full_name: REPO, name: "api", owner: { login: "acme" } },
    installation: { id: INSTALLATION },
  });
  const signature = `sha256=${createHmac("sha256", GITHUB_WEBHOOK_SECRET).update(body).digest("hex")}`;
  const res = await fetch(`${api.baseUrl}/webhooks/github-app`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "x-github-event": event, "x-github-delivery": `gh-t-${++githubSeq}`, "x-hub-signature-256": signature,
    },
    body,
  });
  expect(res.status).toBeLessThan(300);
}

function review(pr: number): Record<string, unknown> {
  return {
    action: "submitted",
    review: { id: 5000 + ++githubSeq, state: "approved", body: "Looks good", user: { login: "grace", id: 1002, type: "User" }, submitted_at: new Date().toISOString() },
    pull_request: { number: pr, html_url: `https://github.com/${REPO}/pull/${pr}`, head: { sha: HEAD_SHA }, user: { login: "ada", id: 1001 } },
    sender: { id: 1002, login: "grace", type: "User" },
  };
}

function checkRun(name: string, conclusion: string, prs: number[]): Record<string, unknown> {
  const id = 7000 + ++githubSeq;
  return {
    action: "completed",
    check_run: {
      id, name, status: "completed", conclusion, head_sha: HEAD_SHA,
      html_url: `https://github.com/${REPO}/runs/${id}`,
      pull_requests: prs.map((number) => ({ number, head: { sha: HEAD_SHA } })),
      completed_at: new Date().toISOString(),
    },
    sender: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
  };
}

let slackSeq = 0;
let slackTs = 1712345700;

async function postSlack(api: TestApi, event: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify({
    token: "ignored", api_app_id: "A001", type: "event_callback", team_id: SLACK_TEAM,
    event_id: `EvT${++slackSeq}`, event_time: Math.floor(Date.now() / 1000), event,
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", SLACK_SECRET).update(`v0:${timestamp}:${body}`).digest("hex");
  const res = await fetch(`${api.baseUrl}/api/channels/slack/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-slack-signature": `v0=${digest}`, "x-slack-request-timestamp": String(timestamp) },
    body,
  });
  expect(res.status).toBe(200);
  await poll(() => api.providers.db.select().from(slackWebhookInbox), (rows) => rows.length === 0, "the Slack inbox to drain");
}

let linearSeq = 0;

async function postLinearUpdate(api: TestApi, identifier: string): Promise<void> {
  const body = JSON.stringify({
    action: "update",
    type: "Issue",
    url: `https://linear.app/acme/issue/${identifier}`,
    data: { id: `iss-${identifier}`, identifier, title: `Ticket ${identifier}`, team: { key: "ENG" }, state: { id: "st-started", type: "started", name: "In Progress" } },
    actor: { id: "lin-u2", type: "user", name: "Grace" },
    updatedFrom: { stateId: "st-backlog" },
    organizationId: LINEAR_WORKSPACE, webhookTimestamp: Date.now(), webhookId: "wh-acme", createdAt: new Date().toISOString(),
  });
  const res = await fetch(`${api.baseUrl}/plugins/linear/http/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Linear-Signature": createHmac("sha256", LINEAR_SECRET).update(body).digest("hex"),
      "Linear-Delivery": `lin-t-${++linearSeq}`,
    },
    body,
  });
  expect(res.status).toBe(200);
}

// ── The scenario ────────────────────────────────────────────────────────

describe("api integration: delivery threads acceptance scenario", () => {
  it("Scenario T: thread policies", async () => {
    const api = await bootUniverse();
    const p = api.providers;
    const repoFilter = { field: "repo", op: "eq", value: REPO };

    // T1: R1 groups reviews and check runs by pull request. A review on #12
    // opens the subject thread.
    const r1 = await createRule(api, {
      name: "acme/api reviews and checks",
      eventKeys: ["github.pull_request_review.submitted", "github.check_run.completed"],
      filters: [repoFilter],
      target: { kind: "orchestrator", thread: { mode: "subject" } },
    });
    await postGithub(api, "pull_request_review", review(12));
    const t1 = await settled(api, r1, 1);
    const pr12 = await landingOf(api, t1[0]);
    expect(pr12).toMatchObject({ key: "subject:github:acme/api#12", title: "acme/api#12" });
    expect(await threadsLike(api, "subject:%")).toHaveLength(1);
    // The delivery list names the thread (Part E step 2).
    const t1Event = (await (await call(api, "GET", `/api/events/${t1[0]?.eventId}`)).json()) as GetEventResponse;
    expect(t1Event.deliveries.find((d) => d.id === t1[0]?.id)?.thread).toEqual({ sessionId: pr12.sessionId, threadId: pr12.id });

    // T2: a check run completes on #12. The same thread holds it.
    await postGithub(api, "check_run", checkRun("test", "success", [12]));
    const t2 = await settled(api, r1, 2);
    expect((await landingOf(api, t2[1])).id).toBe(pr12.id);
    expect(await threadsLike(api, "subject:%")).toHaveLength(1);

    // T3: a review on #13 opens a second subject thread.
    await postGithub(api, "pull_request_review", review(13));
    const t3 = await settled(api, r1, 3);
    const pr13 = await landingOf(api, t3[2]);
    expect(pr13).toMatchObject({ key: "subject:github:acme/api#13", title: "acme/api#13" });
    expect(pr13.id).not.toBe(pr12.id);
    expect(await threadsLike(api, "subject:%")).toHaveLength(2);

    // T4: R3 keeps its own thread. Updates on ENG-42 and ENG-43 share it.
    const r3 = await createRule(api, {
      name: "ENG triage",
      eventKeys: ["linear.issue.update"],
      filters: [{ field: "team", op: "eq", value: "ENG" }],
      target: { kind: "orchestrator", thread: { mode: "own" } },
    });
    await postLinearUpdate(api, "ENG-42");
    await postLinearUpdate(api, "ENG-43");
    const t4 = await settled(api, r3, 2);
    const triage = await landingOf(api, t4[0]);
    expect(triage).toMatchObject({ key: `sub:${r3}`, title: "ENG triage" });
    expect((await landingOf(api, t4[1])).id).toBe(triage.id);
    expect(await threadsLike(api, `sub:${r3}%`)).toHaveLength(1);

    // T5: R4 opens a thread per failure. A retry of the second delivery
    // lands in the second thread and opens no third (INV-D4).
    const r4 = await createRule(api, {
      name: "acme/api failures",
      eventKeys: ["github.check_run.completed"],
      filters: [repoFilter],
      target: { kind: "orchestrator", thread: { mode: "new" } },
    });
    await postGithub(api, "check_run", checkRun("lint", "failure", []));
    await postGithub(api, "check_run", checkRun("build", "failure", []));
    const t5 = await settled(api, r4, 2);
    const failureThreads = await threadsLike(api, `sub:${r4}:%`);
    expect(failureThreads).toHaveLength(2);
    for (const [i, delivery] of t5.entries()) {
      const landed = await landingOf(api, delivery);
      expect(landed.key).toBe(`sub:${r4}:${delivery.id}`);
      const [event] = await p.db.select().from(events).where(eq(events.id, delivery.eventId));
      expect(landed.title).toBe(summaryTitle(event?.summary ?? ""));
      expect(landed.id).toBe(failureThreads.find((t) => t.key === `sub:${r4}:${t5[i]?.id}`)?.id);
    }
    const second = t5[1];
    if (!second) throw new Error("no second failure delivery");
    const secondThread = await landingOf(api, second);
    await p.db.update(eventDeliveries).set({ status: "failed", nextAttemptAt: 0 }).where(eq(eventDeliveries.id, second.id));
    const retried = await poll(async () => {
      await p.eventDispatcher.pollOnce();
      return (await deliveriesOf(api, r4)).find((d) => d.id === second.id);
    }, (row) => row?.status === "delivered", "the retried delivery");
    expect(retried?.attempts).toBe(second.attempts + 1);
    expect((await landingOf(api, retried)).id).toBe(secondThread.id);
    expect(await threadsLike(api, `sub:${r4}:%`)).toHaveLength(2);

    // T6: u-001 creates `Platform CI` and pins R4 to it.
    const platform = await createThread(api, "Platform CI");
    const pinned = await patchRule(api, r4, { thread: { mode: "existing", ...platform } });
    expect(pinned.status, await pinned.clone().text()).toBe(200);
    await postGithub(api, "check_run", checkRun("deploy", "failure", []));
    const t6 = await settled(api, r4, 3);
    const t6Thread = await landingOf(api, t6[2]);
    expect(t6Thread).toMatchObject({ id: platform.threadId, sessionId: platform.sessionId, title: "Platform CI" });
    expect(await threadsLike(api, `sub:${r4}:%`)).toHaveLength(2);

    // T7: u-001 archives `Platform CI`. The next failure dead-letters, R4's
    // delivery reports why, and no thread is created or reopened (INV-D3).
    await archiveThread(api, platform.threadId);
    const before = await threadCount(api);
    await postGithub(api, "check_run", checkRun("deploy", "failure", []));
    const t7 = await settled(api, r4, 4);
    const dead = t7[3];
    expect(dead).toMatchObject({ status: "dead", lastError: PIN_UNAVAILABLE });
    expect(await landings(api, `event:${dead?.id}`)).toEqual([]);
    const t7Event = (await (await call(api, "GET", `/api/events/${dead?.eventId}`)).json()) as GetEventResponse;
    expect(t7Event.deliveries.find((d) => d.id === dead?.id)).toMatchObject({ subscriptionId: r4, status: "dead", lastError: PIN_UNAVAILABLE });
    // R1 groups the same failure by repository into its existing thread.
    await settled(api, r1, 7);
    expect(await threadCount(api)).toBe(before);
    expect((await threadById(api, platform.threadId)).archivedAt).not.toBeNull();

    // T8: u-001 archives `ENG triage`. An update on ENG-42 reopens it.
    await archiveThread(api, triage.id);
    expect((await threadById(api, triage.id)).archivedAt).not.toBeNull();
    await postLinearUpdate(api, "ENG-42");
    const t8 = await settled(api, r3, 3);
    const reopened = await landingOf(api, t8[2]);
    expect(reopened).toMatchObject({ id: triage.id, key: `sub:${r3}`, title: "ENG triage", archivedAt: null });

    // T9: S1 keeps its own thread across two fires.
    const created = await call(api, "POST", "/api/workflows/schedules", {
      name: "Morning summary", cron: "0 9 * * *", target: { kind: "orchestrator", prompt: "Summarize the night." }, thread: { mode: "own" },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const s1 = ((await created.json()) as WorkflowScheduleResponse).schedule.scheduleId;
    const fireAt = [Date.now() - 60_000, Date.now() - 30_000];
    for (const slot of fireAt) {
      await p.db.update(workflowSchedules).set({ nextFireAt: slot }).where(eq(workflowSchedules.id, s1));
      await p.workflowScheduler.tick();
      await poll(() => landings(api, `schedule:${s1}:${slot}`), (rows) => rows.length === 1, `the fire at ${slot}`);
    }
    const morning = await threadsLike(api, `schedule:${s1}%`);
    expect(morning).toHaveLength(1);
    expect(morning[0]).toMatchObject({ key: `schedule:${s1}`, title: "Morning summary" });
    for (const slot of fireAt) expect(await landings(api, `schedule:${s1}:${slot}`)).toEqual([{ sessionId: morning[0]?.sessionId, threadId: morning[0]?.id }]);

    // T10: R2 follows mentions in C900. A mention in a new Slack thread X
    // opens one thread per delivery and binds X to it; a reply in X lands
    // there through the binding.
    const r2 = await createRule(api, {
      name: "C900 mentions",
      eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C900" }],
      target: { kind: "orchestrator", follow: true, thread: { mode: "new" } },
    });
    const threadX = `${++slackTs}.000100`;
    await postSlack(api, {
      type: "app_mention", channel: "C900", user: "U001", text: `<@${BOT_USER}> is the deploy green?`, ts: threadX, team: SLACK_TEAM, event_ts: threadX,
    });
    const t10 = await settled(api, r2, 1);
    const mention = await landingOf(api, t10[0]);
    expect(mention.key).toBe(`sub:${r2}:${t10[0]?.id}`);
    expect(await findFollowedThread(p.db, { orgId: ORG, channelType: "slack", channelId: "C900", threadTs: threadX }))
      .toMatchObject({ ownerType: "user", ownerId: USER, sessionId: mention.sessionId, threadId: mention.id });
    const replyText = "the deploy finished at 09:10";
    await postSlack(api, {
      type: "message", channel: "C900", channel_type: "channel", user: "U001", text: replyText, team: SLACK_TEAM,
      ts: `${++slackTs}.000100`, thread_ts: threadX,
    });
    const reply = await poll(async () => rowsOf(await p.db.execute(
      sql`SELECT session_id, thread_id FROM engine_queue_items WHERE content LIKE ${`%${replyText}%`}`,
    )), (rows) => rows.length > 0, "the reply in X");
    expect(reply).toEqual([{ session_id: mention.sessionId, thread_id: mention.id }]);
    expect(await threadsLike(api, `sub:${r2}%`)).toHaveLength(1);

    // T11: a pin on another user's thread is refused.
    const foreign = await createThread(api, "Member notes", OTHER_USER);
    const refused = await patchRule(api, r2, { thread: { mode: "existing", ...foreign } });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: CROSS_OWNER });
    expect((await deliveriesOf(api, r2)).length).toBe(1);
  }, 120_000);

  it("keeps a legacy team rule's channel events in one thread per channel", async () => {
    const api = await bootUniverse();
    const p = api.providers;
    const team = await createTeam(p.db, { orgId: ORG, name: "Ops", creatorUserId: USER });
    await addMember(p.db, { teamId: team.id, userId: OTHER_USER, role: "member" });
    // CPRIV is private and OTHER_USER is not in it; CPUB is public.
    await p.db.insert(slackChannelPrivacy).values([
      { orgId: ORG, channelId: "CPUB", isPrivate: false, checkedAt: Date.now() },
      { orgId: ORG, channelId: "CPRIV", isPrivate: true, checkedAt: Date.now() },
    ]);
    await linkIdentity(p.db, { provider: "slack", externalId: "U002", userId: OTHER_USER });
    // A rule stored before thread policies: no `thread` in its target.
    const now = Date.now();
    await p.db.insert(eventSubscriptions).values({
      id: "sub-legacy-reactions", orgId: ORG, ownerType: "team", ownerId: team.id, name: "Reactions",
      eventKeys: ["slack.reaction_added"], filters: [], target: { kind: "orchestrator" },
      enabled: true, createdBy: USER, createdAt: now, updatedAt: now,
    });
    for (const channel of ["CPUB", "CPRIV"]) {
      const ts = `${++slackTs}.000100`;
      await postSlack(api, {
        type: "reaction_added", user: "U001", reaction: "eyes", item_user: "U001",
        item: { type: "message", channel, ts }, event_ts: ts,
      });
    }
    const rows = await settled(api, "sub-legacy-reactions", 2);
    const landed = await Promise.all(rows.map((row) => landingOf(api, row)));
    expect(landed.map((thread) => thread.key).sort()).toEqual([`subject:slack:${SLACK_TEAM}/CPRIV`, `subject:slack:${SLACK_TEAM}/CPUB`]);

    // A teammate outside the private channel still sees the public channel's thread.
    const outsider = { orgId: ORG, userId: OTHER_USER };
    for (const thread of landed) {
      const visible = threadVisibility(p, { ownerType: "team", id: thread.sessionId }, outsider);
      const ref = await storedThreadRef(p.db, thread.sessionId, thread.id, thread.key);
      expect(await visible(ref), thread.key).toBe(thread.key.endsWith("/CPUB"));
    }
  }, 60_000);
});
