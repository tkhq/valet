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
import { and, eq } from "drizzle-orm";
import {
  orchestratorSessionId,
  type ChannelTransport,
  type CredentialStore,
  type EventStream,
  type GatePromptRef,
  type InboundChannelEvent,
  type PromptAttachment,
  type SessionStore,
  type ValetPlugin,
} from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { EngineHost } from "../engine/host.js";
import { agentSessions } from "../schema/index.js";
import { ensureOrchestratorSession } from "../orchestrator/ensure.js";
import { writeDropLog } from "../orchestrator/signals.js";
import { consumeLinkCode, identityForExternal, linkIdentity } from "./identity-links.js";

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
  private orgId: string | null = null;

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
      }
    }
  }

  async stop(): Promise<void> {
    // Task 8 adds poll abort + subscription teardown.
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
}
