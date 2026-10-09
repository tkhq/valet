import type { Principal } from "@valet/engine";
import { and, eq } from "drizzle-orm";
import type { Presence } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import { loadLegacyAssistantProfile } from "../assistants/legacy-profile.js";
import { loadAssistantBySessionId } from "../assistants/service.js";
import { orgs, teams } from "../schema/index.js";

/**
 * The identity a workspace's channel posts use before any workflow,
 * subscription, or action presence applies. A workspace whose assistant was
 * customized before the workspace runtime keeps that name and avatar
 * (`legacy-profile.ts`). Otherwise personal posts use the bot identity and
 * shared posts use the workspace name. `assistantId` names the posting
 * assistant when there is one, so a migration-retained assistant reads its
 * own profile, not the workspace's live assistant's.
 */
export async function workspaceSenderIdentity(db: AppDb, orgId: string, owner: Principal, assistantId?: string): Promise<Presence | undefined> {
  try {
    const legacy = await loadLegacyAssistantProfile(db, orgId, assistantId ? { assistantId } : { owner });
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

/** The base identity for one assistant session's channel posts, or
 * undefined when the session is not an assistant's. */
export async function assistantSessionSender(db: AppDb, sessionId: string): Promise<Presence | undefined> {
  const row = await loadAssistantBySessionId(db, sessionId);
  return row ? workspaceSenderIdentity(db, row.orgId, { type: row.ownerType, id: row.ownerId }, row.id) : undefined;
}
