# Auth v2 Design — better-auth + OIDC (Keycloak-ready)

**Date:** 2026-07-14
**Status:** Approved for planning
**Scope:** Real authentication for the v2 stack (`packages/api` + `packages/web`): email/password login, generic OIDC SSO (Keycloak first), invites, API keys, and provisioning. Replaces the `VALET_LOCAL_AUTH` stub as the production path while keeping it for dev/tests.

## Decisions (locked)

1. **Deployment model: single deployment, one IdP.** Each Valet deployment configures at most ONE external OIDC issuer via environment variables. Per-org / multi-tenant IdP routing is out of scope (the design must not preclude it, but no code ships for it).
2. **Engine: better-auth** (v1.6.x) with the Drizzle adapter over the existing better-sqlite3 app db. Plugins: email/password (core), `@better-auth/sso` (generic OIDC), `apiKey`. We do NOT use better-auth's organization plugin — Valet's own single-org model (`orgs`, `org_members`) stays authoritative.
3. **No managed auth vendor.** Keycloak (or any OIDC issuer) is the IAM layer; Valet is a standard OIDC relying party. SAML never terminates at Valet — Keycloak brokers SAML/social upstream and presents OIDC downstream.
4. **Built-in email/password** exists for deployments without an IdP. Passwords are hashed and managed entirely by better-auth; Valet code never touches password material.
5. **Signup policy: first user open, then invite-only.** The first-ever signup becomes org admin (creates the org row if absent). Every subsequent email/password signup requires a valid invite. **OIDC logins skip the invite requirement** — a configured IdP is the deployment's access control, and anyone it authenticates is auto-provisioned as a member.
6. **API keys are in scope**: user-generated, hashed at rest, shown once, revocable, listed with a `vlt_`-prefixed hint and last-used timestamp. A key authenticates as its owner with the owner's role — no separate scope model this pass.
7. **The internal-token bypass (`x-valet-internal`) is preserved unchanged** for sandbox→api calls (memory routes). Narrowing it further is out of scope.
8. **The dev stub survives**: `VALET_LOCAL_AUTH=1` keeps today's single-local-user behavior as the LAST rung of the middleware ladder, so `make dev-local` and the existing test fleet run unchanged. `VALET_TEST_AUTH_HEADER` impersonation stays test-bootstrap-only, exactly as documented in `middleware/auth.ts` today.
9. **Carried over from v1** (`packages/worker` auth, the proven parts): provisioning semantics of `finalizeIdentityLogin` (match-by-email, first-user-promote, invite-by-code OR invite-by-email with role attached), the provider-token → credential-store hook (login can double as connecting an integration), git-config backfill from identity, and the api-token UX details (prefix display, last-used). NOT carried: the `IdentityProvider` plugin registry, hand-rolled state JWTs/session issuance/password hashing/rate limiting, and the SAML endpoint — better-auth and Keycloak replace all of it.
10. **Pre-1.0 schema policy applies**: all new tables are folded into the `0000` migrations (api + store-sqlite as appropriate); no new numbered migrations; `rm ~/.valet/app.db` after schema edits.

## Architecture

```
packages/api/src/auth/
├── index.ts          # buildAuth(providers): the configured better-auth instance
├── config.ts         # env parsing: AUTH_* vars → typed AuthConfig (or "stub mode")
├── provisioning.ts   # signup/sign-in hooks: first-user-admin, invite gate,
│                     #   org membership, git backfill, provider-token capture
└── invites.ts        # invite create/validate/consume (Valet-owned table)
```

- The better-auth instance is built once at boot in `main.ts` (alongside `buildProviders`) and mounted on Hono: `app.on(["GET","POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))`. better-auth owns everything under `/api/auth/*`: signup, login, logout, session, OIDC redirect/callback, api-key management endpoints.
  - Note: v1's worker also used `/api/auth/me` for profile reads; v2 already moved that to `/api/me`, so there is no route collision.
- `authMiddleware` (existing file) grows the ladder described below and remains the ONLY place that sets `c.var.user`. No route handler changes.
- The web client uses `better-auth/react` (`createAuthClient`) for `/login` and `/signup` pages and the signed-in session; all other data fetching keeps the existing TanStack Query layer.

### Config (`config.ts`)

| Env var | Meaning |
|---|---|
| `BETTER_AUTH_SECRET` | Required to enable real auth. Absent → auth runs in stub-only mode (today's behavior). |
| `BETTER_AUTH_URL` | External base URL of the api (cookie domain / redirect base). Defaults to `http://localhost:8788`. |
| `AUTH_OIDC_ISSUER` | OIDC issuer URL (e.g. `https://kc.example.com/realms/valet`). Optional. |
| `AUTH_OIDC_CLIENT_ID` / `AUTH_OIDC_CLIENT_SECRET` | Client credentials. Required iff issuer is set. |
| `AUTH_OIDC_NAME` | Display name for the login button (default: `SSO`). |

If `AUTH_OIDC_ISSUER` is set, boot registers it with the SSO plugin (providerId `oidc`, discovery + PKCE handled by the plugin); the login page shows "Continue with {AUTH_OIDC_NAME}". If not, password-only.

## Schema

better-auth's `user` model **is** our `users` table — one identity source. Our existing columns (`role`, `default_model`, `name`, `email`, timestamps) map onto better-auth's expected fields plus `additionalFields` (`role`, `defaultModel`); `org_members.user_id` keeps pointing at the same ids. New tables (all in the api `0000` migration, Drizzle schema in `packages/api/src/schema/`):

- `session` — better-auth sessions (token hashed by the library, expiry, ip/user-agent).
- `account` — password hashes AND linked OIDC identities (providerId + accountId per user; this is what makes "same email via Keycloak and via password" one user with two accounts).
- `verification` — better-auth's short-lived verification rows (state, tokens).
- `sso_provider` — the SSO plugin's provider registration row(s); seeded from env at boot, not user-editable.
- `apikey` — better-auth apiKey plugin table (hashed key, prefix, name, last-used, expiry, revocation).
- `invites` — **Valet-owned**, not a better-auth table: `id`, `code_hash` (SHA-256 of the invite code), `email` (nullable — when set, the invite auto-matches that address), `role` (`admin` | `member`), `created_by`, `created_at`, `expires_at`, `accepted_by` (nullable), `accepted_at` (nullable).

Exact column shapes for the better-auth tables come from `npx @better-auth/cli generate` output at plan time and are transcribed into the 0000 migration + Drizzle schema (we do not adopt the CLI's migration flow — pre-1.0 rule 10).

Dependency alignment: better-auth peers on `better-sqlite3 ^12` and `drizzle-orm ^0.45.2`; bump `packages/api` + `packages/store-sqlite` accordingly (Node 22 satisfies both).

## Middleware ladder

`authMiddleware` — first match wins:

1. **Internal token**: valid `x-valet-internal` → pass through without `c.var.user` (unchanged, memory routes only).
2. **Session**: `auth.api.getSession({ headers })` resolves → `c.var.user = { id, email, name, role, orgId }`. `role` comes from the user row; `orgId` from the single org row (cached lookup).
3. **API key**: `x-api-key` header → apiKey plugin verification → key owner's user row → same `c.var.user` shape. Verification updates `last_used_at`.
4. **Dev stub**: `VALET_LOCAL_AUTH=1` → today's hardcoded local user (and the separately-gated test impersonation header).
5. Otherwise → 401 `{ error: "unauthorized" }`.

Rungs 2–3 exist only when `BETTER_AUTH_SECRET` is configured; without it the ladder is exactly today's behavior. Real auth and the dev stub may coexist (a dev running real auth locally still gets the stub as fallback only if they explicitly set `VALET_LOCAL_AUTH=1`).

## Provisioning & invites (`provisioning.ts`)

Implemented as better-auth lifecycle hooks; the logic ports v1's `finalizeIdentityLogin` semantics:

**Signup gate (before-hook on email/password signup):**
- Zero users in the db → allow; after creation, promote to `role='admin'`, create the org row if absent (name: `"My organization"`, features default), insert `org_members` row with `role='admin'`.
- Otherwise → require an invite: a `code` provided at signup, or an unexpired unaccepted invite matching the signup email. No invite → reject with `"an invite is required to join this deployment"`.
- On success: mark the invite accepted (`accepted_by`, `accepted_at`), create `org_members` row with the invite's role, set `users.role` to the invite's role.

**OIDC sign-in (after-hook on SSO sign-in creating a new user):**
- No invite required (decision 5). New users join as `member` (org_members row created). First-ever user via OIDC still gets the first-user-admin promotion.
- If the IdP returned provider tokens and the provider maps to a known integration service, store them into the v2 `SqliteCredentialStore` for that user (the v1 "login doubles as connecting the integration" hook). For plain Keycloak this is a no-op; the seam exists for Google/GitHub-style IdPs later.

**Both paths:** backfill `git_name`/`git_email`-equivalent profile fields from the identity when we grow them (today v2's users table has `name`/`email` only — backfill `name` if empty; the git fields arrive with a later sessions pass and reuse this hook).

**Invite management (Valet routes, org-admin only):**
- `POST /api/org/invites` `{ email?, role }` → generates a URL-safe code (shown once, hash stored), default expiry 7 days → `{ id, code, email, role, expiresAt }`.
- `GET /api/org/invites` → pending invites (no codes — only prefix hints).
- `DELETE /api/org/invites/:id` → revoke.
- The Members settings page gains an **Invite** action (dialog: optional email, role picker, produces a copyable link `{web}/signup?invite={code}`), and a pending-invites list with revoke. Copy follows the settings spec's voice; the promised string "Invites arrive with real login." is retired by this feature.

## API keys

- Settings → **You** → new **API keys** section: create (name it, secret displayed once), list (`prefix` hint `vlt_xxxx…`, created, last used, expiry if set), revoke.
- better-auth apiKey plugin config: prefix `vlt_`, metadata disabled, rate-limit defaults.
- Wire: requests authenticate with `x-api-key: vlt_…` (rung 3).

## Frontend (`packages/web`)

- New public routes `/login` and `/signup` (and `/signup?invite=…`), designed under the frontend-design skill in the app's established idiom. Login: email/password form + "Continue with {AUTH_OIDC_NAME}" button when the api reports SSO configured (a tiny unauthenticated `GET /api/auth-config` returning `{ ssoName? , stub? }` drives this).
- Route guard: when the api answers 401 and stub mode is off, redirect to `/login`. When stub mode is on, behavior is unchanged (no login wall in `make dev-local`).
- Signed-in chrome: user menu gains Sign out (better-auth `signOut()`).
- Session transport is better-auth's cookie; the existing WS connection authenticates by riding the same cookie on the upgrade request (same-origin dev proxy already forwards cookies).

## Testing

- **Middleware matrix** (route-level): session cookie / api key / internal token / stub / nothing→401; stub disabled when `VALET_LOCAL_AUTH≠1`.
- **Signup gate**: first user becomes admin + org created; second signup without invite rejected; with code-invite joins with invite role; with email-matched invite auto-consumes; expired/revoked/accepted invites rejected; invite single-use.
- **OIDC provisioning hook**: unit-tested against a fake SSO sign-in event (new user → member + org_members row; token capture writes to credential store).
- **API keys**: create/list/revoke round-trip; revoked key 401s; `last_used_at` updates; secret never re-readable.
- **E2E**: boot with `BETTER_AUTH_SECRET` set and `VALET_LOCAL_AUTH` off → signup → login → cookie-authed `GET /api/me` → API key create → key-authed request.
- Existing fleet: entire current suite must stay green with no env changes (stub path untouched).

## Non-goals (this pass)

- Multi-tenant / per-org IdP configuration; IdP admin UI.
- SAML terminating at Valet (Keycloak brokers it).
- API-key scopes; org-level login-provider toggles; email delivery of invites (link-sharing only); password reset email flow (requires a mailer — follow-up; better-auth supports it when one exists).
- Narrowing the internal-token bypass; sandbox gateway JWTs (`deriveSandboxJwtSecret` stays a v1 reference for the future sandbox pass).
- Multi-org.
