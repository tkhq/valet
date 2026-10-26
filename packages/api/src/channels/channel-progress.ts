import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { ChannelProgressRejectedError, readTurnProgress, type ChannelTransport, type DeliveredBusEvent, type EventStream, type QueueItem, type SessionStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { channelProgressDeliveries as deliveries, type ChannelProgressDeliveryRow } from "../schema/index.js";

type Progress = NonNullable<Awaited<ReturnType<typeof readTurnProgress>>>;
export type ProgressTransport = Pick<ChannelTransport,
  "publishProgress" | "conversationKeyFromThreadKey" | "threadKeyFromConversationKey">;
export const CHANNEL_PROGRESS_PAGE_SIZE = 50;
export const CHANNEL_PROGRESS_MAX_ATTEMPTS = 8;
const LEASE_MS = 60_000;
const REFRESH_MS = 2_000;
const terminal = (progress: Progress) => ["complete", "error", "interrupted"].includes(progress.status);
export const channelProgressRetryDelay = (attempts: number) => Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1));

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Authorization policy: a non-signal channel prompt authorizes its channel.
 * Signals authorize their origin only when reply=auto, or after a completed
 * origin-channel reply_to_origin call in this turn (result.details.ok=true).
 * Missing reply policy means manual. Neither replyTarget, author flags,
 * mutable thread bindings, unrelated posting tools, nor failed replies
 * authorize progress.
 */
export async function resolveProgressDestination(store: SessionStore, sessionId: string, item: QueueItem,
  transportFor: (channelType: string) => ProgressTransport | undefined,
): Promise<{ channelType: string; conversationKey: string; threadTs: string } | null> {
  const signal = typeof item.content === "object" && "kind" in item.content && item.content.kind === "signal" ? item.content : undefined;
  if (!signal) {
    const target = item.channel;
    if (!target) return null;
    const threadKey = transportFor(target.channelType)?.threadKeyFromConversationKey?.(target.channelId);
    const threadTs = target.threadId ?? threadKey?.split(":").at(-1);
    if (!threadTs) return null;
    return { channelType: target.channelType, conversationKey: target.channelId, threadTs };
  }
  const origin = signal.origin;
  if (!origin) return null;
  if (origin.reply !== "auto") {
    const entries = await store.getEntries(sessionId, item.threadId, { queueItemId: item.id, includeCompacted: true, includeSystemEntries: true });
    const replied = entries.some(entry => entry.type === "message" && entry.role === "assistant" && entry.queueItemId === item.id &&
      entry.parts?.some(part => part.type === "tool_call" && part.status === "completed" && record(part.args) &&
        part.args.tool_id === `${origin.channelType}.reply_to_origin` && record(part.result) &&
        record(part.result.details) && part.result.details.ok === true));
    if (!replied) return null;
  }
  const conversationKey = transportFor(origin.channelType)?.conversationKeyFromThreadKey?.(origin.threadKey);
  if (!conversationKey) return null;
  // Host thread keys end in the native root. Direct targets can provide
  // an explicit root or a transport mapping. Empty roots do not authorize a send.
  const threadTs = origin.threadKey.split(":").at(-1);
  if (!threadTs) return null;
  return { channelType: origin.channelType, conversationKey, threadTs };
}

/** Durable, provider-neutral publisher. No remote calls occur before intent creation. */
export class ChannelProgressPublisher {
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private running?: Promise<void>;
  private recovering?: Promise<void>;
  private readonly pending = new Map<string, { sessionId: string; turnId: string }>();
  private recoveryCursor = "";

  constructor(private readonly deps: {
    db: AppDb; engineStore: SessionStore; eventStream?: EventStream;
    resolveOrgId(): Promise<string>;
    transportFor(channelType: string): ProgressTransport | undefined;
    now?: () => number;
    readProgress?: typeof readTurnProgress;
    onError?: (error: unknown) => void;
  }) {}

  private now() { return this.deps.now?.() ?? Date.now(); }
  private report = (error: unknown) => {
    if (this.deps.onError) this.deps.onError(error);
    else console.error("[channels] progress publisher failed", error);
  };

  start(): void {
    if (this.timer) return;
    this.unsubscribe = this.deps.eventStream?.subscribe({ eventTypes: ["queue_state", "tool_start", "tool_end", "message_end",
      "decision_gate", "decision_gate_resolved", "decision_gate_expired", "decision_gate_withdrawn", "submission_settled"] }, event => this.observe(event));
    this.timer = setInterval(() => { void this.poll().catch(this.report); }, REFRESH_MS);
    this.timer.unref?.();
    void this.poll().catch(this.report);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.running;
    await this.recovering;
  }

  /** Coalesce hints, never trust event revisions or destinations. Durable state wins. */
  observe(event: DeliveredBusEvent): void {
    const e = event.event;
    const ids = new Set<string>();
    if (event.queueItemId) ids.add(event.queueItemId);
    if ("queueItemId" in e && typeof e.queueItemId === "string") ids.add(e.queueItemId);
    if (e.type === "decision_gate") ids.add(e.gate.queueItemId);
    if (e.type === "queue_state") {
      if (e.state.activeItemId) ids.add(e.state.activeItemId);
      for (const item of [...e.state.pending, ...(e.state.collectBuffer ?? [])]) ids.add(item.id);
    }
    // Bounded memory: overflow is recovered by the durable queue scan.
    for (const turnId of ids) {
      if (this.pending.size >= 1_000) break;
      this.pending.set(JSON.stringify([event.sessionId, turnId]), { sessionId: event.sessionId, turnId });
    }
  }

  /** Persist an authorized intent, scoped by authenticated organization and immutable turn. */
  async track(sessionId: string, turnId: string): Promise<void> {
    const orgId = await this.deps.resolveOrgId();
    const session = await this.deps.engineStore.getSession(sessionId);
    if (session?.orgId !== orgId) return;
    const item = await this.deps.engineStore.getQueueItem(sessionId, turnId);
    if (!item) return;
    const destination = await resolveProgressDestination(this.deps.engineStore, sessionId, item, this.deps.transportFor);
    if (!destination || !this.deps.transportFor(destination.channelType)?.publishProgress) return;
    const id = JSON.stringify([orgId, sessionId, item.threadId, turnId, destination.channelType, destination.conversationKey]);
    await this.deps.db.insert(deliveries).values({ id, orgId, sessionId, threadId: item.threadId, turnId, ...destination })
      .onConflictDoNothing();
  }

  /** One keyset page per call discovers unfinished turns; the ledger recovers terminal deliveries. */
  recover(): Promise<void> {
    if (this.recovering) return this.recovering;
    this.recovering = this.recoverPage().finally(() => { this.recovering = undefined; });
    return this.recovering;
  }

  private async recoverPage(): Promise<void> {
    const orgId = await this.deps.resolveOrgId();
    const result = await this.deps.db.execute(sql`
      SELECT q.id, q.session_id FROM engine_queue_items q JOIN engine_sessions s ON s.id=q.session_id
      WHERE s.org_id=${orgId} AND q.status <> 'settled' AND q.id > ${this.recoveryCursor}
      ORDER BY q.id LIMIT ${CHANNEL_PROGRESS_PAGE_SIZE}`);
    if (!record(result) || !Array.isArray(result.rows)) throw new Error("Invalid progress recovery query result");
    let cursor = "";
    for (const row of result.rows) {
      if (!record(row) || typeof row.id !== "string" || typeof row.session_id !== "string") throw new Error("Invalid progress recovery row");
      try { await this.track(row.session_id, row.id); } catch (error) { this.report(error); }
      cursor = row.id;
    }
    this.recoveryCursor = result.rows.length === CHANNEL_PROGRESS_PAGE_SIZE ? cursor : "";
  }

  /** One bounded discovery and delivery pass; all sends are serialized in this instance. */
  poll(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async run(): Promise<void> {
    for (const [key, hint] of [...this.pending].slice(0, CHANNEL_PROGRESS_PAGE_SIZE)) {
      this.pending.delete(key);
      try { await this.track(hint.sessionId, hint.turnId); } catch (error) { this.report(error); }
    }
    await this.recover();
    const orgId = await this.deps.resolveOrgId();
    const due = and(eq(deliveries.orgId, orgId), isNull(deliveries.completedAt), isNull(deliveries.failedAt),
      lte(deliveries.nextAttemptAt, this.now()), lte(deliveries.leaseUntil, this.now()));
    const rows = await this.deps.db.select().from(deliveries).where(due)
      .orderBy(asc(deliveries.nextAttemptAt), asc(deliveries.id)).limit(CHANNEL_PROGRESS_PAGE_SIZE);
    for (const candidate of rows) {
      const token = randomUUID();
      const [row] = await this.deps.db.update(deliveries).set({ leaseToken: token, leaseUntil: this.now() + LEASE_MS })
        .where(and(due, eq(deliveries.id, candidate.id))).returning();
      if (row) await this.deliver(row, token);
    }
  }

  private async deliver(row: ChannelProgressDeliveryRow, token: string): Promise<void> {
    const owned = and(eq(deliveries.id, row.id), eq(deliveries.orgId, row.orgId), eq(deliveries.leaseToken, token));
    // Renew while a provider request is in flight. Every write is fenced by
    // this claim's random token; a process that lost its lease cannot commit.
    const heartbeat = setInterval(() => {
      void this.deps.db.update(deliveries).set({ leaseUntil: this.now() + LEASE_MS }).where(owned).catch(this.report);
    }, LEASE_MS / 3);
    heartbeat.unref?.();
    try {
      const session = await this.deps.engineStore.getSession(row.sessionId);
      if (session?.orgId !== row.orgId || await this.deps.resolveOrgId() !== row.orgId) throw new Error("Progress organization mismatch");
      const item = await this.deps.engineStore.getQueueItem(row.sessionId, row.turnId);
      if (!item || item.threadId !== row.threadId) throw new Error("Progress turn missing or moved");
      const destination = await resolveProgressDestination(this.deps.engineStore, row.sessionId, item, this.deps.transportFor);
      if (destination?.channelType !== row.channelType || destination.conversationKey !== row.conversationKey)
        throw new Error("Progress destination no longer authorized");
      const progress = await (this.deps.readProgress ?? readTurnProgress)(this.deps.engineStore, row.sessionId, row.threadId, row.turnId);
      if (!progress) throw new Error("Progress unavailable");
      const transport = this.deps.transportFor(row.channelType);
      if (!transport?.publishProgress) throw new Error("Progress transport unavailable");
      // Only a plan gets a card, as on the web. A turn without one shows
      // the transport's working status. A card already posted keeps updating.
      if (!progress.planned && !row.messageId && !row.createStarted) {
        await this.deps.db.update(deliveries).set({ nextAttemptAt: this.now() + REFRESH_MS,
          completedAt: terminal(progress) ? this.now() : null }).where(owned);
        return;
      }
      if (row.lastRevision === progress.revision) {
        await this.deps.db.update(deliveries).set({ nextAttemptAt: this.now() + REFRESH_MS,
          completedAt: terminal(progress) ? this.now() : null }).where(owned);
        return;
      }
      const options = { threadTs: row.threadTs ?? destination.threadTs, idempotencyKey: row.id };
      let messageId = row.messageId;
      if (!messageId && row.createStarted) {
        const [claim] = await this.deps.db.update(deliveries).set({ leaseUntil: this.now() + LEASE_MS })
          .where(and(owned, sql`${deliveries.leaseUntil} > ${this.now()}`)).returning({ id: deliveries.id });
        if (!claim) return;
        // Null is NOT permission to create: an earlier create may still land.
        const recovered = await transport.publishProgress(row.conversationKey, progress, { ...options, recoverOnly: true });
        if (!recovered) throw new Error("Progress creation uncertain; recovery found no message");
        messageId = recovered.messageId;
        await this.deps.db.update(deliveries).set({ messageId }).where(owned);
      }
      // Commit the uncertainty marker BEFORE invoking the provider.
      const [claim] = await this.deps.db.update(deliveries).set({ createStarted: true })
        .where(and(owned, sql`${deliveries.leaseUntil} > ${this.now()}`)).returning({ id: deliveries.id });
      if (!claim) return;
      let sent: { messageId: string } | null;
      try {
        sent = await transport.publishProgress(row.conversationKey, progress, { ...options, messageId: messageId ?? undefined });
      } catch (error) {
        // Only a definitive rejection of this first create proves no native
        // message exists. Recovery and known-message failures remain uncertain.
        if (error instanceof ChannelProgressRejectedError && !row.messageId && !messageId && !row.createStarted) {
          await this.deps.db.update(deliveries).set({ createStarted: false })
            .where(and(owned, isNull(deliveries.messageId), sql`${deliveries.leaseUntil} > ${this.now()}`));
        }
        throw error;
      }
      if (!sent?.messageId) throw new Error("Progress provider returned no message");
      await this.deps.db.update(deliveries).set({ messageId: sent.messageId, lastRevision: progress.revision,
        attempts: 0, lastError: null, nextAttemptAt: this.now() + REFRESH_MS,
        completedAt: terminal(progress) ? this.now() : null }).where(owned);
    } catch (error) {
      const attempts = row.attempts + 1;
      await this.deps.db.update(deliveries).set({ attempts, lastError: error instanceof Error ? error.message.slice(0, 500) : "Progress delivery failed",
        nextAttemptAt: this.now() + channelProgressRetryDelay(attempts),
        failedAt: attempts >= CHANNEL_PROGRESS_MAX_ATTEMPTS ? this.now() : null }).where(owned);
    } finally {
      clearInterval(heartbeat);
      await this.deps.db.update(deliveries).set({ leaseToken: null, leaseUntil: 0 }).where(owned);
    }
  }
}
