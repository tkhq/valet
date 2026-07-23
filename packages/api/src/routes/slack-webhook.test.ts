/**
 * PUBLIC `/api/channels/slack/webhook` dedicated ingress (slack design
 * decision 2): verify once, ack fast, fan out to the channel host AND the
 * event pipeline. Route-level against the real slack plugin — real HMAC
 * signatures, assertions against actual DB rows. The fan-out runs after the
 * 200 is returned, so DB assertions poll.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import slackPlugin from "@valet/plugin-slack/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { eventDeliveries, eventDropLog, events, eventSubscriptions } from "../schema/index.js";
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

function sign(body: string, ts: number, secret = SECRET): Record<string, string> {
  const sig = createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  return {
    "Content-Type": "application/json",
    "X-Slack-Signature": `v0=${sig}`,
    "X-Slack-Request-Timestamp": String(ts),
  };
}

async function seedSlackOrg(a: TestApi): Promise<void> {
  await a.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", {
    type: "bot_token",
    accessToken: "xoxb-test-token",
    metadata: { webhookSecret: SECRET, teamId: TEAM_ID, botUserId: "B001" },
  });
  await a.providers.channelHost.start();
}

function envelope(event: Record<string, unknown>, eventId: string, teamId = TEAM_ID): string {
  return JSON.stringify({
    token: "ignored",
    team_id: teamId,
    api_app_id: "A001",
    type: "event_callback",
    event_id: eventId,
    event_time: Math.floor(Date.now() / 1000),
    event,
  });
}

async function post(baseUrl: string, body: string, headers: Record<string, string>) {
  return fetch(`${baseUrl}/api/channels/slack/webhook`, { method: "POST", headers, body });
}

/** Scope every event assertion to THIS event's dedupeKey. The webhook route's
 * fan-out is fire-and-forget, so a prior test's in-flight ingest can bleed a
 * stray row into the next test's freshly-reset shared PGlite schema — a total
 * row count would be flaky under load; a dedupeKey-scoped query is not. */
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

function reactionEvent(): Record<string, unknown> {
  return {
    type: "reaction_added",
    user: "U100",
    reaction: "tada",
    item: { type: "message", channel: "C200", ts: "1720000000.000100" },
    item_user: "U101",
    event_ts: "1720000001.000000",
  };
}

function dmMessageEvent(): Record<string, unknown> {
  return {
    type: "message",
    channel: "D300",
    channel_type: "im",
    user: "U100",
    text: "hello valet",
    ts: "1720000002.000100",
    event_ts: "1720000002.000100",
  };
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

  it("drops x-slack-retry-num redeliveries with an immediate 200 and no ingestion", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedSlackOrg(api);
    await seedSubscription(api, ["slack.reaction_added"]);
    const body = envelope(reactionEvent(), "Ev-retry");
    const res = await post(api.baseUrl, body, { ...sign(body, Math.floor(Date.now() / 1000)), "x-slack-retry-num": "1" });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 250));
    expect(await eventCount(api, "Ev-retry")).toBe(0);
  });

  it("acks 200 + drop-logs unknown_org when no slack credential is configured", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    const body = envelope(reactionEvent(), "Ev-nocred");
    const res = await post(api.baseUrl, body, sign(body, Math.floor(Date.now() / 1000)));
    expect(res.status).toBe(200);
    const drops = await api.providers.db.select().from(eventDropLog).where(eq(eventDropLog.orgId, "local-org"));
    expect(drops.some((d) => d.reason === "unknown_org")).toBe(true);
  });

  it("401s a bad signature + drop-logs bad_signature", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedSlackOrg(api);
    const body = envelope(reactionEvent(), "Ev-bad");
    const res = await post(api.baseUrl, body, sign(body, Math.floor(Date.now() / 1000), "wrong-secret"));
    expect(res.status).toBe(401);
    const drops = await api.providers.db.select().from(eventDropLog).where(eq(eventDropLog.orgId, "local-org"));
    expect(drops.some((d) => d.reason === "bad_signature")).toBe(true);
    expect(await eventCount(api, "Ev-bad")).toBe(0);
  });

  it("ingests a signed reaction_added into events + delivery when subscribed", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedSlackOrg(api);
    await seedSubscription(api, ["slack.reaction_added"]);

    const body = envelope(reactionEvent(), "Ev-react-1");
    const res = await post(api.baseUrl, body, sign(body, Math.floor(Date.now() / 1000)));
    expect(res.status).toBe(200);

    await expect.poll(() => eventCount(api!, "Ev-react-1"), { timeout: 5_000 }).toBe(1);
    const [row] = await api.providers.db
      .select()
      .from(events)
      .where(and(eq(events.orgId, "local-org"), eq(events.dedupeKey, "Ev-react-1")));
    expect(row.service).toBe("slack");
    expect(row.eventKey).toBe("slack.reaction_added");
    const deliveries = await api.providers.db.select().from(eventDeliveries).where(eq(eventDeliveries.eventId, row.id));
    expect(deliveries).toHaveLength(1);
  });

  it("slack.message is ephemeral: no subscription → no events row; subscribed → row + delivery", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedSlackOrg(api);

    // No subscription — the message must never touch the events table.
    const body1 = envelope(dmMessageEvent(), "Ev-msg-1");
    expect((await post(api.baseUrl, body1, sign(body1, Math.floor(Date.now() / 1000)))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(await eventCount(api, "Ev-msg-1")).toBe(0);

    // Subscribe, redeliver a fresh event id — now it persists.
    await seedSubscription(api, ["slack.message"]);
    const body2 = envelope(dmMessageEvent(), "Ev-msg-2");
    expect((await post(api.baseUrl, body2, sign(body2, Math.floor(Date.now() / 1000)))).status).toBe(200);
    await expect.poll(() => eventCount(api!, "Ev-msg-2"), { timeout: 5_000 }).toBe(1);
    const [row] = await api.providers.db
      .select()
      .from(events)
      .where(and(eq(events.orgId, "local-org"), eq(events.dedupeKey, "Ev-msg-2")));
    expect(row.eventKey).toBe("slack.message");
  });

  it("routes a DM through the channel consumer: unlinked sender → unlinked_sender drop log", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedSlackOrg(api);

    const body = envelope(dmMessageEvent(), "Ev-dm-1");
    expect((await post(api.baseUrl, body, sign(body, Math.floor(Date.now() / 1000)))).status).toBe(200);

    await expect
      .poll(
        async () => {
          const drops = await api!.providers.db.select().from(eventDropLog).where(eq(eventDropLog.orgId, "local-org"));
          return drops.some((d) => d.reason === "unlinked_sender");
        },
        { timeout: 5_000 },
      )
      .toBe(true);
  });

  it("401s (not 500) a crafted multibyte signature header", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedSlackOrg(api);
    const body = envelope(reactionEvent(), "Ev-crafted");
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await post(api.baseUrl, body, {
      "Content-Type": "application/json",
      "X-Slack-Signature": "v0=" + "0".repeat(63) + "é",
      "X-Slack-Request-Timestamp": ts,
    });
    expect(res.status).toBe(401);
  });

  it("never ingests the bot's own message even when slack.message is subscribed", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedSlackOrg(api);
    await seedSubscription(api, ["slack.message"]);
    const botMsg = { ...dmMessageEvent(), bot_id: "B001", channel_type: "channel", channel: "C200" };
    const body = envelope(botMsg, "Ev-botmsg");
    expect((await post(api.baseUrl, body, sign(body, Math.floor(Date.now() / 1000)))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(await eventCount(api, "Ev-botmsg")).toBe(0);
  });

  it("drop-logs unknown_org for a foreign team_id and ingests nothing", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await seedSlackOrg(api);
    await seedSubscription(api, ["slack.reaction_added"]);

    const body = envelope(reactionEvent(), "Ev-foreign", "T9999");
    expect((await post(api.baseUrl, body, sign(body, Math.floor(Date.now() / 1000)))).status).toBe(200);

    await expect
      .poll(
        async () => {
          const drops = await api!.providers.db.select().from(eventDropLog).where(eq(eventDropLog.orgId, "local-org"));
          return drops.some((d) => d.reason === "unknown_org" && (d.detail ?? "").includes("T9999"));
        },
        { timeout: 5_000 },
      )
      .toBe(true);
    expect(await eventCount(api, "Ev-foreign")).toBe(0);
  });
});
