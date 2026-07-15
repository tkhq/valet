/**
 * Org service — org membership, feature gate, and org-scoped settings
 * (split-settings design). `org_members.role` is the real authz source for
 * "is this user an admin of this org"; `users.role` remains the global
 * *operator* gate for `/api/admin` only (see `requireOrgAdmin`'s doc
 * comment on the routes that use it).
 */
import { and, eq } from "drizzle-orm";
import type { AppDb, AppQueryable } from "../lib/drizzle.js";
import { orgMembers, orgs, users } from "../schema/index.js";

export type OrgRole = "admin" | "member";

export interface OrgFeatures {
  organizations: boolean;
}

export interface OrgMemberSummary {
  userId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: OrgRole;
  joinedAt: number;
}

export type SetOrgMemberRoleResult = { ok: true } | { ok: false; error: string };

/** Exact copy string the last-admin guard returns — routes/tests assert on it byte-exact. */
export const LAST_ADMIN_ERROR = "an organization needs at least one admin";

/** True when `userId` holds `org_members.role === "admin"` in `orgId`. */
export async function isOrgAdmin(db: AppQueryable, orgId: string, userId: string): Promise<boolean> {
  const row = db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .get();
  return row?.role === "admin";
}

function parseFeatures(raw: string): OrgFeatures {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const organizations =
    typeof parsed === "object" && parsed !== null && "organizations" in parsed
      ? Boolean((parsed as Record<string, unknown>).organizations)
      : false;
  return { organizations };
}

/** Reads `orgs.features`, parsed; an absent `organizations` key reads as false. */
export async function getOrgFeatures(db: AppDb, orgId: string): Promise<OrgFeatures> {
  const row = db.select({ features: orgs.features }).from(orgs).where(eq(orgs.id, orgId)).get();
  if (!row) return { organizations: false };
  return parseFeatures(row.features);
}

/** Merges `features` into `orgs.features` (partial update — only provided keys change). */
export async function setOrgFeatures(db: AppDb, orgId: string, features: Partial<OrgFeatures>): Promise<void> {
  const current = await getOrgFeatures(db, orgId);
  const merged: OrgFeatures = { ...current, ...features };
  db.update(orgs).set({ features: JSON.stringify(merged) }).where(eq(orgs.id, orgId)).run();
}

/** Updates `orgs.name`. */
export async function renameOrg(db: AppDb, orgId: string, name: string): Promise<void> {
  db.update(orgs).set({ name }).where(eq(orgs.id, orgId)).run();
}

/** Lists every member of `orgId`, joined against `users`. */
export async function listOrgMembers(db: AppDb, orgId: string): Promise<OrgMemberSummary[]> {
  const rows = db
    .select({
      userId: orgMembers.userId,
      role: orgMembers.role,
      memberCreatedAt: orgMembers.createdAt,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
      userCreatedAt: users.createdAt,
    })
    .from(orgMembers)
    .innerJoin(users, eq(orgMembers.userId, users.id))
    .where(eq(orgMembers.orgId, orgId))
    .orderBy(users.createdAt)
    .all();

  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    name: r.name,
    avatarUrl: r.avatarUrl,
    role: r.role,
    joinedAt: r.memberCreatedAt ?? r.userCreatedAt,
  }));
}

function countOrgAdmins(db: AppQueryable, orgId: string): number {
  const rows = db
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, "admin")))
    .all();
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
  let result: SetOrgMemberRoleResult = { ok: true };
  db.transaction((tx) => {
    const member = tx
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
      .get();

    if (member?.role === "admin" && role === "member") {
      const admins = countOrgAdmins(tx, orgId);
      if (admins <= 1) {
        result = { ok: false, error: LAST_ADMIN_ERROR };
        return;
      }
    }

    tx.update(orgMembers)
      .set({ role })
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
      .run();
  });
  return result;
}
