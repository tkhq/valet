import type { CredentialOwner, StoredCredential } from "@valet/engine";
import { and, eq } from "drizzle-orm";
import type { AppQueryable, AppTx } from "../lib/drizzle.js";
import { deriveSecretKey, encryptSecret } from "../lib/secret-crypto.js";
import { credentials, orgMembers, teamMembers, teams } from "../schema/index.js";
import { lockTeamForOwnership } from "./teams.js";

/** Call inside the insertion transaction; retain authority locks until commit. */
export async function lockTeamCredentialAuthority(
  tx: AppTx,
  actor: { orgId: string; userId: string; teamId: string },
): Promise<boolean> {
  // Deletion removes credentials before the team row. Its existing ownership
  // lock prevents an insert after that cleanup but before the team disappears.
  await lockTeamForOwnership(tx, actor.teamId);
  const [team] = await tx.select({ id: teams.id }).from(teams)
    .where(and(eq(teams.id, actor.teamId), eq(teams.orgId, actor.orgId))).for("share");
  if (!team) return false;
  // SHARE blocks role updates as well as membership deletion. The membership
  // writers need no advisory lock: their UPDATE/DELETE conflicts with these rows.
  const [orgMember] = await tx.select({ role: orgMembers.role }).from(orgMembers)
    .where(and(eq(orgMembers.orgId, actor.orgId), eq(orgMembers.userId, actor.userId))).for("share");
  if (!orgMember) return false;
  const [teamMember] = await tx.select({ role: teamMembers.role }).from(teamMembers)
    .where(and(eq(teamMembers.teamId, actor.teamId), eq(teamMembers.userId, actor.userId))).for("share");
  return orgMember.role === "admin" || teamMember?.role === "admin";
}

function encryptedCredentialValues(
  encryptionKey: string, owner: CredentialOwner,
  service: string, credential: StoredCredential,
) {
  const key = deriveSecretKey(encryptionKey);
  const now = Date.now();
  return {
    ownerType: owner.type, ownerId: owner.id, service, type: credential.type,
    accessTokenEnc: credential.accessToken ? encryptSecret(credential.accessToken, key) : null,
    apiKeyEnc: credential.apiKey ? encryptSecret(credential.apiKey, key) : null,
    refreshTokenEnc: credential.refreshToken ? encryptSecret(credential.refreshToken, key) : null,
    expiresAt: credential.expiresAt ?? null, scopes: credential.scopes ?? null,
    metadata: credential.metadata ?? null, createdAt: now, updatedAt: now,
  };
}

/** Caller authorizes the owner; the unique key protects against replacement. */
export async function insertCredentialIfAbsent(
  db: AppQueryable, encryptionKey: string, owner: CredentialOwner,
  service: string, credential: StoredCredential,
): Promise<boolean> {
  const rows = await db.insert(credentials).values(encryptedCredentialValues(encryptionKey, owner, service, credential))
    .onConflictDoNothing().returning({ service: credentials.service });
  return rows.length > 0;
}

/** Preserve legacy replacement semantics inside the authority-lock transaction. */
export async function replaceCredential(
  tx: AppTx, encryptionKey: string, owner: CredentialOwner,
  service: string, credential: StoredCredential,
): Promise<void> {
  const values = encryptedCredentialValues(encryptionKey, owner, service, credential);
  const { createdAt: _createdAt, ...updated } = values;
  await tx.insert(credentials).values(values).onConflictDoUpdate({
    target: [credentials.ownerType, credentials.ownerId, credentials.service],
    set: updated,
  });
}
