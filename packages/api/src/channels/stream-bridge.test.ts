/**
 * The failure paths get one test each, because each of them ends with a
 * person looking at a Slack message that never stops shimmering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChannelStreamError,
  InMemoryEventStream,
  type BusEvent,
  type ChannelGatePrompt,
  type ChannelTransport,
  type EngineEvent,
  type OutboundChannelMessage,
  type StreamRef,
} from "@valet/engine";
import { MemoryActiveStreamStore } from "./active-streams.js";
import {
  ChannelStreamBridge,
  FLUSH_INTERVAL_MS,
  MAX_MARKDOWN_CHARS,
  splitForFlush,
  type StreamTurn,
} from "./stream-bridge.js";

const SESSION_ID = "orchestrator:user:u1";
const THREAD_ID = "t1";
const CHANNEL_TYPE = "slack";
const CONVERSATION_KEY = "slack:T1:D1";
const THREAD_TS = "1700000000.000100";

interface AppendCall {
  messageId: string;
  markdown: string;
  at: number;
}

class FakeStreamTransport implements ChannelTransport {
  readonly channelType = CHANNEL_TYPE;
  started: Array<{ conversationKey: string; threadTs: string }> = [];
  appends: AppendCall[] = [];
  stopped: Array<{ ref: StreamRef; final?: { markdown?: string } }> = [];
  sent: Array<{ conversationKey: string; message: OutboundChannelMessage }> = [];
  statuses: Array<{ conversationKey: string; threadTs: string; status: string }> = [];
  gatePrompts: ChannelGatePrompt[] = [];
  /** Queue of failures applied to the next appendStream calls, in order. */
  appendFailures: Array<ChannelStreamError | Error> = [];
  startFailure: Error | null = null;
  /** Applied to every stopStream call while set. */
  stopFailure: ChannelStreamError | Error | null = null;
  private nextTs = 1;

  verifyWebhook(): null {
    return null;
  }
  parseUpdate(): null {
    return null;
  }
  async send(conversationKey: string, message: OutboundChannelMessage) {
    this.sent.push({ conversationKey, message });
    return { conversationKey, messageId: `m${this.sent.length}` };
  }
  async sendMedia(conversationKey: string) {
    return { conversationKey, messageId: "media" };
  }
  async sendGatePrompt(conversationKey: string, gate: ChannelGatePrompt) {
    this.gatePrompts.push(gate);
    return { conversationKey, messageId: "gate" };
  }
  async updateGatePrompt() {}

  async startStream(conversationKey: string, ctx: { threadTs: string }): Promise<StreamRef> {
    if (this.startFailure) throw this.startFailure;
    this.started.push({ conversationKey, threadTs: ctx.threadTs });
    return { conversationKey, messageId: `ts${this.nextTs++}`, threadTs: ctx.threadTs };
  }
  async appendStream(ref: StreamRef, markdown: string): Promise<void> {
    const failure = this.appendFailures.shift();
    if (failure) throw failure;
    this.appends.push({ messageId: ref.messageId, markdown, at: Date.now() });
  }
  async stopStream(ref: StreamRef, final?: { markdown?: string }): Promise<void> {
    if (this.stopFailure) throw this.stopFailure;
    this.stopped.push({ ref, final });
  }
  async setStatus(conversationKey: string, threadTs: string, status: string): Promise<void> {
    this.statuses.push({ conversationKey, threadTs, status });
  }

  /** Everything the reader ended up seeing, in order. */
  streamedText(): string {
    return this.appends.map((a) => a.markdown).join("");
  }
}

/** A transport with no streaming methods at all — the Telegram shape. */
class PlainTransport implements ChannelTransport {
  readonly channelType = "telegram";
  sent: Array<{ conversationKey: string; message: OutboundChannelMessage }> = [];
  verifyWebhook(): null {
    return null;
  }
  parseUpdate(): null {
    return null;
  }
  async send(conversationKey: string, message: OutboundChannelMessage) {
    this.sent.push({ conversationKey, message });
    return { conversationKey, messageId: "m" };
  }
  async sendMedia(conversationKey: string) {
    return { conversationKey, messageId: "media" };
  }
  async sendGatePrompt(conversationKey: string) {
    return { conversationKey, messageId: "gate" };
  }
  async updateGatePrompt() {}
}

interface Harness {
  bridge: ChannelStreamBridge;
  transport: FakeStreamTransport;
  streams: MemoryActiveStreamStore;
  eventStream: InMemoryEventStream;
  delivered: string[];
  aborted: Array<{ sessionId: string; threadId: string }>;
  emit(event: EngineEvent): Promise<void>;
  delta(text: string): void;
  turn: StreamTurn;
}

function makeHarness(
  overrides: {
    transport?: ChannelTransport;
    /** Lets a test take the transport away mid-turn, as a restart does. */
    transportFor?: (channelType: string, fallback: ChannelTransport) => ChannelTransport | null;
  } = {},
): Harness {
  const transport = overrides.transport ?? new FakeStreamTransport();
  const eventStream = new InMemoryEventStream();
  const streams = new MemoryActiveStreamStore();
  const delivered: string[] = [];
  const aborted: Array<{ sessionId: string; threadId: string }> = [];

  const bridge = new ChannelStreamBridge({
    eventStream,
    streams,
    transportFor: (channelType) =>
      overrides.transportFor
        ? overrides.transportFor(channelType, transport)
        : channelType === transport.channelType
          ? transport
          : null,
    markDelivered: (key) => delivered.push(key),
    abortTurn: async (sessionId, threadId) => {
      aborted.push({ sessionId, threadId });
    },
  });
  bridge.start();

  const turn: StreamTurn = {
    channelType: transport.channelType,
    conversationKey: CONVERSATION_KEY,
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    threadTs: THREAD_TS,
    orgId: "org1",
  };

  let seq = 0;
  const busEvent = (event: EngineEvent): BusEvent => ({
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    event,
    timestamp: Date.now(),
  });

  return {
    bridge,
    // The harness always builds the streaming fake; a caller that passes a
    // PlainTransport asserts on its own reference instead.
    transport: transport as FakeStreamTransport,
    streams,
    eventStream,
    delivered,
    aborted,
    turn,
    emit: async (event) => {
      await eventStream.append(busEvent(event), `ev${seq++}`);
      await Promise.resolve();
    },
    delta: (text) => {
      eventStream.publishEphemeral(busEvent({ type: "text_delta", threadId: THREAD_ID, text }));
    },
  };
}

const messageStart = (messageId: string): EngineEvent => ({
  type: "message_start",
  threadId: THREAD_ID,
  messageId,
  role: "assistant",
});

const messageEnd = (messageId: string, reason: "end_turn" | "error" | "abort"): EngineEvent => ({
  type: "message_end",
  threadId: THREAD_ID,
  messageId,
  reason,
});

/** Runs pending timers and lets the promise chains behind them settle. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("batching against Slack's documented rate limits", () => {
  it("coalesces a burst of deltas into one append instead of one per token", async () => {
    const h = makeHarness();
    h.bridge.noteInboundTurn(h.turn);
    await h.emit(messageStart("m1"));

    for (const word of ["Hello", " ", "there", ", ", "friend", ".\n"]) h.delta(word);
    await advance(FLUSH_INTERVAL_MS);

    expect(h.transport.appends).toHaveLength(1);
    expect(h.transport.appends[0]?.markdown).toBe("Hello there, friend.\n");
  });

  it("keeps consecutive appends at least one flush interval apart", async () => {
    const h = makeHarness();
    h.bridge.noteInboundTurn(h.turn);
    await h.emit(messageStart("m1"));

    h.delta("first\n");
    await advance(FLUSH_INTERVAL_MS);
    h.delta("second\n");
    await advance(FLUSH_INTERVAL_MS);
    h.delta("third\n");
    await advance(FLUSH_INTERVAL_MS);

    expect(h.transport.appends).toHaveLength(3);
    const gaps = h.transport.appends.slice(1).map((a, i) => a.at - (h.transport.appends[i]?.at ?? 0));
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(FLUSH_INTERVAL_MS);
  });

  it("splits a flush larger than the 12,000-character markdown_text limit", async () => {
    const h = makeHarness();
    h.bridge.noteInboundTurn(h.turn);
    await h.emit(messageStart("m1"));

    const long = `${"x".repeat(MAX_MARKDOWN_CHARS + 500)}\n`;
    h.delta(long);
    await advance(FLUSH_INTERVAL_MS);
    await advance(FLUSH_INTERVAL_MS);

    expect(h.transport.appends.length).toBeGreaterThan(1);
    for (const append of h.transport.appends) {
      expect(append.markdown.length).toBeLessThanOrEqual(MAX_MARKDOWN_CHARS);
    }
    expect(h.transport.streamedText()).toBe(long);
  });
});

describe("the turn fails mid-stream", () => {
  it("closes the stream, names the corrective action, and drops the durable row", async () => {
    const h = makeHarness();
    h.bridge.noteInboundTurn(h.turn);
    await h.emit(messageStart("m1"));
    h.delta("Partial answer.\n");
    await advance(FLUSH_INTERVAL_MS);
    expect(h.streams.size()).toBe(1);

    await h.emit(messageEnd("m1", "error"));
    await advance(0);

    expect(h.transport.stopped).toHaveLength(1);
    // The reader must be told what happened and what to do next.
    expect(h.transport.streamedText()).toContain("This turn failed");
    expect(h.transport.streamedText()).toContain("Send the message again");
    expect(h.streams.size()).toBe(0);
  });

  it("closes the stream when the engine reports an error event", async () => {
    const h = makeHarness();
    h.bridge.noteInboundTurn(h.turn);
    await h.emit(messageStart("m1"));
    h.delta("Working on it.\n");
    await advance(FLUSH_INTERVAL_MS);

    await h.emit({
      type: "error",
      threadId: THREAD_ID,
      code: "provider_error",
      error: "upstream refused",
      recoverable: false,
    });
    await advance(0);

    expect(h.transport.stopped).toHaveLength(1);
    expect(h.transport.streamedText()).toContain("upstream refused");
    expect(h.streams.size()).toBe(0);
  });

  it("still closes the stream when the final flush itself fails", async () => {
    const h = makeHarness();
    h.bridge.noteInboundTurn(h.turn);
    await h.emit(messageStart("m1"));
    h.delta("text\n");
    // Every remaining append fails with an unclassified error.
    h.transport.appendFailures = [new Error("boom"), new Error("boom"), new Error("boom")];

    await h.emit(messageEnd("m1", "end_turn"));
    await advance(FLUSH_INTERVAL_MS);

    // A stranded message is the one outcome that is never acceptable.
    expect(h.transport.stopped.length).toBeGreaterThanOrEqual(1);
    expect(h.streams.size()).toBe(0);
  });
});

describe("the reader stops the stream in Slack", () => {
  it("does not call stopStream, aborts the turn, and drops the row", async () => {
    const h = makeHarness();
    h.bridge.noteInboundTurn(h.turn);
    await h.emit(messageStart("m1"));
    h.transport.appendFailures = [new ChannelStreamError("stopped_by_user", "stopped_by_user")];
    h.delta("this will not land\n");

    await advance(FLUSH_INTERVAL_MS);

    // Slack has already closed the message; calling stopStream would error.
    expect(h.transport.stopped).toHaveLength(0);
    expect(h.aborted).toEqual([{ sessionId: SESSION_ID, threadId: THREAD_ID }]);
    expect(h.streams.size()).toBe(0);
    expect(h.bridge.isStreaming(SESSION_ID, THREAD_ID)).toBe(false);
  });
});

describe("Slack rate-limits an append", () => {
  it("waits for Retry-After and loses no text", async () => {
    const h = makeHarness();
    h.bridge.noteInboundTurn(h.turn);
    await h.emit(messageStart("m1"));
    h.transport.appendFailures = [new ChannelStreamError("rate_limited", "ratelimited", 3_000)];

    h.delta("first part\n");
    await advance(FLUSH_INTERVAL_MS);
    expect(h.transport.appends).toHaveLength(0);

    // More text arrives while we are waiting; it must be coalesced, not dropped.
    h.delta("second part\n");
    await advance(1_000);
    expect(h.transport.appends).toHaveLength(0);

    await advance(3_000);
    expect(h.transport.appends).toHaveLength(1);
    expect(h.transport.streamedText()).toBe("first part\nsecond part\n");
  });

  it("falls back to a plain message when the closing flush is rate-limited", async () => {
    const h = makeHarness();
    h.bridge.noteInboundTurn(h.turn);
    await h.emit(messageStart("m1"));
    h.transport.appendFailures = [new ChannelStreamError("rate_limited", "ratelimited", 60_000)];
    h.delta("the final answer\n");

    await h.emit(messageEnd("m1", "end_turn"));
    await advance(FLUSH_INTERVAL_MS);

    // Waiting 60s to close would strand the message, so the text goes out by
    // another method and the stream closes now.
    expect(h.transport.stopped).toHaveLength(1);
    expect(h.transport.sent.map((s) => s.message.markdown).join("")).toContain("the final answer");
    expect(h.streams.size()).toBe(0);
  });
});

describe("the provider drops the stream", () => {
  it("stops appending and delivers the rest as plain messages", async () => {
    const h = makeHarness();
    h.bridge.noteInboundTurn(h.turn);
    await h.emit(messageStart("m1"));
    h.transport.appendFailures = [
      new ChannelStreamError("stream_gone", "message_not_in_streaming_state"),
    ];

    h.delta("owed text\n");
    await advance(FLUSH_INTERVAL_MS);
    await advance(FLUSH_INTERVAL_MS);

    expect(h.transport.sent.map((s) => s.message.markdown).join("")).toContain("owed text");
    expect(h.streams.size()).toBe(0);
  });

  it("falls back to a plain message when the stream never opens", async () => {
    const h = makeHarness();
    h.transport.startFailure = new Error("channel_not_found");
    h.bridge.noteInboundTurn(h.turn);
    await h.emit(messageStart("m1"));
    h.delta("answer text\n");

    await h.emit(messageEnd("m1", "end_turn"));
    await advance(FLUSH_INTERVAL_MS);

    expect(h.transport.appends).toHaveLength(0);
    expect(h.transport.sent.map((s) => s.message.markdown).join("")).toContain("answer text");
    expect(h.streams.size()).toBe(0);
  });
});

describe("the api restarts with a stream open", () => {
  it("closes the orphaned message on boot and says where to read the answer", async () => {
    // A previous process wrote this row and died before stopStream.
    const streams = new MemoryActiveStreamStore();
    await streams.insert({
      channelType: CHANNEL_TYPE,
      conversationKey: CONVERSATION_KEY,
      messageId: "ts-from-dead-process",
      threadTs: THREAD_TS,
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      orgId: "org1",
      startedAt: Date.now() - 60_000,
    });

    const transport = new FakeStreamTransport();
    const bridge = new ChannelStreamBridge({
      eventStream: new InMemoryEventStream(),
      streams,
      transportFor: () => transport,
      markDelivered: () => {},
      abortTurn: async () => {},
    });

    const closed = await bridge.sweepOnBoot(CHANNEL_TYPE, Date.now());

    expect(closed).toBe(1);
    expect(transport.stopped).toHaveLength(1);
    expect(transport.stopped[0]?.ref.messageId).toBe("ts-from-dead-process");
    expect(transport.stopped[0]?.final?.markdown).toContain("Open the session in Valet");
    expect(streams.size()).toBe(0);
  });

  it("leaves a stream that started after this boot alone", async () => {
    const streams = new MemoryActiveStreamStore();
    const bootedAt = Date.now();
    await streams.insert({
      channelType: CHANNEL_TYPE,
      conversationKey: CONVERSATION_KEY,
      messageId: "ts-live",
      threadTs: THREAD_TS,
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      orgId: "org1",
      startedAt: bootedAt + 5_000,
    });

    const transport = new FakeStreamTransport();
    const bridge = new ChannelStreamBridge({
      eventStream: new InMemoryEventStream(),
      streams,
      transportFor: () => transport,
      markDelivered: () => {},
      abortTurn: async () => {},
    });

    expect(await bridge.sweepOnBoot(CHANNEL_TYPE, bootedAt)).toBe(0);
    expect(transport.stopped).toHaveLength(0);
    expect(streams.size()).toBe(1);
  });

  it("closes streams it owns when the host shuts down cleanly", async () => {
    const h = makeHarness();
    h.bridge.noteInboundTurn(h.turn);
    await h.emit(messageStart("m1"));
    h.delta("half an answer\n");
    await advance(FLUSH_INTERVAL_MS);

    await h.bridge.stop();

    expect(h.transport.stopped).toHaveLength(1);
    expect(h.streams.size()).toBe(0);
  });
});

describe("the orphan sweep", () => {
  it("closes a stream older than the ceiling but never one it is still writing", async () => {
    const h = makeHarness();
    h.bridge.noteInboundTurn(h.turn);
    await h.emit(messageStart("m1"));
    h.delta("live text\n");
    await advance(FLUSH_INTERVAL_MS);

    // A row from a turn that hung, far older than any real turn.
    await h.streams.insert({
      channelType: CHANNEL_TYPE,
      conversationKey: CONVERSATION_KEY,
      messageId: "ts-abandoned",
      threadTs: THREAD_TS,
      sessionId: "orchestrator:user:u2",
      threadId: "t2",
      orgId: "org1",
      startedAt: Date.now() - 60 * 60_000,
    });

    const closed = await h.bridge.sweepOrphans();

    expect(closed).toBe(1);
    expect(h.transport.stopped).toHaveLength(1);
    expect(h.transport.stopped[0]?.ref.messageId).toBe("ts-abandoned");
    // The live stream is untouched.
    expect(h.bridge.isStreaming(SESSION_ID, THREAD_ID)).toBe(true);
  });

  it("keeps the row when the close itself fails, and closes it on the next pass", async () => {
    const h = makeHarness();
    await h.streams.insert({
      channelType: CHANNEL_TYPE,
      conversationKey: CONVERSATION_KEY,
      messageId: "ts-abandoned",
      threadTs: THREAD_TS,
      sessionId: "orchestrator:user:u2",
      threadId: "t2",
      orgId: "org1",
      startedAt: Date.now() - 60 * 60_000,
    });
    // The row is the only record that this message is open. Deleting it after
    // a failed close would leave it shimmering with nothing able to find it.
    h.transport.stopFailure = new ChannelStreamError("rate_limited", "ratelimited");
    h.bridge.noteInboundTurn(h.turn);

    expect(await h.bridge.sweepOrphans()).toBe(0);
    expect(h.streams.size()).toBe(1);

    h.transport.stopFailure = null;
    expect(await h.bridge.sweepOrphans()).toBe(1);
    expect(h.streams.size()).toBe(0);
  });
});

describe("the turn's own close fails", () => {
  it("keeps the row so a sweep can finish the close", async () => {
    const h = makeHarness();
    h.bridge.noteInboundTurn(h.turn);
    await h.emit(messageStart("m1"));
    h.delta("the answer\n");
    await advance(FLUSH_INTERVAL_MS);

    h.transport.stopFailure = new ChannelStreamError("rate_limited", "ratelimited");
    await h.emit(messageEnd("m1", "end_turn"));
    await advance(FLUSH_INTERVAL_MS * 2);

    expect(h.transport.stopped).toHaveLength(0);
    expect(h.streams.size()).toBe(1);
  });

  it("drops the row when the provider says the stream is already gone", async () => {
    const h = makeHarness();
    h.bridge.noteInboundTurn(h.turn);
    await h.emit(messageStart("m1"));
    h.delta("the answer\n");
    await advance(FLUSH_INTERVAL_MS);

    // Nothing is left to close, so retrying would fail the same way for ever.
    h.transport.stopFailure = new ChannelStreamError("stream_gone", "message_not_found");
    await h.emit(messageEnd("m1", "end_turn"));
    await advance(FLUSH_INTERVAL_MS * 2);

    expect(h.streams.size()).toBe(0);
  });
});

describe("the turn parks on an approval gate", () => {
  it("closes the stream so the approval card lands after the text", async () => {
    const h = makeHarness();
    h.bridge.noteInboundTurn(h.turn);
    await h.emit(messageStart("m1"));
    h.delta("I need approval to continue.\n");

    await h.bridge.closeForGate(SESSION_ID, THREAD_ID);

    expect(h.transport.streamedText()).toContain("I need approval to continue.");
    expect(h.transport.stopped).toHaveLength(1);
    expect(h.streams.size()).toBe(0);
    expect(h.bridge.isStreaming(SESSION_ID, THREAD_ID)).toBe(false);
    expect(h.transport.statuses.at(-1)?.status).toContain("approval");
  });

  it("opens a fresh stream for the resumed turn", async () => {
    const h = makeHarness();
    h.bridge.noteInboundTurn(h.turn);
    await h.emit(messageStart("m1"));
    h.delta("before the gate\n");
    await h.bridge.closeForGate(SESSION_ID, THREAD_ID);

    // The resumed turn produces a new assistant message.
    await h.emit(messageStart("m2"));
    h.delta("after the gate\n");
    await advance(FLUSH_INTERVAL_MS);

    expect(h.transport.started).toHaveLength(2);
    const second = h.transport.appends.filter((a) => a.messageId === "ts2");
    expect(second.map((a) => a.markdown).join("")).toContain("after the gate");
  });

  it("streams only the first message of a segment — later messages stay off the channel", async () => {
    // The channel contract is one posted message per gate segment. Once the
    // first message streamed text, mid-turn narration must not open another
    // stream (the discrete path suppresses those messages too).
    const h = makeHarness();
    h.bridge.noteInboundTurn(h.turn);
    await h.emit(messageStart("m1"));
    h.delta("the reply\n");
    await h.emit(messageEnd("m1", "end_turn"));
    await advance(FLUSH_INTERVAL_MS);

    await h.emit(messageStart("m2"));
    h.delta("working notes\n");
    await advance(FLUSH_INTERVAL_MS);

    expect(h.transport.started).toHaveLength(1);
    expect(h.transport.appends.map((a) => a.markdown).join("")).not.toContain("working notes");
  });
});

describe("the double-post guard", () => {
  it("marks a streamed message so the discrete delivery path skips it", async () => {
    const h = makeHarness();
    h.bridge.noteInboundTurn(h.turn);
    await h.emit(messageStart("m1"));

    // The marker must exist as soon as the stream opens, because the host
    // reads it while handling message_end.
    expect(h.bridge.isStreamed(SESSION_ID, "m1")).toBe(true);

    h.delta("the answer\n");
    await h.emit(messageEnd("m1", "end_turn"));
    await advance(FLUSH_INTERVAL_MS);

    expect(h.bridge.isStreamed(SESSION_ID, "m1")).toBe(true);
    expect(h.delivered).toContain(`${SESSION_ID}:m1`);
  });

  it("does not claim a message when the transport stopped streaming mid-turn", async () => {
    // The transport restarts between the prompt and the first token: a
    // credential edit, or a reconnect. The bridge has no stream to open, so
    // it must leave the message to the host's ordinary delivery path. Marking
    // it here would make the host skip it and the answer would vanish.
    let streaming = true;
    const h = makeHarness({ transportFor: (_type, fallback) => (streaming ? fallback : null) });
    h.bridge.noteInboundTurn(h.turn);
    streaming = false;
    await h.emit(messageStart("m1"));
    streaming = true;
    h.delta("the whole answer\n");
    await advance(FLUSH_INTERVAL_MS);
    await h.emit(messageEnd("m1", "end_turn"));
    await advance(FLUSH_INTERVAL_MS);

    expect(h.bridge.isStreamed(SESSION_ID, "m1")).toBe(false);
    expect(h.transport.started).toHaveLength(0);
  });

  it("does not mark a message on a thread with no channel turn", async () => {
    const h = makeHarness();
    // No noteInboundTurn: this is a web-only session.
    await h.emit(messageStart("m1"));
    h.delta("web only\n");
    await advance(FLUSH_INTERVAL_MS);

    expect(h.bridge.isStreamed(SESSION_ID, "m1")).toBe(false);
    expect(h.transport.started).toHaveLength(0);
    expect(h.transport.appends).toHaveLength(0);
  });
});

describe("transports that do not stream", () => {
  it("ignores a turn on a transport with no streaming methods", async () => {
    const plain = new PlainTransport();
    const h = makeHarness({ transport: plain });
    h.bridge.noteInboundTurn({ ...h.turn, channelType: "telegram" });
    await h.emit(messageStart("m1"));
    h.delta("hello\n");
    await advance(FLUSH_INTERVAL_MS);

    // Telegram keeps its existing discrete-message delivery untouched.
    expect(plain.sent).toHaveLength(0);
    expect(h.bridge.isStreamed(SESSION_ID, "m1")).toBe(false);
  });
});

describe("splitForFlush", () => {
  it("holds back an unterminated code fence", () => {
    const { send, keep } = splitForFlush("intro\n```ts\nconst a = 1;\n", { force: false });
    expect(send).toBe("intro\n");
    expect(keep).toBe("```ts\nconst a = 1;\n");
  });

  it("sends a closed code fence whole", () => {
    const buffer = "intro\n```ts\nconst a = 1;\n```\n";
    const { send, keep } = splitForFlush(buffer, { force: false });
    expect(send).toBe(buffer);
    expect(keep).toBe("");
  });

  it("cuts at a line boundary, never mid-line", () => {
    const { send, keep } = splitForFlush("done line\npartial li", { force: false });
    expect(send).toBe("done line\n");
    expect(keep).toBe("partial li");
  });

  it("takes everything when forced", () => {
    const buffer = "```ts\nunclosed";
    expect(splitForFlush(buffer, { force: true })).toEqual({ send: buffer, keep: "" });
  });

  it("stops holding once the held text grows too large", () => {
    // A long code block must not stall the stream forever.
    const buffer = `\`\`\`ts\n${"x".repeat(5_000)}`;
    const { send, keep } = splitForFlush(buffer, { force: false });
    expect(send).toBe(buffer);
    expect(keep).toBe("");
  });
});
