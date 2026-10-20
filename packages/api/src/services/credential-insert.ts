import type { CredentialOwner, StoredCredential } from "@valet/engine";
import { and, eq } from "drizzle-orm";
import type { AppQueryable, AppTx } from "../lib/drizzle.js";
import { deriveSecretKey, encryptSecret } from "../lib/secret-crypto.js";
import { credentials, orgMembers, teamMembers, teams } from "../schema/index.js";
import { fromJsonbColumn } from "@valet/store-postgres";
import { lockTeamForOwnership } from "./teams.js";
import { isDeadConnection } from "./credential-resolution.js";

/**
 * The caller's authority over a team's credentials: "admin" for an
 * organization or team admin, "member" for another member of the team, and
 * null otherwise. Call inside the write transaction; the locks it takes hold
 * until commit.
 */
export async function lockTeamCredentialRole(
  tx: AppTx,
  actor: { orgId: string; userId: string; teamId: string },
): Promise<"admin" | "member" | null> {
  // Deletion removes credentials before the team row. Its existing ownership
  // lock prevents an insert after that cleanup but before the team disappears.
  await lockTeamForOwnership(tx, actor.teamId);
  const [team] = await tx.select({ id: teams.id }).from(teams)
    .where(and(eq(teams.id, actor.teamId), eq(teams.orgId, actor.orgId))).for("share");
  if (!team) return null;
  // SHARE blocks role updates as well as membership deletion. The membership
  // writers need no advisory lock: their UPDATE/DELETE conflicts with these rows.
  const [orgMember] = await tx.select({ role: orgMembers.role }).from(orgMembers)
    .where(and(eq(orgMembers.orgId, actor.orgId), eq(orgMembers.userId, actor.userId))).for("share");
  if (!orgMember) return null;
  const [teamMember] = await tx.select({ role: teamMembers.role }).from(teamMembers)
    .where(and(eq(teamMembers.teamId, actor.teamId), eq(teamMembers.userId, actor.userId))).for("share");
  if (orgMember.role === "admin" || teamMember?.role === "admin") return "admin";
  return teamMember ? "member" : null;
}

async function teamConnectionRow(db: AppQueryable, teamId: string, service: string, lock: boolean) {
  const query = db.select({ type: credentials.type, expiresAt: credentials.expiresAt, metadata: credentials.metadata })
    .from(credentials)
    .where(and(eq(credentials.ownerType, "team"), eq(credentials.ownerId, teamId), eq(credentials.service, service)));
  const [row] = lock ? await query.for("update") : await query;
  return row ? { ...row, metadata: fromJsonbColumn<Record<string, unknown>>(row.metadata) } : undefined;
}

/** True when the team's connection for `service` is dead (`isDeadConnection`). */
export async function teamConnectionIsDead(db: AppQueryable, teamId: string, service: string, now: number): Promise<boolean> {
  const row = await teamConnectionRow(db, teamId, service, false);
  return row !== undefined && isDeadConnection(row, now);
}

/**
 * Replaces the team's dead connection. The row is locked and checked again,
 * so a connection that someone repaired while the caller signed in is kept.
 * Call inside the transaction that holds `lockTeamCredentialRole`.
 */
export async function replaceDeadTeamCredential(
  tx: AppTx, encryptionKey: string, teamId: string,
  service: string, credential: StoredCredential, now: number,
): Promise<boolean> {
  const row = await teamConnectionRow(tx, teamId, service, true);
  if (!row || !isDeadConnection(row, now)) return false;
  await replaceCredential(tx, encryptionKey, { type: "team", id: teamId }, service, credential);
  return true;
}

/**
 * Replaces the team's connection with one that holds more scopes (step-up
 * after an `insufficient_scope` answer). Any member may do this, as for a
 * dead connection: the new row holds the signing-in member's account. A
 * connection removed while the member signed in is not restored. Call inside
 * the transaction that holds `lockTeamCredentialRole`.
 */
export async function replaceTeamCredentialForStepUp(
  tx: AppTx, encryptionKey: string, teamId: string,
  service: string, credential: StoredCredential,
): Promise<boolean> {
  const row = await teamConnectionRow(tx, teamId, service, true);
  if (!row) return false;
  await replaceCredential(tx, encryptionKey, { type: "team", id: teamId }, service, credential);
  return true;
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
