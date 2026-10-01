/** Live authorization for team assistant mentions (TKAI-304/364), under the
 * audience the subscription carries. */
import { and, eq, sql } from "drizzle-orm";
import type { EventCatalogEntry } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { eventSubscriptions, teams, teamMembers, orgMembers, users } from "../schema/index.js";
import { identityForExternal } from "../channels/identity-links.js";
import { writeDropLog } from "../orchestrator/signals.js";
import { resolvePath, subscriptionMatchesEvent } from "./match.js";
import { isOrgMember } from "../services/org.js";

/**
 * A Slack sender who is a full member of the connected workspace, with their
 * email, or null. Boot sets it from the channel host
 * (`setSlackWorkspaceMemberCheck`); the gate is called from ingest, delivery
 * policy, the dispatcher, and the follow router, so one setter replaces a
 * dependency on each. Unset, no sender qualifies.
 */
let slackWorkspaceMember: (userId: string) => Promise<{ email?: string } | null> = async () => null;
export function setSlackWorkspaceMemberCheck(check: (userId: string) => Promise<{ email?: string } | null>): void {
  slackWorkspaceMember = check;
}

/**
 * Who an unlinked Slack sender is. A full workspace member whose email
 * belongs to a member of this Valet org is that person, so removing a Slack
 * link changes nothing about what they may do. A full member with no Valet
 * account is a `newcomer`. Anyone else, including a member whose email Slack
 * does not give, is null.
 */
async function unlinkedSender(db: AppDb, orgId: string, externalId: string): Promise<{ userId: string } | "newcomer" | null> {
  const member = await slackWorkspaceMember(externalId);
  if (!member?.email) return null;
  const [user] = await db.select({ id: users.id }).from(users)
    .innerJoin(orgMembers, and(eq(orgMembers.userId, users.id), eq(orgMembers.orgId, orgId)))
    .where(sql`lower(${users.email}) = lower(${member.email})`).limit(1);
  return user ? { userId: user.id } : "newcomer";
}

/**
 * Who may invoke a team assistant by mention. `team` is the owning team's
 * current members; `organization` is any current member of the organization
 * that owns the team. The audience decides invocation only: the rule still
 * runs as the team's assistant, with the sender as the actor, and it grants
 * that sender nothing else. Session access stays with the team
 * (`services/session-access.ts`).
 */
export type MentionAudience = "team" | "organization";

/** The audience a stored row carries. Null and an unknown value read as
 * `team`, the meaning of every row written before the column existed. */
export function mentionAudience(sub: { audience?: string | null }): MentionAudience {
  return sub.audience === "organization" ? "organization" : "team";
}

/**
 * The audience that governs a followed thread right now. The audience is the
 * RULE's state, not the conversation's: a rule narrowed back to the team must
 * narrow every thread it opened, and a rule widened to the organization must
 * widen them. So the binding rule's current row decides.
 *
 * A rule that is disabled or deleted resolves to `team`, the narrow reading.
 * Turning a rule off is how a person stops it, and it must not leave
 * organization-wide invocation alive in the threads that rule opened. The
 * thread itself survives: the owning team's members continue it.
 *
 * A follow that names no rule reads as `team` for the same reason. That is
 * every follow bound before the column existed.
 */
export async function followedThreadAudience(
  db: AppDb,
  follow: { orgId: string; subscriptionId?: string | null },
): Promise<MentionAudience> {
  if (!follow.subscriptionId) return "team";
  const [rule] = await db
    .select({ audience: eventSubscriptions.audience, enabled: eventSubscriptions.enabled })
    .from(eventSubscriptions)
    .where(and(
      eq(eventSubscriptions.id, follow.subscriptionId),
      eq(eventSubscriptions.orgId, follow.orgId),
    ))
    .limit(1);
  return rule?.enabled === true ? mentionAudience(rule) : "team";
}

/**
 * Whether a subscription is a TEAM ASSISTANT rule: a team's own assistant
 * answers it. The one definition, shared by the runtime gate below and the
 * write gate (`mention-scope.ts`), so the rows that carry an invocation
 * audience are exactly the rows the audience governs at match time.
 *
 * `ownerType` is the stored owner where there is one. On a create there is
 * not: the route derives the owner FROM the target, so an undefined owner
 * falls back to the target's own `orchestrator: "team"`. A stored row needs
 * no such field — the route only ever stamps team ownership on a team
 * orchestrator target, and rows written before that field existed carry the
 * team owner alone.
 */
export function isTeamAssistantRule(ownerType: string | undefined, target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  if (!("kind" in target) || target.kind !== "orchestrator") return false;
  if (ownerType !== undefined) return ownerType === "team";
  return "orchestrator" in target && target.orchestrator === "team";
}

export function isTeamAssistantMention(
  sub: { ownerType?: string; target?: unknown },
  eventKey: string,
): boolean {
  return eventKey === "slack.app_mention" && isTeamAssistantRule(sub.ownerType, sub.target);
}

/** No identity or membership cache: removal applies to the next match. */
export async function teamMentionActor(
  db: AppDb,
  sub: { orgId: string; ownerId: string; audience?: string | null; createdBy?: string },
  payload: unknown,
  logDenied = true,
): Promise<string | null> {
  const audience = mentionAudience(sub);
  const externalId = resolvePath(payload, "user");
  const identity = typeof externalId === "string"
    ? await identityForExternal(db, "slack", externalId) : null;
  let reason: string | undefined;
  if (!identity) {
    reason = "unlinked_sender";
  } else if (audience === "organization") {
    if (!(await isCurrentOrgActor(db, sub, identity.userId))) reason = "not_org_member";
  } else if (!(await isCurrentTeamActor(db, sub, identity.userId))) {
    reason = "not_team_member";
  }
  // An unlinked sender who is a Valet org member is judged as that member.
  // A full Slack workspace member with no Valet account runs as the person
  // who set the channel up, while that person still has access; approvals
  // still apply. Guests and other organizations' users are refused.
  if (reason === "unlinked_sender" && typeof externalId === "string") {
    const sender = await unlinkedSender(db, sub.orgId, externalId);
    const actor = sender === "newcomer" ? sub.createdBy : sender?.userId;
    if (actor && (audience === "organization" ? await isCurrentOrgActor(db, sub, actor) : await isCurrentTeamActor(db, sub, actor))) return actor;
  }
  if (reason) {
    if (logDenied) {
      await writeDropLog(db, {
        orgId: sub.orgId, reason,
        detail: audience === "organization"
          ? "Team mention denied. Link the sender's Slack account and check their organization membership."
          : "Team mention denied. Link the sender's Slack account and check their organization and team memberships.",
      });
    }
    return null;
  }
  return identity?.userId ?? null;
}

/**
 * Applies the team Slack sender gate before a diagnostic retains payload-derived
 * metadata. This does not change event delivery. It guards the bot-message
 * classifier near-miss, which has no normalized app-mention event.
 */
export async function authorizedSlackDiagnosticSubscription(
  db: AppDb,
  sub: { orgId: string; ownerId: string; ownerType: string; target: unknown; audience?: string | null; createdBy?: string },
  payload: unknown,
  logDenied = true,
): Promise<boolean> {
  return !isTeamAssistantRule(sub.ownerType, sub.target) || await teamMentionActor(db, sub, payload, logDenied) !== null;
}

export type SubscriptionMatchOutcome = "matched" | "not_matched" | "authorization_denied";

/** Separates a filter miss from a team-sender denial so ingest cannot retain a
 * denied sender's payload as a filter diagnostic. */
export async function subscriptionMatchOutcome(
  db: AppDb,
  sub: {
    orgId: string; ownerId: string; ownerType: string; target: unknown;
    eventKeys: unknown; filters: unknown; audience?: string | null; createdBy?: string;
  },
  eventKey: string,
  payload: unknown,
  catalog: EventCatalogEntry[],
): Promise<SubscriptionMatchOutcome> {
  const teamMention = isTeamAssistantMention(sub, eventKey);
  if (!subscriptionMatchesEvent(sub, eventKey, payload, catalog, teamMention)) return "not_matched";
  if (!teamMention || await teamMentionActor(db, sub, payload) !== null) return "matched";
  return "authorization_denied";
}

/** Shared by ingress and redelivery; the pure predicate alone cannot authorize a team mention. */
export async function authorizedSubscriptionMatchesEvent(
  db: AppDb,
  sub: {
    orgId: string; ownerId: string; ownerType: string; target: unknown;
    eventKeys: unknown; filters: unknown; audience?: string | null;
  },
  eventKey: string,
  payload: unknown,
  catalog: EventCatalogEntry[],
): Promise<boolean> {
  return (await subscriptionMatchOutcome(db, sub, eventKey, payload, catalog)) === "matched";
}

/** Validate the saved actor against the team's current org and membership.
 * The `team` audience, and a followed thread bound under it. A follow bound
 * under the organization audience re-checks `isCurrentOrgActor` instead. */
export async function isCurrentTeamActor(
  db: AppDb,
  scope: { orgId: string; ownerId: string },
  userId: string,
): Promise<boolean> {
  const [team] = await db.select({ id: teams.id }).from(teams)
    .innerJoin(teamMembers, and(eq(teamMembers.teamId, teams.id), eq(teamMembers.userId, userId)))
    .innerJoin(orgMembers, and(eq(orgMembers.orgId, teams.orgId), eq(orgMembers.userId, userId)))
    .where(and(eq(teams.id, scope.ownerId), eq(teams.orgId, scope.orgId))).limit(1);
  return team !== undefined;
}

/**
 * The organization-audience counterpart of `isCurrentTeamActor`: the sender
 * must be a current member of the organization that owns the team, but not of
 * the team. The team must still belong to the event's organization, so a team
 * moved to another organization stops matching here as well.
 */
export async function isCurrentOrgActor(
  db: AppDb,
  scope: { orgId: string; ownerId: string },
  userId: string,
): Promise<boolean> {
  const [team] = await db.select({ id: teams.id }).from(teams)
    .innerJoin(orgMembers, and(eq(orgMembers.orgId, teams.orgId), eq(orgMembers.userId, userId)))
    .where(and(eq(teams.id, scope.ownerId), eq(teams.orgId, scope.orgId))).limit(1);
  return team !== undefined;
}

/**
 * Whether a followed thread's CURRENT binding still authorizes its actor —
 * the membership its rule's audience requires, read live.
 *
 * Two readers need this one answer. The follow router asks it before it
 * delivers an unmentioned message. The dispatcher asks it before a re-mention
 * on an already-bound thread: a binding that authorizes nobody any more must
 * not survive a mention that does.
 */
export async function followBindingAuthorized(
  db: AppDb,
  follow: { orgId: string; ownerType: string; ownerId: string; createdBy: string; subscriptionId?: string | null },
): Promise<boolean> {
  if (follow.ownerType !== "team") return true;
  const audience = await followedThreadAudience(db, follow);
  return audience === "organization"
    ? isCurrentOrgActor(db, follow, follow.createdBy)
    : isCurrentTeamActor(db, follow, follow.createdBy);
}

/**
 * Who a message in a followed thread runs as: the sender when they are a
 * linked user the binding admits. In a team thread, an unlinked full member
 * of the Slack workspace runs as the person who bound the thread, while the
 * binding still admits them. Approvals still apply.
 */
export async function followedMessageActor(
  db: AppDb,
  follow: { orgId: string; ownerType: string; ownerId: string; createdBy: string; subscriptionId?: string | null },
  externalId: string | undefined,
): Promise<string | null> {
  const admits = async (userId: string): Promise<boolean> => {
    if (!(await isOrgMember(db, follow.orgId, userId))) return false;
    if (follow.ownerType === "user") return userId === follow.ownerId;
    if (follow.ownerType === "org") return follow.ownerId === follow.orgId;
    if (follow.ownerType !== "team") return false;
    return followBindingAuthorized(db, { ...follow, createdBy: userId });
  };
  // A message with no sender, such as another app's post, never routes.
  if (!externalId) return null;
  const identity = await identityForExternal(db, "slack", externalId);
  if (identity) return await admits(identity.userId) ? identity.userId : null;
  // Only a team thread answers an unlinked sender. One who is a Valet org
  // member is judged as that member; a full Slack workspace member with no
  // Valet account runs as the person who bound the thread. A personal thread
  // never runs another person's message as its owner.
  if (follow.ownerType !== "team") return null;
  const sender = await unlinkedSender(db, follow.orgId, externalId);
  const actor = sender === "newcomer" ? follow.createdBy : sender?.userId;
  return actor && await admits(actor) ? actor : null;
}
