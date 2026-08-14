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
 * gates web delivery only (this phase ships no other channel). A user with
 * no row for a kind defaults to enabled — the table only ever needs a row
 * for someone who opted OUT.
 *
 * Idempotent insert: wired producers pass `dedupeKey` (a gate id or queue
 * item id) so the notification row id is deterministic
 * (`n-{kind}-{dedupeKey}-{userId}`) and re-emission (a stuck-alarm pass that
 * fires again, a signal replay after restart) inserts at most once via
 * `onConflictDoNothing` on the primary key. Callers without a natural
 * dedupe key (ad hoc `routeAttention` calls) get a random id — those calls
 * are inherently one-shot, so there's nothing to dedupe against.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { notifications, orgMembers, teamMembers, userNotificationPreferences } from "../schema/index.js";

export type AttentionKind = "notification" | "question" | "escalation" | "approval";
export type AttentionUrgency = "low" | "normal" | "high";

export interface AttentionEvent {
  kind: AttentionKind;
  urgency?: AttentionUrgency;
  owner: Principal;
  actorUserId?: string;
  sessionId?: string;
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

/** Best-effort per-recipient channel delivery (e.g. Telegram DM). Must never throw. */
export interface AttentionChannelDeliverer {
  deliver(userId: string, event: AttentionEvent): Promise<void>;
}

export interface AttentionDeps {
  db: AppDb;
  channels?: AttentionChannelDeliverer[];
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
    if (kind === "escalation") {
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

/** Web-delivery preference for `userId`/`kind`. Default enabled when no row exists. */
async function isWebEnabled(db: AppDb, userId: string, kind: AttentionKind): Promise<boolean> {
  const rows = await db
    .select({ web: userNotificationPreferences.web })
    .from(userNotificationPreferences)
    .where(and(eq(userNotificationPreferences.userId, userId), eq(userNotificationPreferences.kind, kind)))
    .limit(1);
  const row = rows[0];
  if (!row) return true;
  return row.web;
}

function notificationId(event: AttentionEvent, userId: string): string {
  if (event.dedupeKey) return `n-${event.kind}-${event.dedupeKey}-${userId}`;
  return `n-${event.kind}-${randomUUID()}-${userId}`;
}

/**
 * Resolves the audience for `event.owner`, gates each recipient by their
 * web preference for `event.kind`, and inserts one `notifications` row per
 * surviving recipient. Channel deliverers (`deps.channels`) additionally
 * fire per recipient, independent of the web preference — that pref governs
 * web notifications only.
 */
export async function routeAttention(deps: AttentionDeps, event: AttentionEvent): Promise<void> {
  const membership = await fetchMembership(deps.db, event.owner);
  const audience = resolveAudience(event.owner, event.kind, membership);
  if (audience.length === 0) return;

  const now = Date.now();
  for (const userId of audience) {
    if (await isWebEnabled(deps.db, userId, event.kind)) {
      await deps.db
        .insert(notifications)
        .values({
          id: notificationId(event, userId),
          userId,
          kind: event.kind,
          urgency: event.urgency ?? "normal",
          title: event.title,
          body: event.body ?? null,
          href: event.href ?? null,
          sessionId: event.sessionId ?? null,
          createdAt: now,
          readAt: null,
        })
        .onConflictDoNothing();
    }

    for (const ch of deps.channels ?? []) {
      void ch.deliver(userId, event).catch((err) => {
        console.error("attention router: channel deliverer failed:", err);
      });
    }
  }
}
