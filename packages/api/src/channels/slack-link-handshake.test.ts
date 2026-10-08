/**
 * The Slack account-link handshake, end to end and without Slack
 * credentials: the real Slack plugin, the real start route, the real Slack
 * transport's `parseUpdate`, and the real `ChannelHost`. Only outbound
 * `send` is stubbed, because it would call the Slack API.
 *
 * Regression (2026-10-08): a new user could not link from Settings →
 * Connected accounts. v1's flow (pick yourself, the bot DMs a code, type it
 * into Valet) existed only as a reversed v2 port on the Integrations page,
 * and Settings showed a bare code that the bot does not read as a command.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import slackPlugin from "@valet/plugin-slack/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { userIdentityLinks } from "../schema/index.js";
import { hasOpenDirect } from "./host.js";
import type { StartIdentityLinkResponse } from "../wire/types.js";

const TEAM = "T0TEST";
const SLACK_USER = "U0NEWUSER";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function bootSlack() {
  api = await bootTestApi({ plugins: [slackPlugin] });
  await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", {
    type: "bot_token",
    accessToken: "xoxb-test",
    metadata: { teamId: TEAM, signingSecret: "test-signing-secret", botUserId: "U0BOT" },
  });
  await api.providers.channelHost.start();
  const transport = api.providers.channelHost.transportFor("slack");
  if (!transport) throw new Error("the Slack transport did not start");
  const send = vi.spyOn(transport, "send").mockImplementation(async (conversationKey) => ({ conversationKey, messageId: "1" }));
  if (!hasOpenDirect(transport)) throw new Error("the Slack transport cannot open a DM");
  vi.spyOn(transport, "openDirectConversation").mockResolvedValue(`slack:${TEAM}:D0DM:1700000000.000001`);
  return { api, transport, send };
}

/** A DM from the new user, wrapped the way Slack's Events API posts it. */
function dm(text: string, eventId: string): Record<string, unknown> {
  return {
    type: "event_callback",
    event_id: eventId,
    team_id: TEAM,
    event: { type: "message", channel_type: "im", channel: "D0DM", user: SLACK_USER, text, ts: "1700000000.000100" },
  };
}

async function startLink(booted: TestApi): Promise<StartIdentityLinkResponse> {
  const res = await fetch(`${booted.baseUrl}/api/me/identity-links/slack/start`, { method: "POST" });
  expect(res.status).toBe(200);
  return (await res.json()) as StartIdentityLinkResponse;
}

describe("Slack account-link handshake", () => {
  it.each([
    ["the reply line the card shows", (start: StartIdentityLinkResponse) => start.replyText ?? ""],
    ["a pasted bare code", (start: StartIdentityLinkResponse) => start.code],
  ])("links the account from %s", async (_label, message) => {
    const { api: booted, transport, send } = await bootSlack();
    const start = await startLink(booted);
    expect(start.replyText).toBe(`link ${start.code}`);

    const parsed = transport.parseUpdate(dm(message(start), `Ev-${start.code}`));
    if (!parsed) throw new Error("the Slack transport dropped the DM");
    await booted.providers.channelHost.handleUpdate("slack", parsed);

    const links = await booted.providers.db.select().from(userIdentityLinks).where(eq(userIdentityLinks.provider, "slack"));
    expect(links).toEqual([expect.objectContaining({ externalId: SLACK_USER, userId: "local-user" })]);
    expect(send.mock.calls.at(-1)?.[1].markdown).toContain("Linked");
  });

  // The intended flow, as in v1: pick yourself, the bot DMs a code, and you
  // type it into Valet.
  it("links the account the bot DMed after the code is entered in Valet", async () => {
    const { api: booted, transport, send } = await bootSlack();
    const delivered = await fetch(`${booted.baseUrl}/api/me/identity-links/slack/deliver`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalId: SLACK_USER, displayName: "new user" }),
    });
    expect(delivered.status).toBe(200);
    const code = /`([^`]+)`/.exec(send.mock.calls[0]?.[1].markdown ?? "")?.[1];
    if (!code) throw new Error("the DM carried no code");

    // The DM recipient replying with the code from Slack links nothing.
    const reply = transport.parseUpdate(dm(`link ${code}`, "Ev-reply"));
    if (!reply) throw new Error("the Slack transport dropped the reply");
    await booted.providers.channelHost.handleUpdate("slack", reply);
    const before = await booted.providers.db.select().from(userIdentityLinks).where(eq(userIdentityLinks.provider, "slack"));
    expect(before).toHaveLength(0);

    const verified = await fetch(`${booted.baseUrl}/api/me/identity-links/slack/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(verified.status).toBe(200);
    const links = await booted.providers.db.select().from(userIdentityLinks).where(eq(userIdentityLinks.provider, "slack"));
    expect(links).toEqual([expect.objectContaining({ externalId: SLACK_USER, userId: "local-user" })]);
  });
});
