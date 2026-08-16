/**
 * Org service — org membership, feature gate, and org-scoped settings
 * (split-settings design). `org_members.role` is the real authz source for
 * "is this user an admin of this org"; `users.role` remains the global
 * *operator* gate for `/api/admin` only (see `requireOrgAdmin`'s doc
 * comment on the routes that use it).
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ValidationError } from "@valet/shared";
import type { AppDb, AppQueryable } from "../lib/drizzle.js";
import { orgMembers, orgs, users } from "../schema/index.js";
import type { SourceService } from "../bakes/source-service.js";

export type OrgRole = "admin" | "member";

export interface OrgFeatures {
  organizations: boolean;
}

export interface OrgMemberSummary {
  userId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: OrgRole;
  joinedAt: number;
}

export type SetOrgMemberRoleResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "last_admin"; error: string };

/** Exact copy string the last-admin guard returns — routes/tests assert on it byte-exact. */
export const LAST_ADMIN_ERROR = "an organization needs at least one admin";

/** Exact copy string returned when the target userId has no membership row in the org. */
export const MEMBER_NOT_FOUND_ERROR = "member not found";

/**
 * Single-org bootstrap: returns the existing org row (first one found) or
 * creates one named "My organization". Used by the auth provisioning hooks
 * (`auth/provisioning.ts`) to guarantee an org exists before the first
 * `org_members` row is inserted — this app has exactly one org today.
 *
 * When `sourceService` is provided, seeds the default base sources for a
 * newly-created org (best-effort — never fails org creation on seed error).
 */
export async function ensureOrg(
  db: AppQueryable,
  sourceService?: SourceService,
): Promise<{ id: string }> {
  const existingRows = await db.select({ id: orgs.id }).from(orgs).limit(1);
  const existing = existingRows[0];
  if (existing) return existing;

  const id = `org_${randomUUID()}`;
  await db.insert(orgs).values({ id, name: "My organization", createdAt: Date.now() });

  if (sourceService) {
    try {
      await sourceService.seedDefaultBasesIfMissing(id);
    } catch (err) {
      console.error(`ensureOrg: seedDefaultBasesIfMissing(${id}) failed (non-fatal):`, err);
    }
  }

  return { id };
}

/** True when `userId` holds `org_members.role === "admin"` in `orgId`. */
export async function isOrgAdmin(db: AppQueryable, orgId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  return rows[0]?.role === "admin";
}

/** True when `userId` has any `org_members` row in `orgId` (any role). */
export async function isOrgMember(db: AppQueryable, orgId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

/** Reads `orgs.features` (jsonb); an absent `organizations` key reads as false. */
export async function getOrgFeatures(db: AppQueryable, orgId: string): Promise<OrgFeatures> {
  const rows = await db.select({ features: orgs.features }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  const row = rows[0];
  if (!row?.features) return { organizations: false };
  return { organizations: Boolean((row.features as Record<string, unknown>).organizations) };
}

/** Merges `features` into `orgs.features` (partial update — only provided keys change). */
export async function setOrgFeatures(db: AppQueryable, orgId: string, features: Partial<OrgFeatures>): Promise<void> {
  const current = await getOrgFeatures(db, orgId);
  const merged: OrgFeatures = { ...current, ...features };
  await db.update(orgs).set({ features: merged }).where(eq(orgs.id, orgId));
}

/** Reads `orgs.model_preferences` (jsonb); absent/missing reads as `[]`. */
export async function getOrgModelPreferences(db: AppQueryable, orgId: string): Promise<string[]> {
  const rows = await db
    .select({ modelPreferences: orgs.modelPreferences })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  const value = rows[0]?.modelPreferences;
  if (!Array.isArray(value)) return [];
  return value as string[];
}

/**
 * Overwrites `orgs.model_preferences` with `prefs` (an ordered, namespaced
 * model-id list). Rejects non-array input — this is the runtime guard the
 * task brief pins tests against, since the jsonb column has no schema-level
 * array constraint.
 */
export async function setOrgModelPreferences(db: AppQueryable, orgId: string, prefs: string[]): Promise<void> {
  if (!Array.isArray(prefs)) {
    throw new ValidationError("modelPreferences must be an array of strings");
  }
  await db.update(orgs).set({ modelPreferences: prefs }).where(eq(orgs.id, orgId));
}

/** Updates `orgs.name`. */
export async function renameOrg(db: AppQueryable, orgId: string, name: string): Promise<void> {
  await db.update(orgs).set({ name }).where(eq(orgs.id, orgId));
}

/** Lists every member of `orgId`, joined against `users`. */
export async function listOrgMembers(db: AppDb, orgId: string): Promise<OrgMemberSummary[]> {
  const rows = await db
    .select({
      userId: orgMembers.userId,
      role: orgMembers.role,
      memberCreatedAt: orgMembers.createdAt,
      email: users.email,
      name: users.name,
      avatarUrl: users.image,
      userCreatedAt: users.createdAt,
    })
    .from(orgMembers)
    .innerJoin(users, eq(orgMembers.userId, users.id))
    .where(eq(orgMembers.orgId, orgId))
    .orderBy(users.createdAt);

  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    name: r.name,
    avatarUrl: r.avatarUrl,
    role: r.role,
    // `users.createdAt` is a `timestamp`-mode column (Date at the JS
    // boundary); `org_members.createdAt` is a plain ms-epoch integer. Both
    // collapse to a ms-epoch number here.
    joinedAt: r.memberCreatedAt ?? r.userCreatedAt.getTime(),
  }));
}

async function countOrgAdmins(db: AppQueryable, orgId: string): Promise<number> {
  const rows = await db
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, "admin")));
  return rows.length;
}

/**
 * Sets a member's role. Rejects (without throwing) when demoting the org's
 * sole remaining admin — count-and-update run inside one transaction so a
 * concurrent demotion of the same org's last two admins can't both succeed.
 */
export async function setOrgMemberRole(
  db: AppDb,
  orgId: string,
  userId: string,
  role: OrgRole,
): Promise<SetOrgMemberRoleResult> {
  return db.transaction(async (tx) => {
    const memberRows = await tx
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
      .limit(1);
    const member = memberRows[0];

    if (!member) {
      return { ok: false, reason: "not_found", error: MEMBER_NOT_FOUND_ERROR };
    }

    if (member.role === "admin" && role === "member") {
      const admins = await countOrgAdmins(tx, orgId);
      if (admins <= 1) {
        return { ok: false, reason: "last_admin", error: LAST_ADMIN_ERROR };
      }
    }

    await tx
      .update(orgMembers)
      .set({ role })
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
    return { ok: true };
  });
}
