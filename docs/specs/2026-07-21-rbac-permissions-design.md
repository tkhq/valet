# Role-Based Access: Fixed Roles + Permissions Layer (v2)

Date: 2026-07-21
Status: approved design
Depends on: auth-v2 (`2026-07-14-auth-v2-design.md`, shipped), split settings (`2026-07-14-split-settings-design.md`, shipped), integration OAuth (`2026-07-20-integration-oauth-design.md`, shipped)

## Problem

Valet's access model is binary (`admin` | `member`) and enforced as scattered checks in two inconsistent families: most org surfaces call `isOrgAdmin` (reads `org_members.role`), while `/api/admin` and **org-scoped credentials** read `users.role` (`AuthUser.role`). The two columns start equal at provisioning but diverge the moment `PATCH /api/org/members/:userId` edits `org_members.role` — a demoted admin keeps org-credential write access until re-provisioned. There is no middle tier between "runs the org" and "uses the product", and no way for an IdP (Keycloak) to govern roles after first signup.

The long-term vision is full role-based access with OAuth-scope-shaped grants (API keys already carry a declared-but-unchecked `scopes` column; the better-auth `mcp` plugin positions Valet as an OAuth authorization server). This pass builds the permission seam that vision needs, with a deliberately small fixed role set on top.

## Decision summary

1. **Named permissions, `resource:action` strings.** A closed set defined in code. The strings are valid OAuth scope tokens verbatim — they are the future scope vocabulary, not a precursor to it.
2. **Principal-based enforcement seam.** Routes check `can(user, "<permission>")` (or a `requirePermission` middleware) against a **permission set carried on the principal**, never against role names. How the set is derived is per-principal-type; today only one derivation exists (org role → static bundle). Future principal types (API key → its scopes ∩ owner's set; OAuth access token → granted scopes; sandbox principal → narrow fixed set) plug into the same seam without route changes.
3. **Fixed role set: `admin` / `operator` / `member`.** Role → permission bundles are a static map in code. No role CRUD, no DB-defined roles this pass — but the map is the only thing a future custom-roles pass replaces.
4. **Single org-role source.** `org_members.role` (enum widened) is THE org role. `AuthUser` carries the resolved role and permission set. `users.role` reverts to what `services/org.ts` documents: the global `/api/admin` operator flag only. This fixes the credentials-gate divergence bug.
5. **IdP role mapping, synced every SSO login.** `AUTH_OIDC_ROLE_MAP` maps IdP claim values to Valet roles; grant/revoke in Keycloak takes effect on the next login. Unset → today's provisioning rules exactly.

## What this spec does NOT cover

- Custom/DB-defined roles or a role-management UI (future pass; replaces the static bundle map).
- Enforcing API-key `scopes` or issuing scoped OAuth access tokens (future pass; consumes the permission vocabulary + `can` seam built here).
- Per-session sharing/ACLs (viewer/collaborator — `auth-access.md`'s participant model; a `viewer` org role is meaningless until that exists, since sessions/workflows are strictly owner-scoped).
- Team-level roles (`teams.ts`'s team-admin logic is untouched).
- Legacy worker/client.

## Permission vocabulary

Defined in `packages/api/src/auth/permissions.ts` (new file — single source of truth):

```ts
export const PERMISSIONS = [
  "org:manage",        // rename org, feature toggles
  "members:manage",    // roster view, role changes, invites
  "providers:manage",  // LLM providers, provider API keys, org model preferences
  "infra:manage",      // GitHub App setup, image catalog, prebuild configs/internals
  "credentials:org",   // org-scoped credential CRUD
] as const;
export type Permission = (typeof PERMISSIONS)[number];
```

Owner-scoped member capabilities (sessions, workflows, user credentials, memory, integrations connect, profile, notifications, teams-create) are **not** permission-gated this pass — they remain "any signed-in member, owner-scoped". Naming them as permissions begins when a non-user principal (scoped API key) needs to be denied them; the vocabulary grows additively.

`/api/admin/*` stays on the global operator flag (`users.role === "admin"`), NOT on an org permission — it is a deployment-operator surface, not an org-role surface.

## Roles and bundles

```ts
export const ORG_ROLES = ["admin", "operator", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  admin:    ["org:manage", "members:manage", "providers:manage", "infra:manage", "credentials:org"],
  operator: ["providers:manage", "infra:manage", "credentials:org"],
  member:   [],
};
```

- **admin** — runs the org: everything.
- **operator** — runs the shared infrastructure (LLM keys, GitHub App, images, prebuilds, org credentials) but cannot touch people or org settings.
- **member** — uses the product; owner-scoped capabilities only.

Existing rows: pre-1.0, the `org_members.role` enum simply widens (`admin | operator | member` — text column, no migration mechanics beyond the 0000 edit; existing values remain valid).

## Enforcement seam

`AuthUser` (middleware/auth.ts) gains the resolved org role and permission set:

```ts
export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  /** Global operator flag (users.role) — gates /api/admin only. */
  role: "admin" | "member";
  /** Org role from org_members.role — the authorization source for org surfaces. */
  orgRole: OrgRole;
  permissions: ReadonlySet<Permission>;
  orgId: string;
}
```

- The auth middleware resolves `orgRole` from `org_members` alongside the existing `resolveOrgId` lookup and stamps `permissions = new Set(ROLE_PERMISSIONS[orgRole])`. The stub rung stamps `orgRole: "admin"` (full set), preserving dev behavior.
- `packages/api/src/auth/permissions.ts` exports `can(user: { permissions: ReadonlySet<Permission> }, permission: Permission): boolean` — deliberately typed against the permission-set shape, not `AuthUser`, so future principals reuse it.
- A `requirePermission(permission)` helper replaces `requireOrgAdmin` (`routes/_org-admin.ts`) and the local `isOrgAdmin` copies. Error shape stays `{ error: "forbidden" }`-family with per-route copy preserved where tests pin it.

### Gate migration map

| Surface | Old gate | New gate |
|---|---|---|
| `PATCH /api/org`, feature toggle | `isOrgAdmin` | `org:manage` |
| members roster/role, invites | `isOrgAdmin` | `members:manage` |
| llm-providers (all admin routes), model prefs | `isOrgAdmin` | `providers:manage` |
| github-app setup/config | `isOrgAdmin` | `infra:manage` |
| image-catalog, prebuilds (admin routes) | `isOrgAdmin` | `infra:manage` |
| org-scoped credentials CRUD | `users.role === "admin"` (**bug**) | `credentials:org` |
| `/api/admin/*` | `users.role` | unchanged (global operator) |
| last-admin guard (`setOrgMemberRole`) | blocks demoting last `admin` | unchanged semantics: at least one `org_members.role === "admin"` must remain (operators don't count) |

`GET /api/org` keeps `callerRole` (now `OrgRole`) and additionally returns `permissions: Permission[]` so the web client renders from permissions, not role names.

## IdP role mapping (OIDC)

New env (all optional; feature entirely off when `AUTH_OIDC_ROLE_MAP` unset):

- `AUTH_OIDC_ROLE_MAP` — comma-separated `claimValue:role` pairs, e.g. `valet-admin:admin,valet-operator:operator`. Roles must be in `ORG_ROLES`; invalid entries fail `loadAuthConfig` loudly (same all-or-none spirit as the existing OIDC triple).
- `AUTH_OIDC_ROLE_CLAIM` — dot-path to the roles array/string in the ID token / userinfo profile. Default `realm_access.roles` (Keycloak realm roles).

Behavior (in the SSO provisioning/login path, `auth/provisioning.ts` + the better-auth SSO hook surface):

- On **every** SSO login (not just first): read the claim, map the first matching entry (map order = precedence) → write `org_members.role` when it differs. No match → `member`. The IdP is the source of truth for SSO users while the map is set — app-side role edits to an SSO user do not survive their next login (documented, deliberate).
- Non-SSO users (email/password, social) are untouched by the map; existing first-user/invite rules continue to govern their provisioning. First-user-bootstrap still applies when the map is unset or the claim is absent.
- `users.role` (global operator) is NEVER written by the map — IdP roles govern org roles only.

Dev harness (`docker/keycloak/valet-realm.json`): add realm roles `valet-admin` and `valet-operator`; grant `valet-admin` to alice, `valet-operator` to bob. `make dev-keycloak`'s printed `.env` block gains `AUTH_OIDC_ROLE_MAP=valet-admin:admin,valet-operator:operator`.

## Web

- `useOrg()` data gains `permissions`; UI affordances branch on permissions:
  - Settings rail org group: shown when the caller has ANY org permission; individual entries per permission (`Members`/`Invites` → `members:manage`; `Providers`/`Models` → `providers:manage`; `GitHub`/`Images`/`Prebuilds` → `infra:manage`; `General` → `org:manage`).
  - Members table role picker offers the three roles; role badges render `operator`.
- API gates remain authoritative; UI is hide-only, as today.

## Teams and resource-scoped roles (framing, not built this pass)

Access control has two axes, and team roles live on the second:

- **Org axis** (this spec): org-wide capability — role → permission bundle → `can(principal, permission)`.
- **Resource axis** (future): capability *within a granted container*. Team roles (`team_members.role: admin|member`) are the existing instance: today they govern only the team object itself (team-admin or org-admin manages membership/deletion; members read the roster) because teams own no resources yet. Session sharing (owner/collaborator/viewer per `auth-access.md`) is the same shape.

When teams start owning resources (team orchestrators, shared workflows, team credentials — orchestrator spec direction), the designed extension is resource-context checks through the same seam — `can(principal, permission, { team })` — deriving the effective set from the caller's *team* role bundle, mirroring the org bundles. Team membership is the access grant; team role is the capability level within it; org `members:manage`/org-admin remains the recovery override. This composes with the OAuth vision as resource-qualified grants later, without renaming any permission. Nothing in this pass may assume permissions are org-global-only in a way that blocks adding the optional resource-context parameter.

## Compatibility with the full-RBAC / OAuth-scopes vision (binding)

- Permission strings are the scope vocabulary: a future token grant of `providers:manage` means exactly what the route checks today. Never rename a shipped permission; add new ones.
- `can()` accepts any principal carrying `permissions: ReadonlySet<Permission>`. API-key enforcement = populate that set from the key's `scopes` ∩ the owner's set; OAuth access tokens = from granted scopes. No route changes.
- Custom roles later = replace `ROLE_PERMISSIONS` static map with a DB-backed lookup behind the same middleware; `OrgRole` widens to `string` at that point, which is why routes must never match on role names.

## Testing

- `auth/permissions.test.ts` — bundle contents, `can()`.
- Route tests: for each migrated surface, an `operator` principal (via the `x-valet-test-user-id` impersonation seam + a seeded operator user in `_setup.ts`) can hit `providers:manage`/`infra:manage`/`credentials:org` surfaces and is 403'd from `org:manage`/`members:manage`; a `member` is 403'd from all. The org-credentials divergence bug gets a regression test: demote a user's `org_members.role`, assert org-credential writes 403 immediately.
- Config: `AUTH_OIDC_ROLE_MAP` parse/validation cases.
- Role-map sync: SSO login with mapped claim promotes/demotes `org_members.role`; unmapped claim → member; map unset → untouched.
- Web: rail/table rendering per permission set.
- Live pass (human-in-the-loop): Keycloak — grant alice `valet-admin`, bob `valet-operator`; verify bob sees Providers/Images but not Members, and a Keycloak role change flips access on re-login.

## Out of scope / follow-ups

- API-key scope enforcement (first consumer of `can()` beyond user principals).
- OAuth access-token issuance with permission scopes (better-auth `mcp` surface).
- Custom roles + role-management UI.
- `viewer` role (blocked on session sharing).
