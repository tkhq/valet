/**
 * PUBLIC `/api/channels/slack/webhook` — verify once, ack fast, fan out to
 * the channel host and the event pipeline.
 *
 * Route-level against the real Slack plugin: real HMAC signatures, real
 * transport, assertions against actual DB rows. The fan-out runs after the
 * 200 is returned, so assertions on its effects poll.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import slackPlugin from "@valet/plugin-slack/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { eventDropLog, events, eventSubscriptions } from "../schema/index.js";
import { __resetSlackWebhookThrottle } from "./slack-webhook.js";

let api: TestApi | undefined;

beforeEach(() => {
  __resetSlackWebhookThrottle();
});

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

const SECRET = "slack-signing-secret";
const TEAM_ID = "T0001";
const DM_CHANNEL = "D300";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sign(body: string, secret = SECRET, ts = nowSeconds()): Record<string, string> {
  const digest = createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  return {
    "Content-Type": "application/json",
    "X-Slack-Signature": `v0=${digest}`,
    "X-Slack-Request-Timestamp": String(ts),
  };
}

/** Saves the org credential the route resolves the signing secret from. */
async function seedCredential(a: TestApi): Promise<void> {
  await a.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", {
    type: "bot_token",
    accessToken: "xoxb-test-token",
    metadata: { webhookSecret: SECRET, teamId: TEAM_ID, botUserId: "U0BOT" },
  });
}

async function seedRunningTransport(a: TestApi): Promise<void> {
  await seedCredential(a);
  await a.providers.channelHost.start();
}

/** `teamId: null` omits `team_id` entirely. `undefined` would select the
 * default parameter instead, which is the opposite of the intent. */
function envelope(event: Record<string, unknown>, eventId: string, teamId: string | null = TEAM_ID): string {
  const body: Record<string, unknown> = {
    token: "ignored",
    api_app_id: "A001",
    type: "event_callback",
    event_id: eventId,
    event_time: nowSeconds(),
    event,
  };
  if (teamId !== null) body.team_id = teamId;
  return JSON.stringify(body);
}

function dmMessage(): Record<string, unknown> {
  return {
    type: "message",
    channel: DM_CHANNEL,
    channel_type: "im",
    user: "U100",
    text: "hello valet",
    ts: "1720000002.000100",
    event_ts: "1720000002.000100",
  };
}

function homeOpened(): Record<string, unknown> {
  return {
    type: "app_home_opened",
    user: "U100",
    channel: DM_CHANNEL,
    tab: "messages",
    event_ts: "1720000003.000000",
  };
}

async function post(baseUrl: string, body: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/api/channels/slack/webhook`, { method: "POST", headers, body });
}

async function dropReasons(a: TestApi): Promise<string[]> {
  const rows = await a.providers.db.select().from(eventDropLog).where(eq(eventDropLog.orgId, "local-org"));
  return rows.map((r) => r.reason);
}

/** Scope every event assertion to this event's dedupeKey. The fan-out is
 * fire-and-forget, so a total row count would be flaky under load. */
async function eventCount(a: TestApi, dedupeKey: string): Promise<number> {
  const rows = await a.providers.db
    .select()
    .from(events)
    .where(and(eq(events.orgId, "local-org"), eq(events.dedupeKey, dedupeKey)));
  return rows.length;
}

async function seedSubscription(a: TestApi, eventKeys: string[]): Promise<void> {
  const now = Date.now();
  await a.providers.db.insert(eventSubscriptions).values({
    id: `sub_${eventKeys[0].replace(/\W/g, "_")}`,
    orgId: "local-org",
    ownerType: "org",
    ownerId: "local-org",
    name: "test subscription",
    eventKeys,
    filters: [],
    target: { kind: "orchestrator" },
    enabled: true,
    createdBy: "local-user",
    createdAt: now,
    updatedAt: now,
  });
}

describe("POST /api/channels/slack/webhook", () => {
  it("echoes the url_verification challenge before any credential exists", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });

    const res = await post(api.baseUrl, JSON.stringify({ type: "url_verification", challenge: "ch-123" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "ch-123" });
  });

  it("refuses to reflect an over-long challenge", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });

    const res = await post(api.baseUrl, JSON.stringify({ type: "url_verification", challenge: "x".repeat(600) }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
  });

  it("processes a redelivery whose first attempt never landed, and records that the ack was slow", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await seedSubscription(api, ["slack.message"]);

    // Slack redelivers because the previous attempt produced no 2xx, so this
    // may be the only copy of the message that ever arrives. Dropping it
    // would lose what the user typed.
    const body = envelope(dmMessage(), "Ev-retry");
    const res = await post(api.baseUrl, body, {
      ...sign(body),
      "x-slack-retry-num": "1",
      "x-slack-retry-reason": "http_timeout",
    });

    expect(res.status).toBe(200);
    await expect.poll(() => eventCount(api!, "Ev-retry"), { timeout: 5_000 }).toBe(1);
    await expect.poll(() => dropReasons(api!), { timeout: 5_000 }).toContain("slack_retry");
  });

  it("does not double-process a redelivery of an update it already handled", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await seedSubscription(api, ["slack.message"]);

    const body = envelope(dmMessage(), "Ev-retry-dup");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);
    await expect.poll(() => eventCount(api!, "Ev-retry-dup"), { timeout: 5_000 }).toBe(1);

    // Same `event_id`, so ingest's `(service, dedupeKey)` conflict target
    // absorbs it and the events table keeps exactly one row.
    const retry = await post(api.baseUrl, body, {
      ...sign(body),
      "x-slack-retry-num": "2",
      "x-slack-retry-reason": "http_timeout",
    });
    expect(retry.status).toBe(200);
    await expect.poll(() => dropReasons(api!), { timeout: 5_000 }).toContain("slack_retry");
    expect(await eventCount(api, "Ev-retry-dup")).toBe(1);
  });

  it("acks and drop-logs when the org has no slack credential", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });

    const body = envelope(dmMessage(), "Ev-nocred");
    const res = await post(api.baseUrl, body, sign(body));

    // An ack, not a 401: a half-configured org must not put Slack into a
    // retry loop against an endpoint that keeps failing.
    expect(res.status).toBe(200);
    expect(await dropReasons(api)).toContain("unknown_org");
  });

  it("acks and drop-logs when the credential exists but the transport is not running", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedCredential(api);

    const body = envelope(dmMessage(), "Ev-notransport");
    const res = await post(api.baseUrl, body, sign(body));

    expect(res.status).toBe(200);
    expect(await dropReasons(api)).toContain("transport_unavailable");
  });

  it("401s a body signed with the wrong secret", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);

    const body = envelope(dmMessage(), "Ev-badsig");
    const res = await post(api.baseUrl, body, sign(body, "wrong-secret"));

    expect(res.status).toBe(401);
    expect(await dropReasons(api)).toContain("bad_signature");
    expect(await eventCount(api, "Ev-badsig")).toBe(0);
  });

  it("401s a crafted multibyte signature header instead of 500ing", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);

    const body = envelope(dmMessage(), "Ev-crafted");
    const res = await post(api.baseUrl, body, {
      "Content-Type": "application/json",
      "X-Slack-Signature": `v0=${"0".repeat(63)}é`,
      "X-Slack-Request-Timestamp": String(nowSeconds()),
    });

    expect(res.status).toBe(401);
  });

  it("401s a replayed body whose timestamp is outside the window", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);

    const body = envelope(dmMessage(), "Ev-replay");
    const res = await post(api.baseUrl, body, sign(body, SECRET, nowSeconds() - 1_000));

    expect(res.status).toBe(401);
  });

  it("routes a DM to the channel host, where an unlinked sender is dropped", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);

    const body = envelope(dmMessage(), "Ev-dm");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);

    // No identity link exists, so reaching the host is observable as this
    // drop reason. It proves the update was verified, parsed, and routed.
    await expect.poll(() => dropReasons(api!), { timeout: 5_000 }).toContain("unlinked_sender");
  });

  it("routes app_home_opened on the messages tab, the signal that replaced assistant_thread_started", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);

    const body = envelope(homeOpened(), "Ev-home");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);

    await expect.poll(() => dropReasons(api!), { timeout: 5_000 }).toContain("unlinked_sender");
  });

  it("persists a subscribed slack.message and skips it when nothing subscribes", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);

    // slack.message is an ephemeral catalog key: unsubscribed, it must never
    // reach the events table.
    const unsubscribed = envelope(dmMessage(), "Ev-msg-1");
    expect((await post(api.baseUrl, unsubscribed, sign(unsubscribed))).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await eventCount(api, "Ev-msg-1")).toBe(0);

    await seedSubscription(api, ["slack.message"]);
    const subscribed = envelope(dmMessage(), "Ev-msg-2");
    expect((await post(api.baseUrl, subscribed, sign(subscribed))).status).toBe(200);
    await expect.poll(() => eventCount(api!, "Ev-msg-2"), { timeout: 5_000 }).toBe(1);
  });

  it("drops an update from another workspace even though its signature is valid", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await seedSubscription(api, ["slack.message"]);

    // A Slack app's signing secret is valid for every workspace that
    // installs the app, so a valid signature alone proves nothing.
    const body = envelope(dmMessage(), "Ev-foreign", "T9999");
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);

    await expect.poll(() => dropReasons(api!), { timeout: 5_000 }).toContain("foreign_workspace");
    expect(await eventCount(api, "Ev-foreign")).toBe(0);
    expect(await dropReasons(api)).not.toContain("unlinked_sender");
  });

  it("drops an update that names no workspace at all", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);
    await seedSubscription(api, ["slack.message"]);

    const body = envelope(dmMessage(), "Ev-noteam", null);
    expect((await post(api.baseUrl, body, sign(body))).status).toBe(200);

    await expect.poll(() => dropReasons(api!), { timeout: 5_000 }).toContain("foreign_workspace");
    expect(await eventCount(api, "Ev-noteam")).toBe(0);
  });

  it("413s a body over the size cap", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);

    const res = await post(api.baseUrl, JSON.stringify({ pad: "x".repeat(1_100_000) }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(413);
  });

  it("acks inside Slack's 3-second window without waiting on the fan-out", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedRunningTransport(api);

    const body = envelope(dmMessage(), "Ev-timing");
    const started = Date.now();
    const res = await post(api.baseUrl, body, sign(body));
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(3_000);
  });
});
