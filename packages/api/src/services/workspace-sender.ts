import type { Principal } from "@valet/engine";
import { and, eq } from "drizzle-orm";
import type { Presence } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import { loadLegacyAssistantProfile } from "../assistants/legacy-profile.js";
import { orgs, teams } from "../schema/index.js";

/**
 * The identity a workspace's channel posts use before any workflow,
 * subscription, or action presence applies. A workspace whose assistant was
 * customized before the workspace runtime keeps that name and avatar
 * (`legacy-profile.ts`). Otherwise personal posts use the bot identity and
 * shared posts use the workspace name.
 */
export async function workspaceSenderIdentity(db: AppDb, orgId: string, owner: Principal): Promise<Presence | undefined> {
  try {
    const legacy = await loadLegacyAssistantProfile(db, orgId, owner);
    if (legacy?.name) return { displayName: legacy.name, ...(legacy.avatarUrl ? { avatarUrl: legacy.avatarUrl } : {}) };
    if (owner.type === "user") return legacy?.avatarUrl ? { avatarUrl: legacy.avatarUrl } : undefined;
    const [row] = owner.type === "team"
      ? await db.select({ name: teams.name }).from(teams).where(and(eq(teams.id, owner.id), eq(teams.orgId, orgId))).limit(1)
      : await db.select({ name: orgs.name }).from(orgs).where(and(eq(orgs.id, owner.id), eq(orgs.id, orgId))).limit(1);
    return row?.name ? { displayName: row.name, ...(legacy?.avatarUrl ? { avatarUrl: legacy.avatarUrl } : {}) } : undefined;
  } catch (error) {
    // Display identity is optional; a lookup failure must not lose the message.
    console.error("[workspace-sender] Cannot read the workspace name; using the bot identity.", error);
    return undefined;
  }
}
