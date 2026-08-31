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
  /**
   * Whether the identity provider's groups become teams at each
   * single-sign-on login (`services/team-sync.ts`).
   *
   * Off is the default, and an absent key reads as off. Team creation from
   * groups changes who can reach a team's skills, workflows and sessions, so
   * an operator must ask for it. Nothing else in the login path depends on
   * it: admission, the global role and org membership are decided by the
   * user-create hooks in `auth/provisioning.ts`, which never read this flag.
   */
  ssoTeamSync: boolean;
  /** Whether personal (per-user) 1Password service-account tokens are
   * allowed for this org. Absent-reads-as-`true` (opt-out, not opt-in) —
   * see `getAllowPersonalOnePassword`, which reads the same underlying
   * `orgs.features` key with the same default. */
  allowPersonalOnePassword: boolean;
}

export interface OrgMemberSummary {
  userId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: OrgRole;
  joinedAt: number;
}

/** The member-visible slice of a roster row: display identity, no org role,
 * no join date. `Pick` keeps the subset relationship compiler-checked. */
export type OrgDirectoryUser = Pick<OrgMemberSummary, "userId" | "email" | "name" | "avatarUrl">;

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

/**
 * Returns the org, or undefined when this deployment has none yet.
 *
 * The read-only half of `ensureOrg`, for a caller that must not create an
 * org as a side effect of asking a question about one. The login team sync
 * is such a caller: its feature gate lives on the org row, so no org means
 * no gate, which means off.
 */
export async function findOrg(db: AppQueryable): Promise<{ id: string } | undefined> {
  const rows = await db.select({ id: orgs.id }).from(orgs).limit(1);
  return rows[0];
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

/** Most feature keys read as false when absent, so a new gate defaults to
 * off. `allowPersonalOnePassword` is the exception: absent reads as true
 * (opt-out). */
const FEATURES_OFF: OrgFeatures = { organizations: false, ssoTeamSync: false, allowPersonalOnePassword: true };

/** Reads the raw `orgs.features` jsonb, or an empty record when the org has none. */
async function readRawFeatures(db: AppQueryable, orgId: string): Promise<Record<string, unknown>> {
  const rows = await db.select({ features: orgs.features }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  const value = rows[0]?.features;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * Recording-gateway credential strategy (org-level). `centralized` (default):
 * the gateway drops the harness's key and bills the org's stored upstream key.
 * `passthrough`: the gateway forwards each user's OWN provider key upstream
 * (the user still identifies with a `vlt_` key), so per-user keys and billing
 * are preserved while valet only observes. Stored as a string key in the
 * `orgs.features` jsonb (untyped at the DB level), so no schema change.
 * Subscriptions (OAuth) are NOT supported by either mode — the proxy is an
 * API-key path (see the gateway design doc).
 */
export type ProxyCredentialMode = "centralized" | "passthrough";

/**
 * Recording-gateway governance (org-level), stored together in the
 * `orgs.features` jsonb:
 *  - `enabled` — master on/off. Default OFF: the gateway forwards a provider
 *    key and records prompts, so an org opts in explicitly on the Proxy
 *    settings page. When off, `/proxy/*` 403s.
 *  - `mode` — credential strategy (`centralized` vs `passthrough`).
 */
export interface ProxySettings {
  enabled: boolean;
  mode: ProxyCredentialMode;
}

function proxySettingsFrom(raw: Record<string, unknown>): ProxySettings {
  return {
    enabled: raw.proxyEnabled === true,
    mode: raw.proxyCredentialMode === "passthrough" ? "passthrough" : "centralized",
  };
}

/** Reads both governance fields in one `orgs.features` read (the gateway hot
 * path and the settings endpoints both need the pair). */
export async function getProxySettings(db: AppQueryable, orgId: string): Promise<ProxySettings> {
  return proxySettingsFrom(await readRawFeatures(db, orgId));
}

/** Applies a partial governance update in ONE read-modify-write, so a combined
 * `{enabled, mode}` PUT is a single write (not two that can interleave), and
 * returns the resulting settings. */
export async function setProxySettings(
  db: AppQueryable,
  orgId: string,
  patch: { enabled?: boolean; mode?: ProxyCredentialMode },
): Promise<ProxySettings> {
  const next = { ...(await readRawFeatures(db, orgId)) };
  if (patch.enabled !== undefined) next.proxyEnabled = patch.enabled;
  if (patch.mode !== undefined) next.proxyCredentialMode = patch.mode;
  await db.update(orgs).set({ features: next }).where(eq(orgs.id, orgId));
  return proxySettingsFrom(next);
}

/**
 * Reads `orgs.features` (jsonb). An absent key reads as false, except
 * `allowPersonalOnePassword`, which reads as true (opt-out).
 */
export async function getOrgFeatures(db: AppQueryable, orgId: string): Promise<OrgFeatures> {
  const raw = await readRawFeatures(db, orgId);
  return {
    organizations: Boolean(raw.organizations),
    ssoTeamSync: Boolean(raw.ssoTeamSync),
    allowPersonalOnePassword: raw.allowPersonalOnePassword !== false,
  };
}

/**
 * Whether personal (per-user) 1Password service-account tokens are allowed
 * for `orgId`. Reads the same `orgs.features` jsonb column `getOrgFeatures`
 * does. An absent `allowPersonalOnePassword` key reads as `true` (opt-out)
 * — org admins disable it explicitly.
 */
export async function getAllowPersonalOnePassword(db: AppQueryable, orgId: string): Promise<boolean> {
  const raw = await readRawFeatures(db, orgId);
  return raw.allowPersonalOnePassword !== false;
}

/**
 * Reads the feature gates of the deployment's org, without creating one.
 *
 * No org means no gate row, so every opt-in feature reads as off
 * (`allowPersonalOnePassword` still defaults to on). A caller on the
 * login path must use this instead of `ensureOrg` + `getOrgFeatures`: a gate
 * check must not be the thing that creates an org.
 */
export async function findOrgFeatures(db: AppQueryable): Promise<OrgFeatures> {
  const org = await findOrg(db);
  if (!org) return { ...FEATURES_OFF };
  return getOrgFeatures(db, org.id);
}

/**
 * Merges `features` into `orgs.features`. Only the given keys change.
 *
 * The merge is against the RAW jsonb, not against `getOrgFeatures`. The
 * typed reader projects the record down to the keys this file knows, so a
 * merge against it would erase every other key. `valet.yaml` may declare a
 * feature key that this build does not name (`config/instance-config.ts`
 * accepts `org.features` as any boolean record), and one write from the
 * settings page must not delete what the file put there.
 */
export async function setOrgFeatures(db: AppQueryable, orgId: string, features: Partial<OrgFeatures>): Promise<void> {
  const raw = await readRawFeatures(db, orgId);
  await db.update(orgs).set({ features: { ...raw, ...features } }).where(eq(orgs.id, orgId));
}

/**
 * Exact copy string the group-path guard throws — routes/tests assert on it.
 * Names the corrective action: the shape a path must have.
 */
export const SSO_TEAM_GROUP_SHAPE_ERROR =
  'ssoTeamGroups entries must be top-level group paths such as "/platform"';

/**
 * Validates and normalizes a group allowlist from untrusted input: trims
 * each entry, requires the top-level-path shape (`/name`, exactly one
 * segment — the same shape `auth.sso.teams.groups` requires in
 * `config/instance-config.ts`), and drops duplicates keeping first
 * position. One bad entry rejects the whole list, because a silently
 * dropped entry would read back as "this group was turned off".
 */
export function normalizeSsoTeamGroups(groups: unknown): string[] {
  if (!Array.isArray(groups)) {
    throw new ValidationError("ssoTeamGroups must be an array of strings");
  }
  const out: string[] = [];
  for (const raw of groups) {
    if (typeof raw !== "string") throw new ValidationError(SSO_TEAM_GROUP_SHAPE_ERROR);
    const trimmed = raw.trim();
    // Leading `/` plus exactly one non-empty segment. A bare name cannot be
    // told from a same-named group nested elsewhere, and the sync mirrors a
    // top-level group and its admin sub-group only (`services/team-sync.ts`).
    if (!/^\/[^/]+$/.test(trimmed)) throw new ValidationError(SSO_TEAM_GROUP_SHAPE_ERROR);
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Reads `orgs.sso_team_groups`. NULL means the list was never set — by the
 * file or by Settings — and the caller must mirror nothing, the same
 * fail-closed answer an empty list gives. The two are kept distinct so the
 * boot reconciler can tell "the operator chose nothing" from "the operator
 * chose an empty list".
 */
export async function getSsoTeamGroups(db: AppQueryable, orgId: string): Promise<string[] | null> {
  const rows = await db
    .select({ ssoTeamGroups: orgs.ssoTeamGroups })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  const value = rows[0]?.ssoTeamGroups;
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** Overwrites `orgs.sso_team_groups` after `normalizeSsoTeamGroups`. */
export async function setSsoTeamGroups(db: AppQueryable, orgId: string, groups: string[]): Promise<void> {
  const normalized = normalizeSsoTeamGroups(groups);
  await db.update(orgs).set({ ssoTeamGroups: normalized }).where(eq(orgs.id, orgId));
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

/**
 * Lists every member of `orgId` as a directory row. This backs the
 * member-visible `GET /api/org/directory`, so it deliberately returns no
 * org role and no join date — those stay on the admin-only roster. Derived
 * from `listOrgMembers` so the two lists can never disagree on join,
 * filter, or order.
 */
export async function listOrgDirectory(db: AppDb, orgId: string): Promise<OrgDirectoryUser[]> {
  const members = await listOrgMembers(db, orgId);
  return members.map(({ userId, email, name, avatarUrl }) => ({ userId, email, name, avatarUrl }));
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
