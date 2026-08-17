import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ChannelStreamError, type StoredCredential } from "@valet/engine";
import { startFakeSlackApi, type FakeSlackApi } from "../../test/fake-slack-api.js";
import {
  cleanSlackText,
  conversationKeyFor,
  parseConversationKey,
  slackTransportFactory,
  SlackTransport,
  splitForStream,
} from "./transport.js";

const TEAM = "T1";
const CHANNEL = "D100";
const KEY = conversationKeyFor(TEAM, CHANNEL);
const SIGNING_SECRET = "shh";

let fake: FakeSlackApi;

beforeAll(async () => {
  fake = await startFakeSlackApi();
});

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.calls.length = 0;
  fake.streams.clear();
});

function credential(metadata: Record<string, unknown>): StoredCredential {
  return { type: "bot_token", accessToken: "xoxb-test", metadata };
}

/** A transport wired at the fake API, with the metadata a real credential carries. */
function makeTransport(extraMetadata: Record<string, unknown> = {}): SlackTransport {
  const transport = slackTransportFactory.create({
    credential: credential({
      teamId: TEAM,
      signingSecret: SIGNING_SECRET,
      botUserId: "UBOT",
      ...extraMetadata,
    }),
    config: { apiBaseUrl: fake.baseUrl },
  });
  if (!(transport instanceof SlackTransport)) throw new Error("factory returned the wrong type");
  return transport;
}

/** Wrap an inner Events API event the way Slack posts it. */
function envelope(event: Record<string, unknown>, eventId = "Ev1"): Record<string, unknown> {
  return { type: "event_callback", event_id: eventId, team_id: TEAM, event };
}

function imMessage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message",
    channel_type: "im",
    channel: CHANNEL,
    user: "U1",
    text: "hello",
    ts: "1700000000.000100",
    ...over,
  };
}

/** Drive one inbound turn so the transport learns the conversation's thread. */
function primeTurn(transport: SlackTransport, ts = "1700000000.000100"): void {
  transport.parseUpdate(envelope(imMessage({ ts }), `Ev-${ts}`));
}

function lastCall(method: string): Record<string, unknown> {
  const call = [...fake.calls].reverse().find((c) => c.method === method);
  if (!call) throw new Error(`no ${method} call recorded`);
  return call.body;
}

describe("conversation key codec", () => {
  it("round-trips a three-part key through the engine thread key", () => {
    const transport = makeTransport();
    const threadKey = transport.threadKeyFromConversationKey(KEY);
    expect(threadKey).toBe(`slack:${CHANNEL}`);
    expect(transport.conversationKeyFromThreadKey(threadKey)).toBe(KEY);
  });

  it("rejects keys with a thread segment, so a per-turn ts can never enter a key", () => {
    expect(parseConversationKey(`slack:${TEAM}:${CHANNEL}:1700000000.000100`)).toBeNull();
    expect(parseConversationKey("slack:T1")).toBeNull();
    expect(parseConversationKey("slack::D1")).toBeNull();
    expect(parseConversationKey("telegram:dm:9")).toBeNull();
  });

  it("does not claim another transport's thread keys", () => {
    const transport = makeTransport();
    expect(transport.conversationKeyFromThreadKey("telegram:99")).toBeNull();
    expect(transport.conversationKeyFromThreadKey("slack:")).toBeNull();
  });
});

describe("parseUpdate — the agent surface events", () => {
  it("routes a direct message and anchors the turn to the user's own message", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(envelope(imMessage()));
    expect(event).toMatchObject({
      kind: "message",
      conversationKey: KEY,
      sender: { externalId: "U1" },
      text: "hello",
      threadTs: "1700000000.000100",
      dispatchId: "slack:Ev1",
    });
  });

  it("keeps an existing thread's root when the user replies inside one", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(
      envelope(imMessage({ ts: "1700000000.000200", thread_ts: "1700000000.000100" })),
    );
    expect(event?.threadTs).toBe("1700000000.000100");
  });

  it("treats app_home_opened on the messages tab as the conversation opening", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(
      envelope({ type: "app_home_opened", user: "U1", channel: CHANNEL, tab: "messages" }, "Ev2"),
    );
    expect(event).toMatchObject({
      kind: "surface_opened",
      conversationKey: KEY,
      sender: { externalId: "U1" },
    });
    expect(event?.text).toBeUndefined();
  });

  it("ignores app_home_opened on the home tab", () => {
    const transport = makeTransport();
    expect(
      transport.parseUpdate(
        envelope({ type: "app_home_opened", user: "U1", channel: CHANNEL, tab: "home" }, "Ev3"),
      ),
    ).toBeNull();
  });

  it("consumes app_context_changed without emitting an event", () => {
    const transport = makeTransport();
    expect(
      transport.parseUpdate(
        envelope(
          { type: "app_context_changed", context: { entities: [{ type: "slack#/types/channel_id", value: "C9" }] } },
          "Ev4",
        ),
      ),
    ).toBeNull();
  });

  it("carries app context injected into a message", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(
      envelope(
        imMessage({
          context: { entities: [{ type: "slack#/types/channel_id", value: "C9", team_id: TEAM }] },
        }),
      ),
    );
    expect(event?.context).toEqual({ entities: [{ type: "slack#/types/channel_id", value: "C9" }] });
  });

  it("tolerates an empty context object, which arrives with no entities key", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(envelope(imMessage({ context: {} })));
    expect(event?.context).toBeUndefined();
  });

  it("drops the app's own streamed output instead of answering itself", () => {
    const transport = makeTransport();
    expect(transport.parseUpdate(envelope(imMessage({ bot_id: "B1", user: "UBOT" })))).toBeNull();
    expect(transport.parseUpdate(envelope(imMessage({ user: "UBOT" })))).toBeNull();
  });

  it("drops edits, deletes and system notices", () => {
    const transport = makeTransport();
    for (const subtype of ["message_changed", "message_deleted", "channel_join"]) {
      expect(transport.parseUpdate(envelope(imMessage({ subtype })))).toBeNull();
    }
  });

  it("keeps a file_share, which carries a real user turn", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(
      envelope(
        imMessage({
          subtype: "file_share",
          text: "",
          files: [{ id: "F1", url_private: "http://x/f", mimetype: "image/png", name: "a.png", size: 10 }],
        }),
      ),
    );
    expect(event?.media).toEqual([
      { kind: "photo", fileId: "F1", mimeType: "image/png", fileName: "a.png", fileSize: 10 },
    ]);
  });

  it("leaves channel traffic to the event pipeline", () => {
    const transport = makeTransport();
    expect(transport.parseUpdate(envelope(imMessage({ channel_type: "channel", channel: "C1" })))).toBeNull();
    expect(transport.parseUpdate(envelope({ type: "app_mention", channel: "C1", user: "U1", text: "hi" }))).toBeNull();
  });
});

describe("parseUpdate — gate callbacks", () => {
  const blockActions = {
    type: "block_actions",
    trigger_id: "TRIG1",
    user: { id: "U1", username: "someone" },
    team: { id: TEAM },
    channel: { id: CHANNEL },
    container: { message_ts: "1700000000.000900", thread_ts: "1700000000.000100" },
    actions: [{ value: "g|gate-77|approve" }],
  };

  it("carries the gate id from the button value so gates survive a restart", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(blockActions);
    expect(event).toMatchObject({
      kind: "gate_callback",
      conversationKey: KEY,
      gateCallback: {
        gateId: "gate-77",
        actionId: "approve",
        callbackId: "TRIG1",
        ref: { conversationKey: KEY, messageId: "1700000000.000900" },
      },
    });
  });

  it("rejects a button value that is not a gate", () => {
    const transport = makeTransport();
    expect(transport.parseUpdate({ ...blockActions, actions: [{ value: "something-else" }] })).toBeNull();
    expect(transport.parseUpdate({ ...blockActions, actions: [{ value: "g||approve" }] })).toBeNull();
    expect(transport.parseUpdate({ ...blockActions, actions: [{ value: "g|gate-77|" }] })).toBeNull();
  });
});

describe("verifyWebhook", () => {
  function signed(body: string, secret = SIGNING_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
    const digest = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
    return {
      headers: { "x-slack-request-timestamp": String(timestamp), "x-slack-signature": `v0=${digest}` },
      rawBody: new TextEncoder().encode(body),
    };
  }

  it("accepts a correctly signed event and returns the parsed body", () => {
    const transport = makeTransport();
    const body = JSON.stringify(envelope(imMessage()));
    const raws = transport.verifyWebhook(signed(body), {});
    expect(raws).toHaveLength(1);
    expect(transport.parseUpdate(raws?.[0])).toMatchObject({ kind: "message" });
  });

  it("rejects a wrong signature", () => {
    const transport = makeTransport();
    expect(transport.verifyWebhook(signed("{}", "wrong"), {})).toBeNull();
  });

  it("rejects a replayed request outside the window", () => {
    const transport = makeTransport();
    const old = Math.floor(Date.now() / 1000) - 400;
    expect(transport.verifyWebhook(signed("{}", SIGNING_SECRET, old), {})).toBeNull();
  });

  it("unwraps a form-encoded interactivity payload", () => {
    const transport = makeTransport();
    const payload = JSON.stringify({ type: "block_actions", trigger_id: "T" });
    const body = `payload=${encodeURIComponent(payload)}`;
    const raws = transport.verifyWebhook(signed(body), {});
    expect(raws?.[0]).toMatchObject({ type: "block_actions" });
  });

  it("rejects everything when no signing secret is configured", () => {
    const transport = makeTransport({ signingSecret: "" });
    expect(transport.verifyWebhook(signed("{}"), {})).toBeNull();
  });

  it("lets the host override the signing secret", () => {
    const transport = makeTransport({ signingSecret: "" });
    expect(transport.verifyWebhook(signed("{}", "host-held"), { signingSecret: "host-held" })).toEqual([{}]);
  });
});

describe("streaming", () => {
  it("opens a stream anchored to the turn's thread, appends, then closes it", async () => {
    const transport = makeTransport();
    const ref = await transport.startStream(KEY, { threadTs: "1700000000.000100" });
    expect(ref).toMatchObject({ conversationKey: KEY, threadTs: "1700000000.000100" });
    expect(lastCall("chat.startStream")).toMatchObject({
      channel: CHANNEL,
      thread_ts: "1700000000.000100",
    });

    await transport.appendStream(ref, "one ");
    await transport.appendStream(ref, "two");
    await transport.stopStream(ref, { markdown: "done" });

    const stream = fake.streams.get(ref.messageId);
    expect(stream?.appended).toEqual(["one ", "two"]);
    expect(stream?.open).toBe(false);
    expect(stream?.final).toBe("done");
  });

  it("omits recipient_user_id, which Slack requires only for channels", async () => {
    const transport = makeTransport();
    await transport.startStream(KEY, { threadTs: "1700000000.000100" });
    expect(lastCall("chat.startStream")).not.toHaveProperty("recipient_user_id");
  });

  it("splits an append over the 12,000-character limit without losing a character", async () => {
    const transport = makeTransport();
    const ref = await transport.startStream(KEY, { threadTs: "1700000000.000100" });
    const long = `${"a".repeat(9000)}\n\n${"b".repeat(9000)}`;
    await transport.appendStream(ref, long);
    const stream = fake.streams.get(ref.messageId);
    expect(stream?.appended.length).toBeGreaterThan(1);
    for (const piece of stream?.appended ?? []) expect(piece.length).toBeLessThanOrEqual(12_000);
    expect(stream?.appended.join("")).toBe(long);
  });

  it("appends the overflow before closing rather than truncating a long final answer", async () => {
    const transport = makeTransport();
    const ref = await transport.startStream(KEY, { threadTs: "1700000000.000100" });
    const long = "z".repeat(20_000);
    await transport.stopStream(ref, { markdown: long });
    const stream = fake.streams.get(ref.messageId);
    expect(stream?.open).toBe(false);
    expect(`${stream?.appended.join("")}${stream?.final ?? ""}`).toBe(long);
  });

  it("splits losslessly, keeping the newline it broke on", () => {
    expect(splitForStream("aa\nbb\ncc", 4).join("")).toBe("aa\nbb\ncc");
    expect(splitForStream("aaaaaaa", 3)).toEqual(["aaa", "aaa", "a"]);
    expect(splitForStream("short", 100)).toEqual(["short"]);
    expect(splitForStream("", 10)).toEqual([]);
  });

  it("neutralizes a broadcast sequence rather than pinging the workspace", async () => {
    const transport = makeTransport();
    const ref = await transport.startStream(KEY, { threadTs: "1700000000.000100" });
    await transport.appendStream(ref, "the doc said <!channel> and <@U123>");
    expect(fake.streams.get(ref.messageId)?.appended[0]).toBe(
      "the doc said &lt;!channel> and &lt;@U123>",
    );
  });

  it("leaves ordinary angle brackets alone on the markdown path", async () => {
    const transport = makeTransport();
    const ref = await transport.startStream(KEY, { threadTs: "1700000000.000100" });
    await transport.appendStream(ref, "`Array<string>` and 3 < 4");
    expect(fake.streams.get(ref.messageId)?.appended[0]).toBe("`Array<string>` and 3 < 4");
  });

  it("reports a reader-cancelled stream as stopped_by_user so the turn can abort", async () => {
    const transport = makeTransport();
    const ref = await transport.startStream(KEY, { threadTs: "1700000000.000100" });
    fake.stopStreamAsUser(ref.messageId);
    await expect(transport.appendStream(ref, "more")).rejects.toMatchObject({
      name: "ChannelStreamError",
      kind: "stopped_by_user",
    });
  });

  it("reports an already-closed stream as stream_gone", async () => {
    const transport = makeTransport();
    const ref = await transport.startStream(KEY, { threadTs: "1700000000.000100" });
    await transport.stopStream(ref);
    const err = await transport.appendStream(ref, "late").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelStreamError);
    expect(err).toMatchObject({ kind: "stream_gone" });
  });

  it("reports an unmapped failure as unknown rather than pretending it is retryable", async () => {
    const transport = makeTransport();
    fake.failNext("chat.startStream", "invalid_blocks");
    await expect(transport.startStream(KEY, { threadTs: "1700000000.000100" })).rejects.toMatchObject({
      kind: "unknown",
    });
  });

  it("declares the whole streaming triple, so the host can feature-detect it", () => {
    const transport = makeTransport();
    expect(typeof transport.startStream).toBe("function");
    expect(typeof transport.appendStream).toBe("function");
    expect(typeof transport.stopStream).toBe("function");
  });
});

describe("assistant thread controls", () => {
  it("sets a status on a thread", async () => {
    const transport = makeTransport();
    await transport.setStatus(KEY, "1700000000.000100", "is thinking...");
    expect(lastCall("assistant.threads.setStatus")).toEqual({
      channel_id: CHANNEL,
      thread_ts: "1700000000.000100",
      status: "is thinking...",
    });
  });

  it("omits thread_ts for a conversation with no turn yet", async () => {
    const transport = makeTransport();
    await transport.setSuggestedPrompts(KEY, [{ title: "Connect Valet", message: "How do I link my account?" }]);
    const body = lastCall("assistant.threads.setSuggestedPrompts");
    expect(body).not.toHaveProperty("thread_ts");
    expect(body.channel_id).toBe(CHANNEL);
  });

  it("keeps at most the four prompts Slack renders", async () => {
    const transport = makeTransport();
    await transport.setSuggestedPrompts(
      KEY,
      [1, 2, 3, 4, 5, 6].map((n) => ({ title: `t${n}`, message: `m${n}` })),
    );
    const prompts = lastCall("assistant.threads.setSuggestedPrompts").prompts;
    expect(Array.isArray(prompts) ? prompts.length : 0).toBe(4);
  });

  it("does not call Slack with an empty prompt list", async () => {
    const transport = makeTransport();
    await transport.setSuggestedPrompts(KEY, []);
    expect(fake.calls.some((c) => c.method === "assistant.threads.setSuggestedPrompts")).toBe(false);
  });

  it("titles a thread", async () => {
    const transport = makeTransport();
    await transport.setThreadTitle(KEY, "1700000000.000100", "Deploy the worker");
    expect(lastCall("assistant.threads.setTitle")).toEqual({
      channel_id: CHANNEL,
      thread_ts: "1700000000.000100",
      title: "Deploy the worker",
    });
  });

  it("shows the status shimmer on the most recent turn", async () => {
    const transport = makeTransport();
    primeTurn(transport, "1700000000.000500");
    await transport.sendTyping(KEY);
    expect(lastCall("assistant.threads.setStatus").thread_ts).toBe("1700000000.000500");
  });

  it("stays quiet when no turn has arrived yet", async () => {
    const transport = makeTransport();
    await transport.sendTyping(KEY);
    expect(fake.calls.some((c) => c.method === "assistant.threads.setStatus")).toBe(false);
  });
});

describe("gate prompts", () => {
  it("posts the gate under the turn that raised it, with the gate id in the button", async () => {
    const transport = makeTransport();
    primeTurn(transport, "1700000000.000700");
    const ref = await transport.sendGatePrompt(KEY, {
      gateId: "gate-77",
      title: "Deploy?",
      body: "This ships to production.",
      actions: [
        { id: "approve", label: "Approve", style: "primary" },
        { id: "deny", label: "Deny", style: "danger" },
      ],
    });
    const body = lastCall("chat.postMessage");
    expect(body.thread_ts).toBe("1700000000.000700");
    const blocks = body.blocks;
    if (!Array.isArray(blocks)) throw new Error("expected blocks");
    const actions = blocks[1];
    expect(actions).toMatchObject({
      type: "actions",
      elements: [
        { value: "g|gate-77|approve", style: "primary" },
        { value: "g|gate-77|deny", style: "danger" },
      ],
    });
    expect(ref.conversationKey).toBe(KEY);
  });

  it("appends the outcome and clears the buttons, pinning parse to none", async () => {
    const transport = makeTransport();
    const ref = await transport.sendGatePrompt(KEY, {
      gateId: "gate-77",
      title: "Deploy?",
      actions: [{ id: "approve", label: "Approve" }],
    });
    await transport.updateGatePrompt(ref, { actionId: "approve", label: "✅ Approved" });
    const body = lastCall("chat.update");
    expect(body.parse).toBe("none");
    expect(String(body.text)).toContain("✅ Approved");
    const blocks = body.blocks;
    expect(Array.isArray(blocks) ? blocks.length : 0).toBe(1);
  });
});

describe("discrete sends", () => {
  it("replies in the turn's thread", async () => {
    const transport = makeTransport();
    primeTurn(transport, "1700000000.000300");
    await transport.send(KEY, { markdown: "**done**" });
    const body = lastCall("chat.postMessage");
    expect(body.thread_ts).toBe("1700000000.000300");
    expect(body.text).toBe("*done*");
  });

  it("switches to blocks rather than several messages when the text is long", async () => {
    const transport = makeTransport();
    await transport.send(KEY, { markdown: "x".repeat(5000) });
    const posts = fake.calls.filter((c) => c.method === "chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(Array.isArray(posts[0].body.blocks)).toBe(true);
  });

  it("names the expected key shape when handed a key it cannot parse", async () => {
    const transport = makeTransport();
    await expect(transport.send("slack:T1:D1:9999", { markdown: "hi" })).rejects.toThrow(
      /Expected "slack:\{teamId\}:\{channelId\}"/,
    );
  });

  it("refuses a well-formed key from another workspace instead of posting anyway", async () => {
    // A host that rebuilds the key with a fixed middle segment produces
    // exactly this: it parses, its channel id is usable, and the reply would
    // land in the DM root with no error. The team check makes it loud.
    const transport = makeTransport();
    await expect(transport.send(`slack:dm:${CHANNEL}`, { markdown: "hi" })).rejects.toThrow(
      /names workspace "dm", but this transport serves "T1"/,
    );
    expect(fake.calls.some((c) => c.method === "chat.postMessage")).toBe(false);
  });
});

describe("factory", () => {
  it("declares external-webhook ingress so the host registers nothing", () => {
    expect(slackTransportFactory.ingress).toBe("external-webhook");
  });

  it("offers Socket Mode only when an app token is present", () => {
    expect(makeTransport().poll).toBeUndefined();
    expect(makeTransport({ appToken: "xapp-1" }).poll).toBeDefined();
  });

  it("names the fix when the bot token is missing", () => {
    expect(() =>
      slackTransportFactory.create({ credential: { type: "bot_token", metadata: { teamId: TEAM } }, config: {} }),
    ).toThrow(/Connect Slack in Settings/);
  });

  it("names the fix when the team id is missing", () => {
    expect(() =>
      slackTransportFactory.create({ credential: credential({}), config: {} }),
    ).toThrow(/Re-save the Slack credential/);
  });
});

describe("cleanSlackText", () => {
  it("removes the app's own mention and flattens link syntax", () => {
    expect(cleanSlackText("<@UBOT> check <https://x.dev|the docs>", "UBOT")).toBe("check the docs");
    expect(cleanSlackText("ping <@U9> in <#C1|general>")).toBe("ping @U9 in #general");
  });
});
