import { mergePresence, readPresence } from "@valet/shared";
import { assistantSessionSender } from "../services/workspace-sender.js";
/**
 * `ChannelHost` — inbound routing for channel transports (telegram etc,
 * Phase 7 / spec decisions 4-6, 10). `handleUpdate` is the single entry
 * point both the poll loop (Task 8) and the webhook route feed normalized
 * `InboundChannelEvent`s through. By default it contains errors: callers can
 * fire-and-forget it from a poll loop or an HTTP handler without a
 * try/catch of their own. Durable ingress opts into propagated errors.
 *
 * Outbound (gate prompts, message edits on `decision_gate_resolved`) is
 * Task 7's job — this file only records enough state (`recordGatePrompt`)
 * for that later code to read back. `start`/`stop`'s poll-loop lifecycle
 * lands in Task 8; `start` here only resolves credentials and constructs
 * transports.
 */
import { runEventVisible, runOriginVisible } from "../services/thread-access.js";
import {
  ConflictError,
  parseAssistantSessionId,
  SANDBOX_READY_TIMEOUT_MS,
  type ActionPlugin,
  type ChannelOrigin,
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
  type SendRef,
  type Session,
  type SessionEntry,
  type SessionStore,
  type SignalContent,
  type StoredCredential,
  type Unsubscribe,
  type ValetPlugin,
} from "@valet/engine";
import type { WorkflowStore } from "@valet/workflow";
import { and, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import {
  ArchivedAssistantError,
  ensureDefaultAssistantSession,
  loadAssistant,
  loadAssistantBySessionId,
} from "../assistants/service.js";
import type { EngineHost } from "../engine/host.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import type { AppDb } from "../lib/drizzle.js";
import { userPrincipal } from "../lib/request-principal.js";
import { attentionHref } from "../orchestrator/attention-wiring.js";
import type { AttentionChannelDeliverer, AttentionEvent } from "../orchestrator/attention.js";
import { activeChildWatch } from "../orchestrator/children.js";
import { writeDropLog } from "../orchestrator/signals.js";
import { canApplyAlwaysAllow, GATE_ACTION_ALWAYS_ALLOW } from "../policies/service.js";
import { teams, agentSessions, users, workflowDefinitions } from "../schema/index.js";
import { ingestChannelFile, type IngestedChannelFile } from "../services/channel-file-ingest.js";
import { resolveOrgCredentialRead } from "../services/credential-resolution.js";
import { OnePasswordAuthError, type OnePasswordService } from "../services/onepassword.js";
import { isOrgAdmin } from "../services/org.js";
import { answersGate, canResolveSessionGate, gateApprover, type SessionOwnerLike } from "../services/session-access.js";
import { recordThreadUserActivity } from "../services/thread-activity.js";
import { ensureWorkflowSession, parseWorkflowSessionId } from "../workflows/engine-deps.js";
import { DbActiveStreamStore, type ActiveStreamStore } from "./active-streams.js";
import { digestGate } from "./gate-digest.js";
import { savedGatePrompts, deleteSavedGatePrompts } from "./gate-prompts.js";
import { consumeLinkCode, identityForExternal, identityForUser, linkIdentity } from "./identity-links.js";
import { ChildReplyDispatcher } from "./child-replies.js";
import { ChannelStreamBridge } from "./stream-bridge.js";
import { recordChannelMessage, slackChannelKey, slackConversationFromThreadKey, slackMessageUrl } from "../services/channel-messages.js";

export interface ChannelHostDeps {
  db: AppDb;
  engineHost: EngineHost;
  engineStore: SessionStore;
  eventStream: EventStream;
  engineCredentials: CredentialStore;
  plugins: ValetPlugin[];
  /** Workflow store for workflow-owned gate callbacks. */
  workflowStore?: WorkflowStore;
  /** Action catalog used when restoring a workflow session for a callback. */
  actionPluginByService?: Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>;
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
const FEEDBACK_RETRY_DELAYS_MS = [0, 50, 100] as const;

/** Rule 4's label: ✅ for approve/primary, ❌ for deny/danger, else a neutral ☑️.
 * `resolvedByName` (the resolver's display name, when known) turns the line
 * into an audit fact: "✅ Approved by Conner". */
function gateResolutionLabel(
  actions: DecisionAction[],
  resolution: DecisionResolution,
  resolvedByName?: string,
): string {
  const action = actions.find((a) => a.id === resolution.actionId);
  const actionLabel = action?.label;
  const by = resolvedByName !== undefined ? ` by ${resolvedByName}` : "";
  if (resolution.actionId === "approve" || action?.style === "primary") {
    return `✅ ${actionLabel ?? resolution.actionId ?? "Resolved"}${by}`;
  }
  if (resolution.actionId === "deny" || action?.style === "danger") {
    return `❌ ${actionLabel ?? resolution.actionId ?? "Resolved"}${by}`;
  }
  return `☑️ ${actionLabel ?? resolution.value ?? "Resolved"}${by}`;
}

/** Outcome lines for the two endings that carry no decision. Each one names
 * the next action: the card is the reader's only sign that the work stopped,
 * and neither ending leaves a button to press. */
const GATE_EXPIRED_LABEL = "⏳ Expired: no one answered in time. Start the run again in Valet.";
const GATE_WITHDRAWN_LABEL =
  "🚫 Withdrawn: the run was stopped. Start it again in Valet if you still need it.";

const OPEN_QUESTION_NOTE = "Answer this question in Valet. A reply here does not reach it.";

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

/** The channel origin attached to this submission's user signal. */
function turnOrigin(entries: SessionEntry[], queueItemId: string) {
  for (const entry of entries) {
    if (entry.type === "message" && entry.role === "user" && entry.queueItemId === queueItemId) {
      return entry.signal?.origin;
    }
  }
  return undefined;
}

/** An automatic `child.settled` reply belongs to the durable child-reply intent. */
function ownedByChildReplyIntent(entries: SessionEntry[], queueItemId: string): boolean {
  const prompt = entries.find(
    (entry) => entry.type === "message" && entry.role === "user" && entry.queueItemId === queueItemId,
  );
  if (prompt?.type !== "message" || prompt.signal?.signalType !== "child.settled") return false;
  return prompt.signal.origin !== undefined && prompt.signal.origin.reply !== "manual";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Runtime shape check for a gate-prompt reference. The field is typed, but it
 * arrives from a transport's parser, so both readers of an inbound callback
 * check it before they key a map with it.
 */
function isGatePromptRef(value: unknown): value is GatePromptRef {
  return isRecord(value) && typeof value.conversationKey === "string" && typeof value.messageId === "string";
}

type OriginReplyState = "none" | "pending" | "succeeded" | "failed";

function successfulToolCall(
  part: Extract<
    NonNullable<Extract<SessionEntry, { type: "message" }>["parts"]>[number],
    { type: "tool_call" }
  >,
): boolean {
  return (
    part.status === "completed" &&
    isRecord(part.result) &&
    isRecord(part.result.details) &&
    part.result.details.ok === true
  );
}

const isTextOriginReplyAction = (toolId: string): boolean => toolId.endsWith(".reply_to_origin");

function isOriginReplyAction(toolId: string, channelType?: string): boolean {
  const prefix = channelType === undefined ? toolId.slice(0, toolId.lastIndexOf(".") + 1) : `${channelType}.`;
  if (!prefix || !toolId.startsWith(prefix)) return false;
  return /^reply(?:_[a-z0-9]+)*_to_origin$/.test(toolId.slice(prefix.length));
}

/** Classify explicit origin delivery across every assistant entry in a submission. */
function originReplyState(entries: SessionEntry[], queueItemId: string): OriginReplyState {
  const calls = entries.flatMap((entry) => {
    if (entry.type !== "message" || entry.role !== "assistant" || entry.queueItemId !== queueItemId) return [];
    return (entry.parts ?? []).filter((part) => {
      if (part.type !== "tool_call" || !isRecord(part.args)) return false;
      const toolId = part.args.tool_id;
      return typeof toolId === "string" && isTextOriginReplyAction(toolId);
    });
  });
  if (calls.length === 0) return "none";
  if (calls.some((part) => part.type === "tool_call" && successfulToolCall(part))) {
    return "succeeded";
  }
  if (calls.some((part) => part.type === "tool_call" && part.status === "running")) return "pending";
  return "failed";
}

const SLACK_USER_DELIVERY_ACTIONS = new Set([
  "add_reaction",
  "post_message",
  "send_dm",
  "send_message",
  "upload_file",
]);

function isChannelDeliveryAction(toolId: string, origin: ChannelOrigin): boolean {
  const separator = toolId.lastIndexOf(".");
  if (separator === -1) return false;
  const service = toolId.slice(0, separator);
  const action = toolId.slice(separator + 1);
  if (service === origin.channelType) {
    return (
      isOriginReplyAction(toolId, origin.channelType) ||
      action === "react_to_origin" ||
      action === "send_message" ||
      action === "dm_owner" ||
      action === "dm_user"
    );
  }
  return (
    origin.channelType === "slack" &&
    (service === "slack_user" || service === "slack-user") &&
    SLACK_USER_DELIVERY_ACTIONS.has(action)
  );
}

/** True when this submission successfully posted, reacted, or sent a DM. */
function turnCompletedChannelAction(
  entries: SessionEntry[],
  queueItemId: string,
  origin: ChannelOrigin,
): boolean {
  return entries.some((entry) => {
    if (entry.type !== "message" || entry.role !== "assistant" || entry.queueItemId !== queueItemId) return false;
    return (entry.parts ?? []).some((part) => {
      if (part.type !== "tool_call" || !successfulToolCall(part) || !isRecord(part.args)) return false;
      const toolId = part.args.tool_id;
      return typeof toolId === "string" && isChannelDeliveryAction(toolId, origin);
    });
  });
}

function turnPromptIsFeedback(entries: SessionEntry[], queueItemId: string): boolean {
  return entries.some(
    (entry) =>
      entry.type === "message" &&
      entry.role === "user" &&
      entry.queueItemId === queueItemId &&
      (entry.signal?.signalType === "channel.reply_dropped" || entry.signal?.attributes?.feedback !== undefined),
  );
}

const PUBLIC_DELIVERY_REASONS = [
  "channel_archived", "channel_not_found", "invalid_auth", "not_authed",
  "not_in_channel", "rate_limited", "ratelimited",
] as const;

/** Convert an untrusted provider error into a public, allowlisted reason. */
function publicDeliveryReason(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const normalized = message.toLowerCase();
  const code = PUBLIC_DELIVERY_REASONS.find((candidate) =>
    new RegExp(`(^|[^a-z0-9_])${candidate}([^a-z0-9_]|$)`).test(normalized),
  );
  if (code === "ratelimited") return "rate_limited";
  if (code !== undefined) return code;
  if (/\b(?:e?timedout|timed out|timeout)\b/.test(normalized)) return "provider_timeout";
  return "provider_error";
}

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

/**
 * True when this submission is a plain web-UI prompt, the one kind of
 * submission whose output stays off a bound channel (TKAI-323).
 *
 * The single classifier for the submission's surface. Gate prompts use it
 * to stay off a channel when a prompt came from the web app. A
 * submission is NOT a web prompt when any of its user entries carries:
 *
 * - `channel` — the direct-message path (`handleMessage`) stamps it, and the
 *   engine's compaction auto-continue inherits it from the interrupted item.
 * - `signal` — every engine-routed admission: the event dispatcher and the
 *   follow-router (which also set `signal.origin`), child settlement,
 *   agent-to-agent messages. These posted on a mapped thread before the
 *   surface check existed, and muting them would silently swallow, e.g., a
 *   task's settlement report on the Slack thread that asked for the task.
 *
 * A submission with no user entry at all is not classified (returns false):
 * that is a pre-submission path, and the safe default is the pre-existing
 * deliver-by-binding behavior. The failure mode of this classifier is
 * silent muting, so every branch defaults to "not web".
 */
function submissionIsWebPrompt(entries: SessionEntry[], queueItemId: string, personOnly = false): boolean {
  const prompts = entries.filter(
    (e): e is Extract<SessionEntry, { type: "message" }> =>
      e.type === "message" && e.role === "user" && e.queueItemId === queueItemId,
  );
  if (prompts.length === 0) return false;
  // `personOnly`: a child's prompt from its parent agent has no author, and
  // only a person typing in the web app makes a child submission web-origin.
  return prompts.every((e) => e.channel === undefined && e.signal === undefined && (!personOnly || e.author !== undefined));
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
  /** Serializes same-gate callbacks so only the first concurrent decision wins. */
  private gateCallbackChains = new Map<string, Promise<void>>();
  /** Recent gate resolutions, bounded FIFO (cap `DEDUP_CAP`). A prompt can be
   * recorded AFTER its gate settled — `routeAttention` fires deliverers
   * without awaiting them, so a fast resolution legitimately beats an
   * in-flight DM send. This map lets the late prompt get the resolution edit
   * immediately instead of keeping live buttons forever. */
  private settledGates = new Map<string, DecisionResolution>();
  /** Gates that expired or were withdrawn, kept the same way, so a prompt
   * recorded after that still gets its outcome edit and loses its buttons. */
  private endedGates = new Map<string, { label: string; resolvedAtMs: number }>();
  private settledOrder: string[] = [];
  private orgId: string | null = null;
  private outboundUnsub: Unsubscribe | null = null;
  /** Per-(session, thread) outbound delivery chains. Events for one thread
   * run in arrival order: a mid-turn text message must post before the gate
   * card its tool call raised, and fire-and-forget handlers would let the
   * two race. An entry is removed once its chain drains. */
  private outboundChains = new Map<string, Promise<void>>();
  private delivered = new Set<string>();
  private deliveredOrder: string[] = [];
  /** Cancels bounded feedback-admission backoff during shutdown. */
  private feedbackRetryController = new AbortController();
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
  private readonly childReplies: ChildReplyDispatcher;

  constructor(private readonly deps: ChannelHostDeps) {
    this.childReplies = new ChildReplyDispatcher({
      db: deps.db, engineStore: deps.engineStore, resolveOrgId: deps.resolveOrgId, now: () => this.now(),
      deliver: async (row) => {
        const session = await deps.engineStore.getSession(row.sessionId);
        if (!session) return true;
        if (session.orgId !== row.orgId) throw new Error("Child reply session organization mismatch");
        if (!row.queueItemId) return false;
        return this.deliverFirstAssistantReply(row.sessionId, row.threadId, {
          queueItemId: row.queueItemId, durableChildReply: true,
        });
      },
    });
    this.streamBridge = new ChannelStreamBridge({
      eventStream: deps.eventStream,
      streams: deps.activeStreams ?? new DbActiveStreamStore(deps.db),
      transportFor: (channelType) => this.transportFor(channelType),
      markDelivered: (dedupeKey) => this.markDelivered(dedupeKey),
      onMessageClosed: (turn, providerMessageId, engineMessageId) =>
        this.recordSentReply(turn.channelType, turn.conversationKey, turn.sessionId, turn.threadId, providerMessageId, { entryId: engineMessageId }),
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
    if (!refs.some(existing => existing.conversationKey === ref.conversationKey && existing.messageId === ref.messageId)) refs.push(ref);
    this.gatePrompts.set(gateId, refs);
  }

  gateForRef(ref: GatePromptRef): { gateId: string; sessionId: string } | null {
    return this.gateRefs.get(`${ref.conversationKey}#${ref.messageId}`) ?? null;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.feedbackRetryController.signal.aborted) {
      this.feedbackRetryController = new AbortController();
    }
    this.orgId = await this.deps.resolveOrgId();
    const orgId = this.orgId;
    // Restore callback addresses before starting ingress. Authorization still
    // runs for each click; a stored address grants no decision authority.
    const restored = await savedGatePrompts(this.deps.db, orgId);
    for (const prompt of restored) {
      const gate = await this.deps.engineStore.getDecisionGate(prompt.sessionId, prompt.gateId);
      if (!gate) continue;
      this.recordGatePrompt(prompt.gateId, prompt.ref, prompt.sessionId);
      this.gateActions.set(prompt.gateId, gate.actions);
    }
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
            { orgId, scopes: ["org"] },
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
    // A gate can settle while channel delivery is offline. Clear its old buttons.
    const restoredGates = new Map(restored.map(prompt => [prompt.gateId, prompt]));
    for (const prompt of restoredGates.values()) {
      const gate = await this.deps.engineStore.getDecisionGate(prompt.sessionId, prompt.gateId);
      if (gate?.status === "resolved" && gate.resolution) await this.deliverGateResolution(gate.id, gate.resolution);
      else if (gate && gate.status !== "pending") await this.settleGatePrompts(gate.id, gate.status === "expired" ? GATE_EXPIRED_LABEL : GATE_WITHDRAWN_LABEL);
    }
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
      if (signal.aborted) {
        resolve();
        return;
      }
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
    this.feedbackRetryController.abort();
    for (const controller of this.pollControllers.values()) controller.abort();
    await Promise.all(this.pollLoops);
    this.pollControllers.clear();
    this.pollLoops = [];
    // Before the transports go away: a stream closed here is one the next
    // boot does not have to apologise for.
    await this.streamBridge.stop();
    this.stopOutbound();
    await this.childReplies.drain();
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
   * Rule 1: subscribe once (no sessionId filter) to outbound control events.
   * Live subscription only. There is no replay from a stored offset.
   * Child completion replies use a separate durable intent queue for restart recovery.
   */
  startOutbound(): void {
    if (this.outboundUnsub) return;
    this.childReplies.start();
    this.outboundUnsub = this.deps.eventStream.subscribe(
      {
        eventTypes: [
          "message_end",
          "submission_settled",
          "tool_end",
          "decision_gate",
          "decision_gate_resolved",
          // An ending without a decision still has to clear the card:
          // otherwise a cancelled or timed-out run leaves live buttons in the
          // channel for the life of the process.
          "decision_gate_expired",
          "decision_gate_withdrawn",
          "command_result",
        ],
      },
      (event) => {
        // Serialize per (session, thread): each handler awaits transport
        // sends, and two concurrent handlers can land out of order — the
        // reader would see the approval card before the text that led to it.
        // An event without a threadId has no thread to order against.
        const e = event.event;
        const threadId = "threadId" in e ? e.threadId : undefined;
        if (threadId === undefined) {
          void this.handleOutboundEvent(event);
          return;
        }
        const key = `${event.sessionId}\u0000${threadId}`;
        const tail = (this.outboundChains.get(key) ?? Promise.resolve()).then(() =>
          this.handleOutboundEvent(event),
        );
        this.outboundChains.set(key, tail);
        // handleOutboundEvent never throws (its body is try/caught), so the
        // chain cannot reject; finally is only bookkeeping.
        void tail.finally(() => {
          if (this.outboundChains.get(key) === tail) this.outboundChains.delete(key);
        });
      },
    );
  }

  stopOutbound(): void {
    this.childReplies.stop();
    this.outboundUnsub?.();
    this.outboundUnsub = null;
    this.outboundChains.clear();
  }

  /** Runs one bounded retry pass; also used by deterministic recovery tests. */
  retryChildReplies(): Promise<void> {
    return this.childReplies.poll();
  }

  /** Rule 5: every callback body try/caught — errors logged, never thrown into the stream. */
  private async handleOutboundEvent(event: DeliveredBusEvent): Promise<void> {
    try {
      const e = event.event;
      if (e.type === "message_end") {
        await this.deliverFirstAssistantReply(event.sessionId, e.threadId, {
          messageId: e.messageId,
          queueItemId: event.queueItemId,
          reason: e.reason,
        });
      } else if (e.type === "submission_settled" && e.outcome.outcome === "failed") {
        await this.deliverSubmissionFailure(event.sessionId, e.threadId, e.queueItemId);
      } else if (e.type === "tool_end" && event.queueItemId !== undefined) {
        await this.deliverFirstAssistantReply(event.sessionId, e.threadId, {
          queueItemId: event.queueItemId,
        });
      } else if (e.type === "decision_gate") {
        await this.deliverGatePrompt(event.sessionId, e.gate);
      } else if (e.type === "decision_gate_resolved") {
        await this.deliverGateResolution(e.gateId, e.resolution);
      } else if (e.type === "decision_gate_expired" || e.type === "decision_gate_withdrawn") {
        await this.endGate(e.gateId, e.type === "decision_gate_expired" ? GATE_EXPIRED_LABEL : GATE_WITHDRAWN_LABEL, event.timestamp);
      } else if (e.type === "command_result") {
        await this.deliverCommandResult(event.sessionId, e.threadId, e.entry);
      }
    } catch (err) {
      console.error("[channels] outbound delivery failed", err);
    }
  }

  /** Provider attempts can recover. Only a settled failure needs a channel notice. */
  private async deliverSubmissionFailure(sessionId: string, threadId: string, queueItemId: string): Promise<void> {
    const dedupeKey = `${sessionId}:failure:${queueItemId}`;
    if (this.delivered.has(dedupeKey)) return;
    const entries = await this.deps.engineStore.getEntries(sessionId, threadId);
    const origin = turnOrigin(entries, queueItemId);
    if (!origin || origin.reply === "manual") return;
    if (originReplyState(entries, queueItemId) === "succeeded") return;
    const target = this.channelThreadFor(origin.threadKey);
    if (!target) return;
    const transport = this.transports.get(target.channelType);
    if (!transport) return;
    const sender = await this.workspaceSenderForSession(sessionId, queueItemId);
    await transport.send(target.conversationKey, {
      markdown: "This turn failed. Open the session in Valet for details.",
      ...(sender !== undefined ? { sender } : {}),
    });
    this.markDelivered(dedupeKey);
  }

  /** Post only the first assistant text for an addressed channel turn. */
  private async deliverFirstAssistantReply(
    sessionId: string,
    threadId: string,
    trigger: {
      durableChildReply?: boolean;
      messageId?: string;
      queueItemId?: string;
      reason?: "end_turn" | "tool_use" | "error" | "abort";
    },
  ): Promise<boolean> {
    const thread = await this.deps.engineStore.getThread(sessionId, threadId);
    if (!thread) return false;
    const entries = await this.deps.engineStore.getEntries(sessionId, threadId);
    const triggerEntry = trigger.messageId === undefined
      ? undefined
      : entries.find(
          (entry): entry is Extract<SessionEntry, { type: "message" }> =>
            entry.type === "message" && entry.role === "assistant" && entry.id === trigger.messageId,
        );
    const queueItemId = trigger.queueItemId ?? triggerEntry?.queueItemId;
    if (!queueItemId) return false;
    // The durable intent owns automatic child replies, including the
    // admission-to-receipt crash window. Manual settlements stay on the live
    // path so they keep the dropped-reply reminder.
    if (!trigger.durableChildReply && ownedByChildReplyIntent(entries, queueItemId)) return false;
    const dedupeKey = `${sessionId}:first-reply:${queueItemId}`;
    if (trigger.reason === "error" || trigger.reason === "abort") {
      if (trigger.reason === "abort") this.markDelivered(dedupeKey);
      return false;
    }
    const queueItem = await this.deps.engineStore.getQueueItem(sessionId, queueItemId);
    if (queueItem?.abortRequestedAt !== undefined || queueItem?.outcome?.outcome === "aborted") {
      this.markDelivered(dedupeKey);
      return true;
    }

    const first = entries.find(
      (entry) =>
        entry.type === "message" &&
        entry.role === "assistant" &&
        entry.queueItemId === queueItemId &&
        entry.stopReason !== "error" && entry.stopReason !== "abort" &&
        Boolean(entry.content),
    );
    if (!first || first.type !== "message" || !first.content) return queueItem?.status === "settled";
    const origin = turnOrigin(entries, queueItemId);
    if (!origin) return true;
    if (origin.reply === "manual") {
      if (
        triggerEntry?.stopReason === "end_turn" &&
        !turnCompletedChannelAction(entries, queueItemId, origin) &&
        !turnPromptIsFeedback(entries, queueItemId)
      ) {
        await this.submitReplyFeedback(sessionId, thread.key, origin, {
          dispatchId: `feedback:overheard-dropped:${threadId}`,
          body:
            "Your response was not posted to the channel origin. " +
            "If you intended to stay silent, do nothing. " +
            "Only call the current signal origin service's reply_to_origin action if you intended to reply. " +
            "This reminder is sent once per assistant thread.",
          acceptDispatchConflict: true,
          queueItemId,
        });
      }
      return true;
    }

    const explicit = originReplyState(entries, queueItemId);
    if (explicit === "pending") return false;
    if (explicit === "succeeded") return true;

    const target = this.channelThreadFor(origin.threadKey);
    if (!target) return false;
    if (this.delivered.has(dedupeKey)) return true;
    const transport = this.transports.get(target.channelType);
    if (!transport) return false;
    const sender = await this.workspaceSenderForSession(sessionId, queueItemId);
    let sent: SendRef;
    try {
      sent = await transport.send(target.conversationKey, {
        markdown: first.content,
        ...(sender !== undefined ? { sender } : {}),
      });
      this.markDelivered(dedupeKey);
    } catch (error) {
      // The durable child dispatcher keeps its intent and retries provider
      // errors itself, so they bypass the live best-effort feedback below.
      if (trigger.durableChildReply) throw error;
      const reason = publicDeliveryReason(error);
      console.error("[channels] addressed reply send failed", error);
      try {
        const orgId = this.orgId ?? (await this.deps.resolveOrgId());
        await this.dropLog(orgId, "channel_reply_failed", target.conversationKey, reason);
      } catch (dropError) {
        console.error("[channels] reply failure drop-log failed", dropError);
      }
      await this.retryFailedReplyFeedback(sessionId, thread.key, queueItemId, origin, reason);
      this.markDelivered(dedupeKey);
      return true;
    }
    // Outside the send's error handling: the reply is already posted, so a
    // failed record must never tell the agent to post it again.
    await this.recordSentReply(target.channelType, target.conversationKey, sessionId, threadId, sent.messageId, { text: first.content });
    return true;
  }

  /**
   * Records a reply Valet posted in a channel thread, with the engine message
   * it carried. A DM is not a channel, so it records nothing. Best effort: it
   * logs a failure and never throws, because the reply is already posted.
   */
  private async recordSentReply(
    channelType: string, conversationKey: string, sessionId: string, threadId: string,
    providerMessageId: string, body: { text: string } | { entryId: string },
  ): Promise<void> {
    try {
      await this.recordSentReplyOrThrow(channelType, conversationKey, sessionId, threadId, providerMessageId, body);
    } catch (err) {
      console.error("[channels] could not record a sent reply", err);
    }
  }

  private async recordSentReplyOrThrow(
    channelType: string, conversationKey: string, sessionId: string, threadId: string,
    providerMessageId: string, body: { text: string } | { entryId: string },
  ): Promise<void> {
    const threadKey = this.transports.get(channelType)?.threadKeyFromConversationKey?.(conversationKey);
    const conversation = slackConversationFromThreadKey(threadKey);
    if (!threadKey || !conversation || providerMessageId === "") return;
    // One row by id, not the thread's whole transcript: this runs on every reply.
    const text = "text" in body ? body.text : ((await this.deps.db.execute(sql`SELECT content FROM engine_entries
      WHERE session_id = ${sessionId} AND id = ${body.entryId}`)) as { rows: Array<{ content: string | null }> }).rows[0]?.content ?? undefined;
    await recordChannelMessage(this.deps.db, {
      orgId: this.orgId ?? (await this.deps.resolveOrgId()),
      sessionId, threadId,
      channelKey: slackChannelKey(conversation.channelId),
      conversationKey: threadKey,
      providerMessageId,
      direction: "out",
      ...(text ? { text } : {}),
      url: slackMessageUrl(conversation.channelId, providerMessageId, conversation.threadTs),
    });
  }

  private async retryFailedReplyFeedback(
    sessionId: string,
    threadKey: string,
    queueItemId: string,
    origin: ChannelOrigin,
    reason: string,
  ): Promise<boolean> {
    const signal = this.feedbackRetryController.signal;
    const feedback = {
      dispatchId: `feedback:reply-failed:${queueItemId}`,
      body: `Your response was not posted to ${origin.threadKey}. Delivery failed: ${reason}. Call ${origin.channelType}.reply_to_origin with the response text to retry.`,
      acceptDispatchConflict: true,
      queueItemId,
    };
    for (const delay of FEEDBACK_RETRY_DELAYS_MS) {
      if (delay > 0) await this.sleepOrAbort(delay, signal);
      if (signal.aborted) return false;
      const result = await this.submitReplyFeedback(sessionId, threadKey, origin, feedback);
      if (result === "admitted") return true;
      if (result === "not_live") return false;
    }
    return false;
  }

  /** Submit one manual, digest-exempt recovery turn on the same assistant thread. */
  private async submitReplyFeedback(
    sessionId: string,
    threadKey: string,
    origin: ChannelOrigin,
    feedback: { dispatchId: string; body: string; acceptDispatchConflict?: boolean; queueItemId?: string },
  ): Promise<"admitted" | "retryable" | "not_live"> {
    try {
      const session = this.deps.engineHost.liveSession(sessionId);
      if (!session) {
        console.warn("[channels] reply-dropped feedback skipped: session is not live", { sessionId });
        return "not_live";
      }
      const item = feedback.queueItemId ? await this.deps.engineStore.getQueueItem(sessionId, feedback.queueItemId) : undefined;
      const presence = readPresence(item?.metadata?.presence);
      await session.thread(threadKey).submitPrompt(
        {
          kind: "signal",
          signalType: "channel.reply_dropped",
          body: feedback.body,
          tagName: "delivery_failure",
          attributes: { feedback: "reply_dropped" },
          origin: {
            channelType: origin.channelType,
            threadKey: origin.threadKey,
            reply: "manual",
          },
        },
        { dispatchId: feedback.dispatchId, queueMode: "followup", ...(presence ? { metadata: { presence } } : {}) },
      );
      return "admitted";
    } catch (error) {
      if (
        feedback.acceptDispatchConflict === true &&
        error instanceof ConflictError &&
        error.details?.dispatchId === feedback.dispatchId &&
        typeof error.details.existingItemId === "string"
      ) {
        return "admitted";
      }
      console.error("[channels] reply-dropped feedback failed", error);
      return "retryable";
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
  /** The channel conversation that spawned an unsettled child session. */
  private async childOriginConversation(sessionId: string): Promise<{ channelType: string; conversationKey: string } | null> {
    const watch = await activeChildWatch(this.deps.db, sessionId);
    return watch?.origin ? this.channelThreadFor(watch.origin.threadKey) : null;
  }

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

  /**
   * Per-assistant outbound identity for a session's channel posts
   * (TKAI-387): the assistant's `name` and `avatarUrl`, read from the row
   * on every delivery so an edit takes effect on the next post. `undefined`
   * when the session is not an assistant's, or when the assistant has no
   * override set — the transport then posts under the bot's own identity.
   * Best-effort: a lookup failure must not stop the delivery.
   */
  /** "Only members of <team> can approve.", or undefined when the team is gone. */
  private async teamApproverNote(teamId: string): Promise<string | undefined> {
    try {
      const [team] = await this.deps.db.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId)).limit(1);
      return team ? `Only members of ${team.name} can approve.` : undefined;
    } catch (err) {
      console.error("[channels] team name lookup failed", err);
      return undefined;
    }
  }

  private async workspaceSenderForSession(
    sessionId: string,
    queueItemId?: string,
  ): Promise<{ displayName?: string; avatarUrl?: string } | undefined> {
    try {
      const base = await assistantSessionSender(this.deps.db, sessionId);
      const item = queueItemId ? await this.deps.engineStore.getQueueItem(sessionId, queueItemId) : undefined;
      return mergePresence(base, readPresence(item?.metadata?.presence));
    } catch (err) {
      // Identity is decoration on the post; the text must still land.
      console.error("[channels] assistant identity lookup failed", err);
      return undefined;
    }
  }

  /**
   * Rule 6: command_result → send the result markdown to the channel the
   * command came from. A slash command sent from Telegram or Slack must
   * answer there — the web UI reads the same entry over REST/WS. Dedup on
   * the entry id, same LRU as assistant messages.
   *
   * The submission surface rule (TKAI-323): the entry's `channel`
   * mark says the command came from that surface; without it the command
   * was typed in the web UI and its result stays there. Today every engine
   * command arrives via the web REST route (`session.prompt` is its only
   * caller), so this rule is dormant until a transport routes slash
   * commands through `session.prompt` with `channel` set.
   */
  private async deliverCommandResult(
    sessionId: string,
    threadId: string | undefined,
    entry: CommandResultEntry,
  ): Promise<void> {
    if (!threadId) return;
    if (entry.channel === undefined) return;
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
    const sender = await this.workspaceSenderForSession(sessionId);
    await transport.send(mapped.conversationKey, {
      markdown,
      ...(sender !== undefined ? { sender } : {}),
    });
  }

  /** Rule 3: decision_gate → sendGatePrompt, record refs for the inbound gate_callback path. */
  private async deliverGatePrompt(sessionId: string, gate: DecisionGate): Promise<void> {
    const thread = await this.deps.engineStore.getThread(sessionId, gate.threadId);
    if (!thread) return;
    // A child's own thread is never a channel thread. Its card goes to the
    // conversation that spawned the work, so the person who asked there can
    // answer it (TKAI-564). The callback still resolves the child's gate.
    const direct = this.channelThreadFor(thread.key);
    const mapped = direct ?? await this.childOriginConversation(sessionId);
    if (!mapped) return;
    const transport = this.transports.get(mapped.channelType);
    if (!transport) return;

    // The submission surface rule (TKAI-323): a web-UI submission's
    // gate resolves in the web UI. With the submission's text muted on the
    // channel, its card would be a live approve/deny button with zero
    // surrounding context — an invitation to approve an action the channel
    // reader never saw described.
    // A child's prompt from its parent agent is not a web prompt, and the
    // stored origin proves the work started in this conversation. A person
    // can still prompt the child in the web app; that gate stays in the web.
    const entries = await this.deps.engineStore.getEntries(sessionId, gate.threadId);
    if (submissionIsWebPrompt(entries, gate.queueItemId, !direct)) {
      console.debug(
        `[channels] web-origin gate stays off ${mapped.channelType} (session=${sessionId} gate=${gate.id})`,
      );
      return;
    }

    // A gate asking to use a member's shared account answers to that member,
    // who gets it directly (`attention-wiring.ts`). The conversation learns
    // that the request went to them, with no buttons to press.
    const approver = gateApprover(gate);
    if (approver) {
      const sender = await this.workspaceSenderForSession(sessionId, gate.queueItemId);
      await transport.send(mapped.conversationKey, {
        markdown: `This needs ${approver.name ?? "a teammate"}'s shared account. Valet asked them for permission and continues once they allow it.`,
        ...(sender !== undefined ? { sender } : {}),
      });
      return;
    }

    // Digest before sending: a tool-approval gate's raw body is a
    // tool_id/args JSON dump; the card shows the summary plus labeled
    // fields instead, with a link for the full request.
    const digest = digestGate(gate);
    const source = await this.deps.engineStore.getSession(sessionId);
    const link = this.openInValetLink(attentionHref(sessionId, gate.threadId, source?.owner));
    // Anyone in the channel can mention a team's Valet, but only the team can
    // settle its approvals. Say so on the card, so its buttons are not a dead end.
    const who = source?.owner?.type === "team" ? await this.teamApproverNote(source.owner.id) : undefined;
    const body = [digest.body, who, link].filter((part): part is string => part !== undefined).join("\n\n") || undefined;
    await this.sendAndRecordGatePrompt(
      transport,
      mapped.conversationKey,
      { gateId: gate.id, title: digest.title, body, fields: digest.fields, actions: gate.actions },
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
    prompt: {
      gateId: string;
      title: string;
      body?: string;
      fields?: Array<{ label: string; value: string }>;
      actions: DecisionAction[];
    },
    sessionId: string,
  ): Promise<void> {
    // The card carries the asking assistant's identity. In a channel with
    // shared workspaces, the reader must see who asks for approval.
    // Resolution edits keep the posted identity.
    const sourceGate = await this.deps.engineStore.getDecisionGate(sessionId, prompt.gateId);
    const sender = await this.workspaceSenderForSession(sessionId, sourceGate?.queueItemId);
    // A channel reply cannot answer an open question (one with no options),
    // so the card says where the answer goes instead of showing no control.
    const body = prompt.actions.length > 0 ? prompt.body
      : [prompt.body, OPEN_QUESTION_NOTE].filter((part): part is string => part !== undefined).join("\n\n");
    const ref = await transport.sendGatePrompt(conversationKey, {
      ...prompt,
      ...(body !== undefined ? { body } : {}),
      ...(sender !== undefined ? { sender } : {}),
    });
    // The card is live once sent, so this host records its callback address
    // first. The saved ref only lets a restarted host restore the address; a
    // failed save costs that restore, not the buttons on this host.
    this.gateActions.set(prompt.gateId, prompt.actions);
    this.recordGatePrompt(prompt.gateId, ref, sessionId);
    try {
      const gate = await this.deps.engineStore.getDecisionGate(sessionId, prompt.gateId);
      if (gate) {
        await this.deps.engineStore.saveDecisionGateRef(sessionId, gate.threadId, gate.id, {
          channelType: transport.channelType, ref: { channelId: ref.conversationKey, messageId: ref.messageId },
        });
      }
    } catch (err) {
      console.error(`[channels] could not save the callback reference for gate ${prompt.gateId}; the card works until this host restarts`, err);
    }
    const settled = this.settledGates.get(prompt.gateId);
    const ended = this.endedGates.get(prompt.gateId);
    if (settled) {
      await this.deliverGateResolution(prompt.gateId, settled);
    } else if (ended) {
      await this.settleGatePrompts(prompt.gateId, ended.label, { resolvedAtMs: ended.resolvedAtMs });
    }
  }

  /** An expiry or a withdrawal: remembered first, like a decision, so a
   * prompt whose send is still in flight is settled when it lands. */
  private async endGate(gateId: string, label: string, resolvedAtMs: number): Promise<void> {
    this.endedGates.set(gateId, { label, resolvedAtMs });
    this.settledOrder.push(gateId);
    if (this.settledOrder.length > DEDUP_CAP) {
      const evict = this.settledOrder.shift();
      if (evict !== undefined) { this.settledGates.delete(evict); this.endedGates.delete(evict); }
    }
    await this.settleGatePrompts(gateId, label, { resolvedAtMs });
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
      if (evict !== undefined) { this.settledGates.delete(evict); this.endedGates.delete(evict); }
    }

    const refs = this.gatePrompts.get(gateId);
    if (!refs || refs.length === 0) return;
    const actions = this.gateActions.get(gateId) ?? [];
    const label = gateResolutionLabel(actions, resolution, await this.userName(resolution.resolvedBy));
    await this.settleGatePrompts(gateId, label, {
      ...(resolution.actionId !== undefined ? { actionId: resolution.actionId } : {}),
      resolvedAtMs: resolution.resolvedAt,
    });
  }

  /**
   * Writes the outcome line onto every prompt message for a gate, then drops
   * the gate from all three gate maps. The single place a gate's channel
   * state ends: a decision, an expiry, and a withdrawal all arrive here.
   *
   * A prompt whose send is still in flight has no ref yet, so this settles
   * nothing for it. `sendAndRecordGatePrompt` replays the remembered outcome
   * (`settledGates` for a decision, `endedGates` for an expiry or a
   * withdrawal) when that send lands.
   */
  private async settleGatePrompts(
    gateId: string,
    label: string,
    outcome: { actionId?: string; resolvedAtMs?: number } = {},
  ): Promise<void> {
    let allUpdated = true;
    for (const ref of this.gatePrompts.get(gateId) ?? []) {
      const channelType = ref.conversationKey.slice(0, ref.conversationKey.indexOf(":"));
      const transport = this.transports.get(channelType);
      if (transport) {
        try {
          await transport.updateGatePrompt(ref, { ...outcome, label });
        } catch (err) {
          // One stale message (deleted DM, revoked scope) must not keep the
          // other copies of the same prompt un-updated.
          allUpdated = false;
          console.error(`[channels] ${channelType}: gate prompt update failed`, err);
        }
      } else {
        allUpdated = false;
      }
      this.gateRefs.delete(`${ref.conversationKey}#${ref.messageId}`);
    }

    this.gatePrompts.delete(gateId);
    this.gateActions.delete(gateId);
    if (allUpdated) await deleteSavedGatePrompts(this.deps.db, gateId);
  }

  /**
   * Display name for a resolver's user id, for the resolution edit.
   * `undefined` when the id names no user row (engine-internal resolvers,
   * e.g. an expiry) — the label then omits the "by …" clause.
   */
  private async userName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;
    try {
      const rows = await this.deps.db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return rows[0]?.name || undefined;
    } catch (err) {
      // Best-effort: the name is decoration on the edit. A lookup failure
      // must not stop the buttons from clearing on every prompt message.
      console.error("[channels] resolver name lookup failed", err);
      return undefined;
    }
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

  async handleUpdate(channelType: string, event: InboundChannelEvent, propagateErrors = false): Promise<void> {
    try {
      await this.routeUpdate(channelType, event);
    } catch (err) {
      this.seenDispatchIds.delete(event.dispatchId);
      console.error("[channels] update failed", err);
      if (propagateErrors) throw err;
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
      const callback = event.gateCallback;
      const callbackRef = callback && isGatePromptRef(callback.ref) ? callback.ref : undefined;
      const mappedGateId = callbackRef ? this.gateForRef(callbackRef)?.gateId : undefined;
      // Never use gateId from the callback payload. It is untrusted input and
      // must not let a forged button join another gate's serialization chain.
      const key = mappedGateId ?? `${callbackRef?.conversationKey ?? event.conversationKey}#${callbackRef?.messageId ?? ""}`;
      await this.serializeGateCallback(key, () => this.handleGateCallback(transport, event, orgId, userId, channelType));
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

  /**
   * Puts one non-image channel attachment into the session sandbox.
   *
   * Returns `undefined` when the file cannot be stored, so the caller can
   * degrade to a note. The sandbox has to be awake to hold the file; the
   * turn that follows needs it awake anyway, and the Slack webhook already
   * answered 200 before this runs, so the wait costs no provider timeout.
   */
  private async storeChannelFile(
    session: Session,
    fetched: { data: Uint8Array; mimeType: string; name?: string },
  ): Promise<IngestedChannelFile | undefined> {
    const attachment = session.attachment;
    if (attachment.state === "released") return undefined;
    try {
      const { sandbox } = await attachment.ensureReady({ timeoutMs: SANDBOX_READY_TIMEOUT_MS });
      const stored = await ingestChannelFile({
        sandbox,
        name: fetched.name ?? "attachment",
        mimeType: fetched.mimeType,
        data: fetched.data,
      });
      return stored ?? undefined;
    } catch (err) {
      console.error("[channel-host] could not store a channel attachment", err);
      return undefined;
    }
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

    const alreadyAdmitted = async () => {
      const rows = await this.deps.db.execute(sql`SELECT id FROM engine_queue_items
        WHERE session_id=${session.id} AND dispatch_id=${event.dispatchId} LIMIT 1`) as { rows: Array<{ id: string }> };
      return rows.rows.length > 0;
    };
    // A restart may replay after admission but before inbox deletion. Do not
    // download attachments again: their filenames or contents may have changed.
    if (await alreadyAdmitted()) return;

    // Ask the transport for the thread key when it owns the mapping, so this
    // half and `channelThreadFor`'s inverse cannot drift apart. The default
    // below is the same derivation Telegram has always used.
    const threadKey =
      transport?.threadKeyFromConversationKey?.(event.conversationKey) ??
      `${channelType}:${chatIdFromKey(event.conversationKey)}`;
    const thread = await this.deps.engineHost.ensureFreshThread(session, threadKey, {
      userId,
      orgId,
      workspace: session.options.workspace,
    });

    let text = event.text ?? "";
    const attachments: PromptAttachment[] = [];
    for (const media of event.media ?? []) {
      const fetched = transport?.fetchMedia ? await transport.fetchMedia(media) : null;
      if (!fetched) {
        text += "\n\n[attachment skipped: too large or unavailable]";
        continue;
      }
      if (fetched.mimeType.startsWith("image/")) {
        // Signal content is persisted before the turn runs. Keep image data
        // JSON-safe across that queue boundary.
        attachments.push({
          type: "image",
          url: `data:${fetched.mimeType};base64,${Buffer.from(fetched.data).toString("base64")}`,
          mimeType: fetched.mimeType,
          name: fetched.name,
        });
        continue;
      }
      // A PDF, spreadsheet or archive cannot ride an image content block, so
      // it goes to the sandbox instead and the agent reads it from there.
      const file = await this.storeChannelFile(session, fetched);
      if (!file) {
        text += `\n\n[attachment skipped: could not store ${fetched.mimeType}]`;
        continue;
      }
      attachments.push({ type: "file", ...file });
    }

    const content: SignalContent = {
      kind: "signal",
      signalType: `${channelType}.message`,
      body: text === "" ? "(media message)" : text,
      origin: { channelType, threadKey },
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(event.sender.displayName ? { attributes: { sender: event.sender.displayName } } : {}),
    };
    try { await thread.submitPrompt(
      content,
      {
        dispatchId: event.dispatchId,
        author: { id: userId, name: event.sender.displayName, externalId: event.sender.externalId },
        // Stamp the surface this prompt came from. A channel thread keeps its
        // binding for its whole life, so the thread key alone cannot say
        // whether a given turn started on the channel or in the web UI. The
        // Gate and command-result delivery use this mark to distinguish a
        // channel turn from a web turn on the same bound thread (TKAI-323).
        channel: { channelType, channelId: event.conversationKey },
      },
    ); } catch (err) {
      // A concurrent consumer may have admitted the same authenticated delivery.
      if (!(err instanceof ConflictError) || !await alreadyAdmitted()) throw err;
    }

    // Bump lastActivityAt so a long-lived channel-bound session rises in
    // the session list when it receives a message (TKAI-341).
    const channelNow = this.now();
    await this.deps.db
      .update(agentSessions)
      .set({ lastActivityAt: channelNow })
      .where(eq(agentSessions.id, session.id));
    await recordThreadUserActivity(this.deps.db, {
      sessionId: session.id,
      threadId: thread.id,
      threadCreatedAt: thread.toThreadData().createdAt,
      activityAt: channelNow,
      emit: (activityEvent) => session.emit(activityEvent),
    });
  }

  private async serializeGateCallback(key: string, callback: () => Promise<void>): Promise<void> {
    const previous = this.gateCallbackChains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(callback);
    this.gateCallbackChains.set(key, next);
    try {
      await next;
    } finally {
      if (this.gateCallbackChains.get(key) === next) this.gateCallbackChains.delete(key);
    }
  }

  /**
   * Decides whether a user may resolve the gates of a workflow session.
   *
   * Reads rows only. It builds no session, so asking the question for one
   * more recipient on one more transport costs queries and nothing else —
   * `workflowGateSessionFor` builds the session, and only the path that
   * actually resolves a gate calls it.
   */
  private async authorizeWorkflowGate(
    sessionId: string,
    orgId: string,
    userId: string,
    gateId: string,
  ): Promise<
    | { ok: true; owner: SessionOwnerLike; orgId: string }
    | { ok: false; reason: "workflow_session_malformed" | "workflow_session_missing" | "workflow_session_deleted" | "workflow_session_cross_org" | "unauthorized" }
  > {
    if (!this.deps.workflowStore || !this.deps.actionPluginByService || !sessionId.startsWith("wf:")) {
      return { ok: false, reason: "workflow_session_malformed" };
    }
    let parts: ReturnType<typeof parseWorkflowSessionId>;
    try {
      parts = parseWorkflowSessionId(sessionId);
    } catch {
      return { ok: false, reason: "workflow_session_malformed" };
    }
    const run = await this.deps.workflowStore.getRun(parts.runId);
    if (!run) return { ok: false, reason: "workflow_session_missing" };
    if (!run.owner) return { ok: false, reason: "workflow_session_deleted" };
    const rows = await this.deps.db
      .select({ orgId: workflowDefinitions.orgId })
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, run.params.workflowId))
      .limit(1);
    const workflowOrgId = rows[0]?.orgId;
    if (!workflowOrgId) return { ok: false, reason: "workflow_session_deleted" };
    if (workflowOrgId !== orgId) return { ok: false, reason: "workflow_session_cross_org" };
    if (!(await this.deps.engineStore.getSession(sessionId))) {
      return { ok: false, reason: "workflow_session_deleted" };
    }
    const owner: SessionOwnerLike = {
      ownerType: run.owner.ownerType,
      ownerId: run.owner.ownerId,
      userId: run.owner.ownerType === "user" ? run.owner.ownerId : "",
    };
    const authorized = owner.ownerType === "org"
      ? await isOrgAdmin(this.deps.db, workflowOrgId, userId)
      : await canResolveSessionGate(this.deps.db, owner, userPrincipal(userId));
    if (!authorized) return { ok: false, reason: "unauthorized" };
    // A run from a private thread or a private Slack channel's event is that
    // audience's. A named account approver may answer only their pending gate.
    const gate = await this.deps.engineStore.getDecisionGate(sessionId, gateId);
    const namedApprover = gate?.status === "pending" && gateApprover(gate)?.userId === userId;
    if (owner.ownerType === "team" && !namedApprover) {
      const access = { db: this.deps.db, engineCredentials: this.deps.engineCredentials, onePassword: this.deps.onePassword, engineStore: this.deps.engineStore };
      const viewer = { orgId: workflowOrgId, userId };
      if (!(await runOriginVisible(access, viewer, { ownerType: "team", origin: run.params.origin, actorUserId: run.actorUserId }))
        || !(await runEventVisible(access, viewer, run.params))) {
        return { ok: false, reason: "unauthorized" };
      }
    }
    return { ok: true, owner, orgId: workflowOrgId };
  }

  /**
   * Builds the engine session for a workflow gate the caller already
   * authorized with `authorizeWorkflowGate`. Throws when the workflow
   * dependencies are absent, which that check refuses first.
   */
  private async workflowGateSessionFor(sessionId: string): Promise<Session> {
    const { workflowStore, actionPluginByService } = this.deps;
    if (!workflowStore || !actionPluginByService) {
      throw new Error("workflow gate session requires the workflow store and action plugins");
    }
    return ensureWorkflowSession({
      host: this.deps.engineHost,
      store: workflowStore,
      db: this.deps.db,
      engineStore: this.deps.engineStore,
      actionPluginByService,
      plugins: this.deps.plugins,
      credentials: this.deps.engineCredentials,
      onePassword: this.deps.onePassword,
    }, sessionId);
  }

  private async handleGateCallback(
    transport: ChannelTransport | undefined,
    event: InboundChannelEvent,
    orgId: string,
    userId: string,
    channelType: string,
  ): Promise<void> {
    const gateCallback = event.gateCallback;
    if (!gateCallback || !isRecord(gateCallback) || !isGatePromptRef(gateCallback.ref)) {
      const callbackId = isRecord(gateCallback) && typeof gateCallback.callbackId === "string" ? gateCallback.callbackId : undefined;
      await transport?.answerCallback?.(callbackId ?? "", "This approval has expired — resolve it on the web.");
      await this.dropLog(orgId, "malformed_callback", event.conversationKey, "gate_callback missing valid ref payload");
      return;
    }
    const mapped = this.gateForRef(gateCallback.ref);
    if (!mapped) {
      await transport?.answerCallback?.(gateCallback.callbackId, "This approval has expired — resolve it on the web.");
      await this.dropLog(orgId, "unsupported_kind", event.conversationKey, "unknown_gate_ref");
      return;
    }

    // Explicit resolve authorization — the same named check the web
    // decision routes make (`canResolveSessionGate`): the session's direct
    // owner, or a live member of the owning team. A refusal matches the
    // unknown-ref reply, so a probe cannot tell "not yours" from "gone". One
    // exception, below: a team-owned card already names its team to everyone
    // in the thread ("Only members of X can approve."), so a non-member's
    // click gets that same sentence; it discloses nothing the card did not.
    const rows = await this.deps.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, mapped.sessionId))
      .limit(1);
    const sessionRow = rows[0];
    let workflow: Awaited<ReturnType<ChannelHost["authorizeWorkflowGate"]>> | null = null;
    try {
      workflow = mapped.sessionId.startsWith("wf:")
        ? await this.authorizeWorkflowGate(mapped.sessionId, orgId, userId, mapped.gateId)
        : null;
    } catch (err) {
      console.error("[channels] workflow gate authorization failed", err);
      await transport?.answerCallback?.(
        gateCallback.callbackId,
        "Valet could not process this approval. Open the session in Valet to resolve it.",
      );
      return;
    }
    if ((workflow && !workflow.ok) || (!sessionRow && !workflow)) {
      // No app row and no workflow run behind the id: nothing authorizes this
      // click. It is an unknown or deleted ordinary session, not a workflow.
      const reason = workflow?.reason ?? "unauthorized";
      await transport?.answerCallback?.(gateCallback.callbackId, "This approval has expired — resolve it on the web.");
      await this.dropLog(orgId, reason, event.conversationKey, reason === "unauthorized" ? "sender may not resolve this session's gates" : reason);
      return;
    }
    if (sessionRow && (sessionRow.orgId !== orgId || (!workflow?.ok && !(await canResolveSessionGate(this.deps.db, sessionRow, userPrincipal(userId)))))) {
      // A team's card already names who may approve, so a non-member's click
      // gets that answer, not "expired". Every other refusal keeps the reply
      // that cannot be told apart from an unknown card.
      const teamNote = sessionRow.orgId === orgId && sessionRow.ownerType === "team" && sessionRow.ownerId
        ? await this.teamApproverNote(sessionRow.ownerId) : undefined;
      await transport?.answerCallback?.(
        gateCallback.callbackId,
        teamNote ? `${teamNote} Ask a team member to answer it.` : "This approval has expired — resolve it on the web.",
      );
      await this.dropLog(orgId, "unauthorized", event.conversationKey, "sender may not resolve this session's gates");
      return;
    }

    // Same backstop as the web resolve route, via the same shared guard:
    // `always_allow` widens policy for the SESSION's org, so a non-admin's
    // click must fail here with a clear answer, not late inside the engine.
    const sessionOrgId = sessionRow?.orgId ?? (workflow?.ok ? workflow.orgId : undefined);
    if (gateCallback.actionId === GATE_ACTION_ALWAYS_ALLOW && sessionOrgId && !(await canApplyAlwaysAllow(this.deps.db, sessionOrgId, userId))) {
      await transport?.answerCallback?.(gateCallback.callbackId, "Only an org admin can choose Always allow — resolve it on the web.");
      await this.dropLog(orgId, "unauthorized", event.conversationKey, "always_allow requires org admin");
      return;
    }
    // A gate asking to use a member's shared account answers to that member alone.
    const stored = await this.deps.engineStore.getDecisionGate(mapped.sessionId, mapped.gateId);
    if (stored && !answersGate(stored, userPrincipal(userId))) {
      await transport?.answerCallback?.(gateCallback.callbackId, `Only ${gateApprover(stored)?.name ?? "the account's owner"} can allow use of their account.`);
      await this.dropLog(orgId, "unauthorized", event.conversationKey, "only the account's owner may answer this gate");
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
    // The wake can refuse: a retired/archived assistant throws
    // ArchivedAssistantError from the build (TKAI-296). Every rejection
    // branch in this handler answers the callback — an unanswered one
    // leaves the clicker's channel UI spinning forever — so the wake
    // failure must answer too, not escape to handleUpdate's log-only catch.
    let session: Session;
    try {
      if (workflow?.ok) {
        session = await this.workflowGateSessionFor(mapped.sessionId);
      } else {
        if (!sessionRow) throw new Error("missing session row for channel gate callback");
        const assistant = await loadAssistantBySessionId(this.deps.db, mapped.sessionId);
        session = assistant
          ? await this.deps.engineHost.assistantSessionFor(assistant.id, { actorUserId: userId, orgId }, { sessionId: mapped.sessionId })
          : await this.deps.engineHost.sessionFor(mapped.sessionId, await loadSessionMeta(this.deps.db, sessionRow));
      }
    } catch (err) {
      console.error("[channels] gate resolve wake failed", err);
      await transport?.answerCallback?.(
        gateCallback.callbackId,
        err instanceof ArchivedAssistantError
          ? "This assistant was deleted. The approval no longer applies."
          : "Valet could not process this approval. Open the session in Valet to resolve it.",
      );
      return;
    }
    const gate = (await session.pendingDecisionGates()).find((candidate) => candidate.id === mapped.gateId);
    if (!gate || gate.status !== "pending" || !gate.actions.some((action) => action.id === gateCallback.actionId)) {
      await transport?.answerCallback?.(
        gateCallback.callbackId,
        "This approval was already resolved. Open the session in Valet to see the outcome.",
      );
      return;
    }
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
      deliverTeam: async (event): Promise<void> => {
        if (event.owner.type !== "team") return;
        const transport = this.transports.get("slack");
        if (!transport?.sendToChannel) return;
        const orgId = this.orgId ?? await this.deps.resolveOrgId();
        const [team] = await this.deps.db.select().from(teams)
          .where(and(eq(teams.id, event.owner.id), eq(teams.orgId, orgId))).limit(1);
        if (!team?.slackHomeChannelId) return;
        if (event.sessionId && event.threadId) {
          const thread = await this.deps.engineStore.getThread(event.sessionId, event.threadId);
          // Existing Slack conversations keep their origin. This is only a new-message default.
          if (thread?.key.startsWith("slack:")) return;
        }
        // Channel membership can differ from team membership. Keep sensitive details and
        // approval controls behind the authorized web route.
        const href = event.href ?? `/chat?workspace=${encodeURIComponent(team.id)}`;
        await transport.sendToChannel(team.slackHomeChannelId, {
          markdown: ["A team notification is ready in Valet.", this.openInValetLink(href)].filter(Boolean).join("\n\n"),
        });
      },
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
            if (event.gate && event.sessionId && (await this.mayResolveGateOverDm(event.sessionId, userId, event.gate.id))) {
              await this.sendAndRecordGatePrompt(
                transport,
                conversationKey,
                {
                  gateId: event.gate.id,
                  title: event.title,
                  body: this.attentionBody(event),
                  fields: event.gate.fields,
                  actions: event.gate.actions,
                },
                event.sessionId,
              );
              continue;
            }
            // No gate, a recipient who cannot resolve it, or a lookup that
            // failed: fall through to the plain summary with the web link.
            const sender = event.sessionId
              ? await this.workspaceSenderForSession(event.sessionId)
              : undefined;
            await transport.send(conversationKey, {
              markdown: this.attentionMarkdown(event),
              ...(sender !== undefined ? { sender } : {}),
            });
          } catch (err) {
            console.error(`[channels] ${channelType}: attention delivery failed`, err);
          }
        }
      },
    };
  }

  /**
   * May this recipient resolve the gate on `sessionId`, so the attention DM
   * can carry real buttons?
   *
   * Answering costs two or three reads, and any of them can fail. A failed
   * read costs the buttons, never the message: the caller then sends the
   * plain summary, which carries the web link. Throwing here instead would
   * lose the whole notification for a run that is waiting on it.
   */
  private async mayResolveGateOverDm(sessionId: string, userId: string, gateId: string): Promise<boolean> {
    try {
      const rows = await this.deps.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .limit(1);
      const sessionRow = rows[0];
      if (sessionRow && (await canResolveSessionGate(this.deps.db, sessionRow, userPrincipal(userId)))) {
        return true;
      }
      // A `wf:` id is authorized by its run, the same way the click path
      // authorizes it — a workflow session can also own an app row.
      if (!sessionId.startsWith("wf:")) return false;
      const workflow = await this.authorizeWorkflowGate(
        sessionId,
        this.orgId ?? (await this.deps.resolveOrgId()),
        userId,
        gateId,
      );
      return workflow.ok;
    } catch (err) {
      console.error("[channels] gate DM authorization failed", err);
      return false;
    }
  }

  /** The one composer of the web deep link, shared by every outbound path. */
  private openInValetLink(href: string): string | undefined {
    return this.deps.publicUrl ? `[Open in Valet](${this.deps.publicUrl}${href})` : undefined;
  }

  /** Body-only markdown (no title) for gate prompts, which render the title themselves. */
  private attentionBody(event: AttentionEvent): string | undefined {
    let markdown = event.body ?? "";
    const link = event.href ? this.openInValetLink(event.href) : undefined;
    if (link) markdown += `${markdown ? "\n\n" : ""}${link}`;
    return markdown === "" ? undefined : markdown;
  }

  /**
   * Plain-summary rendering, for events delivered without an interactive
   * prompt. A gate event's digested fields ride along here too: the
   * audience for this path (a recipient who cannot resolve the gate) still
   * needs to see WHAT was requested, and the digested body alone no longer
   * carries the tool id or args.
   */
  private attentionMarkdown(event: AttentionEvent): string {
    const fields = event.gate?.fields?.length
      ? event.gate.fields.map((f) => `**${f.label}:** ${f.value}`).join("\n")
      : undefined;
    const rest = this.attentionBody(event);
    return [`**${event.title}**`, fields, rest].filter((part) => part !== undefined).join("\n\n");
  }
}
