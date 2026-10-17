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
import { createHmac, generateKeyPairSync } from "node:crypto";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
  type FauxResponseFactory,
  type JsonObject,
  type JsonValue,
} from "@earendil-works/pi-ai/compat";
import githubPlugin from "@valet/plugin-github/plugin";
import linearPlugin from "@valet/plugin-linear/plugin";
import slackPlugin from "@valet/plugin-slack/plugin";
import type { Wakeup } from "@valet/engine";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linkIdentity } from "../channels/identity-links.js";
import { __resetSlackWebhookThrottle } from "../channels/slack-inbox.js";
import { WakeWatcher } from "../engine/wake-watcher.js";
import { productionEventWaiterDeriver } from "../events/derive.js";
import { findFollowedThread } from "../events/followed-threads.js";
import type { SubscriptionFilter } from "../events/match.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { resolveWakeupLimits } from "../providers/sandbox-backend.js";
import {
  eventSubscriptions,
  githubInstallations,
  linearInstallations,
  slackWebhookInbox,
  teamMembers,
  teams,
} from "../schema/index.js";
import { saveAppConfig, type GithubAppConfig } from "../services/github-app.js";
import { startGithubFixture, type GithubFixture, type GithubFixtureResponse } from "../test-helpers/github-fixture.js";
import type { CreateSessionResponse, ListMessagesResponse, ListThreadsResponse, Message } from "../wire/types.js";
import { bootTestApi, type TestApi } from "./_setup.js";

const ORG = "local-org";
const USER = "local-user";
const PUBLIC_URL = "https://valet.acme.test";

// GitHub universe.
const APP_ID = "9001";
const APP_SLUG = "valet-app";
const INSTALLATION = 77;
const PR_URL = "https://github.com/acme/lean-proofs/pull/42";
const PR_SUBJECT = "github:acme/lean-proofs#42";
const HEAD_SHA = "aaaa000000000000000000000000000000000001";
const REPO_SUBJECT = "github:acme/lean-proofs";
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
const USER_SLACK_TOKEN = "xoxp-u001";
const BOT_ID = "B9";
const BOT_USER = "U-BOT";
const THREAD_ROOT = "1712345678.000100";
const SLACK_PERMALINK = "https://acme.slack.com/archives/C001/p1712345678000100";

// Linear universe.
const LINEAR_WORKSPACE = "lin-org-acme";
const LINEAR_SECRET = "linear-webhook-secret";
const LINEAR_APP_TOKEN = "lin-app-token";
const LINEAR_USER_TOKEN = "lin-user-token";

const PENDING_FAILURES = ["failure", "timed_out", "cancelled", "action_required", "startup_failure"];

// ── The scripted agent ──────────────────────────────────────────────────

interface ScriptedCall {
  name: string;
  args: JsonObject;
}

/** One tool result the scripted agent saw, in order. */
interface SeenResult {
  toolName: string;
  text: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const rec = asRecord(part);
      return rec?.type === "text" && typeof rec.text === "string" ? rec.text : "";
    })
    .join("");
}

/** Replaces `{{threadLink}}` in string arguments with the link the system context carries. */
function withThreadLink(value: JsonValue, link: string | undefined): JsonValue {
  if (typeof value === "string") return link ? value.replaceAll("{{threadLink}}", link) : value;
  if (value === null || typeof value !== "object") return value;
  if (isJsonArray(value)) return value.map((v) => withThreadLink(v, link));
  return linkArgs(value, link);
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function linkArgs(args: JsonObject, link: string | undefined): JsonObject {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, withThreadLink(v, link)]));
}

/**
 * A model that runs a script per prompt. A user turn whose text matches a
 * registered pattern makes the model call that script's tools in order,
 * one per model call; any other turn (a signal, a plain prompt) gets a
 * short reply. Every tool result is recorded, so a step asserts the text
 * the agent actually saw.
 */
class ScriptedAgent {
  readonly results: SeenResult[] = [];
  readonly threadLinks: string[] = [];
  private readonly scripts: Array<{ pattern: RegExp; calls: ScriptedCall[] }> = [];
  private nextId = 1;
  private readonly faux: FauxProviderRegistration;

  constructor() {
    this.faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    const step: FauxResponseFactory = (context) => this.respond(context.messages);
    this.faux.setResponses(Array.from({ length: 400 }, () => step));
  }

  /** Registers the tools to call when a user turn matches `pattern`. */
  on(pattern: RegExp, calls: ScriptedCall[]): void {
    this.scripts.push({ pattern, calls });
  }

  unregister(): void {
    this.faux.unregister();
  }

  private respond(messages: readonly unknown[]) {
    const all = JSON.stringify(messages);
    const link = /This thread's link is (\S+?)\. Post it/.exec(all)?.[1];
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (asRecord(messages[i])?.role === "user") {
        lastUser = i;
        break;
      }
    }
    const last = asRecord(messages[messages.length - 1]);
    if (last?.role === "toolResult") {
      this.results.push({ toolName: String(last.toolName ?? ""), text: textOf(last.content) });
    }
    const userText = lastUser >= 0 ? textOf(asRecord(messages[lastUser])?.content) : "";
    const script = this.scripts.find((s) => s.pattern.test(userText));
    const done = messages.slice(lastUser + 1).filter((m) => asRecord(m)?.role === "toolResult").length;
    const call = script?.calls[done];
    if (call) {
      if (link) this.threadLinks.push(link);
      return fauxAssistantMessage([fauxToolCall(call.name, linkArgs(call.args, link), { id: `tc-${this.nextId++}` })], {
        stopReason: "toolUse",
      });
    }
    return fauxAssistantMessage("noted");
  }
}

// ── The Slack and Linear API stub ───────────────────────────────────────

interface SlackCall {
  method: string;
  token: string | undefined;
  params: Record<string, string>;
}

interface ProviderStub {
  slackCalls: SlackCall[];
  linearQueries: string[];
}

async function paramsOf(input: Request): Promise<Record<string, string>> {
  const params: Record<string, string> = Object.fromEntries(new URL(input.url).searchParams);
  if (input.method !== "POST") return params;
  const text = await input.text();
  if (!text) return params;
  if ((input.headers.get("content-type") ?? "").includes("json")) {
    const body = asRecord(JSON.parse(text)) ?? {};
    for (const [k, v] of Object.entries(body)) params[k] = typeof v === "string" ? v : JSON.stringify(v);
  } else {
    for (const [k, v] of new URLSearchParams(text)) params[k] = v;
  }
  return params;
}

/** Slack's answer to one Web API call. C001 and C900 hold the bot; C002 does not. */
function slackAnswer(call: SlackCall): unknown {
  const bot = call.token === `Bearer ${BOT_TOKEN}`;
  switch (call.method) {
    case "auth.test":
      return { ok: true, team_id: SLACK_TEAM, user_id: bot ? BOT_USER : "U001", bot_id: bot ? BOT_ID : undefined };
    case "conversations.info": {
      const names: Record<string, string> = { C001: "proofs", C002: "random-2", C900: "inc-db-latency" };
      const name = names[call.params.channel ?? ""];
      if (!name) return { ok: false, error: "channel_not_found" };
      return { ok: true, channel: { id: call.params.channel, name, is_private: false, is_member: bot && call.params.channel !== "C002" } };
    }
    case "conversations.join":
      return { ok: true, channel: { id: call.params.channel }, already_in: false };
    case "chat.postMessage":
      return { ok: true, channel: call.params.channel, ts: "1712399999.000100" };
    case "users.info":
      return { ok: true, user: { id: call.params.user, name: call.params.user, real_name: call.params.user, profile: {} } };
    default:
      return { ok: true };
  }
}

const LINEAR_STATES = [
  { id: "st-triage", type: "triage" },
  { id: "st-backlog", type: "backlog" },
  { id: "st-started", type: "started" },
];

function linearAnswer(query: string, token: string | null): unknown {
  if (query.includes("viewer")) return { data: { viewer: { id: token === `Bearer ${LINEAR_APP_TOKEN}` ? "app-1" : "lin-u1" } } };
  if (query.includes("workflowStates")) return { data: { workflowStates: { nodes: LINEAR_STATES } } };
  if (query.includes("teams(")) return { data: { teams: { nodes: [{ id: "team-eng" }] } } };
  if (query.includes("issue(")) return { data: { issue: { id: "iss-1" } } };
  return { data: {} };
}

/** Routes `slack.com` and `api.linear.app` to the stub; everything else reaches the network as usual. */
function stubProviders(): ProviderStub {
  const stub: ProviderStub = { slackCalls: [], linearQueries: [] };
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "slack.com") {
      const call = { method: url.pathname.replace(/^\/api\//, ""), token: request.headers.get("authorization") ?? undefined, params: await paramsOf(request) };
      stub.slackCalls.push(call);
      return Response.json(slackAnswer(call));
    }
    if (url.hostname === "api.linear.app") {
      const body = asRecord(await request.json()) ?? {};
      const query = typeof body.query === "string" ? body.query : "";
      stub.linearQueries.push(query);
      return Response.json(linearAnswer(query, request.headers.get("authorization")));
    }
    return realFetch(input, init);
  });
  return stub;
}

// ── The GitHub fixture state ────────────────────────────────────────────

interface CheckRunState {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
}

interface CombinedStatus {
  state: string;
  statuses: { state: string; context: string; updated_at: string }[];
}

interface GithubRuns {
  current: CheckRunState[];
  combined: CombinedStatus;
}

function startAcmeGithub(runs: GithubRuns): GithubFixture {
  const notFound: GithubFixtureResponse = { status: 404, body: { message: "Not Found" } };
  return startGithubFixture({
    getApp: () => ({ body: { id: Number(APP_ID), slug: APP_SLUG, owner: { login: "acme", id: 5000, type: "Organization" } } }),
    createInstallationToken: (id) => ({ body: { token: `inst-${id}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() } }),
    getUser: () => ({ body: { login: "ada", id: 1001 } }),
    getUserByLogin: (login) => (login === `${APP_SLUG}[bot]` ? { body: { login, id: Number(APP_ID), type: "Bot" } } : notFound),
    getIssue: (owner, repo, number) =>
      owner === "acme" && repo === "lean-proofs" && number === "42"
        ? { body: { number: 42, pull_request: { url: PR_URL } } }
        : notFound,
    getPull: (owner, repo, number) =>
      owner === "acme" && repo === "lean-proofs" && number === "42"
        ? { body: { number: 42, html_url: PR_URL, head: { sha: HEAD_SHA } } }
        : notFound,
    listCheckRuns: () => ({ body: { total_count: runs.current.length, check_runs: runs.current.map((r, i) => ({ id: i + 1, ...r })) } }),
    getCombinedStatus: () => ({ body: runs.combined }),
  });
}

// ── Universe setup ──────────────────────────────────────────────────────

interface Universe {
  api: TestApi;
  agent: ScriptedAgent;
  stub: ProviderStub;
  github: GithubFixture;
  runs: GithubRuns;
  clock: { now: number };
  watcher: WakeWatcher;
  sessionId: string;
  threadId: string;
}

let cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function bootUniverse(): Promise<Universe> {
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key");
  vi.stubEnv("VALET_PUBLIC_URL", PUBLIC_URL);
  __resetSlackWebhookThrottle();
  const runs: GithubRuns = { current: [], combined: { state: "pending", statuses: [] } };
  const github = startAcmeGithub(runs);
  cleanups.push(() => github.close());
  vi.stubEnv("GITHUB_API_URL", github.url);
  const stub = stubProviders();
  const agent = new ScriptedAgent();
  cleanups.push(() => agent.unregister());

  const api = await bootTestApi({ plugins: [githubPlugin, slackPlugin, linearPlugin], githubApiUrl: github.url });
  cleanups.push(() => api.cleanup());
  const p = api.providers;

  // GitHub: the App, installation 77 on acme, and ada's own token.
  await saveAppConfig({ credentials: p.engineCredentials }, ORG, APP_CONFIG);
  const now = Date.now();
  await p.db.insert(githubInstallations).values({
    id: `ghi_${INSTALLATION}`, orgId: ORG, installationId: INSTALLATION, accountLogin: "acme", accountType: "Organization",
    repositorySelection: "selected", suspended: false, cachedToken: null, cachedTokenExpiresAt: null, createdAt: now, updatedAt: now,
  });
  await p.engineCredentials.save({ type: "user", id: USER }, "github", { type: "oauth2", accessToken: "gho-ada", metadata: { login: "ada" } });

  // Slack: the org bot in T001 and U001's own token.
  await p.engineCredentials.save({ type: "org", id: ORG }, "slack", {
    type: "bot_token", accessToken: BOT_TOKEN,
    metadata: { webhookSecret: SLACK_SECRET, teamId: SLACK_TEAM, botUserId: BOT_USER, botId: BOT_ID },
  });
  await p.engineCredentials.save({ type: "user", id: USER }, "slack", { type: "oauth2", accessToken: USER_SLACK_TOKEN });
  await p.channelHost.start();

  // Linear: the app actor app-1 and lin-u1's own token.
  await p.engineCredentials.save({ type: "org", id: ORG }, "linear", {
    type: "oauth2", accessToken: LINEAR_APP_TOKEN, metadata: { webhookSecret: LINEAR_SECRET, grant: "client_credentials" },
  });
  await p.db.insert(linearInstallations).values({
    id: "li_acme", orgId: ORG, workspaceId: LINEAR_WORKSPACE, workspaceName: "Acme", connectedBy: USER, createdAt: now, updatedAt: now,
  });
  await p.engineCredentials.save({ type: "user", id: USER }, "linear", { type: "oauth2", accessToken: LINEAR_USER_TOKEN });

  // u-001's identity links.
  await linkIdentity(p.db, { provider: "github", externalId: "1001", userId: USER });
  await linkIdentity(p.db, { provider: "slack", externalId: "U001", userId: USER });
  await linkIdentity(p.db, { provider: "linear", externalId: "lin-u1", userId: USER });

  // Personal session s-1 and its thread t-1.
  const created = await fetch(`${api.baseUrl}/api/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace: "/tmp" }),
  });
  expect(created.status).toBe(201);
  const { id: sessionId } = (await created.json()) as CreateSessionResponse;
  const { threads } = (await (await fetch(`${api.baseUrl}/api/sessions/${sessionId}/threads`)).json()) as ListThreadsResponse;
  const threadId = threads[0]?.id;
  if (!threadId) throw new Error("the created session has no default thread");

  // The WakeWatcher on a fake clock, with the production derive step.
  const clock = { now: Date.now() };
  const watcher = new WakeWatcher({
    db: p.db,
    engineStore: p.engineStore,
    engineHost: p.engineHost,
    provider: p.sandboxProvider,
    limits: resolveWakeupLimits(process.env),
    deriveEvent: productionEventWaiterDeriver({
      db: p.db,
      plugins: p.plugins,
      githubTokenDeps: { db: p.db, credentials: p.engineCredentials, key: deriveSecretKey("test-key"), apiUrl: github.url, githubUrl: github.url },
    }),
    sweepIntervalMs: 0,
    now: () => clock.now,
  });
  return { api, agent, stub, github, runs, clock, watcher, sessionId, threadId };
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (ok(value)) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function threadMessages(u: Universe, sessionId: string, threadId: string): Promise<Message[]> {
  const res = await fetch(`${u.api.baseUrl}/api/sessions/${sessionId}/messages?threadId=${encodeURIComponent(threadId)}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as ListMessagesResponse).messages;
}

async function signals(u: Universe, signalType: string, sessionId = u.sessionId, threadId = u.threadId): Promise<Message[]> {
  return (await threadMessages(u, sessionId, threadId)).filter((m) => m.signal?.signalType === signalType);
}

/** Sends a prompt to t-1 and waits for the scripted agent to see `results` more tool results. */
async function prompt(u: Universe, text: string, results: number): Promise<SeenResult[]> {
  const before = u.agent.results.length;
  const res = await fetch(`${u.api.baseUrl}/api/sessions/${u.sessionId}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, threadId: u.threadId }),
  });
  expect(res.status).toBe(202);
  await poll(async () => u.agent.results.length, (n) => n >= before + results, `${results} tool results for "${text}"`);
  return u.agent.results.slice(before, before + results);
}

/** Waits until t-1 holds `count` signals of `signalType`, then returns them. */
async function awaitSignals(u: Universe, signalType: string, count: number, sessionId = u.sessionId, threadId = u.threadId): Promise<Message[]> {
  return poll(() => signals(u, signalType, sessionId, threadId), (s) => s.length >= count, `${count} ${signalType} signals`);
}

/** Lets a pass's delivery settle, then asserts no new signal of `signalType` arrived. */
async function expectNoNewSignal(u: Universe, signalType: string, count: number, sessionId = u.sessionId, threadId = u.threadId): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
  expect(await signals(u, signalType, sessionId, threadId)).toHaveLength(count);
}

function rowsOf(result: unknown): unknown[] {
  if (result !== null && typeof result === "object" && "rows" in result && Array.isArray(result.rows)) return result.rows;
  throw new Error("db.execute returned no rows array");
}

async function leaseCount(u: Universe): Promise<number> {
  const rows = rowsOf(await u.api.providers.db.execute(sql`SELECT count(*)::int AS n FROM engine_leases`));
  return Number(asRecord(rows[0])?.n ?? -1);
}

interface QueuedTurn {
  id: string;
  sessionId: string;
  threadId: string;
}

/** Every queued turn whose content contains `needle`, across all sessions. */
async function queuedWith(u: Universe, needle: string): Promise<QueuedTurn[]> {
  const rows = rowsOf(await u.api.providers.db.execute(
    sql`SELECT id, session_id, thread_id FROM engine_queue_items WHERE content LIKE ${`%${needle}%`} ORDER BY created_at`,
  ));
  return rows.map((row) => {
    const rec = asRecord(row) ?? {};
    return { id: String(rec.id), sessionId: String(rec.session_id), threadId: String(rec.thread_id) };
  });
}

/** Every queued signal turn of `signalType`, across all sessions. */
function queuedSignals(u: Universe, signalType: string): Promise<QueuedTurn[]> {
  return queuedWith(u, `"signalType":"${signalType}"`);
}

async function eventWaiters(u: Universe, sessionId = u.sessionId): Promise<Wakeup[]> {
  return (await u.api.providers.engineStore.listWakeups(sessionId)).filter((w) => w.kind === "event");
}

function waiterIdFrom(text: string): string {
  const id = /^waiting (wk_\S+) /.exec(text)?.[1];
  if (!id) throw new Error(`no waiter id in "${text}"`);
  return id;
}

async function postGithub(u: Universe, event: string, deliveryId: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", GITHUB_WEBHOOK_SECRET).update(body).digest("hex")}`;
  const res = await fetch(`${u.api.baseUrl}/webhooks/github-app`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-github-event": event, "x-github-delivery": deliveryId, "x-hub-signature-256": signature },
    body,
  });
  expect(res.status).toBeLessThan(300);
}

function checkRunCompleted(name: string, conclusion: string, id: number): Record<string, unknown> {
  return {
    action: "completed",
    check_run: {
      id, name, status: "completed", conclusion, head_sha: HEAD_SHA,
      html_url: `https://github.com/acme/lean-proofs/runs/${id}`,
      pull_requests: [{ number: 42, head: { sha: HEAD_SHA } }],
      completed_at: new Date().toISOString(),
    },
    repository: { full_name: "acme/lean-proofs", name: "lean-proofs", owner: { login: "acme" } },
    installation: { id: INSTALLATION },
    sender: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
  };
}

let slackEventSeq = 0;

/** Posts one signed Slack Events delivery and waits until the durable inbox has processed it. */
async function postSlack(u: Universe, event: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify({
    token: "ignored", api_app_id: "A001", type: "event_callback", team_id: SLACK_TEAM,
    event_id: `Ev${++slackEventSeq}`, event_time: Math.floor(Date.now() / 1000), event,
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", SLACK_SECRET).update(`v0:${timestamp}:${body}`).digest("hex");
  const res = await fetch(`${u.api.baseUrl}/api/channels/slack/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-slack-signature": `v0=${digest}`, "x-slack-request-timestamp": String(timestamp) },
    body,
  });
  expect(res.status).toBe(200);
  await poll(() => u.api.providers.db.select().from(slackWebhookInbox), (rows) => rows.length === 0, "the Slack inbox to drain");
}

let slackTs = 1712345700;

function slackMessage(channel: string, user: string, text: string, threadTs?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message", channel, channel_type: "channel", user, text, team: SLACK_TEAM,
    ts: `${++slackTs}.000100`, ...(threadTs ? { thread_ts: threadTs } : {}), ...extra,
  };
}

let linearSeq = 0;

async function postLinear(u: Universe, payload: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify({ organizationId: LINEAR_WORKSPACE, webhookTimestamp: Date.now(), webhookId: "wh-acme", createdAt: new Date().toISOString(), ...payload });
  const res = await fetch(`${u.api.baseUrl}/plugins/linear/http/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Linear-Signature": createHmac("sha256", LINEAR_SECRET).update(body).digest("hex"),
      "Linear-Delivery": `lin-del-${++linearSeq}`,
    },
    body,
  });
  expect(res.status).toBe(200);
}

function linearIssue(identifier: string, stateType: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "Issue",
    url: `https://linear.app/acme/issue/${identifier}`,
    data: { id: `iss-${identifier}`, identifier, title: `Ticket ${identifier}`, team: { key: "ENG" }, state: { id: `st-${stateType}`, type: stateType, name: stateType } },
    actor: { id: "lin-u2", type: "user", name: "Grace" },
    ...extra,
  };
}

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
    const TEAM = "team-acme";
    const now = Date.now();
    await p.db.insert(teams).values({ id: TEAM, orgId: ORG, name: "Acme SRE", createdAt: now });
    await p.db.insert(teamMembers).values({ teamId: TEAM, userId: USER, role: "admin" });
    const subscription = (id: string, eventKeys: string[], filters: SubscriptionFilter[], follow = false): typeof eventSubscriptions.$inferInsert => ({
      id, orgId: ORG, ownerType: "team", ownerId: TEAM, createdBy: USER, name: id, eventKeys, filters,
      // No thread policy: a follow rule defaults to a thread per mention
      // (`new`), any other rule to its own thread (spec 2026-10-16, Part A step 3).
      target: { kind: "orchestrator", ...(follow ? { follow: true } : {}) }, enabled: true, createdAt: now, updatedAt: now,
    });
    await p.db.insert(eventSubscriptions).values([
      subscription("sub-incidents", ["slack.channel_created"], [{ field: "channel_name", op: "prefix", value: "inc-" }]),
      // The mention rule follows its threads (incident mention routing, universe).
      subscription("sub-mentions", ["slack.app_mention"], [], true),
    ]);
    // An admin lets the team assistant post and join without a gate.
    const policy = await fetch(`${u.api.baseUrl}/api/org/policies`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service: "slack", mode: "allow" }),
    });
    expect(policy.status).toBe(201);

    // E2's script runs in the turn that E1's signal starts.
    u.agent.on(/channel #inc-db-latency created/, [
      { name: "call_tool", args: { tool_id: "slack.join_channel", params: { channel: "C900" }, summary: "Join the incident channel" } },
      { name: "call_tool", args: { tool_id: "slack.send_message", params: { channel: "C900", text: "Following this incident at {{threadLink}}" }, summary: "Post the thread link" } },
      {
        name: "wait_for_event",
        args: {
          subject: `slack:${SLACK_TEAM}/C900`, on: [{ key: "slack.message", bots: false }],
          once: false, min_interval_seconds: 30, reason: "Incident inc-db-latency", max_hours: 168,
        },
      },
    ]);

    // E1: the channel is created. The team assistant gets one signal in a new thread.
    const before = u.agent.results.length;
    await postSlack(u, {
      type: "channel_created",
      channel: { id: "C900", name: "inc-db-latency", created: Math.floor(Date.now() / 1000), creator: "U002", is_private: false },
      event_ts: `${++slackTs}.000100`,
    });
    await p.eventDispatcher.pollOnce();
    const created = await poll(() => queuedSignals(u, "slack.channel_created"), (rows) => rows.length > 0, "the channel_created delivery");
    expect(created).toHaveLength(1);
    const incident = created[0];
    if (!incident) throw new Error("no channel_created delivery");
    // A team conversation runs in its own execution session (CLAUDE.md, decision 5).
    const tInc = { sessionId: incident.sessionId, threadId: incident.threadId };
    const e1 = await awaitSignals(u, "slack.channel_created", 1, tInc.sessionId, tInc.threadId);
    expect(e1).toHaveLength(1);
    const thread = await p.engineStore.getThread(tInc.sessionId, tInc.threadId);
    // The rule sets no thread policy, so it lands in its own thread (spec
    // 2026-10-16: delivery threads, Part A step 3), not a channel events thread.
    expect(thread?.key).toBe("sub:sub-incidents");

    // E2: the agent joins, posts the thread link, and arms the stream wait.
    const e2 = await poll(async () => u.agent.results.slice(before), (r) => r.length >= 3, "E2's three tool results");
    expect(e2.map((r) => (r.text.startsWith("waiting wk_") ? "waiting" : r.toolName))).toEqual(["call_tool", "call_tool", "waiting"]);
    expect(u.stub.slackCalls.some((c) => c.method === "conversations.join" && c.params.channel === "C900")).toBe(true);
    const posted = u.stub.slackCalls.find((c) => c.method === "chat.postMessage" && c.params.channel === "C900");
    expect(posted?.params.text).toContain(`${PUBLIC_URL}/threads/${tInc.threadId}`);
    const waiters = await eventWaiters(u, tInc.sessionId);
    expect(waiters).toHaveLength(1);
    expect(waiters[0]).toMatchObject({ threadId: tInc.threadId, status: "running", subjects: [`slack:${SLACK_TEAM}/C900`] });
    const waiterId = waiters[0]?.id ?? "";

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

    // E5 / M1: a mention of the bot in the watched channel. The app_mention
    // subscription delivers it once, to t-inc; the event waiter skips the
    // message event (incident mention routing, INV-M1).
    const mentionTs = `${++slackTs}.000100`;
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
    await awaitSignals(u, "slack.app_mention", 1, tInc.sessionId, tInc.threadId);
    // No new assistant thread exists for the mention's Slack post.
    const mentionThreads = rowsOf(await p.db.execute(sql`SELECT id FROM engine_threads WHERE key = ${`slack:C900:${mentionTs}`}`));
    expect(mentionThreads).toHaveLength(0);

    // C2: the claim redirect binds the mention's Slack thread to t-inc
    // (spec 2026-10-16: delivery threads and claims, Part C).
    expect(await findFollowedThread(p.db, { orgId: ORG, channelType: "slack", channelId: "C900", threadTs: mentionTs }))
      .toMatchObject({ sessionId: tInc.sessionId, threadId: tInc.threadId });

    // M4: the agent's reply to the mention posts in the mention's Slack thread.
    const reply = await poll(
      async () => u.stub.slackCalls.find((c) => c.method === "chat.postMessage" && c.params.channel === "C900" && c.params.thread_ts === mentionTs),
      (call) => call !== undefined,
      "the reply in the mention's Slack thread",
    );
    expect(reply?.params.text).toContain("noted");

    // M3: a threaded reply under the mention reaches t-inc once, through the event waiter.
    const underMention = "replica caught up";
    await postSlack(u, slackMessage("C900", "U003", underMention, mentionTs));
    await p.eventDispatcher.pollOnce();
    u.clock.now += 60_000;
    await u.watcher.sweep(u.clock.now);
    const m3 = await awaitSignals(u, "event.matched", 3, tInc.sessionId, tInc.threadId);
    expect(m3[2]?.content).toContain(underMention);
    expect(await queuedWith(u, underMention)).toEqual([expect.objectContaining(tInc)]);

    // M5: a mention from U002, who links to no Valet user. The team mention
    // gate refuses U002, so the mention rule does not skip the message event,
    // and t-inc receives it once through the event waiter (Part C).
    const unlinkedTs = `${++slackTs}.000100`;
    const unlinkedText = `<@${BOT_USER}> is the replica healthy?`;
    await postSlack(u, { ...slackMessage("C900", "U002", unlinkedText), ts: unlinkedTs });
    await postSlack(u, { type: "app_mention", channel: "C900", user: "U002", text: unlinkedText, ts: unlinkedTs, team: SLACK_TEAM, event_ts: unlinkedTs });
    await p.eventDispatcher.pollOnce();
    u.clock.now += 60_000;
    await u.watcher.sweep(u.clock.now);
    const m5 = await awaitSignals(u, "event.matched", 4, tInc.sessionId, tInc.threadId);
    expect(m5[3]?.content).toContain("is the replica healthy?");
    expect(await queuedWith(u, "is the replica healthy?")).toEqual([expect.objectContaining(tInc)]);
    expect(await queuedSignals(u, "slack.app_mention")).toHaveLength(1);

    // M6: the agent cancels the watching waiter. A later mention opens its own
    // thread, keyed by its delivery (the follow rule's default `new` policy), and the dispatcher binds a
    // follow to that thread.
    u.agent.on(/incident closed, stop watching/, [{ name: "wakeup_cancel", args: { id: waiterId } }]);
    await postSlack(u, slackMessage("C900", "U002", "incident closed, stop watching"));
    u.clock.now += 60_000;
    await u.watcher.sweep(u.clock.now);
    await poll(() => p.engineStore.getWakeup(waiterId), (w) => w?.status !== "running", "the agent to cancel the waiter");
    expect(await p.engineStore.getWakeup(waiterId)).toMatchObject({ status: "cancelled" });
    const laterTs = `${++slackTs}.000100`;
    const laterText = `<@${BOT_USER}> who is on call?`;
    await postSlack(u, { ...slackMessage("C900", "U001", laterText), ts: laterTs });
    await postSlack(u, { type: "app_mention", channel: "C900", user: "U001", text: laterText, ts: laterTs, team: SLACK_TEAM, event_ts: laterTs });
    await p.eventDispatcher.pollOnce();
    const later = await poll(() => queuedWith(u, "who is on call?"), (rows) => rows.length > 0, "the later app_mention delivery");
    expect(later).toHaveLength(1);
    expect(later[0]?.threadId).not.toBe(tInc.threadId);
    expect((await p.engineStore.getThread(later[0]?.sessionId ?? "", later[0]?.threadId ?? ""))?.key).toMatch(/^sub:sub-mentions:/);
    expect(await findFollowedThread(p.db, { orgId: ORG, channelType: "slack", channelId: "C900", threadTs: laterTs }))
      .toMatchObject({ ownerType: "team", ownerId: TEAM, sessionId: later[0]?.sessionId, threadId: later[0]?.threadId });
  }, 90_000);
});
