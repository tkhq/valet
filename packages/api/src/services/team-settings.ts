import { and, eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { teams } from "../schema/index.js";

/** Both settings paths write only the already-authorized team's row in this organization. */
export async function saveTeamSettings(db: AppDb, orgId: string, teamId: string, update: {
  name?: string; defaultModel?: string | null; defaultReasoning?: string | null; slackHomeChannelId?: string | null;
}) {
  return db.update(teams).set(update).where(and(eq(teams.id, teamId), eq(teams.orgId, orgId))).returning();
}
