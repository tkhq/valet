import { and, asc, eq, gt } from "drizzle-orm";
import type { EventCatalogEntry } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { eventSubscriptions, teams, teamMembers } from "../schema/index.js";
import { isTeamAssistantRule, subscriptionMatchOutcome } from "./team-slack-gate.js";
import { isAssistantKind } from "./target-names.js";

/** Evaluate current team coverage at dispatch, including retries, not symbolic overlap.
 * `event.subjects` comes from the stored event row (spec 2026-10-15: event wakeups,
 * Part G); null/absent (a row stored before that column existed) reads as no
 * subjects, so a team subscription's `subject` filter fails closed for it. */
export async function hasTeamCoverage(
  db: AppDb,
  personal: typeof eventSubscriptions.$inferSelect,
  event: { eventKey: string; payload: unknown; subjects?: string[] | null },
  catalog: EventCatalogEntry[],
): Promise<boolean> {
  const target = personal.target;
  if (personal.ownerType !== "user" || typeof target !== "object" || target === null ||
      !("kind" in target) || !isAssistantKind(target.kind) || !("deliveryPolicy" in target)) return false;
  const policy = target.deliveryPolicy;
  if (policy !== "ignoreIfMyTeamSubscribed" && policy !== "ignoreIfAnyTeamSubscribed") return false;
  let after: string | undefined;
  for (;;) {
    const page = await db.select({ sub: eventSubscriptions }).from(eventSubscriptions)
      .innerJoin(teams, and(eq(teams.id, eventSubscriptions.ownerId), eq(teams.orgId, personal.orgId)))
      .where(and(eq(eventSubscriptions.orgId, personal.orgId), eq(eventSubscriptions.ownerType, "team"),
        eq(eventSubscriptions.enabled, true), after ? gt(eventSubscriptions.id, after) : undefined))
      .orderBy(asc(eventSubscriptions.id)).limit(100);
    for (const { sub } of page) {
      if (!isTeamAssistantRule(sub.ownerType, sub.target)) continue;
      if (policy === "ignoreIfMyTeamSubscribed") {
        const [member] = await db.select({ userId: teamMembers.userId }).from(teamMembers)
          .innerJoin(teams, and(eq(teams.id, teamMembers.teamId), eq(teams.orgId, personal.orgId)))
          .where(and(eq(teamMembers.teamId, sub.ownerId), eq(teamMembers.userId, personal.ownerId))).limit(1);
        if (!member) continue;
      }
      if (await subscriptionMatchOutcome(db, sub, event.eventKey, event.payload, catalog, false, event.subjects ?? []) === "matched") return true;
    }
    if (page.length < 100) return false;
    after = page[page.length - 1]!.sub.id;
  }
}
