/**
 * Slack channel transport for the agent messaging experience (`agent_view`).
 *
 * The surface is a direct message between one person and the app, and every
 * turn is a thread whose root is the user's own message. That shape drives
 * three decisions this file makes differently from a general channel adapter:
 *
 * 1. It routes direct messages only. Channel posts and @mentions belong to
 *    the event pipeline (`../triggers.ts`), not to a conversation.
 * 2. Each Slack thread maps to its own Valet thread. The conversation key
 *    includes the thread root's timestamp (`threadTs = event.thread_ts ??
 *    event.ts`), so a top-level DM opens a new Valet thread while replies
 *    inside an existing Slack thread stay in the same Valet thread.
 * 3. Replies stream. `chat.startStream`/`appendStream`/`stopStream` put the
 *    agent's text on screen as it is produced, the way the web UI shows it.
 *    The host drives that lifecycle; this file provides the three calls and
 *    translates Slack's error vocabulary into `ChannelStreamError`.
 *
 * Under `agent_view` the thread root is the user's own message and carries no
 * `assistant_app_thread` subtype. Nothing here keys off that subtype.
 */
import {
  ChannelLookupError,
  ChannelStreamError,
  type ChannelGatePrompt,
  type ChannelGateResolution,
  type ChannelStreamErrorKind,
  type ChannelTransport,
  type ChannelTransportFactory,
  type FetchedChannelMedia,
  type GatePromptRef,
  type InboundChannelEvent,
  type InboundChannelMedia,
  type OutboundChannelAttachment,
  type OutboundChannelMessage,
  type RawChannelUpdate,
  type SendRef,
  type StreamRef,
  type SuggestedPrompt,
  type TransportContext,
} from "@valet/engine";
import { buildContentBlocks, SLACK_MAX_BLOCKS, SLACK_TEXT_LIMIT } from "../message-chunking.js";
import { SKIP_SUBTYPES } from "../subtypes.js";
import { SlackApi, SlackApiError, SLACK_MARKDOWN_TEXT_LIMIT } from "./api.js";
import { fetchThreadTranscript } from "./thread-context.js";
import { enrichSlackText } from "./text-enrich.js";
import { markdownToSlackMrkdwn, neutralizeSlackMentions } from "./format.js";
import { verifySlackSignatureSync } from "./verify.js";

const MAX_IMAGE_DOWNLOAD_BYTES = 10 * 1024 * 1024; // 10 MB (images prefer thumbnails anyway)
const MAX_FILE_DOWNLOAD_BYTES = 25 * 1024 * 1024; // 25 MB (PDFs, documents)

/** Cap the in-memory url_private / gate-text / turn maps. Per-thread keys
 * grow faster than per-DM keys, so allow for more active threads. */
const MAX_TRACKED_ENTRIES = 2000;

/** Slack limits: a header block's plain_text is 150 chars; a section holds 10 fields. */
const SLACK_HEADER_LIMIT = 150;
const SLACK_SECTION_FIELD_LIMIT = 10;

function truncatePlain(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Escape a plain-text line for an mrkdwn field — same rationale as the
 * escape inside `markdownToSlackMrkdwn`: `&`/`<` render control sequences
 * (mass pings, spoofed links) inert. */
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** Slack date token: renders the moment in each reader's own timezone. */
function slackDateToken(epochMs: number): string {
  const seconds = Math.floor(epochMs / 1000);
  return `<!date^${seconds}^{date_short_pretty} at {time}|${new Date(epochMs).toISOString()}>`;
}

/** Matches a `link <code>` DM that starts the identity-link flow. Exported
 * so the plugin's `deliveryDm` copy can be tested against the same parser —
 * the DM tells the user to send exactly what this regex accepts. */
export const LINK_COMMAND_RE = /^\s*link\s+(\S+)\s*$/i;

// ─── Conversation-key codec ─────────────────────────────────────────────────
//
// conversationKey: "slack:{teamId}:{channelId}:{threadTs}"
// engine threadKey: "slack:{channelId}:{threadTs}"
//
// Each Slack thread root maps to its own Valet thread: a top-level DM uses its
// own `ts` as `threadTs`, a reply inside an existing Slack thread uses that
// thread's root ts. The team id stays out of the thread key because the
// transport already knows it — one credential serves one workspace. It stays
// IN the conversation key because the host round-trips that value into
// outbound calls and a bare channel id would not say which workspace it
// belongs to.

export interface SlackConversationRef {
  teamId: string;
  channelId: string;
  threadTs: string;
}

export function conversationKeyFor(teamId: string, channelId: string, threadTs: string): string {
  return `slack:${teamId}:${channelId}:${threadTs}`;
}

/** The engine thread key for a Slack conversation (no team id — it lives on the credential). */
export function threadKeyFor(channelId: string, threadTs: string): string {
  return `slack:${channelId}:${threadTs}`;
}

export function parseConversationKey(key: string): SlackConversationRef | null {
  if (!key.startsWith("slack:")) return null;
  const parts = key.slice("slack:".length).split(":");
  if (parts.length !== 3 || parts.some((p) => p === "")) return null;
  return { teamId: parts[0], channelId: parts[1], threadTs: parts[2] };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Clean Slack-specific markup from message text. The app's own mention is
 * removed, other user mentions fall back to "@USERID", channel links
 * `<#C…|name>` become #name, and link syntax collapses to its label.
 */
export function cleanSlackText(text: string, selfUserId?: string): string {
  let cleaned = text;
  if (selfUserId) cleaned = cleaned.split(`<@${selfUserId}>`).join("");
  cleaned = cleaned.replace(/<@([A-Z0-9]+)>/g, "@$1");
  cleaned = cleaned.replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1");
  cleaned = cleaned.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2");
  cleaned = cleaned.replace(/<(https?:\/\/[^>]+)>/g, "$1");
  return cleaned.trim();
}

/**
 * Slack error codes that end a stream, mapped to what the host should do.
 * Anything absent here is `unknown`, which the host treats as fatal — see
 * `ChannelStreamErrorKind`.
 */
const STREAM_ERROR_KINDS: Record<string, ChannelStreamErrorKind> = {
  stopped_by_user: "stopped_by_user",
  message_not_in_streaming_state: "stream_gone",
  message_not_owned_by_app: "stream_gone",
  message_not_found: "stream_gone",
  channel_not_found: "stream_gone",
  is_archived: "stream_gone",
  // slackFetch already slept and retried three times before surfacing these,
  // so no Retry-After value survives to pass on. The host must choose its own
  // backoff; a number invented here would be worse than none.
  rate_limited: "rate_limited",
  ratelimited: "rate_limited",
};

/** Re-throw a Slack failure as the host-facing stream error. */
function asStreamError(err: unknown): never {
  if (err instanceof SlackApiError) {
    const kind = STREAM_ERROR_KINDS[err.detail] ?? "unknown";
    throw new ChannelStreamError(kind, err.message);
  }
  throw new ChannelStreamError("unknown", err instanceof Error ? err.message : String(err));
}

/**
 * Split streamed markdown so no piece exceeds `maxLen`, losing nothing.
 *
 * `splitText` in message-chunking drops the newline it splits on, which suits
 * discrete blocks but would delete paragraph breaks from a stream. Here the
 * newline stays at the head of the next piece, so concatenating the pieces
 * reproduces the input exactly.
 */
export function splitForStream(text: string, maxLen: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n", maxLen);
    if (cut <= 0) cut = maxLen;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest !== "") pieces.push(rest);
  return pieces;
}

interface SlackFileRef {
  urlPrivate: string;
  thumb?: string;
  mimeType: string;
  name?: string;
  size?: number;
}

export class SlackTransport implements ChannelTransport {
  readonly channelType = "slack";
  /** Socket Mode ingress; only present when the credential carries an app token. */
  readonly poll?: (signal: AbortSignal) => AsyncIterable<RawChannelUpdate>;

  /** fileId → private download URLs captured at parseUpdate time. */
  private readonly fileRefs = new Map<string, SlackFileRef>();
  /** `${conversationKey}#${messageId}` → gate title (mrkdwn), for the
   * resolution edit: the update keeps the title and drops the prompt detail. */
  private readonly gateTitles = new Map<string, string>();
  /**
   * conversationKey → `thread_ts` of the most recent inbound turn.
   *
   * Two host calls carry no per-turn handle: `sendTyping(conversationKey)`
   * and `sendGatePrompt(conversationKey, gate)`. Slack needs a `thread_ts`
   * for both — a status shimmer attaches to a thread, and a gate must appear
   * under the turn that raised it. A DM has one person in it, so the last
   * inbound turn is the right thread for both.
   */
  private readonly lastTurn = new Map<string, string>();
  /**
   * conversationKeys minted for a fresh DM (`openDirectConversation`), whose
   * threadTs is synthetic and names no real message. A reply on such a key must
   * stay top-level, so `replyThreadTs` does not fall back to the key's threadTs
   * for these.
   */
  private readonly syntheticKeys = new Map<string, true>();
  /** Monotonic counter for collision avoidance in synthetic ts generation. */
  private syntheticTsCounter = 0;

  constructor(
    private readonly api: SlackApi,
    private readonly teamId: string,
    private readonly signingSecret?: string,
    private readonly botUserId?: string,
    appToken?: string,
  ) {
    if (appToken !== undefined) {
      this.poll = (signal) => this.socketModePoll(appToken, signal);
    }
  }

  // ─── Ingress ──────────────────────────────────────────────────────────

  /**
   * Slack signs every delivery with the app's signing secret, which is
   * provider-issued and stored on the credential. That is unlike a transport
   * whose webhook the host registers with a secret it minted.
   *
   * `webhookSecret` is the key the rest of Valet uses for a provider-issued
   * webhook secret: `routes/slack-webhook.ts` passes it, the Slack
   * `TriggerDef`s read it, and `routes/credentials.ts` stores it under that
   * name. `signingSecret` is accepted as well so a credential saved under
   * the older key still verifies.
   */
  verifyWebhook(
    req: { headers: Record<string, string>; rawBody: Uint8Array },
    secrets: Record<string, string> = {},
  ): RawChannelUpdate[] | null {
    const secret = secrets.webhookSecret ?? secrets.signingSecret ?? this.signingSecret;
    if (secret === undefined || secret === "") return null;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) headers[key.toLowerCase()] = value;
    const bodyText = new TextDecoder().decode(req.rawBody);
    if (!verifySlackSignatureSync(headers, bodyText, secret)) return null;
    try {
      if (bodyText.startsWith("payload=")) {
        // Interactivity posts form-encoded with a single `payload` JSON param.
        const payload = new URLSearchParams(bodyText).get("payload");
        if (payload === null) return null;
        return [JSON.parse(payload) as unknown];
      }
      return [JSON.parse(bodyText) as unknown];
    } catch {
      return null;
    }
  }

  parseUpdate(update: RawChannelUpdate): InboundChannelEvent | null {
    const u = rec(update);
    if (!u) return null;
    if (u.type === "block_actions") return this.parseBlockActions(u, update);
    if (u.type !== "event_callback") return null;

    const eventId = str(u.event_id);
    const event = rec(u.event);
    if (!eventId || !event) return null;
    const teamId = str(u.team_id) ?? this.teamId;

    switch (str(event.type)) {
      case "message":
        return this.parseMessage(event, eventId, teamId, update);
      // app_home_opened is deliberately ignored under per-thread routing: the
      // event has no thread_ts to anchor a conversation key, and starter
      // prompts re-emit on the first real message anyway.
      case "app_context_changed":
        // Consumed on purpose. The app subscribes to this event because the
        // subscription is what makes Slack attach `context` to message.im and
        // app_home_opened, which is where this transport reads it. The
        // standalone event adds nothing the next real event will not carry.
        return null;
      default:
        return null;
    }
  }

  private parseMessage(
    event: Record<string, unknown>,
    eventId: string,
    teamId: string,
    update: RawChannelUpdate,
  ): InboundChannelEvent | null {
    // Drop the app's own output. Streamed replies come back as message events
    // on the same DM; without this the agent answers itself forever.
    if (event.bot_id !== undefined && event.bot_id !== null) return null;
    const subtype = str(event.subtype);
    if (subtype !== undefined && SKIP_SUBTYPES.has(subtype)) return null;
    if (subtype !== undefined && subtype !== "file_share") return null;

    // The agent surface is the DM. Channel traffic is the event pipeline's.
    if (str(event.channel_type) !== "im") return null;

    const channel = str(event.channel);
    const user = str(event.user);
    const ts = str(event.ts) ?? str(event.event_ts);
    if (!channel || !user || !ts) return null;
    if (this.botUserId !== undefined && user === this.botUserId) return null;

    // A turn replies under the user's own message. When the user types into
    // an existing thread, that thread's root wins. Compute this BEFORE the
    // conversation key since it is now part of the key.
    const threadTs = str(event.thread_ts) ?? ts;
    const conversationKey = conversationKeyFor(teamId, channel, threadTs);
    this.remember(this.lastTurn, conversationKey, threadTs);

    const text = cleanSlackText(str(event.text) ?? "", this.botUserId);
    const media = this.mediaOf(event);
    if (text === "" && media === undefined) return null;

    const linkCmd = text !== "" ? LINK_COMMAND_RE.exec(text) : null;
    if (linkCmd) {
      const inbound: InboundChannelEvent = {
        dispatchId: `slack:${eventId}`,
        conversationKey,
        sender: { externalId: user },
        kind: "command",
        text,
        command: { name: "start", args: linkCmd[1] },
        raw: update,
      };
      return inbound;
    }

    const inbound: InboundChannelEvent = {
      dispatchId: `slack:${eventId}`,
      conversationKey,
      sender: { externalId: user },
      kind: "message",
      text: text !== "" ? text : undefined,
      media,
      threadTs,
      raw: update,
    };
    const context = this.contextOf(event);
    if (context) inbound.context = context;
    return inbound;
  }

  /**
   * Read the app context Slack attaches once the app subscribes to
   * `app_context_changed`. An empty context serializes as `"context": {}`
   * with no `entities` key, so the array is never assumed to exist.
   */
  private contextOf(event: Record<string, unknown>): InboundChannelEvent["context"] {
    const raw = rec(event.context);
    if (!raw || !Array.isArray(raw.entities)) return undefined;
    const entities: Array<{ type: string; value: string }> = [];
    for (const item of raw.entities) {
      const entity = rec(item);
      const type = str(entity?.type);
      const value = str(entity?.value);
      if (type && value) entities.push({ type, value });
    }
    return entities.length > 0 ? { entities } : undefined;
  }

  private parseBlockActions(u: Record<string, unknown>, raw: RawChannelUpdate): InboundChannelEvent | null {
    const triggerId = str(u.trigger_id);
    if (!triggerId) return null;
    const actions = Array.isArray(u.actions) ? u.actions : [];
    const action = rec(actions[0]);
    if (!action) return null;
    const value = str(action.value);
    if (!value) return null;
    const parts = value.split("|");
    if (parts.length < 3 || parts[0] !== "g" || parts[1] === "") return null;
    const gateId = parts[1];
    const actionId = parts.slice(2).join("|");
    if (actionId === "") return null;

    const container = rec(u.container);
    const messageTs = str(container?.message_ts);
    const channelId = str(rec(u.channel)?.id) ?? str(container?.channel_id);
    const userRec = rec(u.user);
    const userId = str(userRec?.id);
    if (!messageTs || !channelId || !userId) return null;

    const teamId = str(rec(u.team)?.id) ?? this.teamId;
    const threadTs = str(container?.thread_ts) ?? messageTs;
    const conversationKey = conversationKeyFor(teamId, channelId, threadTs);

    return {
      dispatchId: `slack:ia:${triggerId}`,
      conversationKey,
      sender: { externalId: userId, displayName: str(userRec?.username) ?? str(userRec?.name) },
      kind: "gate_callback",
      threadTs,
      gateCallback: {
        actionId,
        gateId,
        callbackId: triggerId,
        ref: { conversationKey, messageId: messageTs },
      },
      raw,
    };
  }

  private mediaOf(event: Record<string, unknown>): InboundChannelMedia[] | undefined {
    const files = Array.isArray(event.files) ? event.files : [];
    const media: InboundChannelMedia[] = [];
    for (const item of files) {
      const file = rec(item);
      if (!file) continue;
      const fileId = str(file.id);
      const urlPrivate = str(file.url_private);
      if (!fileId || !urlPrivate) continue;
      const mimeType = str(file.mimetype) ?? "application/octet-stream";
      const name = str(file.name);
      const size = num(file.size);
      const thumb = str(file.thumb_1024) ?? str(file.thumb_720) ?? str(file.thumb_480) ?? str(file.thumb_360);
      this.remember(this.fileRefs, fileId, { urlPrivate, thumb, mimeType, name, size });
      media.push({
        kind: mimeType.startsWith("image/") ? "photo" : "document",
        fileId,
        mimeType,
        fileName: name,
        fileSize: size,
      });
    }
    return media.length > 0 ? media : undefined;
  }

  private remember<V>(map: Map<string, V>, key: string, value: V): void {
    map.set(key, value);
    if (map.size > MAX_TRACKED_ENTRIES) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }

  /**
   * The `thread_ts` an outbound message should carry.
   *
   * Prefer the thread root recorded for the most recent INBOUND turn on this
   * key (`lastTurn`). When none was recorded — a reply routed from an event
   * trigger, whose `parseUpdate` never ran for this conversation — fall back to
   * the key's own thread root, which is the real message ts. A synthetic
   * fresh-DM key names no real thread, so it stays top-level (`undefined`).
   */
  private replyThreadTs(conversationKey: string): string | undefined {
    const recorded = this.lastTurn.get(conversationKey);
    if (recorded !== undefined) return recorded;
    if (this.syntheticKeys.has(conversationKey)) return undefined;
    return parseConversationKey(conversationKey)?.threadTs;
  }

  // ─── Socket Mode (local-dev ingress) ──────────────────────────────────

  private async *socketModePoll(appToken: string, signal: AbortSignal): AsyncIterable<RawChannelUpdate> {
    // Reconnect backoff is only reset after a connection that STAYED UP for at
    // least this long. Otherwise a connect→immediate-disconnect storm (Slack
    // refusing/rotating the socket) would reset the backoff to the floor on
    // every accept and spin at ~1 reconnect/sec against connections.open.
    const MIN_HEALTHY_DWELL_MS = 30_000;
    let backoffMs = 1000;
    while (!signal.aborted) {
      let ws: WebSocket;
      let connectedAt = 0;
      try {
        const url = await this.api.connectionsOpen(appToken);
        ws = await openWebSocket(url, signal);
        connectedAt = Date.now();
      } catch {
        if (signal.aborted) return;
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60_000);
        continue;
      }

      const queue: RawChannelUpdate[] = [];
      let closed = false;
      let notify: (() => void) | null = null;
      const wake = (): void => {
        notify?.();
        notify = null;
      };
      const onAbort = (): void => ws.close();
      signal.addEventListener("abort", onAbort);
      ws.addEventListener("close", () => {
        closed = true;
        wake();
      });
      ws.addEventListener("error", () => {
        closed = true;
        wake();
      });
      ws.addEventListener("message", (ev: MessageEvent) => {
        const data: unknown = ev.data;
        if (typeof data !== "string") return;
        let msg: Record<string, unknown> | undefined;
        try {
          msg = rec(JSON.parse(data));
        } catch {
          return;
        }
        if (!msg) return;
        if (msg.type === "disconnect") {
          // Slack asks us to reconnect (deploys, connection rotation).
          ws.close();
          return;
        }
        const envelopeId = str(msg.envelope_id);
        if (envelopeId !== undefined) ws.send(JSON.stringify({ envelope_id: envelopeId }));
        // events_api payloads are event_callback bodies; interactive payloads
        // are block_actions objects — both are parseUpdate inputs. Slash
        // command envelopes are acked but not yielded.
        if ((msg.type === "events_api" || msg.type === "interactive") && msg.payload !== undefined) {
          queue.push(msg.payload);
          wake();
        }
      });

      try {
        while (true) {
          while (queue.length > 0) {
            const next = queue.shift();
            if (next !== undefined) yield next;
            if (signal.aborted) return;
          }
          if (closed) break;
          await new Promise<void>((resolve) => {
            notify = resolve;
            if (closed || queue.length > 0) wake();
          });
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        try {
          ws.close();
        } catch {
          // already closed
        }
      }

      if (signal.aborted) return;
      // A connection that stayed up is healthy — reset so the next reconnect
      // is prompt. A short-lived one keeps escalating the backoff.
      if (Date.now() - connectedAt >= MIN_HEALTHY_DWELL_MS) backoffMs = 1000;
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }

  // ─── Streaming egress ─────────────────────────────────────────────────

  async startStream(conversationKey: string, ctx: { threadTs: string }): Promise<StreamRef> {
    const target = this.mustParse(conversationKey);
    try {
      // No recipient_user_id: Slack requires it only when streaming into a
      // channel, and this surface is a DM. Add it if `missing_recipient_user_id`
      // ever comes back.
      const res = await this.api.startStream({ channel: target.channelId, threadTs: ctx.threadTs });
      return { conversationKey, messageId: res.ts, threadTs: ctx.threadTs };
    } catch (err) {
      asStreamError(err);
    }
  }

  /**
   * Append markdown to an open stream. Slack caps `markdown_text` at 12,000
   * characters and drops the excess without an error, so anything longer is
   * split and sent in order. The host batches deltas; this is the last guard
   * against silent text loss.
   */
  async appendStream(ref: StreamRef, markdown: string): Promise<void> {
    const target = this.mustParse(ref.conversationKey);
    const safe = neutralizeSlackMentions(markdown);
    if (safe === "") return;
    try {
      for (const piece of splitForStream(safe, SLACK_MARKDOWN_TEXT_LIMIT)) {
        await this.api.appendStream({ channel: target.channelId, ts: ref.messageId, markdownText: piece });
      }
    } catch (err) {
      asStreamError(err);
    }
  }

  /**
   * Close the stream, optionally with a last piece of markdown.
   *
   * A `final` longer than the 12,000-character limit is appended in pieces
   * first and only its tail rides on the stop call. Truncating instead would
   * silently drop the end of the answer, which is the one part the reader was
   * waiting for.
   */
  async stopStream(ref: StreamRef, final?: { markdown?: string }): Promise<void> {
    const target = this.mustParse(ref.conversationKey);
    const markdown = final?.markdown;
    const safe =
      markdown !== undefined && markdown !== "" ? neutralizeSlackMentions(markdown) : undefined;
    try {
      let tail = safe;
      if (safe !== undefined && safe.length > SLACK_MARKDOWN_TEXT_LIMIT) {
        const pieces = splitForStream(safe, SLACK_MARKDOWN_TEXT_LIMIT);
        tail = pieces.pop();
        for (const piece of pieces) {
          await this.api.appendStream({ channel: target.channelId, ts: ref.messageId, markdownText: piece });
        }
      }
      await this.api.stopStream({ channel: target.channelId, ts: ref.messageId, markdownText: tail });
    } catch (err) {
      asStreamError(err);
    }
  }

  // ─── Assistant thread controls ────────────────────────────────────────

  async setStatus(conversationKey: string, threadTs: string, status: string): Promise<void> {
    const target = this.mustParse(conversationKey);
    await this.api.setThreadStatus(target.channelId, threadTs, status);
  }

  /**
   * Offer starter prompts. `threadTs` is omitted for a conversation with no
   * turn yet, which puts the prompts at the top of the Messages tab.
   */
  async setSuggestedPrompts(
    conversationKey: string,
    prompts: SuggestedPrompt[],
    opts?: { threadTs?: string; title?: string },
  ): Promise<void> {
    if (prompts.length === 0) return;
    const target = this.mustParse(conversationKey);
    await this.api.setSuggestedPrompts({
      channelId: target.channelId,
      prompts,
      threadTs: opts?.threadTs,
      title: opts?.title,
    });
  }

  async setThreadTitle(conversationKey: string, threadTs: string, title: string): Promise<void> {
    const target = this.mustParse(conversationKey);
    await this.api.setThreadTitle(target.channelId, threadTs, title);
  }

  // ─── Discrete-message egress ──────────────────────────────────────────

  async send(conversationKey: string, message: OutboundChannelMessage): Promise<SendRef> {
    const target = this.mustParse(conversationKey);
    const threadTs = this.replyThreadTs(conversationKey);
    const formatted = markdownToSlackMrkdwn(message.markdown);
    let text = formatted;
    let blocks: Record<string, unknown>[] | undefined;
    if (message.markdown.length > SLACK_TEXT_LIMIT) {
      // One API call with blocks — never several messages (chat.postMessage is
      // limited to 1/sec/channel; see message-chunking.ts).
      blocks = buildContentBlocks(message.markdown, formatted, SLACK_MAX_BLOCKS);
      text = formatted.slice(0, SLACK_TEXT_LIMIT); // notification fallback
    }
    const res = await this.api.postMessage({ channel: target.channelId, text, threadTs, blocks });
    return { conversationKey, messageId: res.ts };
  }

  async sendMedia(conversationKey: string, attachment: OutboundChannelAttachment): Promise<SendRef> {
    const target = this.mustParse(conversationKey);
    const name = attachment.type === "file" ? attachment.name : (attachment.name ?? `image-${Date.now()}.png`);
    const { uploadUrl, fileId } = await this.api.getUploadUrlExternal(name, attachment.data.byteLength);
    await this.api.uploadToUrl(uploadUrl, attachment.data, attachment.mimeType);
    await this.api.completeUploadExternal({
      fileId,
      channelId: target.channelId,
      threadTs: this.replyThreadTs(conversationKey),
      initialComment: attachment.caption,
    });
    // files.completeUploadExternal returns no message ts; the file id is the
    // only stable handle for what was shared.
    return { conversationKey, messageId: fileId };
  }

  // ─── Approval gates ───────────────────────────────────────────────────

  /**
   * A gate is its own message, not a chunk inside the stream. A parked turn
   * can wait hours for an answer, and Slack documents no timeout for a stream
   * left open — so the host closes the stream first and posts this
   * separately. Interactivity is unaffected by `agent_view`.
   */
  async sendGatePrompt(conversationKey: string, gate: ChannelGatePrompt): Promise<GatePromptRef> {
    const target = this.mustParse(conversationKey);
    const titleMrkdwn = markdownToSlackMrkdwn(`**${gate.title}**`);
    // Notification fallback: title + body, no field detail.
    const text = gate.body ? `${titleMrkdwn}\n\n${markdownToSlackMrkdwn(gate.body)}` : titleMrkdwn;
    const blocks: Record<string, unknown>[] = [
      // Header block, not a bold section: Slack renders it as a real title,
      // which is what makes the card scannable in a busy thread.
      { type: "header", text: { type: "plain_text", text: truncatePlain(gate.title, SLACK_HEADER_LIMIT) } },
    ];
    if (gate.body) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: markdownToSlackMrkdwn(gate.body) } });
    }
    // Key parameters as labeled two-column fields — Slack caps a section at
    // 10 fields, so overflow rolls into further sections.
    const fieldTexts = (gate.fields ?? []).map((f) => ({
      type: "mrkdwn",
      text: `*${markdownToSlackMrkdwn(f.label)}*\n${markdownToSlackMrkdwn(f.value)}`,
    }));
    for (let i = 0; i < fieldTexts.length; i += SLACK_SECTION_FIELD_LIMIT) {
      blocks.push({ type: "section", fields: fieldTexts.slice(i, i + SLACK_SECTION_FIELD_LIMIT) });
    }
    blocks.push({
      type: "actions",
      elements: gate.actions.map((action) => ({
        type: "button",
        text: { type: "plain_text", text: action.label },
        action_id: action.id,
        // Slack allows 2,000-char values, so the real gate id rides along
        // instead of being looked up by message reference (Telegram's
        // 64-byte callback_data cannot carry it). The host uses it as a
        // fallback when its in-memory ref map misses, but the map's
        // sessionId is still required to resolve — an api restart still
        // loses a pending gate.
        value: `g|${gate.gateId}|${action.id}`,
        ...(action.style !== undefined ? { style: action.style } : {}),
      })),
    });
    const threadTs = this.replyThreadTs(conversationKey);
    const res = await this.api.postMessage({
      channel: target.channelId,
      text,
      threadTs,
      blocks,
    });
    // The returned ref must round-trip through the inbound click:
    // `parseBlockActions` rebuilds the conversationKey from
    // `container.thread_ts ?? message_ts` — the REAL thread ts. A key minted
    // by `openDirectConversation` carries a synthetic ts and would never
    // match, so re-key the ref by what the click will actually carry: the
    // thread we posted into, or the message's own ts for a root post.
    const refKey = conversationKeyFor(target.teamId, target.channelId, threadTs ?? res.ts);
    this.remember(this.gateTitles, `${refKey}#${res.ts}`, titleMrkdwn);
    return { conversationKey: refKey, messageId: res.ts };
  }

  async updateGatePrompt(ref: GatePromptRef, resolution: ChannelGateResolution): Promise<void> {
    const target = this.mustParse(ref.conversationKey);
    const key = `${ref.conversationKey}#${ref.messageId}`;
    const title = this.gateTitles.get(key);
    // The edit REPLACES the prompt: title + outcome + timestamp, so a settled
    // approval stops occupying the thread with the full request. The label
    // arrives as plain text (it may carry a person's name), so escape it for
    // mrkdwn; `<!date^…>` renders in the reader's own timezone.
    const outcome =
      resolution.resolvedAtMs !== undefined
        ? `${escapeMrkdwn(resolution.label)} · ${slackDateToken(resolution.resolvedAtMs)}`
        : escapeMrkdwn(resolution.label);
    const text = title !== undefined ? `${title}\n${outcome}` : outcome;
    // Keep a single section block (which clears the buttons) and pin
    // parse: "none" — chat.update defaults parse to "client" and would
    // re-render link markup.
    await this.api.updateMessage({
      channel: target.channelId,
      ts: ref.messageId,
      text,
      blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
      parse: "none",
    });
    this.gateTitles.delete(key);
  }

  /**
   * Slack has no bot typing indicator; the agent surface has a thread status
   * shimmer instead. Failures are swallowed — a missing shimmer must not fail
   * the turn, and the status lapses on its own after two minutes.
   */
  async sendTyping(conversationKey: string): Promise<void> {
    // Only a conversation with a recorded inbound turn gets a shimmer; a
    // fresh/uninitiated key stays quiet (not `replyThreadTs`, which would
    // shimmer an event-triggered thread that never sent an inbound turn here).
    const threadTs = this.lastTurn.get(conversationKey);
    if (threadTs === undefined) return;
    try {
      await this.setStatus(conversationKey, threadTs, "is thinking...");
    } catch {
      // Not an agent thread, or the scope is missing — nothing to show.
    }
  }

  /** Prior thread messages as an attributed transcript — see `ChannelTransport`.
   *  `selfUserId` strips the bot's own mention from the seeded trigger line. */
  async fetchThreadContext(channelId: string, threadTs: string): Promise<string | null> {
    return fetchThreadTranscript(this.api, { channelId, threadTs, selfUserId: this.botUserId });
  }

  /** Normalize an inbound message for an agent — see `ChannelTransport`. Resolves
   *  the sender's name and cleans the text so the model never sees raw ids or
   *  Slack markup. */
  async normalizeForAgent(msg: { userId?: string; text: string }): Promise<{ senderName?: string; text: string }> {
    const senderName = msg.userId ? (await this.api.usersInfo(msg.userId).catch(() => null))?.displayName : undefined;
    const text = await enrichSlackText(this.api, msg.text, this.botUserId);
    return { senderName, text };
  }

  /** The triggering message's own ts, so `react_to_origin` has a target — see
   *  `ChannelTransport`. `thread_ts` would point at the parent, not the message
   *  that mentioned the bot. */
  messageTsFromEvent(eventKey: string, payload: unknown): string | null {
    if (eventKey !== "slack.message" && eventKey !== "slack.app_mention") return null;
    if (typeof payload !== "object" || payload === null) return null;
    const ts = (payload as Record<string, unknown>).ts;
    return typeof ts === "string" ? ts : null;
  }

  async fetchMedia(media: InboundChannelMedia): Promise<FetchedChannelMedia | null> {
    let ref = this.fileRefs.get(media.fileId);
    if (!ref) {
      // Re-derive url_private via files.info (e.g. after an api restart).
      try {
        const file = await this.api.filesInfo(media.fileId);
        const urlPrivate = str(file.url_private);
        if (!urlPrivate) return null;
        ref = {
          urlPrivate,
          thumb: str(file.thumb_1024) ?? str(file.thumb_720) ?? str(file.thumb_480) ?? str(file.thumb_360),
          mimeType: str(file.mimetype) ?? media.mimeType ?? "application/octet-stream",
          name: str(file.name) ?? media.fileName,
          size: num(file.size) ?? media.fileSize,
        };
      } catch {
        return null;
      }
    }
    const isImage = ref.mimeType.startsWith("image/");
    const maxBytes = isImage ? MAX_IMAGE_DOWNLOAD_BYTES : MAX_FILE_DOWNLOAD_BYTES;
    // Prefer a Slack-generated thumbnail for images over the full-size file.
    const url = isImage && ref.thumb !== undefined ? ref.thumb : ref.urlPrivate;
    if (url === ref.urlPrivate && ref.size !== undefined && ref.size > maxBytes) return null;
    let data: Uint8Array | null;
    try {
      data = await this.api.downloadFile(url, maxBytes);
    } catch {
      return null;
    }
    if (data === null) return null;
    // When we served a Slack-generated thumbnail (images), the bytes are a
    // JPEG/PNG derivative, not the original encoding — report a matching
    // mimeType so a downstream decoder/vision API isn't handed e.g. image/heic
    // bytes that are actually JPEG. Full-file downloads keep the real mime.
    const servedThumb = isImage && ref.thumb !== undefined && url === ref.thumb;
    const mimeType = servedThumb ? "image/jpeg" : ref.mimeType;
    return { data, mimeType, name: ref.name };
  }

  // ─── Key mappings ─────────────────────────────────────────────────────

  threadKeyFromConversationKey(conversationKey: string): string {
    const target = parseConversationKey(conversationKey);
    if (!target) return conversationKey;
    return threadKeyFor(target.channelId, target.threadTs);
  }

  conversationKeyFromThreadKey(threadKey: string): string | null {
    if (!threadKey.startsWith("slack:")) return null;
    const rest = threadKey.slice("slack:".length);
    const parts = rest.split(":");
    // Expect exactly 2 segments: channelId and threadTs.
    if (parts.length !== 2 || parts.some((p) => p === "")) return null;
    const [channelId, threadTs] = parts;
    return conversationKeyFor(this.teamId, channelId, threadTs);
  }

  threadKeyFromEvent(eventKey: string, payload: unknown): string | null {
    // Only message-like events name a conversation to reply into. A reaction,
    // a channel-lifecycle change, or a workspace-join has no thread to answer.
    if (eventKey !== "slack.message" && eventKey !== "slack.app_mention") return null;
    if (typeof payload !== "object" || payload === null) return null;
    const p = payload as Record<string, unknown>;
    const channel = typeof p.channel === "string" ? p.channel : undefined;
    const ts = typeof p.thread_ts === "string" ? p.thread_ts : typeof p.ts === "string" ? p.ts : undefined;
    if (channel === undefined || ts === undefined) return null;
    return threadKeyFor(channel, ts);
  }

  // ─── Feature-detected extras (not part of ChannelTransport) ───────────

  /** Workspace-member typeahead for the identity-link flow (users.list, bot token). */
  async listWorkspaceMembers(query: string): Promise<Array<{ id: string; name: string; realName?: string }>> {
    const q = query.trim().toLowerCase();
    const out: Array<{ id: string; name: string; realName?: string }> = [];
    let cursor: string | undefined;
    // Bound the SCAN, not just the match count: a selective query that matches
    // few/no members would otherwise page through the entire directory (~250
    // users.list calls in a 50k-member workspace), hanging the typeahead and
    // hammering rate limits. Cap pages regardless of how many matches accrue.
    const MAX_PAGES = 10;
    let pages = 0;
    do {
      const page = await this.api.listUsers(cursor);
      pages += 1;
      for (const member of page.members) {
        if (member.isBot || member.deleted || member.id === "USLACKBOT") continue;
        if (
          q !== "" &&
          !member.name.toLowerCase().includes(q) &&
          !(member.realName ?? "").toLowerCase().includes(q)
        ) {
          continue;
        }
        out.push({ id: member.id, name: member.name, realName: member.realName });
        if (out.length >= 20) return out;
      }
      cursor = page.nextCursor;
      if (pages >= MAX_PAGES) break;
    } while (cursor !== undefined);
    return out;
  }

  /**
   * Channel typeahead for the event-filter picker (conversations.list, bot
   * token). Returns public and private channels matching `query` by name.
   */
  async listWorkspaceChannels(query: string): Promise<Array<{ id: string; name: string }>> {
    const q = query.trim().toLowerCase();
    const out: Array<{ id: string; name: string }> = [];
    let cursor: string | undefined;
    // Bound the SCAN, not just the match count: mirror listWorkspaceMembers so
    // a selective query in a workspace with thousands of channels cannot page
    // the whole directory and hang the typeahead.
    const MAX_PAGES = 10;
    let pages = 0;
    do {
      const page = await this.api.listChannels(cursor);
      pages += 1;
      for (const channel of page.channels) {
        if (channel.isArchived) continue;
        if (q !== "" && !channel.name.toLowerCase().includes(q)) continue;
        out.push({ id: channel.id, name: channel.name });
        if (out.length >= 20) return out;
      }
      cursor = page.nextCursor;
      if (pages >= MAX_PAGES) break;
    } while (cursor !== undefined);
    return out;
  }

  /**
   * Resolve a workspace member by email (users.lookupByEmail; needs the
   * `users:read.email` bot scope). Powers the "DM me the code" identity-link
   * delivery. `null` = the email names nobody here — the caller falls back
   * to the show-code flow.
   */
  async lookupUserByEmail(email: string): Promise<{ externalId: string; displayName: string } | null> {
    try {
      const match = await this.api.lookupUserByEmail(email);
      return match ? { externalId: match.id, displayName: match.displayName } : null;
    } catch (err) {
      if (err instanceof SlackApiError && err.detail === "missing_scope") {
        throw new ChannelLookupError(
          "missing_scope",
          "The Slack app is missing the users:read.email scope. Reinstall the Slack app to grant it.",
        );
      }
      throw new ChannelLookupError(
        "transport",
        `Slack users.lookupByEmail failed: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
  }

  /**
   * Open (or fetch) the app↔user IM and return a conversationKey for sending.
   *
   * Returns a key with a synthetic `threadTs` (current time as a Slack-style
   * timestamp). The recipient sees the message at the DM root because no
   * `lastTurn` entry exists for this key; if they reply, that reply's
   * inbound event mints its own (real) conversationKey with the actual
   * thread ts.
   *
   * The synthetic ts owns its full 6-digit microsecond field with a
   * per-instance monotonic counter, so the collision cycle is one million
   * calls per transport instance regardless of wall-clock resolution. That
   * is well above any realistic notification fan-out — Slack DM rate limits
   * hit long before it matters — and eliminates the earlier ms-only
   * collision window entirely.
   *
   * JS is single-threaded, so `syntheticTsCounter++` between the read of
   * `Date.now()` and the string build is atomic within an event-loop turn.
   * The function performs no `await` between those two points.
   */
  async openDirectConversation(slackUserId: string): Promise<string> {
    const channelId = await this.api.openConversation(slackUserId);
    // Slack ts format is "seconds.microseconds" (6 fractional digits).
    // The seconds come from wall clock; the microseconds come from a local
    // counter so distinct calls always mint distinct keys within a 10^6
    // window. See docstring for the atomicity argument.
    const secs = Math.floor(Date.now() / 1000);
    const micro = this.syntheticTsCounter++ % 1_000_000;
    const syntheticTs = `${secs}.${String(micro).padStart(6, "0")}`;
    const key = conversationKeyFor(this.teamId, channelId, syntheticTs);
    // A fresh DM has no real thread; mark the key so a reply on it stays
    // top-level instead of threading under the synthetic ts.
    this.remember(this.syntheticKeys, key, true);
    return key;
  }

  /**
   * Parse a conversation key and prove it belongs to this workspace.
   *
   * The team check is not decoration. A three-segment key that this transport
   * did not mint — for example one a host built with a hard-coded middle
   * segment — still parses, and its channel id still posts somewhere
   * plausible, so the damage would be a reply in the wrong place rather than
   * an error. Comparing the team id against the credential's own turns that
   * silent misdelivery into a named failure, and stops a key from one
   * workspace addressing another.
   */
  private mustParse(conversationKey: string): SlackConversationRef {
    const target = parseConversationKey(conversationKey);
    if (!target) {
      throw new Error(
        `Not a Slack conversation key: "${conversationKey}". Expected "slack:{teamId}:{channelId}:{threadTs}".`,
      );
    }
    if (target.teamId !== this.teamId) {
      throw new Error(
        `Slack conversation key "${conversationKey}" names workspace "${target.teamId}", but this transport serves "${this.teamId}". Rebuild the key with conversationKeyFromThreadKey().`,
      );
    }
    return target;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openWebSocket(url: string, signal: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const ws = new WebSocket(url);
    const onAbort = (): void => {
      ws.close();
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    ws.addEventListener("open", () => {
      signal.removeEventListener("abort", onAbort);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error(`websocket connect failed: ${url}`));
    });
  });
}

export const slackTransportFactory: ChannelTransportFactory = {
  channelType: "slack",
  // Slack's request URL is app-level configuration the operator sets in the
  // app manifest, and verification uses the app's own signing secret. The
  // host must not mint a secret or try to register anything.
  ingress: "external-webhook",
  create(ctx: TransportContext): ChannelTransport {
    const token = ctx.credential.accessToken;
    if (!token) {
      throw new Error(
        "Slack transport requires a bot token. Connect Slack in Settings → Integrations and save the bot token.",
      );
    }
    const metadata = ctx.credential.metadata ?? {};
    // teamId is load-bearing for outbound: conversation keys embed it, and an
    // empty one makes every send and gate key unparseable. Fail at
    // construction rather than on the first reply. The credential-save route
    // populates it from auth.test.
    const teamId = typeof metadata.teamId === "string" ? metadata.teamId : "";
    if (teamId === "") {
      throw new Error(
        "Slack transport requires metadata.teamId. Re-save the Slack credential so auth.test can populate it.",
      );
    }
    // `webhookSecret` is the canonical key `routes/credentials.ts` writes and
    // every other provider in this repo uses. `signingSecret` is read as a
    // fallback so a credential saved under the older key still works.
    const signingSecret = [metadata.webhookSecret, metadata.signingSecret].find(
      (value): value is string => typeof value === "string" && value !== "",
    );
    const botUserId = typeof metadata.botUserId === "string" ? metadata.botUserId : undefined;
    const appToken =
      typeof metadata.appToken === "string" && metadata.appToken !== "" ? metadata.appToken : undefined;
    if (signingSecret === undefined && appToken === undefined) {
      // Outbound still works, so this is a warning rather than a throw — but
      // nothing the user types will ever arrive, which is worth saying once.
      console.warn(
        "[slack] no signingSecret and no appToken: outbound only. Add the app signing secret for webhook ingress, or an app-level token for Socket Mode.",
      );
    }
    return new SlackTransport(
      new SlackApi(token, ctx.config.apiBaseUrl),
      teamId,
      signingSecret,
      botUserId,
      appToken,
    );
  },
};
