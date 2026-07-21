# Auth v2 Design — better-auth + OIDC (Keycloak-ready) + social + MCP

**Date:** 2026-07-14 (rev 3 — adds allowed-email-domains policy and sandbox auth: per-session sandbox tokens + browser→sandbox JWT primitives)
**Status:** Implemented (2026-07-15)
**Scope:** Real authentication for the v2 stack (`packages/api` + `packages/web`): email/password login, social sign-on (Google/GitHub), generic OIDC SSO (Keycloak first), invites, allowed email domains, API keys, MCP OAuth provider + minimal `/mcp` endpoint, sandbox auth (per-session tokens + service-JWT primitives), and provisioning. Replaces the `VALET_LOCAL_AUTH` stub as the production path while keeping it for dev/tests.

All better-auth API facts below were verified against the installed `better-auth@1.6.23` / `@better-auth/sso@1.6.23` / `@better-auth/api-key@1.6.23` types and CLI-generated schema (research scratch: `$CLAUDE_JOB_DIR/tmp/ba-research`).

## Decisions (locked)

1. **Deployment model: single deployment, one enterprise IdP.** Each deployment configures at most ONE external OIDC issuer via env. Per-org / multi-tenant IdP routing is out of scope (must not be precluded; no code ships for it).
2. **Engine: better-auth 1.6.23** with the Drizzle adapter over the existing better-sqlite3 app db. Packages: `better-auth` (core email/password, social providers, MCP plugin) + `@better-auth/sso` (generic OIDC) + `@better-auth/api-key`. We do NOT use better-auth's organization plugin — Valet's single-org model (`orgs`, `org_members`) stays authoritative. (Considered and rejected: it would migrate the just-shipped org/teams/members work onto the auth library's tables, fight our feature-gate semantics, and couple core domain to the identity dependency. Cost accepted: we own our invites table, and future fine-grained permissions or org-switching is a design pass, not a config change.)
3. **No managed auth vendor.** Keycloak (or any OIDC issuer) is the IAM layer; Valet is a standard OIDC relying party. SAML never terminates at Valet — Keycloak brokers SAML/social upstream and presents OIDC downstream.
4. **Built-in email/password** for deployments without an IdP. Passwords hashed and managed entirely by better-auth; Valet code never touches password material.
5. **Signup policy: first user open, then gated by trust source.**
   - First-ever signup (any method) → org admin; creates the org row if absent.
   - **Email/password** signups require an invite: a code presented at signup, or an unexpired invite matching the email.
   - **Social** (Google/GitHub) signups require an **email-targeted invite** — configuring Google as a login option must not admit every Google account on the internet, and OAuth redirects can't carry a code, so admission is by invite-matching-email only.
   - **Enterprise SSO (OIDC/Keycloak)** signups skip invites entirely — the IdP is the deployment's access control; anyone it authenticates is provisioned as a member.
   - **Allowed email domains act as a standing invite**: when `AUTH_ALLOWED_EMAIL_DOMAINS` is set (comma-separated, e.g. `example.com,example.dev`), a signup (password or social) whose email domain matches is admitted WITHOUT an invite, as `member`. Explicit invites still admit non-matching emails (external-contractor case). Unset → invite-only as above. Matching is on the exact domain of the email address, case-insensitive, no subdomain wildcards.
6. **API keys are in scope**: user-generated via the `@better-auth/api-key` plugin, hashed at rest, shown once, revocable, listed with a displayable `start` hint and last-request timestamp. A key authenticates as its owner with the owner's role — no scope model this pass. **Explicit verification** (`auth.api.verifyApiKey`) in our middleware; the plugin's `enableSessionForAPIKeys` mode stays off (its own docs mark it not recommended for production).
7. **Valet MCP server (walking skeleton).** better-auth's `mcp` plugin makes Valet an OAuth **authorization server** (dynamic client registration, authorize/token/consent endpoints, `/.well-known` discovery), so Claude or any remote MCP client can OAuth in as a Valet user. This pass ships the OAuth plumbing plus a minimal `/mcp` endpoint (Streamable HTTP, `withMcpAuth`-guarded) exposing two tools: `whoami` and `list_sessions`. The full Valet tool surface over MCP is a follow-up design.
8. **Sandbox auth is in scope — the internal token stops being the sandbox story.**
   - The `x-valet-internal` token is redefined as **process-internal only**: it authenticates loopback calls from the api's own process (today's orchestrator `mem_*` tools). It never enters a container. Behavior unchanged, contract narrowed and documented.
   - **Per-session sandbox tokens** are the credential for anything running inside a sandbox that calls the api: minted at sandbox provision (`st_` opaque token, SHA-256 hash stored in a `sandbox_tokens` table with `session_id`, `user_id`, `org_id`, `created_at`, `expires_at`, `revoked_at`), injected into the container env (`VALET_SANDBOX_TOKEN`, `VALET_API_URL`), revoked when the session stops. A request bearing one gets a **constrained principal** — `c.var.sandbox = { sessionId, userId, orgId }`, NOT `c.var.user` — and only routes that opt into the sandbox principal accept it. The token binds the owner: no trusting caller-supplied owner headers on this path.
   - **Browser→sandbox service-JWT primitives** ship now; the gateway that consumes them is a later pass. Carried from v1: a per-session signing secret derived as `HMAC-SHA256(master secret, sessionId)` — the sandbox can verify JWTs without holding the master secret, and a compromised sandbox cannot forge tokens for other sessions. The api exposes `POST /api/sessions/:id/sandbox-jwt` (session-access-gated) minting a short-lived (10-minute) HS256 JWT `{ sub: userId, sid: sessionId, iat, exp }`; sandbox-docker injects the derived secret as `VALET_SANDBOX_JWT_SECRET` into the container env. The master secret is `VALET_SANDBOX_JWT_MASTER` (falls back to `BETTER_AUTH_SECRET` when unset — one fewer required var; the derivation isolates sessions either way).
9. **The dev stub survives**: `VALET_LOCAL_AUTH=1` keeps today's single-local-user behavior as the LAST rung of the middleware ladder, so `make dev-local` and the existing test fleet run unchanged. `VALET_TEST_AUTH_HEADER` impersonation stays test-bootstrap-only, exactly as documented in `middleware/auth.ts` today.
10. **Carried over from v1** (`packages/worker` auth, the proven parts): `finalizeIdentityLogin` provisioning semantics (match-by-email, first-user-promote, invite-by-code OR invite-by-email with role attached), the provider-token → credential-store hook (login doubles as connecting an integration), name backfill from identity, api-token prefix/last-used UX, and `deriveSandboxJwtSecret`'s per-session key-derivation construction (decision 8). NOT carried: the `IdentityProvider` plugin registry, hand-rolled state JWTs/sessions/password hashing/rate limiting, the SAML endpoint — better-auth and Keycloak replace all of it.
11. **Pre-1.0 schema policy applies**: all new tables fold into the `0000` api migration; no new numbered migrations; `rm ~/.valet/app.db` after schema edits.
12. **Database portability is preserved, not implemented.** SQLite (better-sqlite3) is the only backend this pass, but Postgres and Cloudflare D1 must remain reachable: better-auth's Drizzle adapter is dialect-parametric (`sqlite`/`pg`/`mysql`; D1 is sqlite-dialect), so the constraint falls on OUR code — auth modules (`invites`, `sandbox-tokens`, `provisioning`, middleware) take an injected Drizzle `Db` and use the query builder exclusively: no raw SQL strings, no better-sqlite3 APIs. Multi-backend itself (parallel `pg-core` schema, dialect migrations, `store-postgres`, a PG `CredentialStore`) is a later pass.

## Architecture

```
packages/api/src/auth/
├── index.ts          # buildAuth(deps): the configured better-auth instance
├── config.ts         # env parsing: AUTH_* vars → typed AuthConfig (or "stub mode")
├── provisioning.ts   # hooks: invite gate, first-user-admin, org membership,
│                     #   name backfill, provider-token → credential-store capture
├── invites.ts        # invite create/validate/consume (Valet-owned table)
├── sandbox-tokens.ts # per-session sandbox token mint/verify/revoke + JWT derivation/mint
└── mcp.ts            # /mcp endpoint: withMcpAuth + minimal MCP tool handler
```

- One better-auth instance built at boot in `main.ts` (alongside `buildProviders`), mounted on Hono:
  ```ts
  app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.get("/.well-known/oauth-authorization-server", (c) => oAuthDiscoveryMetadata(auth)(c.req.raw));
  app.get("/.well-known/oauth-protected-resource", (c) => oAuthProtectedResourceMetadata(auth)(c.req.raw));
  app.all("/mcp", (c) => mcpHandler(auth)(c.req.raw));   // auth/mcp.ts, withMcpAuth-guarded
  ```
  better-auth owns everything under `/api/auth/*`: signup, login, logout, session, social + SSO redirects/callbacks, api-key endpoints, MCP authorize/token/register/consent. (v2 already moved profile reads to `/api/me`, so no collision with v1's `/api/auth/me`.)
- `authMiddleware` (existing file) grows the ladder below and remains the ONLY place that sets `c.var.user`. No route handler changes.
- The web client uses `createAuthClient` from `better-auth/react` with `inferAdditionalFields`, `ssoClient()`, and `apiKeyClient()` plugins, for `/login`, `/signup`, and the API-keys settings section. All other data fetching keeps the existing TanStack Query layer.

### Config (`config.ts`)

| Env var | Meaning |
|---|---|
| `BETTER_AUTH_SECRET` | Required to enable real auth. Absent → stub-only mode (today's behavior). |
| `BETTER_AUTH_URL` | External base URL of the api. Default `http://localhost:8788`. |
| `AUTH_OIDC_ISSUER` / `AUTH_OIDC_CLIENT_ID` / `AUTH_OIDC_CLIENT_SECRET` | Enterprise OIDC (Keycloak). All three required together. |
| `AUTH_OIDC_NAME` | Login button label (default `SSO`). |
| `AUTH_OIDC_DOMAIN` | Email domain for the SSO provider registration (the sso plugin requires one; also enables domain-matched sign-in). |
| `AUTH_GOOGLE_CLIENT_ID` / `AUTH_GOOGLE_CLIENT_SECRET` | Optional social provider. |
| `AUTH_GITHUB_CLIENT_ID` / `AUTH_GITHUB_CLIENT_SECRET` | Optional social provider. |
| `AUTH_TRUSTED_ORIGINS` | Comma-separated extra origins (dev default adds `http://localhost:5173` for the Vite proxy). When OIDC is enabled, MUST include the issuer's origin — the sso plugin rejects discovery URLs outside `trustedOrigins` (`discovery_untrusted_origin`, sign-in 400s). |
| `AUTH_ALLOWED_EMAIL_DOMAINS` | Optional comma-separated domains admitted without an invite (decision 5). |
| `VALET_SANDBOX_JWT_MASTER` | Optional master secret for per-session service-JWT derivation; falls back to `BETTER_AUTH_SECRET`. |

Keycloak is configured via the sso plugin's **`defaultSSO` option** (config-only, idempotent, takes precedence over DB rows — no `sso_provider` seeding, no `registerSSOProvider` call, which requires a session and is non-idempotent). Set `trustEmailVerified: true` on the plugin: we trust the enterprise IdP's `email_verified` claim.

Keycloak client config gets redirect URI `{BETTER_AUTH_URL}/api/auth/sso/callback/oidc`; social providers use `{BETTER_AUTH_URL}/api/auth/callback/{google|github}`. Google is configured with `accessType: "offline"` + `prompt: "select_account consent"` so a refresh token is captured. better-auth requests the `offline_access` scope on SSO sign-in, so Keycloak users need the `offline_access` realm role (default in stock realms; explicit in imported ones) or the token exchange fails with `not_allowed`. A local Keycloak harness for this flow ships in `docker-compose.yml` (`make dev-keycloak`, realm import at `docker/keycloak/valet-realm.json`).

Rate limiting: better-auth's built-in limiter (enabled in production; `/sign-in/email` 3 req/10s built-in rule). In-memory storage is acceptable — the api is a single Node process.

## Schema

better-auth's `user` model **is** our `users` table. The existing table is reshaped to better-auth's expected columns (`name` NOT NULL, `email` unique, `email_verified`, `image`, ms-epoch `created_at`/`updated_at`) plus our `additionalFields`: `role` (`required, input: false` — set by provisioning, never by clients) and `default_model` (nullable). `org_members.user_id` keeps pointing at the same ids.

New tables, transcribed verbatim from the CLI-generated Drizzle schema (research §1) into the api `0000` migration + `packages/api/src/schema/`:

- `session`, `account`, `verification` — core. `account` holds password hashes AND linked social/SSO identities per user, including IdP tokens (`access_token`, `refresh_token`, `id_token`, expiries, `scope`) — this is what makes "same email via Google and via password" one user with two accounts, and what feeds the credential-capture hook.
- `sso_provider` — sso plugin (table required even though we configure via `defaultSSO`).
- `apikey` — api-key plugin. Note: owner column is `reference_id` (not `user_id`), plus `config_id` (default `"default"`), `start` (displayable first chars), `prefix`, `last_request`, `expires_at`, `enabled`, rate-limit columns.
- `oauth_application`, `oauth_access_token`, `oauth_consent` — MCP plugin (dynamic client registration + issued tokens + consent records).
- `invites` — **Valet-owned**: `id`, `code_hash` (SHA-256 of the invite code), `email` (nullable — when set, the invite auto-matches that address; required path for social signups), `role` (`admin` | `member`), `created_by`, `created_at`, `expires_at`, `accepted_by` (nullable), `accepted_at` (nullable).
- `sandbox_tokens` — **Valet-owned**: `id`, `token_hash` (SHA-256), `session_id`, `user_id`, `org_id`, `created_at`, `expires_at`, `revoked_at` (nullable).

Dependency alignment: bump `better-sqlite3` to `^12` and `drizzle-orm` to `^0.45.2` in `packages/api` + `packages/store-sqlite` (better-auth peer ranges; Node 22 satisfies both).

## Middleware ladder

`authMiddleware` — first match wins:

1. **Internal token**: valid `x-valet-internal` → pass through without `c.var.user` (process-internal callers only; unchanged behavior, narrowed contract).
1b. **Sandbox token**: `x-valet-sandbox: st_…` → hash lookup in `sandbox_tokens` (unexpired, unrevoked) → `c.var.sandbox = { sessionId, userId, orgId }` — NOT `c.var.user`. Routes opt in to the sandbox principal explicitly (this pass: the memory routes, which derive their owner tuple from it instead of trusting `x-valet-owner` headers on this path).
2. **Session**: `auth.api.getSession({ headers })` → `{ session, user } | null`; on hit, `c.var.user = { id, email, name, role, orgId }` (`role`/`defaultModel` ride on the returned user via additionalFields; `orgId` from the single org row, cached).
3. **API key**: `x-api-key` header present → `auth.api.verifyApiKey({ body: { key } })` → on `valid`, load the owner via `key.referenceId` → same `c.var.user` shape. The plugin updates `last_request` itself.
4. **Dev stub**: `VALET_LOCAL_AUTH=1` → today's hardcoded local user (and the separately-gated test impersonation header).
5. Otherwise → 401 `{ error: "unauthorized" }`.

Rungs 2–3 exist only when `BETTER_AUTH_SECRET` is configured; without it the ladder is exactly today's behavior.

MCP requests do not use this ladder: the `/mcp` endpoint is guarded by `withMcpAuth` (Bearer tokens from the `oauth_access_token` table), and the handler derives the acting user from the MCP session's `userId`.

## Provisioning & invites

Ports v1's `finalizeIdentityLogin` semantics onto better-auth's verified hook points:

**Admission rule (one function, used by both gates):** admit when (in order) the db has zero users (→ role `admin`), OR the email's domain matches `AUTH_ALLOWED_EMAIL_DOMAINS` (→ `member`), OR a valid invite matches by code or email (→ the invite's role). Enterprise SSO paths skip the rule entirely (→ `member`, or `admin` if first user).

**Invite gate — `hooks.before`** (`createAuthMiddleware`, sees the raw body): on `ctx.path === "/sign-up/email"`, apply the admission rule with `ctx.body.inviteCode` (extra body keys pass schema validation and are not persisted) + the signup email. Reject with `APIError("FORBIDDEN", { message: "an invite is required to join this deployment" })`.

**Creation gate for OAuth paths — `databaseHooks.user.create.before`**: receives `(user, context)`; `context?.path` distinguishes the flow — `"/sign-up/email"` (already gated above), `"/callback/:id"` / `"/sign-in/social"` (social), `"/sso/callback/:providerId"` (enterprise SSO). Social paths apply the admission rule with `user.email` (no code available — domain match or email-targeted invite only); on failure return `false` (aborts creation). SSO paths always pass. This hook also returns `{ data }` to stamp `role` per the admission rule's outcome.

**Post-create provisioning — `databaseHooks.user.create.after`**: create the org row if absent; insert the `org_members` row with the resolved role; mark the matched invite accepted (`accepted_by`, `accepted_at`).

**Provider-token capture — `databaseHooks.account.create.after`** (+ sso plugin's `provisionUser` callback): when a social/SSO account row carries tokens and the provider maps to a known integration service (google → the Google plugins' service, github → github), copy tokens into the v2 `SqliteCredentialStore` for that user — v1's "login doubles as connecting the integration". For plain Keycloak this is a no-op; the seam is the point.

**Name backfill**: identity name → `users.name` when empty (better-auth handles this on OAuth flows; the hook covers edge cases). Git-config fields arrive with a later sessions pass and will reuse this hook.

**Invite management (Valet routes, org-admin gated via existing `isOrgAdmin`):**
- `POST /api/org/invites` `{ email?, role }` → URL-safe code (shown once, hash stored), 7-day default expiry → `{ id, code, email, role, expiresAt }`.
- `GET /api/org/invites` → pending invites (no codes).
- `DELETE /api/org/invites/:id` → revoke.
- Members settings page gains an **Invite** action (dialog: optional email, role picker, copyable link `{web}/signup?invite={code}`) and a pending-invites list with revoke. An email-targeted invite is required for invitees who'll sign in with Google/GitHub — the dialog copy says so.

## API keys

- Settings → **You** → new **API keys** section: create (named, secret displayed once), list (`start` hint, created, last used, expiry), revoke. Backed by the plugin's own endpoints via `apiKeyClient()`.
- Server config: `apiKey({ defaultPrefix: "vlt_", rateLimit: { enabled: false } })` — Valet keys are power-user credentials; better-auth's per-key rate limiting defaults (10 req/day) are wrong for us.
- Wire: `x-api-key: vlt_…` (middleware rung 3).

## Sandbox auth (`auth/sandbox-tokens.ts`)

Two credentials, one file, both independent of better-auth:

**Sandbox→api tokens.** `mintSandboxToken(sessionId, userId, orgId, ttl)` → `st_{48 hex}` (returned once; SHA-256 hash stored). The engine host's sandbox provision path calls it and injects `VALET_SANDBOX_TOKEN` + `VALET_API_URL` into the container env (sandbox-docker `create` env plumbing); session stop/hibernate revokes (`revoked_at`). `verifySandboxToken(token)` → `{ sessionId, userId, orgId } | null` (unexpired, unrevoked; constant-time hash compare). Middleware rung 1b consumes it. TTL: 24h, re-minted on session restore — an evicted/restored sandbox gets a fresh token, and hibernated sandboxes hold only expired/revoked credentials.

**Browser→sandbox service JWTs.** `deriveSandboxJwtSecret(master, sessionId)` = hex(HMAC-SHA256(master, sessionId)) — v1's proven construction: the container can verify JWTs without the master secret, and one sandbox's secret is useless for another session. `mintSandboxJwt(master, sessionId, userId)` → HS256 JWT `{ sub, sid, iat, exp: +10min }` (via `jose` or the few lines of node:crypto v1 used). Surface:
- `POST /api/sessions/:id/sandbox-jwt` → `{ token, expiresAt }`, gated on the caller's access to the session (owner this pass).
- sandbox-docker injects `VALET_SANDBOX_JWT_SECRET` (the derived secret) into the container env at create.
- No in-sandbox consumer ships this pass (the gateway is a later pass); the contract is pinned by tests: a JWT minted by the api verifies against the derived secret inside the container env, expired/cross-session JWTs fail.

## Valet MCP server (walking skeleton)

- `mcp({ loginPage: "/login" })` plugin on the instance; discovery + OAuth endpoints as in Architecture.
- `auth/mcp.ts`: an `app.all("/mcp")` handler wrapped in `withMcpAuth(auth, handler)`. The handler speaks MCP Streamable HTTP via `@modelcontextprotocol/sdk` server primitives and exposes:
  - `whoami` → the acting user's id/email/role.
  - `list_sessions` → the user's sessions (id, title, status) via the existing session service.
- Acting user = `session.userId` from the validated OAuth token; tool handlers reuse existing services (no bespoke queries).
- Success criterion: Claude (or MCP inspector) completes dynamic client registration + OAuth against Valet and calls both tools.

## Frontend (`packages/web`)

- New public routes `/login` and `/signup` (and `/signup?invite=…`), designed under the frontend-design skill in the app's established idiom. Login: email/password form, then social buttons (Google/GitHub) and "Continue with {AUTH_OIDC_NAME}" as configured. A tiny unauthenticated `GET /api/auth-config` returns `{ stub: boolean, social: ("google"|"github")[], sso?: { name } }` and drives which controls render.
- Signup accepts the invite code (prefilled from the URL); social/SSO buttons appear there too (social signup succeeds only with an email-targeted invite; copy explains a rejected social signup).
- Route guard: api 401 + stub off → redirect to `/login`. Stub on → unchanged (no login wall in `make dev-local`).
- Signed-in chrome: user menu gains Sign out (`authClient.signOut()`).
- Session transport is better-auth's cookie (`better-auth.session_token`, SameSite=Lax, httpOnly). The Vite dev proxy keeps everything same-origin; `AUTH_TRUSTED_ORIGINS` covers the direct-origin case. The WS upgrade rides the same cookie.

## Testing

- **Middleware matrix**: session cookie / api key / internal token / sandbox token / stub / nothing→401; stub disabled when `VALET_LOCAL_AUTH≠1`; rungs 2–3 absent in stub-only mode; sandbox principal never satisfies user-only routes.
- **Sandbox tokens**: mint→verify round-trip; expired/revoked fail; revocation on session stop; memory routes accept the sandbox principal and derive the owner tuple from it; JWT derivation/mint: derived-secret verify succeeds, cross-session and expired JWTs fail; container env carries `VALET_SANDBOX_TOKEN`/`VALET_SANDBOX_JWT_SECRET` (sandbox-docker unit test on the create env).
- **Domain admission**: matching email admitted without invite as member (password + social paths); non-matching still requires invite; case-insensitivity; unset → invite-only.
- **Signup gates**: first user (password) → admin + org + membership; second password signup without invite rejected; with code-invite joins with invite role; email-matched invite auto-consumes; expired/revoked/accepted invites rejected; single-use enforced. Social-path creation hook: rejected without email-matched invite, admitted with one (unit-tested by invoking the hook with a synthesized social context). SSO-path: admitted without invite as member.
- **Provisioning**: role stamping via `create.before` data; org_members rows; invite acceptance bookkeeping; account-token capture writes to the credential store (fake account row with tokens).
- **API keys**: create/list/revoke round-trip via plugin endpoints; revoked/expired key fails rung 3; `verifyApiKey` path sets the right user; secret never re-readable.
- **MCP**: discovery endpoints serve metadata; `withMcpAuth` rejects missing/invalid Bearer; with a token minted through the OAuth flow (or directly seeded `oauth_access_token` row), `whoami` and `list_sessions` return the acting user's data.
- **E2E**: boot with `BETTER_AUTH_SECRET`, `VALET_LOCAL_AUTH` off → signup → login → cookie-authed `GET /api/me` → API key create → key-authed request.
- Existing fleet: entire current suite stays green with no env changes (stub path untouched).

## Non-goals (this pass)

- Multi-tenant / per-org IdP configuration; IdP admin UI.
- SAML terminating at Valet (Keycloak brokers it).
- API-key scopes/permissions; org-level login-provider toggles; email delivery of invites (link-sharing only); password reset / email verification flows (need a mailer — follow-up; better-auth supports both when one exists).
- The full Valet MCP tool surface (own design pass; this pass proves the OAuth plumbing with two tools).
- The in-sandbox auth gateway itself (v1's :9000 proxy) and any in-sandbox services consuming the service JWTs — this pass ships the tested token/JWT contract only.
- Multi-org.
