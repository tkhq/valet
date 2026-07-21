/**
 * SSO role sync — maps an IdP claim (Keycloak `realm_access.roles` by
 * default) onto `org_members.role` on every SSO login (RBAC design,
 * docs/specs/2026-07-21-rbac-permissions-design.md). Wired into
 * `auth/index.ts`'s `sso()` plugin options as `provisionUser`, only when
 * `cfg.oidc.roleMap` is configured.
 *
 * NEVER touches `users.role` (the global admin/member flag stamped by
 * `provisioning.ts`'s admission rule) — this only syncs the per-org
 * membership role.
 */
import { eq, and } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { orgMembers } from "../schema/index.js";
import type { OrgRole } from "./permissions.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Walks a dot-path (e.g. `"realm_access.roles"`) over an `unknown`-shaped
 * object, narrowing at each segment. Returns `undefined` if any segment is
 * missing or the container isn't a plain object.
 */
function walkDotPath(obj: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".").filter((s) => s.length > 0);
  let current: unknown = obj;
  for (const segment of segments) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Normalizes a claim value (string, string[], or anything else) to a string[]. */
function claimValues(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * Resolves the mapped `OrgRole` for a login: walks `roleClaim` in `userInfo`
 * first, falling back to `idTokenClaims` when `userInfo` lacks the path.
 * The first `roleMap` entry (in array order) whose `claimValue` appears
 * among the claim's values wins; no match (or no claim at all) → "member".
 */
export function extractMappedRole(params: {
  roleMap: { claimValue: string; role: OrgRole }[];
  roleClaim: string;
  userInfo: Record<string, unknown>;
  idTokenClaims?: Record<string, unknown>;
}): OrgRole {
  const { roleMap, roleClaim, userInfo, idTokenClaims } = params;

  let values = claimValues(walkDotPath(userInfo, roleClaim));
  if (values.length === 0 && idTokenClaims) {
    values = claimValues(walkDotPath(idTokenClaims, roleClaim));
  }

  for (const entry of roleMap) {
    if (values.includes(entry.claimValue)) {
      return entry.role;
    }
  }
  return "member";
}

/**
 * Decodes a JWT's payload (middle segment) as base64url JSON, without
 * signature verification — the token came directly from the IdP's token
 * endpoint over TLS, so there's no untrusted-transport step to guard
 * against here. Returns `null` for anything that isn't a well-formed
 * `header.payload.signature` JWT with a JSON object payload.
 */
export function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (!payload) return null;

  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Syncs `org_members.role` for `userId` to `role` when it differs from the
 * current value. A missing membership row is a no-op by design — on first
 * login, `provisioning.ts`'s `userCreateAfter` inserts the row earlier in
 * the same request, so this only ever "misses" if that hook hasn't run
 * (shouldn't happen in the wired flow). Never writes `users.role`.
 *
 * Guards against a sole-admin lockout: if the incoming claim would demote
 * the org's last remaining admin (e.g. a revoked IdP group or a typo'd
 * role map), the write is skipped and a loud `console.error` is logged
 * instead — leaving the existing admin role in place until a later login
 * with corrected claims resolves it. Mirrors `setOrgMemberRole`'s
 * count-then-update-in-one-transaction posture in services/org.ts.
 */
export async function syncSsoOrgRole(db: AppDb, userId: string, role: OrgRole): Promise<void> {
  const rows = await db.select().from(orgMembers).where(eq(orgMembers.userId, userId));
  for (const row of rows) {
    if (row.role === role) continue;

    await db.transaction(async (tx) => {
      if (row.role === "admin" && role !== "admin") {
        const admins = await tx
          .select({ userId: orgMembers.userId })
          .from(orgMembers)
          .where(and(eq(orgMembers.orgId, row.orgId), eq(orgMembers.role, "admin")));
        if (admins.length <= 1) {
          console.error(
            `[sso-role-sync] refused to demote user ${userId} in org ${row.orgId} from admin to ${role}: ` +
              `this would leave the org with zero admins. IdP-driven demotion skipped; a later login with ` +
              `corrected claims will apply the change.`,
          );
          return;
        }
      }

      await tx
        .update(orgMembers)
        .set({ role })
        .where(and(eq(orgMembers.orgId, row.orgId), eq(orgMembers.userId, userId)));
    });
  }
}
