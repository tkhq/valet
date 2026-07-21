/**
 * Permission vocabulary + fixed role bundles (RBAC design,
 * docs/specs/2026-07-21-rbac-permissions-design.md).
 *
 * BINDING: permission strings are the future OAuth scope vocabulary —
 * never rename a shipped permission, only add. `can()` is deliberately
 * typed against "anything carrying a permission set", not `AuthUser`, so
 * future principals (scoped API keys, OAuth access tokens, sandbox
 * principals) reuse the same seam without route changes. Custom roles
 * later = replace ROLE_PERMISSIONS with a DB-backed lookup; nothing else
 * moves, which is why routes must never match on role names.
 */
export const PERMISSIONS = [
  "org:manage", // rename org, feature toggles
  "members:manage", // roster view, role changes, invites
  "providers:manage", // LLM providers, provider API keys, org model preferences
  "infra:manage", // GitHub App setup, image catalog, prebuild configs/internals
  "credentials:org", // org-scoped credential CRUD
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ORG_ROLES = ["admin", "operator", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  admin: ["org:manage", "members:manage", "providers:manage", "infra:manage", "credentials:org"],
  operator: ["providers:manage", "infra:manage", "credentials:org"],
  member: [],
};

export function isOrgRole(v: unknown): v is OrgRole {
  return typeof v === "string" && (ORG_ROLES as readonly string[]).includes(v);
}

const BUNDLES: Record<OrgRole, ReadonlySet<Permission>> = {
  admin: new Set(ROLE_PERMISSIONS.admin),
  operator: new Set(ROLE_PERMISSIONS.operator),
  member: new Set(ROLE_PERMISSIONS.member),
};

export function permissionsForOrgRole(role: OrgRole): ReadonlySet<Permission> {
  return BUNDLES[role];
}

export function can(principal: { permissions: ReadonlySet<Permission> }, permission: Permission): boolean {
  return principal.permissions.has(permission);
}
