/** Live authorization for team assistant mentions (TKAI-304/364). */
import { and, eq } from "drizzle-orm";
import type { EventCatalogEntry } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { teams, teamMembers, orgMembers } from "../schema/index.js";
import { identityForExternal } from "../channels/identity-links.js";
import { writeDropLog } from "../orchestrator/signals.js";
import { resolvePath, subscriptionMatchesEvent } from "./match.js";

export function isTeamAssistantMention(
  sub: { ownerType?: string; target?: unknown },
  eventKey: string,
): boolean {
  return eventKey === "slack.app_mention" && sub.ownerType === "team" &&
    typeof sub.target === "object" && sub.target !== null &&
    "kind" in sub.target && sub.target.kind === "orchestrator";
}

/** No identity or membership cache: removal applies to the next match. */
export async function teamMentionActor(
  db: AppDb,
  sub: { orgId: string; ownerId: string },
  payload: unknown,
): Promise<string | null> {
  const externalId = resolvePath(payload, "user");
  const identity = typeof externalId === "string"
    ? await identityForExternal(db, "slack", externalId) : null;
  let reason: string | undefined;
  if (!identity) {
    reason = "unlinked_sender";
  } else {
    if (!(await isCurrentTeamActor(db, sub, identity.userId))) reason = "not_team_member";
  }
  if (reason) {
    await writeDropLog(db, {
      orgId: sub.orgId, reason,
      detail: "Team mention denied. Link the sender's Slack account and check their organization and team memberships.",
    });
    return null;
  }
  return identity?.userId ?? null;
}

/** Shared by ingress and redelivery; the pure predicate alone cannot authorize a team mention. */
export async function authorizedSubscriptionMatchesEvent(
  db: AppDb,
  sub: { orgId: string; ownerId: string; ownerType: string; target: unknown; eventKeys: unknown; filters: unknown },
  eventKey: string,
  payload: unknown,
  catalog: EventCatalogEntry[],
): Promise<boolean> {
  const teamMention = isTeamAssistantMention(sub, eventKey);
  if (!subscriptionMatchesEvent(sub, eventKey, payload, catalog, teamMention)) return false;
  return !teamMention || await teamMentionActor(db, sub, payload) !== null;
}

/** Validate the saved actor against the team's current org and membership. */
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
