/**
 * The shared universe of the event acceptance scenarios: the event wakeups
 * spec's Scenarios A to E (`event-wakeups.test.ts`) and the delivery threads
 * and claims spec's Scenario C (`event-claims.test.ts`).
 *
 * What runs for real: the api app (`bootTestApi`), signed webhooks into the
 * GitHub App, Slack Events, and Linear ingest routes, the Postgres store,
 * the agent tools in real turns, and a WakeWatcher with the production
 * derive step. What is stubbed: the model (a scripted faux provider that
 * calls the tools a step names), the GitHub API (`startGithubFixture`), and
 * the Slack and Linear APIs (a `fetch` stub for `slack.com` and
 * `api.linear.app`).
 *
 * Universe mapping: org `acme` is the harness org `local-org`, and user
 * `u-001` is `local-user`. The external ids (GitHub `ada` 1001, Slack
 * `U001`, Linear `lin-u1`) are the specs'.
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
import { expect, vi } from "vitest";
import { linkIdentity } from "../channels/identity-links.js";
import { __resetSlackWebhookThrottle } from "../channels/slack-inbox.js";
import { WakeWatcher } from "../engine/wake-watcher.js";
import { productionEventWaiterDeriver } from "../events/derive.js";
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

export const ORG = "local-org";
export const USER = "local-user";
export const PUBLIC_URL = "https://valet.acme.test";

// GitHub universe.
export const APP_ID = "9001";
export const APP_SLUG = "valet-app";
export const INSTALLATION = 77;
export const PR_URL = "https://github.com/acme/lean-proofs/pull/42";
export const PR_SUBJECT = "github:acme/lean-proofs#42";
export const HEAD_SHA = "aaaa000000000000000000000000000000000001";
export const REPO_SUBJECT = "github:acme/lean-proofs";
export const GITHUB_WEBHOOK_SECRET = "gh-webhook-secret";
export const { privateKey: APP_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
export const APP_CONFIG: GithubAppConfig = {
  appId: APP_ID,
  appSlug: APP_SLUG,
  oauthClientId: "Iv1.acme",
  htmlUrl: `https://github.com/apps/${APP_SLUG}`,
  oauthClientSecret: "client-secret",
  webhookSecret: GITHUB_WEBHOOK_SECRET,
  privateKeyPem: APP_PEM,
};

// Slack universe.
export const SLACK_TEAM = "T001";
export const SLACK_SECRET = "slack-signing-secret";
export const BOT_TOKEN = "xoxb-acme-bot";
export const USER_SLACK_TOKEN = "xoxp-u001";
export const BOT_ID = "B9";
export const BOT_USER = "U-BOT";
export const THREAD_ROOT = "1712345678.000100";
export const SLACK_PERMALINK = "https://acme.slack.com/archives/C001/p1712345678000100";

// Linear universe.
export const LINEAR_WORKSPACE = "lin-org-acme";
export const LINEAR_SECRET = "linear-webhook-secret";
export const LINEAR_APP_TOKEN = "lin-app-token";
export const LINEAR_USER_TOKEN = "lin-user-token";

export const PENDING_FAILURES = ["failure", "timed_out", "cancelled", "action_required", "startup_failure"];

// ── The scripted agent ──────────────────────────────────────────────────

export interface ScriptedCall {
  name: string;
  args: JsonObject;
}

/** One tool result the scripted agent saw, in order. */
export interface SeenResult {
  toolName: string;
  text: string;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function textOf(content: unknown): string {
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
export function withThreadLink(value: JsonValue, link: string | undefined): JsonValue {
  if (typeof value === "string") return link ? value.replaceAll("{{threadLink}}", link) : value;
  if (value === null || typeof value !== "object") return value;
  if (isJsonArray(value)) return value.map((v) => withThreadLink(v, link));
  return linkArgs(value, link);
}

export function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function linkArgs(args: JsonObject, link: string | undefined): JsonObject {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, withThreadLink(v, link)]));
}

/**
 * A model that runs a script per prompt. A user turn whose text matches a
 * registered pattern makes the model call that script's tools in order,
 * one per model call; any other turn (a signal, a plain prompt) gets a
 * short reply. Every tool result is recorded, so a step asserts the text
 * the agent actually saw.
 */
export class ScriptedAgent {
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

export interface SlackCall {
  method: string;
  token: string | undefined;
  params: Record<string, string>;
}

export interface ProviderStub {
  slackCalls: SlackCall[];
  linearQueries: string[];
}

export async function paramsOf(input: Request): Promise<Record<string, string>> {
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
export function slackAnswer(call: SlackCall): unknown {
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

export const LINEAR_STATES = [
  { id: "st-triage", type: "triage" },
  { id: "st-backlog", type: "backlog" },
  { id: "st-started", type: "started" },
];

export function linearAnswer(query: string, token: string | null): unknown {
  if (query.includes("viewer")) return { data: { viewer: { id: token === `Bearer ${LINEAR_APP_TOKEN}` ? "app-1" : "lin-u1" } } };
  if (query.includes("workflowStates")) return { data: { workflowStates: { nodes: LINEAR_STATES } } };
  if (query.includes("teams(")) return { data: { teams: { nodes: [{ id: "team-eng" }] } } };
  if (query.includes("issue(")) return { data: { issue: { id: "iss-1" } } };
  return { data: {} };
}

/** Routes `slack.com` and `api.linear.app` to the stub; everything else reaches the network as usual. */
export function stubProviders(): ProviderStub {
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

export interface CheckRunState {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
}

export interface CombinedStatus {
  state: string;
  statuses: { state: string; context: string; updated_at: string }[];
}

export interface GithubRuns {
  current: CheckRunState[];
  combined: CombinedStatus;
}

/** The head SHA of `acme/api#12` and `#14` (claims Scenario C). Each pull request has its own. */
export const API_HEADS: Record<number, string> = {
  12: "dddd000000000000000000000000000000000012",
  14: "eeee000000000000000000000000000000000014",
};

/** The pull requests the fixture knows, with their head SHA: `acme/lean-proofs#42` (Scenario A) and `acme/api#12`, `#14`. */
const KNOWN_PULLS: Record<string, string> = {
  "lean-proofs/42": HEAD_SHA,
  "api/12": API_HEADS[12] ?? "",
  "api/14": API_HEADS[14] ?? "",
};

function knownPull(owner: string, repo: string, number: string): { url: string; head: string } | null {
  const head = owner === "acme" ? KNOWN_PULLS[`${repo}/${number}`] : undefined;
  return head ? { url: `https://github.com/acme/${repo}/pull/${number}`, head } : null;
}

export function startAcmeGithub(runs: GithubRuns): GithubFixture {
  const notFound: GithubFixtureResponse = { status: 404, body: { message: "Not Found" } };
  return startGithubFixture({
    getApp: () => ({ body: { id: Number(APP_ID), slug: APP_SLUG, events: githubPlugin.triggers?.map((trigger) => trigger.id.slice("github.".length)) ?? [], permissions: { checks: "read", actions: "read", statuses: "read", pull_requests: "read", issues: "read" }, owner: { login: "acme", id: 5000, type: "Organization" } } }),
    getRepoInstallation: (owner, repo) => owner === "acme" && Object.keys(KNOWN_PULLS).some((key) => key.startsWith(`${repo}/`))
      ? { body: { id: Number(INSTALLATION), suspended_at: null, events: githubPlugin.triggers?.map((trigger) => trigger.id.slice("github.".length)) ?? [], permissions: { checks: "read", actions: "read", statuses: "read", pull_requests: "read", issues: "read" } } } : notFound,
    createInstallationToken: (id) => ({ body: { token: `inst-${id}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() } }),
    getUser: () => ({ body: { login: "ada", id: 1001 } }),
    getUserByLogin: (login) => (login === `${APP_SLUG}[bot]` ? { body: { login, id: Number(APP_ID), type: "Bot" } } : notFound),
    getIssue: (owner, repo, number) => {
      const pull = knownPull(owner, repo, number);
      return pull ? { body: { number: Number(number), pull_request: { url: pull.url } } } : notFound;
    },
    getPull: (owner, repo, number) => {
      const pull = knownPull(owner, repo, number);
      return pull ? { body: { number: Number(number), html_url: pull.url, head: { sha: pull.head } } } : notFound;
    },
    listCheckRuns: () => ({ body: { total_count: runs.current.length, check_runs: runs.current.map((r, i) => ({ id: i + 1, ...r })) } }),
    getCombinedStatus: () => ({ body: runs.combined }),
  });
}

// ── Universe setup ──────────────────────────────────────────────────────

export interface Universe {
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

/** Closes what `bootUniverse` opened. Each test file calls it in `afterEach`. */
export async function teardownUniverse(): Promise<void> {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
}

export async function bootUniverse(): Promise<Universe> {
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
    childEvents: { active: (row) => p.childWatcher.subscriptionActive(row), deliver: (row, digest) => p.childWatcher.deliverEvent(row, digest), close: (row) => p.childWatcher.closeSubscription(row), finish: (row, blocked) => p.childWatcher.finishDeliveryPass(row, blocked) },
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

export async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (ok(value)) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function threadMessages(u: Universe, sessionId: string, threadId: string): Promise<Message[]> {
  const res = await fetch(`${u.api.baseUrl}/api/sessions/${sessionId}/messages?threadId=${encodeURIComponent(threadId)}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as ListMessagesResponse).messages;
}

export async function signals(u: Universe, signalType: string, sessionId = u.sessionId, threadId = u.threadId): Promise<Message[]> {
  return (await threadMessages(u, sessionId, threadId)).filter((m) => m.signal?.signalType === signalType);
}

/** Sends a prompt to a thread (t-1 by default) and waits for the scripted agent to see `results` more tool results. */
export async function prompt(
  u: Universe, text: string, results: number, at: { sessionId: string; threadId: string } = u,
): Promise<SeenResult[]> {
  const before = u.agent.results.length;
  const res = await fetch(`${u.api.baseUrl}/api/sessions/${at.sessionId}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, threadId: at.threadId }),
  });
  expect(res.status).toBe(202);
  await poll(async () => u.agent.results.length, (n) => n >= before + results, `${results} tool results for "${text}"`);
  return u.agent.results.slice(before, before + results);
}

/** Waits until t-1 holds `count` signals of `signalType`, then returns them. */
export async function awaitSignals(u: Universe, signalType: string, count: number, sessionId = u.sessionId, threadId = u.threadId): Promise<Message[]> {
  return poll(() => signals(u, signalType, sessionId, threadId), (s) => s.length >= count, `${count} ${signalType} signals`);
}

/** Lets a pass's delivery settle, then asserts no new signal of `signalType` arrived. */
export async function expectNoNewSignal(u: Universe, signalType: string, count: number, sessionId = u.sessionId, threadId = u.threadId): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
  expect(await signals(u, signalType, sessionId, threadId)).toHaveLength(count);
}

export function rowsOf(result: unknown): unknown[] {
  if (result !== null && typeof result === "object" && "rows" in result && Array.isArray(result.rows)) return result.rows;
  throw new Error("db.execute returned no rows array");
}

export async function leaseCount(u: Universe): Promise<number> {
  const rows = rowsOf(await u.api.providers.db.execute(sql`SELECT count(*)::int AS n FROM engine_leases`));
  return Number(asRecord(rows[0])?.n ?? -1);
}

export interface QueuedTurn {
  id: string;
  sessionId: string;
  threadId: string;
}

/** Every queued turn whose content contains `needle`, across all sessions. */
export async function queuedWith(u: Universe, needle: string): Promise<QueuedTurn[]> {
  const rows = rowsOf(await u.api.providers.db.execute(
    sql`SELECT id, session_id, thread_id FROM engine_queue_items WHERE content LIKE ${`%${needle}%`} ORDER BY created_at`,
  ));
  return rows.map((row) => {
    const rec = asRecord(row) ?? {};
    return { id: String(rec.id), sessionId: String(rec.session_id), threadId: String(rec.thread_id) };
  });
}

/** Every queued signal turn of `signalType`, across all sessions. */
export function queuedSignals(u: Universe, signalType: string): Promise<QueuedTurn[]> {
  return queuedWith(u, `"signalType":"${signalType}"`);
}

export async function eventWaiters(u: Universe, sessionId = u.sessionId): Promise<Wakeup[]> {
  return (await u.api.providers.engineStore.listWakeups(sessionId)).filter((w) => w.kind === "event");
}

export function waiterIdFrom(text: string): string {
  const id = /^waiting (wk_\S+) /.exec(text)?.[1];
  if (!id) throw new Error(`no waiter id in "${text}"`);
  return id;
}

export async function postGithub(u: Universe, event: string, deliveryId: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", GITHUB_WEBHOOK_SECRET).update(body).digest("hex")}`;
  const res = await fetch(`${u.api.baseUrl}/webhooks/github-app`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-github-event": event, "x-github-delivery": deliveryId, "x-hub-signature-256": signature },
    body,
  });
  expect(res.status).toBeLessThan(300);
}

export function checkRunCompleted(name: string, conclusion: string, id: number): Record<string, unknown> {
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
export async function postSlack(u: Universe, event: Record<string, unknown>): Promise<void> {
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

/** The next Slack message ts, unique within the run. */
export function nextSlackTs(): string {
  return `${++slackTs}.000100`;
}

export function slackMessage(channel: string, user: string, text: string, threadTs?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message", channel, channel_type: "channel", user, text, team: SLACK_TEAM,
    ts: nextSlackTs(), ...(threadTs ? { thread_ts: threadTs } : {}), ...extra,
  };
}

let linearSeq = 0;

export async function postLinear(u: Universe, payload: Record<string, unknown>): Promise<void> {
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

export function linearIssue(identifier: string, stateType: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "Issue",
    url: `https://linear.app/acme/issue/${identifier}`,
    data: { id: `iss-${identifier}`, identifier, title: `Ticket ${identifier}`, team: { key: "ENG" }, state: { id: `st-${stateType}`, type: stateType, name: stateType } },
    actor: { id: "lin-u2", type: "user", name: "Grace" },
    ...extra,
  };
}

// ── Scenario E's incident channel, steps E1 and E2 ──────────────────────

/** The team that owns the incident channel thread `t-inc` (`sre` in the claims spec). */
export const TEAM = "team-acme";

/** One assistant or workflow rule row, inserted directly. */
export function ruleRow(
  id: string,
  owner: { type: "user" | "team"; id: string },
  eventKeys: string[],
  filters: SubscriptionFilter[],
  target: (typeof eventSubscriptions.$inferInsert)["target"],
): typeof eventSubscriptions.$inferInsert {
  const now = Date.now();
  return {
    id, orgId: ORG, ownerType: owner.type, ownerId: owner.id, createdBy: USER, name: id, eventKeys, filters,
    target, enabled: true, createdAt: now, updatedAt: now,
  };
}

/** Creates team `TEAM` with `u-001` as its admin, and lets the team assistant post and join without a gate. */
export async function createIncidentTeam(u: Universe): Promise<void> {
  const p = u.api.providers;
  await p.db.insert(teams).values({ id: TEAM, orgId: ORG, name: "Acme SRE", createdAt: Date.now() });
  await p.db.insert(teamMembers).values({ teamId: TEAM, userId: USER, role: "admin" });
  const policy = await fetch(`${u.api.baseUrl}/api/org/policies`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service: "slack", mode: "allow" }),
  });
  expect(policy.status).toBe(201);
}

export interface IncidentThread {
  tInc: { sessionId: string; threadId: string };
  /** The stream waiter E2 arms on `slack:T001/C900`. */
  waiterId: string;
}

/**
 * Steps E1 and E2: the `inc-` channel rule opens `t-inc`, and the agent
 * joins `C900`, posts its thread link, and arms the stream wait. Call
 * `createIncidentTeam` first.
 */
export async function armIncident(u: Universe): Promise<IncidentThread> {
  const p = u.api.providers;
  await p.db.insert(eventSubscriptions).values(
    // No thread policy: a channel event lands in its channel's subject thread (spec 2026-10-16, Part A step 3).
    ruleRow("sub-incidents", { type: "team", id: TEAM }, ["slack.channel_created"], [{ field: "channel_name", op: "prefix", value: "inc-" }], { kind: "orchestrator" }),
  );
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
    event_ts: nextSlackTs(),
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
  // The rule sets no thread policy, so the channel event lands in the
  // channel's subject thread (spec 2026-10-16: delivery threads, Part A
  // step 3), not a shared rule thread.
  expect(thread?.key).toBe(`subject:slack:${SLACK_TEAM}/C900`);

  // E2: the agent joins, posts the thread link, and arms the stream wait.
  const e2 = await poll(async () => u.agent.results.slice(before), (r) => r.length >= 3, "E2's three tool results");
  expect(e2.map((r) => (r.text.startsWith("waiting wk_") ? "waiting" : r.toolName))).toEqual(["call_tool", "call_tool", "waiting"]);
  expect(u.stub.slackCalls.some((c) => c.method === "conversations.join" && c.params.channel === "C900")).toBe(true);
  const posted = u.stub.slackCalls.find((c) => c.method === "chat.postMessage" && c.params.channel === "C900" && c.params.text?.startsWith("Following this incident"));
  expect(posted?.params.text).toContain(`${PUBLIC_URL}/threads/${tInc.threadId}`);
  const waiters = await eventWaiters(u, tInc.sessionId);
  expect(waiters).toHaveLength(1);
  expect(waiters[0]).toMatchObject({ threadId: tInc.threadId, status: "running", subjects: [`slack:${SLACK_TEAM}/C900`] });
  return { tInc, waiterId: waiters[0]?.id ?? "" };
}
