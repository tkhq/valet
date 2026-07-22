import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChannelTransport, InboundChannelEvent } from "@valet/engine";
import { startFakeSlackApi, type FakeSlackApi } from "../../test/fake-slack-api.js";
import {
  SlackTransport,
  cleanSlackText,
  conversationKeyFor,
  parseConversationKey,
  slackTransportFactory,
} from "./transport.js";

const CREDENTIAL = {
  type: "bot_token" as const,
  accessToken: "xoxb-test",
  metadata: { webhookSecret: "signing-secret", teamId: "T1", botUserId: "UBOT" },
};

function makeTransport(baseUrl: string, extraMetadata: Record<string, unknown> = {}): SlackTransport {
  const transport = slackTransportFactory.create({
    credential: { ...CREDENTIAL, metadata: { ...CREDENTIAL.metadata, ...extraMetadata } },
    config: { apiBaseUrl: baseUrl },
  });
  // The factory is typed to return the interface; the Slack-specific surface
  // (extras, key codec) is what these tests exercise.
  if (!(transport instanceof SlackTransport)) throw new Error("factory did not build a SlackTransport");
  return transport;
}

function dmMessageBody(overrides: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: "T1",
    event_id: "Ev123",
    event: {
      type: "message",
      channel: "D555",
      channel_type: "im",
      user: "U777",
      text: "hello there",
      ts: "1700000001.000100",
      ...overrides,
    },
    ...envelope,
  };
}

function sign(body: string, secret: string, timestamp: string): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
}

/** Most recent recorded call for a Web API method (Array.findLast is ES2023, lib is ES2022). */
function lastCall(fake: FakeSlackApi, method: string): { method: string; body: Record<string, unknown> } | undefined {
  for (let i = fake.calls.length - 1; i >= 0; i--) {
    if (fake.calls[i].method === method) return fake.calls[i];
  }
  return undefined;
}

describe("slackTransportFactory", () => {
  it("throws without an access token", () => {
    expect(() =>
      slackTransportFactory.create({
        credential: { type: "bot_token", metadata: { webhookSecret: "s" } },
        config: {},
      }),
    ).toThrow(/bot token/);
  });

  it("throws without metadata.webhookSecret", () => {
    expect(() =>
      slackTransportFactory.create({
        credential: { type: "bot_token", accessToken: "xoxb", metadata: { teamId: "T1" } },
        config: {},
      }),
    ).toThrow(/webhookSecret/);
  });

  it("declares external-webhook ingress", () => {
    expect(slackTransportFactory.ingress).toBe("external-webhook");
    expect(slackTransportFactory.channelType).toBe("slack");
  });

  it("only exposes poll when an app token is present", () => {
    const without = makeTransport("http://127.0.0.1:1");
    expect(without.poll).toBeUndefined();
    const withToken = makeTransport("http://127.0.0.1:1", { appToken: "xapp-1" });
    expect(withToken.poll).toBeDefined();
  });
});

describe("conversation key codec", () => {
  const transport = makeTransport("http://127.0.0.1:1");

  it("round-trips a threaded key through threadKey and back", () => {
    const conversationKey = conversationKeyFor("T1", "C42", "1700.0001");
    const threadKey = transport.threadKeyFromConversationKey(conversationKey);
    expect(threadKey).toBe("slack:C42:1700.0001");
    expect(transport.conversationKeyFromThreadKey(threadKey)).toBe(conversationKey);
  });

  it("round-trips an unthreaded key through threadKey and back", () => {
    const conversationKey = conversationKeyFor("T1", "C42");
    const threadKey = transport.threadKeyFromConversationKey(conversationKey);
    expect(threadKey).toBe("slack:C42");
    expect(transport.conversationKeyFromThreadKey(threadKey)).toBe(conversationKey);
  });

  it("round-trips the other direction (threadKey → conversationKey → threadKey)", () => {
    expect(transport.threadKeyFromConversationKey(transport.conversationKeyFromThreadKey("slack:D9:1.2") ?? "")).toBe(
      "slack:D9:1.2",
    );
    expect(transport.threadKeyFromConversationKey(transport.conversationKeyFromThreadKey("slack:D9") ?? "")).toBe(
      "slack:D9",
    );
  });

  it("returns null for non-slack thread keys", () => {
    expect(transport.conversationKeyFromThreadKey("telegram:dm:123")).toBeNull();
    expect(transport.conversationKeyFromThreadKey("slack:")).toBeNull();
  });

  it("parses conversation keys", () => {
    expect(parseConversationKey("slack:T1:C2:3.4")).toEqual({ teamId: "T1", channelId: "C2", threadTs: "3.4" });
    expect(parseConversationKey("slack:T1:C2")).toEqual({ teamId: "T1", channelId: "C2", threadTs: undefined });
    expect(parseConversationKey("telegram:dm:1")).toBeNull();
  });
});

describe("verifyWebhook", () => {
  const transport: ChannelTransport = makeTransport("http://127.0.0.1:1");
  const secrets = { webhookSecret: "signing-secret" };

  it("accepts a signed JSON Events API body", () => {
    const body = JSON.stringify(dmMessageBody());
    const timestamp = String(Math.floor(Date.now() / 1000));
    const updates = transport.verifyWebhook(
      {
        headers: {
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        rawBody: new TextEncoder().encode(body),
      },
      secrets,
    );
    expect(updates).not.toBeNull();
    expect(updates).toHaveLength(1);
    expect((updates?.[0] as Record<string, unknown>).type).toBe("event_callback");
  });

  it("decodes a signed form-encoded interactivity payload", () => {
    const payload = { type: "block_actions", trigger_id: "tr1" };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const updates = transport.verifyWebhook(
      {
        headers: {
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": sign(body, "signing-secret", timestamp),
        },
        rawBody: new TextEncoder().encode(body),
      },
      secrets,
    );
    expect(updates).toEqual([payload]);
  });

  it("rejects a bad signature", () => {
    const body = JSON.stringify(dmMessageBody());
    const timestamp = String(Math.floor(Date.now() / 1000));
    const updates = transport.verifyWebhook(
      {
        headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": "v0=deadbeef" },
        rawBody: new TextEncoder().encode(body),
      },
      secrets,
    );
    expect(updates).toBeNull();
  });

  it("rejects when the secret is missing", () => {
    const body = JSON.stringify(dmMessageBody());
    expect(
      transport.verifyWebhook({ headers: {}, rawBody: new TextEncoder().encode(body) }, {}),
    ).toBeNull();
  });
});

describe("parseUpdate", () => {
  const transport = makeTransport("http://127.0.0.1:1");

  it("parses a DM message", () => {
    const event = transport.parseUpdate(dmMessageBody());
    expect(event).not.toBeNull();
    expect(event?.kind).toBe("message");
    expect(event?.dispatchId).toBe("slack:Ev123");
    expect(event?.conversationKey).toBe("slack:T1:D555:1700000001.000100");
    expect(event?.sender.externalId).toBe("U777");
    expect(event?.text).toBe("hello there");
    expect(event?.context).toBeUndefined();
  });

  it("continues an existing Slack thread via thread_ts", () => {
    const event = transport.parseUpdate(dmMessageBody({ thread_ts: "1699.5" }));
    expect(event?.conversationKey).toBe("slack:T1:D555:1699.5");
  });

  it("parses an app_mention with mention context and strips the self-mention", () => {
    const event = transport.parseUpdate(
      dmMessageBody(
        { type: "app_mention", channel: "C900", channel_type: undefined, text: "<@UBOT> do the thing" },
        { event_id: "Ev900" },
      ),
    );
    expect(event).not.toBeNull();
    expect(event?.kind).toBe("message");
    expect(event?.dispatchId).toBe("slack:Ev900");
    expect(event?.text).toBe("do the thing");
    expect(event?.context).toEqual({ mention: true, channelLabel: "#C900" });
    expect(event?.conversationKey).toBe("slack:T1:C900:1700000001.000100");
  });

  it("drops bot echoes (bot_id present)", () => {
    expect(transport.parseUpdate(dmMessageBody({ bot_id: "B99" }))).toBeNull();
  });

  it("drops legacy SKIP_SUBTYPES", () => {
    expect(transport.parseUpdate(dmMessageBody({ subtype: "message_changed" }))).toBeNull();
    expect(transport.parseUpdate(dmMessageBody({ subtype: "channel_join" }))).toBeNull();
    expect(transport.parseUpdate(dmMessageBody({ subtype: "some_future_subtype" }))).toBeNull();
  });

  it("allows the file_share subtype and extracts media", () => {
    const event = transport.parseUpdate(
      dmMessageBody({
        subtype: "file_share",
        files: [
          { id: "F1", url_private: "http://x/f1", mimetype: "image/png", name: "shot.png", size: 123 },
          { id: "F2", url_private: "http://x/f2", mimetype: "application/pdf", name: "doc.pdf", size: 456 },
        ],
      }),
    );
    expect(event?.media).toEqual([
      { kind: "photo", fileId: "F1", mimeType: "image/png", fileName: "shot.png", fileSize: 123 },
      { kind: "document", fileId: "F2", mimeType: "application/pdf", fileName: "doc.pdf", fileSize: 456 },
    ]);
  });

  it("drops plain channel messages (non-im, no mention)", () => {
    expect(transport.parseUpdate(dmMessageBody({ channel: "C1", channel_type: "channel" }))).toBeNull();
  });

  it("drops assistant thread events", () => {
    expect(
      transport.parseUpdate(dmMessageBody({ type: "assistant_thread_started" })),
    ).toBeNull();
  });

  it("decodes block_actions into a gate_callback with the embedded gateId", () => {
    const event = transport.parseUpdate({
      type: "block_actions",
      trigger_id: "trig-1",
      team: { id: "T1" },
      user: { id: "U777", username: "conner" },
      channel: { id: "D555" },
      container: { channel_id: "D555", message_ts: "1700.42", thread_ts: "1700.40" },
      actions: [{ action_id: "approve", value: "g|gate-abc|approve" }],
    });
    expect(event).not.toBeNull();
    expect(event?.kind).toBe("gate_callback");
    expect(event?.dispatchId).toBe("slack:ia:trig-1");
    expect(event?.conversationKey).toBe("slack:T1:D555:1700.40");
    expect(event?.sender).toEqual({ externalId: "U777", displayName: "conner" });
    expect(event?.gateCallback).toEqual({
      actionId: "approve",
      gateId: "gate-abc",
      callbackId: "trig-1",
      ref: { conversationKey: "slack:T1:D555:1700.40", messageId: "1700.42" },
    });
  });

  it("rejects block_actions with malformed values", () => {
    const base = {
      type: "block_actions",
      trigger_id: "trig-2",
      user: { id: "U777" },
      channel: { id: "D555" },
      container: { channel_id: "D555", message_ts: "1700.42" },
    };
    expect(transport.parseUpdate({ ...base, actions: [{ action_id: "a", value: "not-a-gate" }] })).toBeNull();
    expect(transport.parseUpdate({ ...base, actions: [{ action_id: "a", value: "g|only-gate" }] })).toBeNull();
  });

  it("returns null for unknown update shapes", () => {
    expect(transport.parseUpdate(null)).toBeNull();
    expect(transport.parseUpdate("nope")).toBeNull();
    expect(transport.parseUpdate({ type: "url_verification", challenge: "x" })).toBeNull();
  });
});

describe("cleanSlackText", () => {
  it("strips self-mentions, decodes channel and url links", () => {
    expect(cleanSlackText("<@UBOT> check <#C1|general> and <https://x.dev|the site> or <https://y.dev>", "UBOT")).toBe(
      "check #general and the site or https://y.dev",
    );
  });

  it("keeps other mentions as @USERID", () => {
    expect(cleanSlackText("ping <@U123>")).toBe("ping @U123");
  });
});

describe("outbound against a fake Slack API", () => {
  let fake: FakeSlackApi;
  let transport: SlackTransport;

  beforeAll(async () => {
    fake = await startFakeSlackApi();
    transport = makeTransport(fake.baseUrl);
  });

  afterAll(async () => {
    await fake.close();
  });

  it("send posts mrkdwn with thread_ts and unfurl_links=false", async () => {
    const ref = await transport.send("slack:T1:C7:1700.1", { markdown: "**bold** hi" });
    const call = lastCall(fake, "chat.postMessage");
    expect(call?.body.channel).toBe("C7");
    expect(call?.body.thread_ts).toBe("1700.1");
    expect(call?.body.text).toBe("*bold* hi");
    expect(call?.body.unfurl_links).toBe(false);
    expect(call?.body.blocks).toBeUndefined();
    expect(ref.conversationKey).toBe("slack:T1:C7:1700.1");
    expect(ref.messageId).toMatch(/^1700000000\./);
  });

  it("send switches to blocks for messages over 4000 chars", async () => {
    const long = "line of text\n".repeat(400); // > 4000 chars
    await transport.send("slack:T1:C7", { markdown: long });
    const call = lastCall(fake, "chat.postMessage");
    const blocks = call?.body.blocks as Array<Record<string, unknown>>;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks[0].type).toBe("markdown");
    expect((call?.body.text as string).length).toBeLessThanOrEqual(4000);
    expect(call?.body.thread_ts).toBeUndefined();
  });

  it("sendMedia runs the v2 external upload flow", async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const ref = await transport.sendMedia("slack:T1:C7:1700.2", {
      type: "image",
      data,
      mimeType: "image/png",
      name: "pic.png",
      caption: "look",
    });
    const getUrl = lastCall(fake, "files.getUploadURLExternal");
    expect(getUrl?.body.filename).toBe("pic.png");
    expect(getUrl?.body.length).toBe("4"); // form-encoded
    expect(fake.uploads.at(-1)?.bytes).toEqual(data);
    const complete = lastCall(fake, "files.completeUploadExternal");
    expect(complete?.body.channel_id).toBe("C7");
    expect(complete?.body.thread_ts).toBe("1700.2");
    expect(complete?.body.initial_comment).toBe("look");
    expect(ref.messageId).toBe(fake.uploads.at(-1)?.fileId);
  });

  it("sendGatePrompt encodes g|gateId|actionId values and styles", async () => {
    const ref = await transport.sendGatePrompt("slack:T1:D5:1700.3", {
      gateId: "gate-77",
      title: "Approve deploy?",
      body: "Deploy `v1.2` to prod",
      actions: [
        { id: "approve", label: "Approve", style: "primary" },
        { id: "deny", label: "Deny", style: "danger" },
      ],
    });
    const call = lastCall(fake, "chat.postMessage");
    const blocks = call?.body.blocks as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("section");
    const section = blocks[0].text as Record<string, unknown>;
    expect(section.type).toBe("mrkdwn");
    expect(section.text).toContain("*Approve deploy?*");
    const elements = (blocks[1] as { elements: Array<Record<string, unknown>> }).elements;
    expect(elements).toEqual([
      {
        type: "button",
        text: { type: "plain_text", text: "Approve" },
        action_id: "approve",
        value: "g|gate-77|approve",
        style: "primary",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Deny" },
        action_id: "deny",
        value: "g|gate-77|deny",
        style: "danger",
      },
    ]);

    // updateGatePrompt: original text + resolution line, buttons cleared, parse pinned
    await transport.updateGatePrompt(ref, { actionId: "approve", label: "✅ Approved by conner" });
    const update = lastCall(fake, "chat.update");
    expect(update?.body.ts).toBe(ref.messageId);
    expect(update?.body.channel).toBe("D5");
    expect(update?.body.parse).toBe("none");
    expect(update?.body.text).toContain("*Approve deploy?*");
    expect(update?.body.text).toContain("\n\n✅ Approved by conner");
    const updateBlocks = update?.body.blocks as Array<Record<string, unknown>>;
    expect(updateBlocks).toHaveLength(1);
    expect(updateBlocks[0].type).toBe("section");
  });

  it("sendTyping calls assistant.threads.setStatus on threaded keys and swallows failures", async () => {
    await transport.sendTyping("slack:T1:D5:1700.4");
    const call = lastCall(fake, "assistant.threads.setStatus");
    expect(call?.body).toMatchObject({ channel_id: "D5", thread_ts: "1700.4", status: "is thinking..." });

    fake.failNext("assistant.threads.setStatus");
    await expect(transport.sendTyping("slack:T1:D5:1700.5")).resolves.toBeUndefined();

    // Unthreaded key → no call at all
    const before = fake.calls.filter((c) => c.method === "assistant.threads.setStatus").length;
    await transport.sendTyping("slack:T1:C7");
    const after = fake.calls.filter((c) => c.method === "assistant.threads.setStatus").length;
    expect(after).toBe(before);
  });

  it("fetchMedia downloads url_private captured at parseUpdate time", async () => {
    const bytes = new Uint8Array([9, 9, 9]);
    fake.addFile("f-inline", bytes);
    const update = dmMessageBody({
      subtype: "file_share",
      files: [{ id: "F-dl", url_private: `${fake.baseUrl}/files/f-inline`, mimetype: "application/pdf", name: "a.pdf", size: 3 }],
    });
    const inbound = transport.parseUpdate(update) as InboundChannelEvent;
    const media = inbound.media?.[0];
    expect(media).toBeDefined();
    const fetched = media ? await transport.fetchMedia(media) : null;
    expect(fetched).not.toBeNull();
    expect(fetched?.data).toEqual(bytes);
    expect(fetched?.mimeType).toBe("application/pdf");
    expect(fetched?.name).toBe("a.pdf");
  });

  it("fetchMedia returns null when the declared size exceeds the cap", async () => {
    const update = dmMessageBody({
      subtype: "file_share",
      files: [
        {
          id: "F-huge",
          url_private: `${fake.baseUrl}/files/missing`,
          mimetype: "application/zip",
          name: "big.zip",
          size: 26 * 1024 * 1024,
        },
      ],
    });
    const inbound = transport.parseUpdate(update) as InboundChannelEvent;
    const media = inbound.media?.[0];
    const fetched = media ? await transport.fetchMedia(media) : null;
    expect(fetched).toBeNull();
  });

  it("fetchMedia re-derives url_private via files.info when untracked", async () => {
    const bytes = new Uint8Array([5, 5]);
    fake.addFile("f-info", bytes);
    fake.setFileInfo("F-info", {
      id: "F-info",
      url_private: `${fake.baseUrl}/files/f-info`,
      mimetype: "text/plain",
      name: "note.txt",
      size: 2,
    });
    const fetched = await transport.fetchMedia({ kind: "document", fileId: "F-info" });
    expect(fetched?.data).toEqual(bytes);
    expect(fetched?.name).toBe("note.txt");
  });

  it("openDirectConversation returns the IM conversationKey", async () => {
    const key = await transport.openDirectConversation("U42");
    expect(key).toBe("slack:T1:D-U42");
    const call = lastCall(fake, "conversations.open");
    expect(call?.body.users).toBe("U42");
  });

  it("listWorkspaceMembers filters bots, deleted users, and by query", async () => {
    fake.setMembers([
      { id: "U1", name: "conner", real_name: "Conner Swann" },
      { id: "U2", name: "botty", is_bot: true },
      { id: "U3", name: "gone", deleted: true },
      { id: "USLACKBOT", name: "slackbot" },
      { id: "U4", name: "sam", profile: { real_name: "Sam Connerly" } },
      { id: "U5", name: "alex", real_name: "Alex Doe" },
    ]);
    const all = await transport.listWorkspaceMembers("");
    expect(all.map((m) => m.id)).toEqual(["U1", "U4", "U5"]);
    const matched = await transport.listWorkspaceMembers("conner");
    expect(matched).toEqual([
      { id: "U1", name: "conner", realName: "Conner Swann" },
      { id: "U4", name: "sam", realName: "Sam Connerly" },
    ]);
  });
});
