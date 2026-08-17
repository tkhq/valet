/**
 * `ChannelStreamBridge` — turns the engine's token stream into a live
 * provider-side stream (Slack `chat.startStream` / `appendStream` /
 * `stopStream`).
 *
 * The happy path is short: open a stream on the first `message_start`,
 * append batched text, close on `message_end`. Almost all of the code below
 * is the other paths, because each one of them ends with a real person
 * looking at a message that never stops shimmering:
 *
 *   - the turn fails or is aborted mid-stream
 *   - the reader presses stop in Slack
 *   - the api restarts with a stream open
 *   - Slack rate-limits an append
 *   - the turn parks on an approval gate
 *
 * Two engine facts shape the whole design.
 *
 * 1. `text_delta` carries NO messageId (`EngineEvent` in engine/types.ts).
 *    The consumer must track the active message per thread off the preceding
 *    `message_start` — the same bookkeeping `busEventToWire` leaves to its
 *    own dispatcher.
 * 2. `text_delta` is published with `publishEphemeral`: live-only, no
 *    append, no offset, no replay. Deltas do not survive a restart. Only
 *    `message_end` is durable. That asymmetry is why open streams are
 *    recorded in `channel_active_streams` and swept at boot.
 */
import {
  canStream,
  ChannelStreamError,
  type ChannelTransport,
  type DeliveredBusEvent,
  type EventStream,
  type StreamRef,
  type Unsubscribe,
} from "@valet/engine";
import type { ActiveStreamRecord, ActiveStreamStore } from "./active-streams.js";

/**
 * Minimum delay between two `chat.appendStream` calls on one stream.
 *
 * Slack's rate-limit reference says: "design your apps with a limit of 1
 * request per second for any given API call, knowing that we'll allow it to
 * go over this limit as long as this is only a temporary burst"
 * (https://docs.slack.dev/apis/web-api/rate-limits/). `chat.appendStream` is
 * documented as Tier 4, "100+ per minute"
 * (https://docs.slack.dev/reference/methods/chat.appendStream/).
 *
 * 750 ms is a floor, not a target: it caps this stream at 80 appends per
 * minute, which sits under Tier 4 and leaves room for the `setStatus`,
 * `setTitle` and `stopStream` calls that share the same per-workspace
 * budget. Every delta that arrives inside the window is buffered and rides
 * out on the next flush, so a fast model costs more text per call rather
 * than more calls. Posting per delta would breach the 1-per-second guidance
 * within the first second of any turn.
 */
export const FLUSH_INTERVAL_MS = 750;

/**
 * Hard cap on one `markdown_text` argument, from the method reference (12,000
 * characters). A flush longer than this is split across calls, which the
 * cadence floor spaces out.
 */
export const MAX_MARKDOWN_CHARS = 12_000;

/**
 * How much text the bridge will hold back to reach a clean markdown boundary.
 * Past this, it flushes mid-construct: a code fence that renders untidily for
 * 750 ms beats text that never arrives.
 */
export const MAX_HELD_CHARS = 4_000;

/**
 * Roll over to a continuation message at this much accumulated text. Slack
 * documents a per-call `markdown_text` limit but not a per-message total, and
 * returns `message_limit_exceeded` when a message is full. Rolling over early
 * keeps long answers inside one thread instead of hitting that error with no
 * way to recover the remaining output.
 */
export const MAX_STREAM_CHARS = 36_000;

/** How often the orphan sweep runs. */
export const ORPHAN_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * A stream open longer than this is treated as abandoned. It is the ceiling
 * on a single turn's visible output, not on a turn: a turn that runs longer
 * without producing text has no stream open to sweep.
 */
export const STREAM_MAX_AGE_MS = 30 * 60_000;

/**
 * Stop retrying a close after this long, and drop the row.
 *
 * A close that keeps failing keeps its row, because the row is the only
 * record that a message is still open. This bounds that: after a day of
 * failed sweeps the provider stream is not coming back, and an immortal row
 * is then only noise in the table.
 */
export const STREAM_ABANDON_AFTER_MS = 24 * 60 * 60_000;

/** Cap on the streamed-message marker set. Same shape as the host's own dedup LRU. */
const STREAMED_CAP = 2048;

export interface StreamTurn {
  channelType: string;
  conversationKey: string;
  sessionId: string;
  threadId: string;
  /** Provider reply anchor for this turn (Slack `thread_ts`). */
  threadTs: string;
  orgId: string;
}

export interface ChannelStreamBridgeDeps {
  eventStream: EventStream;
  streams: ActiveStreamStore;
  /** Running transport for a channelType, or null. */
  transportFor(channelType: string): ChannelTransport | null;
  /** Marks (sessionId, engine messageId) as already delivered, so the host's
   * discrete-message path skips a message this bridge streamed. */
  markDelivered(dedupeKey: string): void;
  /** Stops the engine turn. Called when the reader stops the stream in Slack. */
  abortTurn(sessionId: string, threadId: string): Promise<void>;
  now?: () => number;
}

interface ActiveStream {
  turn: StreamTurn;
  /** Null until `startStream` resolves, or after the stream is abandoned. */
  ref: StreamRef | null;
  engineMessageId: string;
  buffer: string;
  /** Characters accepted by the provider on the current message. */
  sentChars: number;
  /** When the current provider message was opened. Drives the sweeps. */
  startedAt: number;
  lastFlushAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Set while `startStream` is in flight. A flush must wait for it: an open
   * that has not answered yet is not the same as a stream that is gone, and
   * treating it as gone would post the first chunk as a plain message and then
   * stream the rest. */
  opening: Promise<void> | null;
  /** Serializes flushes so two timers cannot append out of order. */
  inFlight: Promise<unknown> | null;
  /** Do not append before this time (rate-limit backoff). */
  retryAfter: number;
  /** The provider stream is gone. Remaining text goes out as plain messages. */
  degraded: boolean;
  closed: boolean;
}

function stateKey(sessionId: string, threadId: string): string {
  return `${sessionId}\u0000${threadId}`;
}

/** What a flush pass achieved. "retry" means the text is still owed, and the
 * next pass will take a different route to deliver it. */
type FlushOutcome = "sent" | "retry" | "stop";

/**
 * Splits a buffer at a boundary that renders cleanly mid-stream.
 *
 * Slack is appending to one message, so the reader sees every intermediate
 * state. A flush that ends inside an open code fence shows an unterminated
 * block until the next flush lands. This holds such a fragment back, but only
 * up to `MAX_HELD_CHARS` — an unbounded hold would stall a long code block
 * completely, which is worse than a briefly ragged one.
 *
 * `force` (the final flush, or a hold that grew too large) takes everything.
 */
export function splitForFlush(buffer: string, opts: { force: boolean }): { send: string; keep: string } {
  if (opts.force || buffer.length > MAX_HELD_CHARS) return { send: buffer, keep: "" };

  // An odd number of fence markers means the last one is still open.
  let candidateEnd = buffer.length;
  const fences = [...buffer.matchAll(/^ {0,3}```/gm)];
  if (fences.length % 2 === 1) {
    const open = fences[fences.length - 1];
    if (open?.index !== undefined) candidateEnd = open.index;
  }

  // Never cut mid-line: a half-written list item or heading reflows on the
  // next flush and the reader sees it jump.
  const lastBreak = buffer.lastIndexOf("\n", candidateEnd - 1);
  const end = lastBreak === -1 ? 0 : lastBreak + 1;
  return { send: buffer.slice(0, end), keep: buffer.slice(end) };
}

export class ChannelStreamBridge {
  private active = new Map<string, ActiveStream>();
  private pending = new Map<string, StreamTurn>();
  private streamed = new Set<string>();
  private streamedOrder: string[] = [];
  private unsubscribe: Unsubscribe | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ChannelStreamBridgeDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.eventStream.subscribe(
      { eventTypes: ["message_start", "text_delta", "message_end", "error", "turn_end"] },
      (event) => this.onBusEvent(event),
    );
    this.sweepTimer = setInterval(() => {
      void this.sweepOrphans();
    }, ORPHAN_SWEEP_INTERVAL_MS);
    // A sweep must never hold the process open on its own.
    this.sweepTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    // Close every stream this process owns. A clean shutdown must not leave
    // the work for the next boot's sweep.
    const keys = [...this.active.keys()];
    await Promise.all(
      keys.map((key) =>
        this.finish(key, "The api restarted during this answer. Open the session in Valet to read all of it."),
      ),
    );
    this.pending.clear();
  }

  /**
   * Called by the host when a channel message starts a turn, BEFORE the
   * prompt is submitted. Nothing opens yet: a turn that parks on an approval
   * gate before it writes anything must not leave an empty stream on screen.
   */
  noteInboundTurn(turn: StreamTurn): void {
    const transport = this.deps.transportFor(turn.channelType);
    if (!transport || !canStream(transport)) return;
    this.pending.set(stateKey(turn.sessionId, turn.threadId), turn);
    void this.setStatus(turn, "is thinking…");
  }

  /** True when this bridge streamed an engine message, so the host's discrete
   * `message_end` delivery must skip it. Synchronous by contract: the marker
   * is recorded on `message_start`, which the event stream always delivers
   * before `message_end` for the same message. */
  isStreamed(sessionId: string, messageId: string): boolean {
    return this.streamed.has(`${sessionId}:${messageId}`);
  }

  /** True while a stream is open on a thread. */
  isStreaming(sessionId: string, threadId: string): boolean {
    return this.active.has(stateKey(sessionId, threadId));
  }

  /**
   * Closes the stream before an approval card is posted.
   *
   * A parked turn ends that segment of output. Holding a stream open across
   * an approval that may sit for hours is the worst case for a provider that
   * documents no unclosed-stream timeout, and the card has to be a separate
   * message anyway to stay interactive after the turn resumes. The resumed
   * turn opens a new stream on its next `message_start`, so the reader sees
   * streamed text, then the card, then streamed text again.
   */
  async closeForGate(sessionId: string, threadId: string): Promise<void> {
    const key = stateKey(sessionId, threadId);
    if (!this.active.has(key)) return;
    await this.finish(key);
    const turn = this.pending.get(key);
    if (turn) await this.setStatus(turn, "is waiting for your approval…");
  }

  // ── Event intake ──────────────────────────────────────────────────

  private onBusEvent(event: DeliveredBusEvent): void {
    const e = event.event;
    const threadId = "threadId" in e ? e.threadId : undefined;
    if (threadId === undefined) return;
    const key = stateKey(event.sessionId, threadId);

    if (e.type === "message_start") {
      if (e.role !== "assistant") return;
      const turn = this.pending.get(key);
      if (!turn || this.active.has(key)) return;
      // Register the stream state first. The marker below tells the host to
      // skip its own delivery of this message, so it may only be set once
      // this bridge owns the message and can deliver it by some route. A
      // transport that stopped streaming between `noteInboundTurn` and this
      // event leaves nothing registered, and the answer must then travel the
      // host's ordinary path rather than disappear.
      const opener = this.registerStream(turn, e.messageId);
      if (!opener) return;
      // Recorded synchronously, before any await: the host reads this marker
      // when `message_end` arrives, and an async record would race it.
      this.markStreamed(event.sessionId, e.messageId);
      void this.guard("open", opener);
      return;
    }

    if (e.type === "text_delta") {
      const stream = this.active.get(key);
      if (!stream || stream.closed) return;
      stream.buffer += e.text;
      this.scheduleFlush(stream);
      return;
    }

    if (e.type === "message_end") {
      if (!this.active.has(key)) return;
      const note =
        e.reason === "abort"
          ? "Stopped."
          : e.reason === "error"
            ? "This turn failed. Send the message again, or open the session in Valet."
            : undefined;
      void this.guard("finish", () => this.finish(key, note));
      return;
    }

    if (e.type === "error") {
      if (!this.active.has(key)) return;
      // The engine's own error text is the useful half; the corrective action
      // is ours to add.
      const note = `This turn failed: ${e.error}. Send the message again, or open the session in Valet.`;
      void this.guard("finish", () => this.finish(key, note));
      return;
    }

    if (e.type === "turn_end") {
      const turn = this.pending.get(key);
      this.pending.delete(key);
      // A turn can end without a message_end for an open stream (a crash
      // between rounds). Close anything still open rather than trust that
      // message_end always arrives.
      if (this.active.has(key)) {
        void this.guard("finish", () => this.finish(key));
      }
      if (turn) void this.setStatus(turn, "");
    }
  }

  /** Every path out of an event callback funnels through here: an unhandled
   * rejection in a bus subscriber would take down the stream for every user,
   * not just this one. */
  private async guard(what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      console.error(`[channels] stream ${what} failed`, err);
    }
  }

  // ── Stream lifecycle ──────────────────────────────────────────────

  /**
   * Records the stream state for a turn and returns the opener that talks to
   * the provider, or null when this transport cannot stream right now.
   *
   * The split matters: everything here is synchronous, so the caller learns
   * whether the bridge owns the message in the same tick as `message_start`.
   * The returned opener is the only part that awaits.
   */
  private registerStream(turn: StreamTurn, engineMessageId: string): (() => Promise<void>) | null {
    const key = stateKey(turn.sessionId, turn.threadId);
    const transport = this.deps.transportFor(turn.channelType);
    if (!transport || !canStream(transport)) return null;

    const stream: ActiveStream = {
      turn,
      ref: null,
      engineMessageId,
      buffer: "",
      sentChars: 0,
      startedAt: this.now(),
      lastFlushAt: this.now(),
      timer: null,
      opening: null,
      inFlight: null,
      retryAfter: 0,
      degraded: false,
      closed: false,
    };
    // Registered before the opener runs so deltas that arrive during
    // startStream are buffered rather than dropped.
    this.active.set(key, stream);
    return () => {
      const opening = this.openRef(stream, transport);
      stream.opening = opening;
      return opening;
    };
  }

  private async openRef(
    stream: ActiveStream,
    transport: ChannelTransport & Required<Pick<ChannelTransport, "startStream">>,
  ): Promise<void> {
    try {
      const ref = await transport.startStream(stream.turn.conversationKey, {
        threadTs: stream.turn.threadTs,
      });
      stream.ref = ref;
      await this.deps.streams.insert(this.recordFor(stream));
    } catch (err) {
      // The stream never opened. Keep the buffer: the text still reaches the
      // reader as an ordinary message.
      stream.degraded = true;
      console.error(
        `[channels] ${stream.turn.channelType}: startStream failed, sending this answer as a plain message`,
        err,
      );
    } finally {
      stream.opening = null;
    }
  }

  private recordFor(stream: ActiveStream): ActiveStreamRecord {
    return {
      channelType: stream.turn.channelType,
      conversationKey: stream.turn.conversationKey,
      messageId: stream.ref?.messageId ?? "",
      threadTs: stream.turn.threadTs,
      sessionId: stream.turn.sessionId,
      threadId: stream.turn.threadId,
      engineMessageId: stream.engineMessageId,
      orgId: stream.turn.orgId,
      startedAt: stream.startedAt,
    };
  }

  private scheduleFlush(stream: ActiveStream): void {
    if (stream.closed || stream.timer) return;
    const earliest = Math.max(stream.lastFlushAt + FLUSH_INTERVAL_MS, stream.retryAfter);
    const wait = Math.max(0, earliest - this.now());
    stream.timer = setTimeout(() => {
      stream.timer = null;
      void this.guard("flush", () => this.flush(stream));
    }, wait);
    stream.timer.unref?.();
  }

  /** Appends what is ready. Serialized per stream: two overlapping appends
   * would interleave the reader's text. */
  private async flush(stream: ActiveStream, force = false): Promise<void> {
    if (stream.inFlight) {
      await stream.inFlight;
      if (stream.closed && !force) return;
    }
    const run = force ? this.drain(stream) : this.flushOnce(stream, false);
    stream.inFlight = run;
    try {
      await run;
    } finally {
      stream.inFlight = null;
    }
  }

  /**
   * Empties the buffer before the stream closes. One `flushOnce` sends at
   * most `MAX_MARKDOWN_CHARS`, so an answer longer than that needs several
   * passes; without them the tail would be dropped at close with nothing said
   * about it.
   *
   * A pass that sends nothing is allowed only when it changed how the next
   * pass will send — a failed append switches the stream to plain messages,
   * which is a different method and a different rate-limit bucket. Two such
   * passes in a row mean nothing is getting through, so the loop stops.
   */
  private async drain(stream: ActiveStream): Promise<void> {
    let stalled = 0;
    while (stream.buffer !== "" && stalled < 2) {
      const before = stream.buffer.length;
      const outcome = await this.flushOnce(stream, true);
      if (outcome === "stop") return;
      stalled = stream.buffer.length >= before ? stalled + 1 : 0;
    }
  }

  private async flushOnce(stream: ActiveStream, force: boolean): Promise<FlushOutcome> {
    // Wait for an in-flight open rather than treat a pending stream as a lost
    // one. Never rejects: `openRef` handles its own failure.
    if (stream.opening) await stream.opening;
    if (stream.buffer === "") return "stop";
    if (!force && this.now() < stream.retryAfter) {
      this.scheduleFlush(stream);
      return "stop";
    }

    const transport = this.deps.transportFor(stream.turn.channelType);
    if (!transport || !canStream(transport)) return "stop";

    const { send, keep } = splitForFlush(stream.buffer, { force });
    if (send === "") {
      if (!force) this.scheduleFlush(stream);
      return "stop";
    }
    const chunk = send.slice(0, MAX_MARKDOWN_CHARS);
    const remainder = send.slice(chunk.length) + keep;

    // No open stream: either startStream failed or the provider dropped it.
    // The text is still owed to the reader, so it goes out as a message.
    if (stream.degraded || !stream.ref) {
      stream.buffer = remainder;
      stream.lastFlushAt = this.now();
      await transport.send(stream.turn.conversationKey, { markdown: chunk });
      if (stream.buffer !== "" && !force) this.scheduleFlush(stream);
      return "sent";
    }

    try {
      await transport.appendStream(stream.ref, chunk);
    } catch (err) {
      return await this.onAppendFailed(stream, err, chunk + remainder, force);
    }

    stream.buffer = remainder;
    stream.sentChars += chunk.length;
    stream.lastFlushAt = this.now();

    if (stream.sentChars >= MAX_STREAM_CHARS && !stream.closed) {
      await this.rollover(stream);
    }
    if (stream.buffer !== "" && !stream.closed && !force) this.scheduleFlush(stream);
    return "sent";
  }

  /**
   * Classifies an append failure. `unsent` is every character the provider did
   * not accept — it is restored to the buffer on the paths where the text can
   * still be delivered, because dropping a reader's answer to save a retry is
   * never the right trade.
   *
   * Returns "retry" when the same text can go out by another route on the next
   * pass, and "stop" when nothing further should be attempted now.
   */
  private async onAppendFailed(
    stream: ActiveStream,
    err: unknown,
    unsent: string,
    force: boolean,
  ): Promise<FlushOutcome> {
    const kind = err instanceof ChannelStreamError ? err.kind : "unknown";
    stream.buffer = unsent;

    if (kind === "stopped_by_user") {
      // The reader stopped the stream, so Slack has already closed it. Do not
      // call stopStream. Stop the turn too: continuing would spend tokens on
      // output that has nowhere to go.
      stream.buffer = "";
      await this.discard(stream);
      await this.deps
        .abortTurn(stream.turn.sessionId, stream.turn.threadId)
        .catch((abortErr: unknown) => console.error("[channels] abort after reader stop failed", abortErr));
      return "stop";
    }

    if (kind === "rate_limited" && !force) {
      // Keep every character and wait exactly as long as Slack asked.
      const retryAfterMs =
        err instanceof ChannelStreamError && err.retryAfterMs !== undefined
          ? err.retryAfterMs
          : FLUSH_INTERVAL_MS;
      stream.retryAfter = this.now() + retryAfterMs;
      this.scheduleFlush(stream);
      return "stop";
    }

    if (kind === "stream_gone") {
      // The message is no longer ours to append to. Drop the row first —
      // `closeRef` would call stopStream on a message the provider has already
      // taken away — then finish through plain messages.
      await this.deleteRecord(stream);
      stream.ref = null;
      stream.degraded = true;
      if (!force) this.scheduleFlush(stream);
      return "retry";
    }

    // Either an unclassified failure, or a rate limit on the closing flush
    // where there is no next flush to wait for. Both end the stream and send
    // the rest as plain messages: that is a different method, so a different
    // rate-limit bucket.
    if (kind !== "rate_limited") {
      console.error(`[channels] ${stream.turn.channelType}: appendStream failed`, err);
    }
    stream.degraded = true;
    await this.closeRef(stream);
    if (!force) this.scheduleFlush(stream);
    return "retry";
  }

  /** Closes the current message and opens a continuation in the same thread. */
  private async rollover(stream: ActiveStream): Promise<void> {
    const transport = this.deps.transportFor(stream.turn.channelType);
    if (!transport || !canStream(transport) || !stream.ref) return;
    await this.closeRef(stream);
    try {
      stream.ref = await transport.startStream(stream.turn.conversationKey, {
        threadTs: stream.turn.threadTs,
      });
      stream.sentChars = 0;
      await this.deps.streams.insert(this.recordFor(stream));
    } catch (err) {
      stream.degraded = true;
      stream.ref = null;
      console.error(`[channels] ${stream.turn.channelType}: continuation stream failed`, err);
    }
  }

  /**
   * The single close path. Flushes what is left, closes the provider stream,
   * drops the durable row, and forgets the state. `note` appends a visible
   * line — every abnormal ending says what happened and what to do about it.
   */
  private async finish(key: string, note?: string): Promise<void> {
    const stream = this.active.get(key);
    if (!stream) return;
    this.active.delete(key);
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = null;
    if (note !== undefined && note !== "") {
      stream.buffer += (stream.buffer === "" ? "" : "\n\n") + note;
    }
    try {
      await this.flush(stream, true);
    } catch (err) {
      console.error("[channels] final flush failed", err);
    }
    // Marked closed only after the last flush, so `scheduleFlush` cannot
    // arm a timer for a stream that is on its way out.
    stream.closed = true;
    await this.closeRef(stream);
    this.deps.markDelivered(`${stream.turn.sessionId}:${stream.engineMessageId}`);
  }

  /** stopStream + drop the row, each independently guarded. A throw here is
   * exactly what strands a message, so it can never propagate. */
  private async closeRef(stream: ActiveStream): Promise<void> {
    const transport = this.deps.transportFor(stream.turn.channelType);
    const ref = stream.ref;
    stream.ref = null;
    if (!ref) return;
    if (transport && canStream(transport)) {
      const outcome = await this.tryStop(transport, ref, stream.turn.channelType);
      // The row is the ONLY record that a stream is open. Drop it when the
      // close worked, and when the provider says the message is already gone.
      // Keep it after any other failure: the orphan sweep is then the reader's
      // last chance at a message that would otherwise shimmer for ever.
      if (outcome === "retry") return;
    }
    await this.deleteRecordFor(stream.turn.channelType, stream.turn.conversationKey, ref.messageId);
  }

  /**
   * Calls `stopStream` and says whether the row may go.
   *
   * "done" — the provider stream is closed, or it was already gone, so there
   * is nothing left to close. "retry" — the call failed for a reason that may
   * not repeat (a rate limit, a timeout, an unclassified error), so the row
   * must survive for the next sweep.
   */
  private async tryStop(
    transport: ChannelTransport & Required<Pick<ChannelTransport, "stopStream">>,
    ref: StreamRef,
    channelType: string,
    final?: { markdown?: string },
  ): Promise<"done" | "retry"> {
    try {
      await transport.stopStream(ref, final);
      return "done";
    } catch (err) {
      const kind = err instanceof ChannelStreamError ? err.kind : "unknown";
      console.error(`[channels] ${channelType}: stopStream failed`, err);
      // `stream_gone` and `stopped_by_user` both mean the provider has already
      // closed this message. Retrying would fail the same way for ever.
      return kind === "stream_gone" || kind === "stopped_by_user" ? "done" : "retry";
    }
  }

  /** Forgets a stream the provider already closed. No stopStream call. */
  private async discard(stream: ActiveStream): Promise<void> {
    stream.closed = true;
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = null;
    this.active.delete(stateKey(stream.turn.sessionId, stream.turn.threadId));
    await this.deleteRecord(stream);
    this.deps.markDelivered(`${stream.turn.sessionId}:${stream.engineMessageId}`);
  }

  private async deleteRecord(stream: ActiveStream): Promise<void> {
    if (!stream.ref) return;
    await this.deleteRecordFor(stream.turn.channelType, stream.turn.conversationKey, stream.ref.messageId);
  }

  private async deleteRecordFor(
    channelType: string,
    conversationKey: string,
    messageId: string,
  ): Promise<void> {
    try {
      await this.deps.streams.delete({ channelType, conversationKey, messageId });
    } catch (err) {
      console.error("[channels] active-stream row delete failed", err);
    }
  }

  private markStreamed(sessionId: string, messageId: string): void {
    const key = `${sessionId}:${messageId}`;
    this.streamed.add(key);
    this.streamedOrder.push(key);
    if (this.streamedOrder.length > STREAMED_CAP) {
      const evict = this.streamedOrder.shift();
      if (evict !== undefined) this.streamed.delete(evict);
    }
  }

  private async setStatus(turn: StreamTurn, status: string): Promise<void> {
    const transport = this.deps.transportFor(turn.channelType);
    if (!transport?.setStatus) return;
    try {
      await transport.setStatus(turn.conversationKey, turn.threadTs, status);
    } catch (err) {
      // A status shimmer is decoration. Losing it must not fail a turn.
      console.error(`[channels] ${turn.channelType}: setStatus failed`, err);
    }
  }

  // ── Sweeps ────────────────────────────────────────────────────────

  /**
   * Closes streams left open by a previous boot.
   *
   * The deltas are gone — ephemeral, never replayed — so this cannot finish
   * the answer, and it does not claim to. It closes the message with a line
   * pointing at the session, where the durable `message_end` entry holds the
   * full text.
   *
   * Only rows older than this process are swept. With one api this is every
   * row. Running two api processes against one database would let one boot
   * close a peer's live stream; the reader would see a truncated answer with
   * the note above, which is recoverable, whereas leaving the row would strand
   * a message forever. If replicas ever become normal, add an owner column and
   * sweep only your own rows.
   */
  async sweepOnBoot(channelType: string, bootedAt: number): Promise<number> {
    const rows = await this.deps.streams.listStale(channelType, bootedAt);
    return this.closeRows(
      rows,
      "The api restarted during this answer. Open the session in Valet to read all of it.",
    );
  }

  /**
   * Catches rows this process wrote and then lost — a crash between the insert
   * and any handler, or a turn that hung with a stream open.
   */
  async sweepOrphans(): Promise<number> {
    const cutoff = this.now() - STREAM_MAX_AGE_MS;
    let closed = 0;
    const channelTypes = new Set<string>();
    for (const stream of this.active.values()) channelTypes.add(stream.turn.channelType);
    for (const turn of this.pending.values()) channelTypes.add(turn.channelType);
    for (const channelType of channelTypes) {
      try {
        const rows = await this.deps.streams.listStale(channelType, cutoff);
        // Never close a stream this process is still writing to.
        const abandoned = rows.filter((row) => !this.ownsRow(row));
        closed += await this.closeRows(
          abandoned,
          "This answer stopped before it finished. Send the message again, or open the session in Valet.",
        );
      } catch (err) {
        console.error(`[channels] ${channelType}: orphan sweep failed`, err);
      }
    }
    return closed;
  }

  private ownsRow(row: ActiveStreamRecord): boolean {
    const stream = this.active.get(stateKey(row.sessionId, row.threadId));
    return stream?.ref?.messageId === row.messageId;
  }

  private async closeRows(rows: ActiveStreamRecord[], note: string): Promise<number> {
    let closed = 0;
    for (const row of rows) {
      const transport = this.deps.transportFor(row.channelType);
      if (!transport || !canStream(transport)) continue;
      const ref: StreamRef = {
        conversationKey: row.conversationKey,
        messageId: row.messageId,
        threadTs: row.threadTs,
      };
      const outcome = await this.tryStop(transport, ref, row.channelType, { markdown: note });
      if (outcome === "done") {
        closed += 1;
      } else if (this.now() - row.startedAt < STREAM_ABANDON_AFTER_MS) {
        // A transient failure. Keep the row and try again next sweep, because
        // the message is still shimmering on someone's screen.
        continue;
      } else {
        console.error(
          `[channels] ${row.channelType}: giving up on stream ${row.messageId} after ` +
            `${Math.round(STREAM_ABANDON_AFTER_MS / 60_000)} minutes of failed closes`,
        );
      }
      await this.deleteRecordFor(row.channelType, row.conversationKey, row.messageId);
    }
    return closed;
  }
}
