/**
 * `ChannelHost` — inbound routing for channel transports (telegram etc,
 * Phase 7 / spec decisions 4-6, 10). `handleUpdate` is the single entry
 * point both the poll loop (Task 8) and the webhook route feed normalized
 * `InboundChannelEvent`s through. It never throws (rule 7): callers can
 * fire-and-forget it from a poll loop or an HTTP handler without a
 * try/catch of their own.
 *
 * Outbound (gate prompts, message edits on `decision_gate_resolved`) is
 * Task 7's job — this file only records enough state (`recordGatePrompt`)
 * for that later code to read back. `start`/`stop`'s poll-loop lifecycle
 * lands in Task 8; `start` here only resolves credentials and constructs
 * transports.
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  parseAssistantSessionId,
  type ChannelTransport,
  type CommandResultEntry,
  type CredentialStore,
  type DecisionAction,
  type DecisionGate,
  type DecisionResolution,
  type DeliveredBusEvent,
  type EventStream,
  type GatePromptRef,
  type InboundChannelEvent,
  type PromptAttachment,
  type SessionStore,
  type StoredCredential,
  type Unsubscribe,
  type ValetPlugin,
} from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { EngineHost } from "../engine/host.js";
import { agentSessions, assistants } from "../schema/index.js";
import { ensureDefaultAssistantSession, loadAssistant } from "../assistants/service.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { canApplyAlwaysAllow, GATE_ACTION_ALWAYS_ALLOW } from "../policies/service.js";
import { canResolveSessionGate } from "../services/session-access.js";
import { writeDropLog } from "../orchestrator/signals.js";
import type { AttentionChannelDeliverer, AttentionEvent } from "../orchestrator/attention.js";
import { resolveOrgCredentialRead } from "../services/credential-resolution.js";
import { OnePasswordAuthError, type OnePasswordService } from "../services/onepassword.js";
import { consumeLinkCode, identityForExternal, identityForUser, linkIdentity } from "./identity-links.js";
import { DbActiveStreamStore, type ActiveStreamStore } from "./active-streams.js";
import { ChannelStreamBridge } from "./stream-bridge.js";

export interface ChannelHostDeps {
  db: AppDb;
  engineHost: EngineHost;
  engineStore: SessionStore;
  eventStream: EventStream;
  engineCredentials: CredentialStore;
  plugins: ValetPlugin[];
  /** Public base URL for webhook mode; undefined → long-poll. */
  publicUrl?: string;
  /** Resolves the single org id (single-org assumption, same as auth middleware). */
  resolveOrgId: () => Promise<string>;
  /** Durable open-stream state. Defaults to the Postgres store over `db`. */
  activeStreams?: ActiveStreamStore;
  now?: () => number;
  /**
   * 1Password reference-credential resolver (owner-precedence contract,
   * Task 6). Threaded into `resolveOrgCredentialRead` so an org-owned bot
   * token row carrying `metadata.onepassword` resolves through the org's
   * shared 1Password token instead of surfacing the raw reference string.
   * Optional — omit for deployments/tests with no 1Password service wired;
   * rows then pass through raw, byte-identical to before this task.
   */
  onePassword?: OnePasswordService;
}

const DEDUP_CAP = 2048;
const UNLINKED_REPLY_COOLDOWN_MS = 60 * 60_000;
const DELIVERED_CAP = 2048;
const VERIFY_FAILED_LOG_COOLDOWN_MS = 60_000;

/** Rule 4's label: ✅ for approve/primary, ❌ for deny/danger, else a neutral ☑️. */
function gateResolutionLabel(actions: DecisionAction[], resolution: DecisionResolution): string {
  const action = actions.find((a) => a.id === resolution.actionId);
  const actionLabel = action?.label;
  if (resolution.actionId === "approve" || action?.style === "primary") {
    return `✅ ${actionLabel ?? resolution.actionId ?? "Resolved"}`;
  }
  if (resolution.actionId === "deny" || action?.style === "danger") {
    return `❌ ${actionLabel ?? resolution.actionId ?? "Resolved"}`;
  }
  return `☑️ ${actionLabel ?? resolution.value ?? "Resolved"}`;
}

const LOCALDEV_SUFFIX = ".localdev";

/**
 * Resolves the process's own public base URL (Task 8): `VALET_PUBLIC_URL`
 * verbatim if set, else `BETTER_AUTH_URL` when it parses as a public
 * `https:` URL (not localhost/127.0.0.1/*.localdev — those aren't reachable
 * FROM a provider's webhook delivery), else `undefined` — the long-poll
 * default.
 */
export function publicUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  if (env.VALET_PUBLIC_URL) return env.VALET_PUBLIC_URL;
  const authUrl = env.BETTER_AUTH_URL;
  if (!authUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(authUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname.endsWith(LOCALDEV_SUFFIX)) {
    return undefined;
  }
  return authUrl;
}

/** Result of `ChannelHost.handleWebhook` — mirrors the HTTP status the route maps it to. */
export type HandleWebhookResult = "ok" | "rejected" | "unknown_channel";

/** Feature-detects the telegram-shaped `getMe()` probe without a broad cast. */
function hasGetMe(transport: ChannelTransport): transport is ChannelTransport & { getMe(): Promise<{ username?: string }> } {
  return typeof (transport as { getMe?: unknown }).getMe === "function";
}

/** Derives the host-side thread key from a conversationKey: the substring
 * after the LAST `:` — for telegram `telegram:dm:99` → chatId `99`. */
function chatIdFromKey(conversationKey: string): string {
  const idx = conversationKey.lastIndexOf(":");
  return idx === -1 ? conversationKey : conversationKey.slice(idx + 1);
}

/** Feature-detects a transport that opens a direct conversation with one of
 * its users. A provider whose user id is not also a conversation id (Slack:
 * `U…` is a person, `D…` is the DM) needs the call before it can be addressed. */
export function hasOpenDirect(
  transport: ChannelTransport,
): transport is ChannelTransport & { openDirectConversation(externalId: string): Promise<string> } {
  return typeof (transport as { openDirectConversation?: unknown }).openDirectConversation === "function";
}

export class ChannelHost {
  private transports = new Map<string, ChannelTransport>();
  private botUsernames = new Map<string, string>();
  private seenDispatchIds = new Set<string>();
  private seenOrder: string[] = [];
  private unlinkedReplyAt = new Map<string, number>();
  private gateRefs = new Map<string, { gateId: string; sessionId: string }>();
  /** One gate can have several prompt messages: the channel-thread card plus
   * one attention DM per recipient. Resolution edits every one of them. */
  private gatePrompts = new Map<string, GatePromptRef[]>();
  private gateActions = new Map<string, DecisionAction[]>();
  /** Recent gate resolutions, bounded FIFO (cap `DEDUP_CAP`). A prompt can be
   * recorded AFTER its gate settled — `routeAttention` fires deliverers
   * without awaiting them, so a fast resolution legitimately beats an
   * in-flight DM send. This map lets the late prompt get the resolution edit
   * immediately instead of keeping live buttons forever. */
  private settledGates = new Map<string, DecisionResolution>();
  private settledOrder: string[] = [];
  private orgId: string | null = null;
  private outboundUnsub: Unsubscribe | null = null;
  private delivered = new Set<string>();
  private deliveredOrder: string[] = [];
  /** Per-boot webhook secrets, keyed by channelType — kept only in memory
   * (Task 8's locked decision), never persisted. */
  private webhookSecrets = new Map<string, string>();
  /** One AbortController for every poll-mode transport's `runPollLoop`. */
  private pollControllers = new Map<string, AbortController>();
  /** Tracks each poll loop's promise so `stop()` can await its exit. */
  private pollLoops: Promise<void>[] = [];
  /** Rate-limits `verify_failed` drop-log writes, keyed by channelType —
   * same cooldown pattern as `unlinkedReplyAt`: an attacker hammering an
   * unauthenticated webhook endpoint with bad secrets still gets 403 every
   * time, but only writes one drop-log row per channelType per cooldown. */
  private verifyFailedLoggedAt = new Map<string, number>();
  /** Guards against a second `start()` re-creating transports/poll loops
   * on top of already-running ones; reset in `stop()`. */
  private started = false;
  /** Engine deltas → provider streams. Only transports that implement the
   * whole start/append/stop triple ever reach it. */
  private readonly streamBridge: ChannelStreamBridge;

  constructor(private readonly deps: ChannelHostDeps) {
    this.streamBridge = new ChannelStreamBridge({
      eventStream: deps.eventStream,
      streams: deps.activeStreams ?? new DbActiveStreamStore(deps.db),
      transportFor: (channelType) => this.transportFor(channelType),
      markDelivered: (dedupeKey) => this.markDelivered(dedupeKey),
      abortTurn: async (sessionId, threadId) => {
        // Streams only ever run on a channel thread, and channel threads only
        // exist on an assistant's session (`handleMessage` always threads
        // through `ensureDefaultAssistantSession`, which is what enforces
        // the invariant). An assistant session id names the assistant,
        // not its owner, so the owner is read from the row: only a
        // user-owned assistant has a single actor to abort as.
        const assistantId = parseAssistantSessionId(sessionId);
        if (!assistantId) return;
        const assistant = await loadAssistant(this.deps.db, assistantId);
        if (!assistant || assistant.ownerType !== "user") return;
        const session = await this.deps.engineHost.assistantSessionFor(assistantId, {
          actorUserId: assistant.ownerId,
          orgId: this.orgId ?? (await this.deps.resolveOrgId()),
        });
        await session.abort({ threadId });
      },
      now: deps.now,
    });
  }

  /** The streaming bridge, for tests and for routes that need its state. */
  streams(): ChannelStreamBridge {
    return this.streamBridge;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  transportFor(channelType: string): ChannelTransport | null {
    return this.transports.get(channelType) ?? null;
  }

  botUsername(channelType: string): string | null {
    return this.botUsernames.get(channelType) ?? null;
  }

  isRunning(channelType: string): boolean {
    return this.transports.has(channelType);
  }

  recordGatePrompt(gateId: string, ref: GatePromptRef, sessionId: string): void {
    this.gateRefs.set(`${ref.conversationKey}#${ref.messageId}`, { gateId, sessionId });
    const refs = this.gatePrompts.get(gateId) ?? [];
    refs.push(ref);
    this.gatePrompts.set(gateId, refs);
  }

  gateForRef(ref: GatePromptRef): { gateId: string; sessionId: string } | null {
    return this.gateRefs.get(`${ref.conversationKey}#${ref.messageId}`) ?? null;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.orgId = await this.deps.resolveOrgId();
    const orgId = this.orgId;
    for (const plugin of this.deps.plugins) {
      for (const factory of plugin.transports ?? []) {
        // start() now runs on the api's background boot chain, so stop()
        // (shutdown) can complete while this loop is awaiting a credential
        // read or a getMe probe. stop() flips `started` back to false;
        // without this check the loop would keep spawning poll loops and
        // the outbound queue below AFTER stop() already swept them, leaving
        // ingress running on a closed server with nothing left to stop it.
        if (!this.started) return;
        // Org-row-only read + 1Password reference resolution, so an
        // admin-configured reference-backed bot token resolves the same way
        // a plain pasted token does. A failed resolution must NOT crash
        // boot — log it and skip this transport, same as "no bot token".
        let credential: StoredCredential | null;
        try {
          credential = await resolveOrgCredentialRead(
            { credentials: this.deps.engineCredentials, onePassword: this.deps.onePassword },
            { orgId },
            factory.channelType,
          );
        } catch (err) {
          if (err instanceof OnePasswordAuthError) {
            console.error(`[channels] ${factory.channelType}: bot token resolution failed: ${err.message}`);
            continue;
          }
          throw err;
        }
        if (!credential) {
          console.log(`[channels] ${factory.channelType}: no bot token, transport not started`);
          continue;
        }
        // A factory rejects a credential it cannot serve — the Slack one
        // throws when `metadata.teamId` is absent, because every outbound
        // conversation key embeds it. Contained per transport: one bad
        // credential must not stop the transports after it in this loop, nor
        // the outbound queue and the boot stream sweep below. The message
        // names the fix, so the operator reads it in the startup log.
        let transport: ChannelTransport;
        try {
          transport = factory.create({ credential, config: {} });
        } catch (err) {
          console.error(`[channels] ${factory.channelType}: transport not started`, err);
          continue;
        }
        this.transports.set(factory.channelType, transport);
        if (hasGetMe(transport)) {
          try {
            const me = await transport.getMe();
            if (me.username) this.botUsernames.set(factory.channelType, me.username);
          } catch (err) {
            console.error(`[channels] ${factory.channelType}: getMe probe failed`, err);
          }
        }
        // Re-check after the getMe await for the same stop-mid-start race
        // as the loop-top check: this is the last gate before a poll loop
        // (or webhook registration) is spawned for this transport.
        if (!this.started) return;
        await this.startIngress(factory.channelType, transport);
      }
    }
    if (!this.started) return;
    this.startOutbound();
    this.streamBridge.start();
    // Close streams a previous boot left open. Runs after the transports are
    // up because closing one needs its transport, and after `startOutbound`
    // so a slow sweep cannot delay live traffic.
    const bootedAt = this.now();
    for (const channelType of this.transports.keys()) {
      try {
        const closed = await this.streamBridge.sweepOnBoot(channelType, bootedAt);
        if (closed > 0) console.log(`[channels] ${channelType}: closed ${closed} stream(s) left open by a restart`);
      } catch (err) {
        console.error(`[channels] ${channelType}: boot stream sweep failed`, err);
      }
    }
  }

  /**
   * Mode selection (Task 8): webhook when `deps.publicUrl` is set, else
   * long-poll when the transport implements `poll`. Neither → no inbound
   * ingress for this transport (outbound-only, or a transport under test
   * that implements neither).
   */
  private async startIngress(channelType: string, transport: ChannelTransport): Promise<void> {
    if (this.deps.publicUrl) {
      const secret = randomBytes(24).toString("hex");
      this.webhookSecrets.set(channelType, secret);
      try {
        await transport.registerWebhook?.(`${this.deps.publicUrl}/api/channels/${channelType}/webhook`, secret);
      } catch (err) {
        console.error(`[channels] ${channelType}: registerWebhook failed`, err);
      }
      return;
    }
    if (!transport.poll) return;
    const controller = new AbortController();
    this.pollControllers.set(channelType, controller);
    this.pollLoops.push(this.runPollLoop(channelType, transport, controller.signal));
  }

  /**
   * For-await over `transport.poll(signal)`, feeding each raw update through
   * `parseUpdate` → `handleUpdate`. An outer try/catch + 5s sleep + retry
   * ensures a transport crash never kills the host — it just backs off and
   * resumes. Exits cleanly when `signal` aborts.
   */
  private async runPollLoop(channelType: string, transport: ChannelTransport, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const iterable = transport.poll?.(signal);
        if (!iterable) return;
        for await (const raw of iterable) {
          if (signal.aborted) break;
          const event = transport.parseUpdate(raw);
          if (event) await this.handleUpdate(channelType, event);
        }
        if (signal.aborted) return;
      } catch (err) {
        if (signal.aborted) return;
        console.error(`[channels] ${channelType}: poll loop error, retrying in 5s`, err);
        await this.sleepOrAbort(5_000, signal);
      }
    }
  }

  private sleepOrAbort(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async stop(): Promise<void> {
    for (const controller of this.pollControllers.values()) controller.abort();
    await Promise.all(this.pollLoops);
    this.pollControllers.clear();
    this.pollLoops = [];
    // Before the transports go away: a stream closed here is one the next
    // boot does not have to apologise for.
    await this.streamBridge.stop();
    this.stopOutbound();
    this.started = false;
  }

  /**
   * Webhook ingress entry point (Task 8): verifies the raw request via the
   * transport's own `verifyWebhook` (host-held secrets only — this is the
   * ONLY place `webhookSecrets` is read), then fires-and-forgets each parsed
   * update through `handleUpdate` so the provider gets a fast response
   * (Telegram in particular expects the webhook ack within seconds).
   */
  async handleWebhook(
    channelType: string,
    req: { headers: Record<string, string>; rawBody: Uint8Array },
  ): Promise<HandleWebhookResult> {
    const transport = this.transports.get(channelType);
    if (!transport) return "unknown_channel";

    const secret = this.webhookSecrets.get(channelType);
    const raws = transport.verifyWebhook(req, secret ? { webhookSecret: secret } : {});
    if (raws === null) {
      await this.maybeLogVerifyFailed(channelType);
      return "rejected";
    }

    for (const raw of raws) {
      const event = transport.parseUpdate(raw);
      if (event) void this.handleUpdate(channelType, event);
    }
    return "ok";
  }

  /**
   * Rule 1: subscribe once (no sessionId filter) to the three outbound event
   * types. Live subscription only — no replay from a stored offset — which
   * satisfies "high-water mark initializes to now" on restart.
   */
  startOutbound(): void {
    if (this.outboundUnsub) return;
    this.outboundUnsub = this.deps.eventStream.subscribe(
      { eventTypes: ["message_end", "decision_gate", "decision_gate_resolved", "command_result"] },
      (event) => {
        void this.handleOutboundEvent(event);
      },
    );
  }

  stopOutbound(): void {
    this.outboundUnsub?.();
    this.outboundUnsub = null;
  }

  /** Rule 5: every callback body try/caught — errors logged, never thrown into the stream. */
  private async handleOutboundEvent(event: DeliveredBusEvent): Promise<void> {
    try {
      const e = event.event;
      if (e.type === "message_end") {
        await this.deliverAssistantMessage(event.sessionId, e.threadId, e.messageId, e.reason);
      } else if (e.type === "decision_gate") {
        await this.deliverGatePrompt(event.sessionId, e.gate);
      } else if (e.type === "decision_gate_resolved") {
        await this.deliverGateResolution(e.gateId, e.resolution);
      } else if (e.type === "command_result") {
        await this.deliverCommandResult(event.sessionId, e.threadId, e.entry);
      }
    } catch (err) {
      console.error("[channels] outbound delivery failed", err);
    }
  }

  /**
   * Locked convention: split `key` on the FIRST `:`; the first segment must
   * name a running transport.
   *
   * The `${channelType}:dm:${rest}` default is Telegram's key shape, where the
   * chat id is the whole address. A transport whose conversationKey carries
   * more than that — Slack's holds the workspace id, which lives on the
   * credential and never reaches the thread key — rebuilds the key itself
   * through `conversationKeyFromThreadKey`. Without this hop every outbound
   * call for such a transport is handed a key it did not mint.
   */
  channelThreadFor(key: string): { channelType: string; conversationKey: string } | null {
    const idx = key.indexOf(":");
    if (idx === -1) return null;
    const channelType = key.slice(0, idx);
    const rest = key.slice(idx + 1);
    if (rest === "" || !this.isRunning(channelType)) return null;
    const transport = this.transports.get(channelType);
    const rebuilt = transport?.conversationKeyFromThreadKey?.(key);
    if (rebuilt !== undefined) {
      // `null` means the transport disowns the key. Delivering it under the
      // default shape would post somewhere it did not choose, so stop instead.
      if (rebuilt === null) return null;
      return { channelType, conversationKey: rebuilt };
    }
    return { channelType, conversationKey: `${channelType}:dm:${rest}` };
  }

  private markDelivered(dedupeKey: string): void {
    this.delivered.add(dedupeKey);
    this.deliveredOrder.push(dedupeKey);
    if (this.deliveredOrder.length > DELIVERED_CAP) {
      const evict = this.deliveredOrder.shift();
      if (evict !== undefined) this.delivered.delete(evict);
    }
  }

  /** Rule 2: message_end (end_turn only) → resolve the entry, dedup, send text + media attachments. */
  private async deliverAssistantMessage(
    sessionId: string,
    threadId: string,
    messageId: string,
    reason: "end_turn" | "error" | "abort",
  ): Promise<void> {
    if (reason !== "end_turn") return;
    // A streamed message is already on screen. Posting it again as a discrete
    // message would show the reader the same answer twice, once under the
    // stream. Checked before any await: the marker is written on
    // `message_start`, which always precedes this event.
    if (this.streamBridge.isStreamed(sessionId, messageId)) return;
    const thread = await this.deps.engineStore.getThread(sessionId, threadId);
    if (!thread) return;
    const mapped = this.channelThreadFor(thread.key);
    if (!mapped) return;

    const dedupeKey = `${sessionId}:${messageId}`;
    if (this.delivered.has(dedupeKey)) return;

    const entries = await this.deps.engineStore.getEntries(sessionId, threadId);
    const entry = entries.find((e) => e.id === messageId && e.type === "message" && e.role === "assistant");
    if (!entry || entry.type !== "message") return;
    // message_end fires with reason "end_turn" for every non-abort assistant
    // message, including mid-turn narration before a tool call. Only the
    // turn's genuine final message persists stopReason "end_turn" — mid-turn
    // messages persist with stopReason undefined. Without this check a turn
    // like "Let me check." + tool call + final answer double-delivers.
    if (entry.stopReason !== "end_turn") return;

    this.markDelivered(dedupeKey);

    const transport = this.transports.get(mapped.channelType);
    if (!transport) return;

    if (entry.content) {
      await transport.send(mapped.conversationKey, { markdown: entry.content });
    }
    for (const part of entry.parts ?? []) {
      if (part.type !== "attachment") continue;
      const attachment = part.attachment;
      if (attachment.type === "image") {
        await transport.sendMedia(mapped.conversationKey, {
          type: "image",
          data: attachment.data,
          mimeType: attachment.mimeType,
          name: attachment.name,
        });
      } else if (attachment.type === "file") {
        await transport.sendMedia(mapped.conversationKey, {
          type: "file",
          data: attachment.data,
          mimeType: attachment.mimeType,
          name: attachment.name,
        });
      }
      // "text" ToolAttachment variant is skipped (rule 2).
    }
  }

  /**
   * Rule 6: command_result → send the result markdown to the channel the
   * command came from. A slash command sent from Telegram or Slack must
   * answer there — the web UI reads the same entry over REST/WS. Dedup on
   * the entry id, same LRU as assistant messages.
   */
  private async deliverCommandResult(
    sessionId: string,
    threadId: string | undefined,
    entry: CommandResultEntry,
  ): Promise<void> {
    if (!threadId) return;
    const thread = await this.deps.engineStore.getThread(sessionId, threadId);
    if (!thread) return;
    const mapped = this.channelThreadFor(thread.key);
    if (!mapped) return;

    const dedupeKey = `${sessionId}:${entry.id}`;
    if (this.delivered.has(dedupeKey)) return;
    this.markDelivered(dedupeKey);

    const transport = this.transports.get(mapped.channelType);
    if (!transport) return;

    const markdown = `\`${entry.command}\`\n${entry.output}`;
    await transport.send(mapped.conversationKey, { markdown });
  }

  /** Rule 3: decision_gate → sendGatePrompt, record refs for the inbound gate_callback path. */
  private async deliverGatePrompt(sessionId: string, gate: DecisionGate): Promise<void> {
    const thread = await this.deps.engineStore.getThread(sessionId, gate.threadId);
    if (!thread) return;
    const mapped = this.channelThreadFor(thread.key);
    if (!mapped) return;
    const transport = this.transports.get(mapped.channelType);
    if (!transport) return;

    // Close any open stream FIRST, so the approval card lands after the text
    // that led to it. Sequenced here rather than from the bridge's own
    // subscriber, because two independent subscribers to `decision_gate` have
    // no defined order and the reader would sometimes see the card first.
    await this.streamBridge.closeForGate(sessionId, gate.threadId);

    await this.sendAndRecordGatePrompt(
      transport,
      mapped.conversationKey,
      { gateId: gate.id, title: gate.title, body: gate.body, actions: gate.actions },
      sessionId,
    );
  }

  /**
   * Sends a gate prompt, records its ref for the inbound `gate_callback`
   * path, and — when the gate settled while the send was in flight — replays
   * the resolution edit so the new message never keeps live buttons for a
   * settled gate. The one writer both send sites (the channel-thread card and
   * the attention DM) go through, so ref bookkeeping cannot drift between
   * them.
   */
  private async sendAndRecordGatePrompt(
    transport: ChannelTransport,
    conversationKey: string,
    prompt: { gateId: string; title: string; body?: string; actions: DecisionAction[] },
    sessionId: string,
  ): Promise<void> {
    const ref = await transport.sendGatePrompt(conversationKey, prompt);
    this.gateActions.set(prompt.gateId, prompt.actions);
    this.recordGatePrompt(prompt.gateId, ref, sessionId);
    const settled = this.settledGates.get(prompt.gateId);
    if (settled) {
      await this.deliverGateResolution(prompt.gateId, settled);
    }
  }

  /** Rule 4: decision_gate_resolved → edit every prompt message with the outcome label, then clear all gate maps. */
  private async deliverGateResolution(gateId: string, resolution: DecisionResolution): Promise<void> {
    // Remember the resolution BEFORE the refs check: a prompt still in
    // flight has no ref yet, and `sendAndRecordGatePrompt` reads this map to
    // backfill the edit when that send lands.
    this.settledGates.set(gateId, resolution);
    this.settledOrder.push(gateId);
    if (this.settledOrder.length > DEDUP_CAP) {
      const evict = this.settledOrder.shift();
      if (evict !== undefined) this.settledGates.delete(evict);
    }

    const refs = this.gatePrompts.get(gateId);
    if (!refs || refs.length === 0) return;
    const actions = this.gateActions.get(gateId) ?? [];
    const label = gateResolutionLabel(actions, resolution);

    for (const ref of refs) {
      const channelType = ref.conversationKey.slice(0, ref.conversationKey.indexOf(":"));
      const transport = this.transports.get(channelType);
      if (transport) {
        try {
          await transport.updateGatePrompt(ref, { actionId: resolution.actionId, label });
        } catch (err) {
          // One stale message (deleted DM, revoked scope) must not keep the
          // other copies of the same prompt un-updated.
          console.error(`[channels] ${channelType}: gate prompt update failed`, err);
        }
      }
      this.gateRefs.delete(`${ref.conversationKey}#${ref.messageId}`);
    }

    this.gatePrompts.delete(gateId);
    this.gateActions.delete(gateId);
  }

  /** Rule 1: in-memory LRU dedup, cap `DEDUP_CAP`, FIFO eviction. */
  private isDuplicate(dispatchId: string): boolean {
    if (this.seenDispatchIds.has(dispatchId)) return true;
    this.seenDispatchIds.add(dispatchId);
    this.seenOrder.push(dispatchId);
    if (this.seenOrder.length > DEDUP_CAP) {
      const evict = this.seenOrder.shift();
      if (evict !== undefined) this.seenDispatchIds.delete(evict);
    }
    return false;
  }

  private async dropLog(orgId: string, reason: string, conversationKey: string | undefined, detail: string): Promise<void> {
    await writeDropLog(this.deps.db, { orgId, reason, conversationKey, detail });
  }

  async handleUpdate(channelType: string, event: InboundChannelEvent): Promise<void> {
    try {
      await this.routeUpdate(channelType, event);
    } catch (err) {
      console.error("[channels] update failed", err);
    }
  }

  private async routeUpdate(channelType: string, event: InboundChannelEvent): Promise<void> {
    const orgId = this.orgId ?? (await this.deps.resolveOrgId());
    const transport = this.transports.get(channelType);

    // Rule 1: dedup.
    if (this.isDuplicate(event.dispatchId)) {
      await this.dropLog(orgId, "duplicate", event.conversationKey, `duplicate dispatchId ${event.dispatchId}`);
      return;
    }

    // Rule 2: /start <code> — link flow. Handled before sender resolution:
    // an unlinked sender's first message IS the link command.
    if (event.kind === "command" && event.command?.name === "start") {
      await this.handleStart(channelType, transport, event);
      return;
    }

    // Rule 3: resolve sender identity for every other event kind.
    const identity = await identityForExternal(this.deps.db, channelType, event.sender.externalId);
    if (!identity) {
      await this.dropLog(orgId, "unlinked_sender", event.conversationKey, `externalId=${event.sender.externalId}`);
      await this.maybeReplyUnlinked(transport, event.conversationKey);
      return;
    }
    const userId = identity.userId;

    if (event.kind === "message") {
      await this.handleMessage(channelType, transport, event, userId);
      return;
    }

    if (event.kind === "gate_callback") {
      await this.handleGateCallback(transport, event, orgId, userId, channelType);
      return;
    }

    if (event.kind === "surface_opened") {
      // Someone opened the conversation and said nothing. There is no turn to
      // start, so this ends here — but it is not a dropped update, and a
      // drop-log row per DM open would bury the reasons that matter. The
      // useful work for a linked user is a set of suggested prompts, which
      // needs prompt copy this host does not own yet; the unlinked case
      // already answered above with the link instructions.
      return;
    }

    // Rule 6: anything else.
    await this.dropLog(orgId, "unsupported_kind", event.conversationKey, `kind=${event.kind}`);
  }

  private async handleStart(
    channelType: string,
    transport: ChannelTransport | undefined,
    event: InboundChannelEvent,
  ): Promise<void> {
    // Rule 2's contract is reply-only (hit links + confirms, miss replies
    // invalid) — no drop-log entry either way; unlike every other routing
    // decision, an unlinked /start attempt is the expected, common case.
    const code = event.command?.args;
    const consumed = code ? await consumeLinkCode(this.deps.db, channelType, code) : null;
    if (!consumed) {
      await transport?.send(event.conversationKey, {
        markdown: "That link code is invalid or expired — get a fresh one from Settings → Connected accounts.",
      });
      return;
    }
    await linkIdentity(this.deps.db, {
      provider: channelType,
      externalId: event.sender.externalId,
      userId: consumed.userId,
    });
    await transport?.send(event.conversationKey, {
      markdown: "✅ Linked! You're chatting with your Valet assistant.",
    });
  }

  /** Writes a `verify_failed` drop-log row at most once per channelType per
   * `VERIFY_FAILED_LOG_COOLDOWN_MS` — the caller still returns "rejected"
   * (403) on every call; only the DB insert is throttled, so a burst of bad
   * webhook posts can't flood `event_drop_log`. */
  private async maybeLogVerifyFailed(channelType: string): Promise<void> {
    const now = this.now();
    const last = this.verifyFailedLoggedAt.get(channelType);
    if (last !== undefined && now - last < VERIFY_FAILED_LOG_COOLDOWN_MS) return;
    this.verifyFailedLoggedAt.set(channelType, now);
    const orgId = this.orgId ?? (await this.deps.resolveOrgId());
    await this.dropLog(orgId, "verify_failed", undefined, `${channelType} webhook verification failed`);
  }

  private async maybeReplyUnlinked(transport: ChannelTransport | undefined, conversationKey: string): Promise<void> {
    const now = this.now();
    const last = this.unlinkedReplyAt.get(conversationKey);
    if (last !== undefined && now - last < UNLINKED_REPLY_COOLDOWN_MS) return;
    this.unlinkedReplyAt.set(conversationKey, now);
    await transport?.send(conversationKey, {
      markdown: "Link your Valet account to chat here: open Settings → Connected accounts in the web app.",
    });
  }

  private async handleMessage(
    channelType: string,
    transport: ChannelTransport | undefined,
    event: InboundChannelEvent,
    userId: string,
  ): Promise<void> {
    const orgId = this.orgId ?? (await this.deps.resolveOrgId());
    // An inbound channel message names a USER, never one of that user's
    // assistants, so it goes to the user's default — the same target every
    // other machine-driven path resolves to.
    const { session } = await ensureDefaultAssistantSession({ db: this.deps.db, engineHost: this.deps.engineHost }, { type: "user", id: userId }, {
      actorUserId: userId,
      orgId,
    });

    // Ask the transport for the thread key when it owns the mapping, so this
    // half and `channelThreadFor`'s inverse cannot drift apart. The default
    // below is the same derivation Telegram has always used.
    const threadKey =
      transport?.threadKeyFromConversationKey?.(event.conversationKey) ??
      `${channelType}:${chatIdFromKey(event.conversationKey)}`;
    const thread = session.thread(threadKey);

    // Register the turn before the prompt is submitted, so the first
    // `message_start` already knows where to stream. Nothing opens yet: a
    // turn that parks on an approval gate before writing any text must not
    // leave an empty stream on screen. Transports without a reply anchor
    // (Telegram) supply no threadTs and never stream.
    if (event.threadTs !== undefined) {
      this.streamBridge.noteInboundTurn({
        channelType,
        conversationKey: event.conversationKey,
        sessionId: session.id,
        threadId: thread.id,
        threadTs: event.threadTs,
        orgId,
      });
    }

    let text = event.text ?? "";
    const attachments: PromptAttachment[] = [];
    for (const media of event.media ?? []) {
      const fetched = transport?.fetchMedia ? await transport.fetchMedia(media) : null;
      if (!fetched) {
        text += "\n\n[attachment skipped: too large or unavailable]";
        continue;
      }
      if (media.kind === "photo") {
        attachments.push({ type: "image", data: fetched.data, mimeType: fetched.mimeType, name: fetched.name });
      } else if (media.kind === "voice" || media.kind === "audio") {
        attachments.push({ type: "audio", data: fetched.data, mimeType: fetched.mimeType, name: fetched.name });
      } else {
        attachments.push({ type: "file", data: fetched.data, mimeType: fetched.mimeType, name: fetched.name ?? "file" });
      }
    }

    await thread.submitPrompt(
      { text: text === "" ? "(media message)" : text, attachments },
      {
        dispatchId: event.dispatchId,
        author: { id: userId, name: event.sender.displayName, externalId: event.sender.externalId },
      },
    );

    try {
      await transport?.sendTyping?.(event.conversationKey);
    } catch {
      // best-effort
    }
  }

  private async handleGateCallback(
    transport: ChannelTransport | undefined,
    event: InboundChannelEvent,
    orgId: string,
    userId: string,
    channelType: string,
  ): Promise<void> {
    const gateCallback = event.gateCallback;
    if (!gateCallback) {
      await this.dropLog(orgId, "unsupported_kind", event.conversationKey, "gate_callback missing payload");
      return;
    }
    let mapped = this.gateForRef(gateCallback.ref);
    if (!mapped && gateCallback.gateId) {
      // Fallback: the ref key is rebuilt by the transport from the clicked
      // message and can drift from the recorded one (thread-ts codecs, LRU
      // eviction of the send-side key). The gate id embedded in the button
      // payload recovers the mapping while the gate is still tracked.
      const firstRef = this.gatePrompts.get(gateCallback.gateId)?.[0];
      if (firstRef) mapped = this.gateForRef(firstRef);
    }
    if (!mapped) {
      await transport?.answerCallback?.(gateCallback.callbackId, "This approval has expired — resolve it on the web.");
      await this.dropLog(orgId, "unsupported_kind", event.conversationKey, "unknown_gate_ref");
      return;
    }

    // Explicit resolve authorization — the same named check the web
    // decision routes make (`canResolveSessionGate`): the session's direct
    // owner, or a live member of the owning team. The reply deliberately
    // matches the unknown-ref case so a probe cannot distinguish "not
    // yours" from "gone".
    const rows = await this.deps.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, mapped.sessionId))
      .limit(1);
    const sessionRow = rows[0];
    if (!sessionRow || !(await canResolveSessionGate(this.deps.db, sessionRow, userId))) {
      await transport?.answerCallback?.(gateCallback.callbackId, "This approval has expired — resolve it on the web.");
      await this.dropLog(orgId, "unauthorized", event.conversationKey, "sender may not resolve this session's gates");
      return;
    }

    // Same backstop as the web resolve route, via the same shared guard:
    // `always_allow` widens policy for the SESSION's org, so a non-admin's
    // click must fail here with a clear answer, not late inside the engine.
    if (gateCallback.actionId === GATE_ACTION_ALWAYS_ALLOW && !(await canApplyAlwaysAllow(this.deps.db, sessionRow.orgId, userId))) {
      await transport?.answerCallback?.(gateCallback.callbackId, "Only an org admin can choose Always allow — resolve it on the web.");
      await this.dropLog(orgId, "unauthorized", event.conversationKey, "always_allow requires org admin");
      return;
    }

    // Resolve on the session the gate actually lives on. A gate prompt is
    // recorded from two senders — the channel-thread card (always the
    // sender's default assistant session) and an attention DM (any session
    // the recipient may resolve) — so the assistant-only shortcut this path
    // used before no longer covers it. Assistant sessions must still wake
    // through `assistantSessionFor`: rows migrated from
    // orchestrator_identities keep legacy `orchestrator:*` session ids that
    // `sessionFor`'s prefix parse cannot recognize, and a generic build
    // cached under that id would serve later assistant wakes without persona
    // or memory. The assistants table is the authority on which ids those
    // are (`assistants_session` unique index).
    const assistantRows = await this.deps.db
      .select({ id: assistants.id })
      .from(assistants)
      .where(eq(assistants.sessionId, mapped.sessionId))
      .limit(1);
    const session = assistantRows[0]
      ? await this.deps.engineHost.assistantSessionFor(assistantRows[0].id, { actorUserId: userId, orgId })
      : await this.deps.engineHost.sessionFor(mapped.sessionId, await loadSessionMeta(this.deps.db, sessionRow));
    try {
      await session.resolveDecision(mapped.gateId, {
        actionId: gateCallback.actionId,
        resolvedBy: userId,
        resolvedAt: this.now(),
        source: { channelType, channelId: event.conversationKey, messageId: gateCallback.ref.messageId },
      });
    } catch (err) {
      // Routine collision, not an anomaly: one gate holds several prompt
      // messages (channel card + one DM per recipient), so a second
      // recipient can click after the first resolution settles the gate.
      // Every other rejection branch answers the callback — this one must
      // too, or the clicker's UI spins forever.
      console.error("[channels] gate resolve failed (already settled?)", err);
      await transport?.answerCallback?.(
        gateCallback.callbackId,
        "This approval was already resolved. Open the session in Valet to see the outcome.",
      );
      return;
    }
    await transport?.answerCallback?.(gateCallback.callbackId);
  }

  /**
   * Attention-router deliverer (Task 10): for every running transport,
   * resolves the recipient's linked identity and DMs them a summary of the
   * event. Best-effort per channelType — a lookup/send failure on one
   * transport is logged and does not prevent delivery on the others.
   */
  attentionDeliverer(): AttentionChannelDeliverer {
    return {
      deliver: async (userId: string, event: AttentionEvent): Promise<void> => {
        for (const channelType of this.transports.keys()) {
          try {
            const link = await identityForUser(this.deps.db, channelType, userId);
            if (!link || link.notifyAttention === false) continue;
            const transport = this.transports.get(channelType);
            if (!transport) continue;
            // `${channelType}:dm:${externalId}` assumes the sender's id is also
            // the address to answer on, which holds for Telegram and not for
            // Slack: `U…` names a person, `D…` names the DM with them. Ask the
            // transport to open the conversation when it knows the difference.
            const conversationKey = hasOpenDirect(transport)
              ? await transport.openDirectConversation(link.externalId)
              : `${channelType}:dm:${link.externalId}`;
            // An approval event carries its gate, so the DM can be a real
            // prompt: the same buttons the channel-thread card gets, answered
            // through the same inbound `gate_callback` path. Buttons go only
            // to a recipient whose click would be authorized — an audience
            // can be broader than the resolver set (org admins for an
            // org-owned session), and a button that always answers "expired"
            // is worse than the plain summary.
            if (event.gate && event.sessionId) {
              const rows = await this.deps.db
                .select()
                .from(agentSessions)
                .where(eq(agentSessions.id, event.sessionId))
                .limit(1);
              const sessionRow = rows[0];
              if (sessionRow && (await canResolveSessionGate(this.deps.db, sessionRow, userId))) {
                await this.sendAndRecordGatePrompt(
                  transport,
                  conversationKey,
                  {
                    gateId: event.gate.id,
                    title: event.title,
                    body: this.attentionBody(event),
                    actions: event.gate.actions,
                  },
                  event.sessionId,
                );
                continue;
              }
              // Recipient cannot resolve this gate (or its app row is gone):
              // fall through to the plain summary with the web link.
            }
            await transport.send(conversationKey, {
              markdown: this.attentionMarkdown(event),
            });
          } catch (err) {
            console.error(`[channels] ${channelType}: attention delivery failed`, err);
          }
        }
      },
    };
  }

  /** Body-only markdown (no title) for gate prompts, which render the title themselves. */
  private attentionBody(event: AttentionEvent): string | undefined {
    let markdown = event.body ?? "";
    if (event.href && this.deps.publicUrl) {
      markdown += `${markdown ? "\n\n" : ""}[Open in Valet](${this.deps.publicUrl}${event.href})`;
    }
    return markdown === "" ? undefined : markdown;
  }

  private attentionMarkdown(event: AttentionEvent): string {
    const rest = this.attentionBody(event);
    return rest === undefined ? `**${event.title}**` : `**${event.title}**\n\n${rest}`;
  }
}
