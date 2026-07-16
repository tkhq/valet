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
import { and, eq } from "drizzle-orm";
import {
  orchestratorSessionId,
  type ChannelTransport,
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
  type Unsubscribe,
  type ValetPlugin,
} from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { EngineHost } from "../engine/host.js";
import { agentSessions } from "../schema/index.js";
import { ensureOrchestratorSession } from "../orchestrator/ensure.js";
import { writeDropLog } from "../orchestrator/signals.js";
import type { AttentionChannelDeliverer, AttentionEvent } from "../orchestrator/attention.js";
import { consumeLinkCode, identityForExternal, identityForUser, linkIdentity } from "./identity-links.js";

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
  now?: () => number;
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

export class ChannelHost {
  private transports = new Map<string, ChannelTransport>();
  private botUsernames = new Map<string, string>();
  private seenDispatchIds = new Set<string>();
  private seenOrder: string[] = [];
  private unlinkedReplyAt = new Map<string, number>();
  private gateRefs = new Map<string, { gateId: string; sessionId: string }>();
  private gatePrompts = new Map<string, GatePromptRef>();
  private gateActions = new Map<string, DecisionAction[]>();
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

  constructor(private readonly deps: ChannelHostDeps) {}

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
    this.gatePrompts.set(gateId, ref);
  }

  gateForRef(ref: GatePromptRef): { gateId: string; sessionId: string } | null {
    return this.gateRefs.get(`${ref.conversationKey}#${ref.messageId}`) ?? null;
  }

  async start(): Promise<void> {
    this.orgId = await this.deps.resolveOrgId();
    const orgId = this.orgId;
    for (const plugin of this.deps.plugins) {
      for (const factory of plugin.transports ?? []) {
        const credential = await this.deps.engineCredentials.get({ type: "org", id: orgId }, factory.channelType);
        if (!credential) {
          console.log(`[channels] ${factory.channelType}: no bot token, transport not started`);
          continue;
        }
        const transport = factory.create({ credential, config: {} });
        this.transports.set(factory.channelType, transport);
        if (hasGetMe(transport)) {
          try {
            const me = await transport.getMe();
            if (me.username) this.botUsernames.set(factory.channelType, me.username);
          } catch (err) {
            console.error(`[channels] ${factory.channelType}: getMe probe failed`, err);
          }
        }
        await this.startIngress(factory.channelType, transport);
      }
    }
    this.startOutbound();
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
    this.stopOutbound();
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
      { eventTypes: ["message_end", "decision_gate", "decision_gate_resolved"] },
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
      }
    } catch (err) {
      console.error("[channels] outbound delivery failed", err);
    }
  }

  /** Locked convention: split `key` on the FIRST `:`; the first segment must name a running transport. */
  channelThreadFor(key: string): { channelType: string; conversationKey: string } | null {
    const idx = key.indexOf(":");
    if (idx === -1) return null;
    const channelType = key.slice(0, idx);
    const rest = key.slice(idx + 1);
    if (rest === "" || !this.isRunning(channelType)) return null;
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

  /** Rule 3: decision_gate → sendGatePrompt, record refs for the inbound gate_callback path. */
  private async deliverGatePrompt(sessionId: string, gate: DecisionGate): Promise<void> {
    const thread = await this.deps.engineStore.getThread(sessionId, gate.threadId);
    if (!thread) return;
    const mapped = this.channelThreadFor(thread.key);
    if (!mapped) return;
    const transport = this.transports.get(mapped.channelType);
    if (!transport) return;

    const ref = await transport.sendGatePrompt(mapped.conversationKey, {
      gateId: gate.id,
      title: gate.title,
      body: gate.body,
      actions: gate.actions,
    });
    this.gateActions.set(gate.id, gate.actions);
    this.recordGatePrompt(gate.id, ref, sessionId);
  }

  /** Rule 4: decision_gate_resolved → edit the prompt message with the outcome label, then clear all gate maps. */
  private async deliverGateResolution(gateId: string, resolution: DecisionResolution): Promise<void> {
    const ref = this.gatePrompts.get(gateId);
    if (!ref) return;
    const actions = this.gateActions.get(gateId) ?? [];
    const label = gateResolutionLabel(actions, resolution);

    const channelType = ref.conversationKey.slice(0, ref.conversationKey.indexOf(":"));
    const transport = this.transports.get(channelType);
    if (transport) {
      await transport.updateGatePrompt(ref, { actionId: resolution.actionId, label });
    }

    this.gatePrompts.delete(gateId);
    this.gateActions.delete(gateId);
    this.gateRefs.delete(`${ref.conversationKey}#${ref.messageId}`);
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
    const { session } = await ensureOrchestratorSession({ db: this.deps.db, engineHost: this.deps.engineHost }, { type: "user", id: userId }, {
      actorUserId: userId,
      orgId,
    });

    const chatId = chatIdFromKey(event.conversationKey);
    const thread = session.thread(`${channelType}:${chatId}`);

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
    const mapped = this.gateForRef(gateCallback.ref);
    if (!mapped) {
      await transport?.answerCallback?.(gateCallback.callbackId, "This approval has expired — resolve it on the web.");
      await this.dropLog(orgId, "unsupported_kind", event.conversationKey, "unknown_gate_ref");
      return;
    }

    // User-ownership check: the agent_sessions row for the mapped session
    // must belong to the linked user.
    const rows = await this.deps.db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.id, mapped.sessionId), eq(agentSessions.userId, userId)))
      .limit(1);
    if (!rows[0]) {
      await transport?.answerCallback?.(gateCallback.callbackId, "This approval has expired — resolve it on the web.");
      await this.dropLog(orgId, "unsupported_kind", event.conversationKey, "unknown_gate_ref");
      return;
    }

    const session = await this.deps.engineHost.orchestratorSessionFor({ type: "user", id: userId }, {
      actorUserId: userId,
      orgId,
    });
    await session.resolveDecision(mapped.gateId, {
      actionId: gateCallback.actionId,
      resolvedBy: userId,
      resolvedAt: this.now(),
      source: { channelType, channelId: event.conversationKey, messageId: gateCallback.ref.messageId },
    });
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
            await transport.send(`${channelType}:dm:${link.externalId}`, {
              markdown: this.attentionMarkdown(event),
            });
          } catch (err) {
            console.error(`[channels] ${channelType}: attention delivery failed`, err);
          }
        }
      },
    };
  }

  private attentionMarkdown(event: AttentionEvent): string {
    let markdown = `**${event.title}**`;
    if (event.body) markdown += `\n\n${event.body}`;
    if (event.href && this.deps.publicUrl) {
      markdown += `\n\n[Open in Valet](${this.deps.publicUrl}${event.href})`;
    }
    return markdown;
  }
}
