/**
 * The Slack account-link handshake, end to end and without Slack
 * credentials: the real Slack plugin, the real start route, the real Slack
 * transport's `parseUpdate`, and the real `ChannelHost`. Only outbound
 * `send` is stubbed, because it would call the Slack API.
 *
 * Regression (2026-10-08): a new user copied the bare code from Settings →
 * Connected accounts and pasted it into the bot DM. The bot reads only
 * `link <code>` as a link command, so every paste got the generic
 * "link your account" reply and the account never linked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import slackPlugin from "@valet/plugin-slack/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { userIdentityLinks } from "../schema/index.js";
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
});
