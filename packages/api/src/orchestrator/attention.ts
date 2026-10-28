/**
 * Attention router (Phase 4 decision 19). `routeAttention` is the ONLY path
 * that inserts `notifications` rows — wired producers (submission_stuck,
 * child-session decision gates) and any future caller all funnel through
 * here so audience resolution, preference gating, and idempotent insertion
 * stay in one place.
 *
 * Audience resolution (`resolveAudience`) is a pure function over
 * pre-fetched membership, per decision 19: user owner → [userId]; team
 * owner → team members (escalation kind narrows to team admins only); org
 * owner → org admins. `fetchMembership` is the only place that touches the
 * DB for membership — kept separate from `resolveAudience` so the audience
 * matrix is testable without a database.
 *
 * Org-admin resolution: `org_members.role` (admin|member) is the existing
 * column used by admin-gated routes elsewhere in this package — reused here
 * rather than inventing a second admin signal.
 *
 * Preference gating: `user_notification_preferences` (userId, kind, web)
 * gates web delivery and opt-in team DM copies. A missing row enables web
 * delivery and disables team DM copies. Shared home-channel delivery is
 * configured by the team.
 *
 * Idempotent insert: wired producers pass `dedupeKey` (a gate id or queue
 * item id) so the notification row id is deterministic
 * (`n-{kind}-{dedupeKey}-{userId}`) and re-emission (a stuck-alarm pass that
 * fires again, a signal replay after restart) inserts at most once via
 * `onConflictDoNothing` on the primary key. Callers without a natural
 * dedupe key (ad hoc `routeAttention` calls) get a random id — those calls
 * are inherently one-shot, so there's nothing to dedupe against.
 */
import { drainAttentionDeliveries } from "../events/attention-delivery.js";
import { webPresence } from "../services/web-presence.js";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import type { DecisionAction, Principal, SendRef } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { Providers } from "../providers/types.js";
import { governingThreadKey, isPersonalThreadKey, privateThreadOwner, sharedWithWholeTeamSql, SLACK_CHANNELS_METADATA_KEY, threadSlackChannels, threadVisibility } from "../services/thread-access.js";
import { notifications, pendingChannelDeliveries, orgMembers, teamMembers, teams, userNotificationPreferences } from "../schema/index.js";

export type AttentionKind = "notification" | "question" | "escalation" | "approval" | "review" | "platform";
export type AttentionUrgency = "low" | "normal" | "high";

export interface AttentionEvent {
  kind: AttentionKind;
  urgency?: AttentionUrgency;
  owner: Principal;
  actorUserId?: string;
  sessionId?: string;
  /** Origin thread, when attention belongs to an existing conversation. */
  threadId?: string;
  /** The thread key that decides who may see this, when no thread carries
   * it: a workflow run a Slack channel's event started reaches that
   * channel's audience (`slackEventsThreadKey`). */
  audienceKey?: string;
  title: string;
  body?: string;
  href?: string;
  /**
   * Deterministic idempotency key (e.g. a decision gate id or queue item
   * id). When present, the inserted notification row's id is
   * `n-{kind}-{dedupeKey}-{userId}` and a duplicate insert is a no-op.
   * Omit for one-shot events with no natural replay key.
   */
  dedupeKey?: string;
  /** Workflow approval checkpoints are separate from engine decision gates. */
  workflowGate?: { runId: string; nodeId: string; iteration: number; gateId?: string };
  /**
   * Set when the event announces a pending decision gate (`kind:
   * "approval"`). A channel deliverer that can render interactive prompts
   * uses the gate's id and actions to send real approve/deny buttons
   * instead of a plain link; deliverers without that ability ignore this
   * field. The gate lives on `sessionId`.
   */
  gate?: {
    id: string;
    actions: DecisionAction[];
    /** Pre-digested key parameters of the gated action (see `gate-digest.ts`). */
    fields?: Array<{ label: string; value: string }>;
  };
}

/**
 * Narrows a stored owner record to a `Principal`. Ports that persist
 * ownership (the `WorkflowStore`, for one) type `ownerType` as a plain
 * string because they never interpret it, so the value is checked here
 * rather than asserted. An owner this router cannot resolve an audience for
 * — absent, or an unrecognized type — returns `undefined`, and the caller
 * skips the event.
 */
export function principalFromOwner(
  owner: { ownerType: string; ownerId: string } | undefined,
): Principal | undefined {
  if (!owner) return undefined;
  if (owner.ownerType === "user" || owner.ownerType === "team" || owner.ownerType === "org") {
    return { type: owner.ownerType, id: owner.ownerId };
  }
  return undefined;
}

export interface AttentionDeliveryRef extends SendRef {
  channelType: string;
}

export interface AttentionDeliveryAttempt {
  /** Opaque per-row provider token. Never the derived durable row id. */
  deliveryId: string;
  sendingAt: number;
  signal?: AbortSignal;
}

/** A personal delivery tier. Web rows are tier zero. */
export interface AttentionChannelDeliverer {
  /** False when this channel is not configured. Startup is not a disabled channel. */
  enabled?(): boolean;
  /** False while a configured transport is still starting. Do not claim jobs yet. */
  ready?(): boolean;
  /** Local link/preference check only. False drops the job before remote audience checks. */
  recipientEnabled?(userId: string, signal?: AbortSignal): Promise<boolean>;
  /** Stable across restarts. Used in the durable delivery key. */
  id: string;
  order: number;
  /** Each waiting tier adds the recipient's per-kind grace to the ladder. */
  grace: "when-web-active" | "immediate";
  deliver(userId: string, event: AttentionEvent, attempt?: AttentionDeliveryAttempt): Promise<AttentionDeliveryRef[] | void>;
  /** A stale send may have reached the provider. Undefined means resend. */
  reconcile?(userId: string, event: AttentionEvent, attempt: AttentionDeliveryAttempt): Promise<AttentionDeliveryRef[] | undefined>;
  /** One shared destination per event, separate from personal DM copies. */
  deliverTeam?(event: AttentionEvent): Promise<void>;
}

export interface AttentionDeps {
  db: AppDb;
  channels?: AttentionChannelDeliverer[];
  /** Credential access for a private Slack channel's membership check. Without
   * it, producers omit restricted channel audiences; durable drains retry
   * instead of treating missing authorization providers as a permanent denial. */
  access?: Pick<Providers, "engineCredentials"> & { onePassword?: Providers["onePassword"] };
}

/** Membership resolved once by the caller of `resolveAudience` — see module doc. */
export interface Membership {
  teamMembers?: Array<{ userId: string; role: "admin" | "member" }>;
  orgAdmins?: string[];
}

/**
 * Pure audience resolution (decision 19). No DB access — `membership` is
 * pre-fetched by `fetchMembership` (or supplied directly in tests) so the
 * audience matrix is exercised without a database.
 */
export function resolveAudience(owner: Principal, kind: AttentionKind, membership: Membership): string[] {
  if (owner.type === "user") return [owner.id];

  if (owner.type === "team") {
    const members = membership.teamMembers ?? [];
    if (kind === "escalation" || kind === "review") {
      return members.filter((m) => m.role === "admin").map((m) => m.userId);
    }
    return members.map((m) => m.userId);
  }

  // org
  return membership.orgAdmins ?? [];
}

/** Resolves the membership `resolveAudience` needs for `owner`. */
async function fetchMembership(db: AppDb, owner: Principal): Promise<Membership> {
  if (owner.type === "team") {
    const rows = await db
      .select({ userId: teamMembers.userId, role: teamMembers.role })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .innerJoin(orgMembers, and(eq(orgMembers.orgId, teams.orgId), eq(orgMembers.userId, teamMembers.userId)))
      .where(eq(teamMembers.teamId, owner.id));
    return { teamMembers: rows };
  }
  if (owner.type === "org") {
    const rows = await db
      .select({ userId: orgMembers.userId })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, owner.id), eq(orgMembers.role, "admin")));
    return { orgAdmins: rows.map((r) => r.userId) };
  }
  return {};
}

/** Default delay while web delivery is actionable. General updates wait longer. */
export function defaultChannelGraceSeconds(kind: AttentionKind): number {
  return kind === "notification" || kind === "platform" ? 300 : 120;
}

function notificationId(event: AttentionEvent, userId: string): string {
  if (event.dedupeKey) return `n-${event.kind}-${event.dedupeKey}-${userId}`;
  return `n-${event.kind}-${randomUUID()}-${userId}`;
}

/** Escapes LIKE metacharacters for a literal prefix match. Gate ids embed
 * session ids, which routinely contain `_` (`assistant:asst_x:...`) — an
 * unescaped `_` would match any character and could hit another gate's rows. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Marks every recipient's notification for `gateId` read. Called when the
 * gate leaves the pending state (resolved, expired, or withdrawn): the
 * notification exists to get a person to answer the gate, and once the gate
 * is terminal that call to action is void for every recipient — the web dot
 * and bell must stop asking. This mirrors the client stream store, which
 * drops a gate from `pendingGates` on all three terminal frames, and the
 * channel path, which edits its prompt messages with the outcome.
 *
 * The row id is the only place the gate id is recorded
 * (`n-approval-{gateId}-{userId}`, see `notificationId`), hence the prefix
 * match. `n-approval-` is the one kind `decision_gate` events produce
 * (`attention-wiring.ts`); a producer that announces gates under another
 * kind must extend this match too.
 */
export async function markGateNotificationsRead(db: AppDb, gateId: string): Promise<void> {
  return markAttentionNotificationsRead(db, "approval", gateId);
}

export async function markAttentionNotificationsRead(db: AppDb, kind: AttentionKind, dedupeKey: string): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: Date.now() })
    .where(
      and(
        isNull(notifications.readAt),
        like(notifications.id, `n-${kind}-${escapeLike(dedupeKey)}-%`),
      ),
    );
}

/** Enqueue-time audience resolution. Deferred delivery checks only its own recipient. */
export async function attentionAudience(deps: AttentionDeps, event: AttentionEvent): Promise<{ audience: string[]; restricted: boolean }> {
  const membership = await fetchMembership(deps.db, event.owner);
  // A team thread only some members may see (a person's helper or workflow
  // editor thread, or a private Slack channel's) reaches only them: no team
  // channel post, and no other member's inbox or DM (`thread-access.ts`).
  const key = await teamThreadKey(deps.db, event);
  // The Slack channels the event's thread holds content from gate it too.
  const channels = key !== undefined && event.sessionId && event.threadId
    ? await threadSlackChannels(deps.db, event.sessionId, event.threadId) : [];
  const restricted = key !== undefined && !(await isSharedTeamThread(deps.db, event.owner.id, key, channels));
  let audience = resolveAudience(event.owner, event.kind, membership);
  if (restricted) {
    const orgId = await orgOf(deps.db, event.owner);
    const shown = await Promise.all(audience.map((userId) => deps.access && orgId
      ? threadVisibility({ db: deps.db, ...deps.access }, { ownerType: "team" }, { orgId, userId })({ key, metadata: { [SLACK_CHANNELS_METADATA_KEY]: channels } })
      : Promise.resolve(privateThreadOwner(key) === userId)));
    audience = audience.filter((_, i) => shown[i]);
  }
  return { audience, restricted };
}

/** Check one queued recipient. Other members' remote lookups cannot delay this job. */
export async function attentionRecipientAllowed(deps: AttentionDeps, event: AttentionEvent, userId: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (event.owner.type === "user") return event.owner.id === userId;
  const orgId = await orgOf(deps.db, event.owner);
  signal?.throwIfAborted();
  const [member] = await deps.db.select({ role: orgMembers.role }).from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId ?? ""), eq(orgMembers.userId, userId))).limit(1);
  signal?.throwIfAborted();
  if (!member) return false;
  if (event.owner.type === "org") return member.role === "admin";
  const [teamMember] = await deps.db.select({ role: teamMembers.role }).from(teamMembers)
    .where(and(eq(teamMembers.teamId, event.owner.id), eq(teamMembers.userId, userId))).limit(1);
  signal?.throwIfAborted();
  if (!teamMember || ((event.kind === "escalation" || event.kind === "review") && teamMember.role !== "admin")) return false;
  const key = await teamThreadKey(deps.db, event);
  signal?.throwIfAborted();
  if (key === undefined) return true;
  // Helpers and editor conversations are personal even when their metadata names channels.
  const owner = privateThreadOwner(key);
  if (isPersonalThreadKey(key)) return owner === userId;
  const channels = event.sessionId && event.threadId ? await threadSlackChannels(deps.db, event.sessionId, event.threadId) : [];
  signal?.throwIfAborted();
  if (!deps.access || !orgId) {
    const shared = await isSharedTeamThread(deps.db, event.owner.id, key, channels);
    signal?.throwIfAborted();
    if (shared) return true;
    throw new Error("Attention access checks are unavailable. Restore the authorization providers, then retry the job.");
  }
  return threadVisibility({ db: deps.db, ...deps.access }, { ownerType: "team" }, { orgId, userId }, { retryUnknownAccess: true, signal })({ key, metadata: { [SLACK_CHANNELS_METADATA_KEY]: channels } });
}

/** Insert web rows and personal delivery jobs atomically. Shared posts stay immediate. */
export async function routeAttention(deps: AttentionDeps, event: AttentionEvent): Promise<void> {
  const { audience, restricted } = await attentionAudience(deps, event);
  if (audience.length === 0) return;

  for (const ch of deps.channels ?? []) {
    if (event.owner.type === "team" && ch.deliverTeam && !restricted) {
      await ch.deliverTeam(event).catch(err => console.error("attention router: team delivery failed:", err));
    }
  }
  const now = Date.now();
  const tiers = [...(deps.channels ?? [])].sort((a, b) => a.order - b.order);
  const immediate: string[] = [];
  for (const userId of audience) {
    const [preference] = await deps.db.select().from(userNotificationPreferences)
      .where(and(eq(userNotificationPreferences.userId, userId), eq(userNotificationPreferences.kind, event.kind))).limit(1);
    const web = preference?.web ?? true;
    const id = notificationId(event, userId);
    const active = web && webPresence(deps.db).isActive(userId, now);
    const graceMs = (preference?.channelGraceSeconds ?? defaultChannelGraceSeconds(event.kind)) * 1_000;
    await deps.db.transaction(async tx => {
      if (web) {
        await tx.insert(notifications).values({
          id, userId, kind: event.kind, urgency: event.urgency ?? "normal",
          title: event.title, body: event.body ?? null, href: event.href ?? null,
          sessionId: event.sessionId ?? null, createdAt: now, readAt: null,
        }).onConflictDoNothing();
      }
      // Team events and platform notices are web-only unless the member opted in to DM copies; other org-owned kinds keep channel delivery.
      if ((event.owner.type === "team" || event.kind === "platform") && preference?.teamDm !== true) return;
      let deliverAfter = now;
      let previousOrder: number | undefined;
      for (const tier of tiers) {
        if (tier.enabled?.() === false) continue;
        if (active && tier.grace === "when-web-active" && tier.order !== previousOrder) deliverAfter += graceMs;
        previousOrder = tier.order;
        const jobId = JSON.stringify([id, tier.id]);
        const inserted = await tx.insert(pendingChannelDeliveries).values({
          id: jobId, userId, tierId: tier.id, notificationId: web ? id : null, event, createdAt: now, deliverAfter, deliveryToken: randomUUID(),
        }).onConflictDoNothing().returning({ id: pendingChannelDeliveries.id });
        if (inserted.length > 0 && deliverAfter <= now) immediate.push(jobId);
      }
    });
  }
  // Immediate delivery uses the same durable claim as a later dispatcher pass.
  if (immediate.length > 0) void drainAttentionDeliveries(deps, now, immediate)
    .catch(err => console.error("attention immediate drain failed:", err));
}

/** The key that decides who may see a team event's thread, or undefined for
 * any other event. A child's gate is judged by the thread that started it. */
async function teamThreadKey(db: AppDb, event: AttentionEvent): Promise<string | null | undefined> {
  if (event.owner.type !== "team") return undefined;
  if (event.audienceKey !== undefined) return event.audienceKey;
  if (!event.sessionId || !event.threadId) return undefined;
  // The event references a thread; a missing row cannot establish its audience.
  return governingThreadKey(db, event.sessionId, event.threadId, "parent link");
}

/** Whether every member may see a team thread, from stored channel privacy. */
async function isSharedTeamThread(db: AppDb, teamId: string, key: string | null, channels: readonly string[]): Promise<boolean> {
  const orgId = await orgOf(db, { type: "team", id: teamId });
  if (!orgId) return false;
  const result = await db.execute(sql`SELECT ${sharedWithWholeTeamSql(orgId, sql`${key}::text`,
    channels.length > 0 ? sql`ARRAY[${sql.join(channels.map((channel) => sql`${channel}`), sql`, `)}]::text[]` : sql`'{}'::text[]`)} AS shared`) as { rows: Array<{ shared: boolean }> };
  return result.rows[0]?.shared === true;
}

async function orgOf(db: AppDb, owner: Principal): Promise<string | undefined> {
  if (owner.type === "org") return owner.id;
  if (owner.type !== "team") return undefined;
  const [team] = await db.select({ orgId: teams.orgId }).from(teams).where(eq(teams.id, owner.id)).limit(1);
  return team?.orgId;
}
