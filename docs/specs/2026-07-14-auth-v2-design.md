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
5. **Signup policy: every signup gated by trust source, the first one too.**
   - No signup becomes admin by being first: on a reachable host that would be anyone. `AUTH_ADMIN_EMAILS` names the administrators; each becomes admin on SSO sign-in, or on Google/GitHub sign-in with a verified email, and an existing user with a verified identity is promoted at boot. Config-declared admins (`org.members` with `role: admin`) and admin invites still work. While no admin exists and SSO is off, each boot prints a one-time admin sign-up link to the server log only. With SSO on, no admin, and nobody declared, the api refuses to boot. Password sign-up cannot claim an administrator's email (an `AUTH_ADMIN_EMAILS` entry or a pending admin invite's target) without an admin invite code, because it does not verify email ownership (`auth/bootstrap-admin.ts`, `auth/provisioning.ts`).
   - **Email/password** signups require an invite: a code presented at signup, or an unexpired invite matching the email.
   - **Social** (Google/GitHub) signups require an **email-targeted invite** — configuring Google as a login option must not admit every Google account on the internet, and OAuth redirects can't carry a code, so admission is by invite-matching-email only.
   - **Enterprise SSO (OIDC/Keycloak)** signups skip invites entirely — the IdP is the deployment's access control; anyone it authenticates is provisioned as a member.
   - **Allowed email domains act as a standing invite**: when `AUTH_ALLOWED_EMAIL_DOMAINS` is set (comma-separated, e.g. `example.com,example.dev`), a signup (password or social) whose email domain matches is admitted WITHOUT an invite, as `member`. Explicit invites still admit non-matching emails (external-contractor case). Unset → invite-only as above. Matching is on the exact domain of the email address, case-insensitive, no subdomain wildcards.
6. **API keys are in scope**: user-generated via the `@better-auth/api-key` plugin, hashed at rest, shown once, revocable, listed with a displayable `start` hint and last-request timestamp. A key authenticates as its owner with the owner's role — no scope model this pass. **Explicit verification** (`auth.api.verifyApiKey`) in our middleware; the plugin's `enableSessionForAPIKeys` mode stays off (its own docs mark it not recommended for production).
7. **Valet MCP server (walking skeleton).** better-auth's `mcp` plugin makes Valet an OAuth **authorization server** (dynamic client registration, authorize/token/consent endpoints, `/.well-known` discovery), so Claude or any remote MCP client can OAuth in as a Valet user. This pass ships the OAuth plumbing plus a minimal `/mcp` endpoint (Streamable HTTP, `withMcpAuth`-guarded) exposing two tools: `whoami` and `list_sessions`. The agent tool surface is in [MCP agent tools](./2026-10-07-mcp-agent-tools-design.md).
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
| `AUTH_METHODS` | Comma list of the sign-in methods to turn on: `password`, `oidc`, `google`, `github`. Empty turns every method off, so nobody can sign in. Unset turns on `oidc` alone when OIDC is configured (SSO with no password), and turns every method off otherwise. A provider with credentials stays off until it is listed. A listed provider without credentials, or an unknown name, stops the boot. Example: `password` for password sign-in only; `oidc` for SSO only. |
| `AUTH_PRIMARY_METHOD` | The method the login page shows first. It must be in `AUTH_METHODS`. Default: the first listed method. |
| `AUTH_OIDC_ISSUER` / `AUTH_OIDC_CLIENT_ID` / `AUTH_OIDC_CLIENT_SECRET` | Enterprise OIDC (Keycloak). All three required together. |
| `AUTH_OIDC_NAME` | Login button label (default `SSO`). |
| `AUTH_OIDC_DOMAIN` | Email domain for the SSO provider registration (the sso plugin requires one; also enables domain-matched sign-in). |
| `AUTH_GOOGLE_CLIENT_ID` / `AUTH_GOOGLE_CLIENT_SECRET` | Optional social provider. |
| `AUTH_GITHUB_CLIENT_ID` / `AUTH_GITHUB_CLIENT_SECRET` | Optional social provider. |
| `AUTH_TRUSTED_ORIGINS` | Comma-separated extra origins (dev default adds `http://localhost:5173` for the Vite proxy). When OIDC is enabled, MUST include the issuer's origin — the sso plugin rejects discovery URLs outside `trustedOrigins` (`discovery_untrusted_origin`, sign-in 400s). |
| `AUTH_ALLOWED_EMAIL_DOMAINS` | Optional comma-separated domains admitted without an invite (decision 5). |
| `AUTH_MCP_REGISTRATION` | `open` (default) or `off`. Off refuses new MCP client registrations with a 403 that names the fix. Apps that already connected keep working. See "MCP client registration". |
| `AUTH_MCP_REGISTRATION_RATE_PER_HOUR` | Registrations each address may make in an hour. Default `10`; `0` turns the limit off. |
| `AUTH_MCP_UNCONSENTED_CLIENT_CAP` | Registration is refused while this many clients from the last day have no consent and no token. Default `200`; `0` turns the cap off. |
| `AUTH_MCP_MAX_REDIRECT_URIS` | Redirect URIs one registration may hold. Default `5`; at least `1`. |
| `AUTH_MCP_APP_SCHEMES` | Comma list of native app schemes an MCP redirect URI may use (see "MCP client registration"). Unset means `claude,cursor`. Empty allows none. `http`, `https`, `javascript`, `data`, `file`, and similar schemes stop the boot. |
| `VALET_SANDBOX_JWT_MASTER` | Optional master secret for per-session service-JWT derivation; falls back to `BETTER_AUTH_SECRET`. |

Keycloak is configured via the sso plugin's **`defaultSSO` option** (config-only, idempotent, takes precedence over DB rows — no `sso_provider` seeding, no `registerSSOProvider` call, which requires a session and is non-idempotent). Set `trustEmailVerified: true` on the plugin: we trust the enterprise IdP's `email_verified` claim.

The `defaultSSO` provider (id `oidc`) is the only SSO provider. The sso plugin also serves routes that let any signed-in user register, edit, and list `sso_provider` rows, and sign-in falls back to those rows by provider id or email domain. The api then fetches a stored row's token and userinfo URLs, and the plugin checks them only by hostname at save time. `guardSsoRoutes` (`auth/sso-hooks.ts`, called from `beforeHook`) returns 403 for every `/sso/*` and `/sign-in/sso` request except sign-in with `providerId: "oidc"`, `/sso/callback/oidc`, and the shared `/sso/callback`. With no OIDC configured, it refuses all of them. Stored rows stay in the table but can no longer be used.

Keycloak client config gets redirect URI `{BETTER_AUTH_URL}/api/auth/sso/callback/oidc`; social providers use `{BETTER_AUTH_URL}/api/auth/callback/{google|github}`. Google is configured with `accessType: "offline"` + `prompt: "select_account consent"` so a refresh token is captured. better-auth requests the `offline_access` scope on SSO sign-in, so Keycloak users need the `offline_access` realm role (default in stock realms; explicit in imported ones) or the token exchange fails with `not_allowed`. A local Keycloak harness for this flow ships in `docker-compose.yml` (`make dev-keycloak`, realm import at `docker/keycloak/valet-realm.json`).

Rate limiting: better-auth's built-in limiter (enabled in production; `/sign-in/email` 3 req/10s built-in rule). In-memory storage is acceptable — the api is a single Node process.

## Schema

better-auth's `user` model **is** our `users` table. The existing table is reshaped to better-auth's expected columns (`name` NOT NULL, `email` unique, `email_verified`, `image`, ms-epoch `created_at`/`updated_at`) plus our `additionalFields`: `role` (`required, input: false` — set by provisioning, never by clients) and `default_model` (nullable). `org_members.user_id` keeps pointing at the same ids.

New tables, transcribed verbatim from the CLI-generated Drizzle schema (research §1) into the api `0000` migration + `packages/api/src/schema/`:

- `session`, `account`, `verification` — core. `account` holds password hashes AND linked social/SSO identities per user, including IdP tokens (`access_token`, `refresh_token`, `id_token`, expiries, `scope`) — this is what makes "same email via Google and via password" one user with two accounts, and what feeds the credential-capture hook.
- `sso_provider` — sso plugin (table required even though we configure via `defaultSSO`).
- `apikey` — api-key plugin. Note: owner column is `reference_id` (not `user_id`), plus `config_id` (default `"default"`), `start` (displayable first chars), `prefix`, `last_request`, `expires_at`, `enabled`, rate-limit columns.
- `oauth_application`, `oauth_access_token`, `oauth_consent` — MCP plugin (dynamic client registration + issued tokens + consent records). `mcpRegisterGate` checks and limits new `oauth_application` rows (see "MCP client registration").
- `invites` — **Valet-owned**: `id`, `code_hash` (SHA-256 of the invite code), `email` (nullable — when set, the invite auto-matches that address; required path for social signups), `role` (`admin` | `member`), `created_by`, `created_at`, `expires_at`, `accepted_by` (nullable), `accepted_at` (nullable).
- `sandbox_tokens` — **Valet-owned**: `id`, `token_hash` (SHA-256), `session_id`, `user_id`, `org_id`, `created_at`, `expires_at`, `revoked_at` (nullable).

Dependency alignment: bump `better-sqlite3` to `^12` and `drizzle-orm` to `^0.45.2` in `packages/api` + `packages/store-sqlite` (better-auth peer ranges; Node 22 satisfies both).

## Middleware ladder

`authMiddleware` — first match wins:

1. **Internal token**: valid `x-valet-internal` → pass through without `c.var.user` (process-internal callers only; unchanged behavior, narrowed contract).
1b. **Sandbox token**: `x-valet-sandbox: st_…` → hash lookup in `sandbox_tokens` (unexpired, unrevoked) → `c.var.sandbox = { sessionId, userId, orgId }` — NOT `c.var.user`. Routes opt in to the sandbox principal explicitly (this pass: the memory routes, which derive their owner tuple from it instead of trusting `x-valet-owner` headers on this path).
   (2026-10-14) `POST /api/sandbox/actions/:toolId/invoke` also opts in, for workflow step sessions of an active run only (`workflowSessionOwner`; a settled or cancelled run gets 409). A script in the step's sandbox calls an integration action with exactly the power of the step's agent: the action invoker runs in the tool broker's external mode, so `appliesIn: "session"` policies apply and no workflow grant meant for `tool` nodes does. The run owner's credentials make the call, each call writes an Action Log row, and no credential reaches the sandbox. A call that policy holds for approval is refused, because a script cannot wait for a person. Valet's own services stay refused. An `idempotencyKey`, namespaced by run, step, tool, and params, makes a retry return the first result; a failed result is not kept. A keyed call holds the same claim row as the broker route (`invokeOnce`), so a retry that overlaps the first call gets `in_progress` and the action runs once. V1 scripts reached integrations through the runner's tool gateway; this route replaces that for workflow steps.
2. **Session**: `auth.api.getSession({ headers })` → `{ session, user } | null`; on hit, `c.var.user = { id, email, name, role, orgId }` (`role`/`defaultModel` ride on the returned user via additionalFields; `orgId` from the single org row, cached).
3. **API key**: `x-api-key` header present → `auth.api.verifyApiKey({ body: { key } })` → on `valid`, load the owner via `key.referenceId` → same `c.var.user` shape, plus a request principal (`c.var.principal`). A key whose `metadata.teamId` names a live team in the same org authenticates as that team: the principal is `{ type: "team", id }`, `c.var.user` stays the creating admin for audit only, and `refuseTeamKeyOutsideScope` limits the key to sessions, workflows, GET `/api/me` and its own team's orchestrator (`docs/specs/2026-09-04-team-api-keys-design.md`). A deleted or cross-org team reads as an invalid key. The plugin updates `last_request` itself.
4. **Dev stub**: `VALET_LOCAL_AUTH=1` → today's hardcoded local user (and the separately-gated test impersonation header).
5. Otherwise → 401 `{ error: "unauthorized" }`.

Rungs 2–3 exist only when `BETTER_AUTH_SECRET` is configured; without it the ladder is exactly today's behavior.

The `/mcp` request itself does not use this ladder: `withMcpAuth` guards it (Bearer tokens from the `oauth_access_token` table), and the handler derives the acting user from the MCP session's `userId`. The agent tools then call `/api` routes in-process. Those calls enter the ladder at rung 1b, which accepts the verified MCP user attached to the in-process request and refuses routes outside the MCP allow-list (`auth/mcp-caller.ts`).

## Provisioning & invites

Ports v1's `finalizeIdentityLogin` semantics onto better-auth's verified hook points:

**Admission rule (one function, used by both gates):** admit when (in order) a valid invite matches by code or email (→ the invite's role), OR the email's domain matches `AUTH_ALLOWED_EMAIL_DOMAINS` (→ `member`). Enterprise SSO paths skip the rule entirely (→ `member`, or the invite's role when an invite matches the email). An `AUTH_ADMIN_EMAILS` entry is `admin` on SSO, and on social sign-in with a verified email. No rule admits the first user as admin.

**Invite gate — `hooks.before`** (`createAuthMiddleware`, sees the raw body): on `ctx.path === "/sign-up/email"`, apply the admission rule with `ctx.body.inviteCode` (extra body keys pass schema validation and are not persisted) + the signup email. Reject with `APIError("FORBIDDEN", { message: "an invite is required to join this deployment" })`.

**Creation gate for OAuth paths — `databaseHooks.user.create.before`**: receives `(user, context)`; `context?.path` distinguishes the flow — `"/sign-up/email"` (already gated above), `"/callback/:id"` / `"/sign-in/social"` (social), `"/sso/callback/:providerId"` (enterprise SSO). Social paths apply the admission rule with `user.email` (no code available — domain match or email-targeted invite only); on failure return `false` (aborts creation). SSO paths always pass. This hook also returns `{ data }` to stamp `role` per the admission rule's outcome.

**Post-create provisioning — `databaseHooks.user.create.after`**: create the org row if absent; insert the `org_members` row with the resolved role; mark the matched invite accepted (`accepted_by`, `accepted_at`).

**Provider-token capture — `databaseHooks.account.create.after`** (+ sso plugin's `provisionUser` callback): when a social/SSO account row carries tokens and the provider maps to a known integration service (google → the Google plugins' service, github → github), copy tokens into the v2 `SqliteCredentialStore` for that user — v1's "login doubles as connecting the integration". For plain Keycloak this is a no-op; the seam is the point.

**Explicit identity-provider team suggestions — sso plugin's `provisionUser` + `provisionUserOnEveryLogin: true`** (`services/team-join-eligibility.ts`, built in `buildAuthHooks`, passed to `sso()` in `auth/index.ts`): each single-sign-on login replaces the user's server-side join eligibility. The callback reads the configured group and asserted-marker claims. It maps rooted top-level paths to existing `origin='idp'` teams in the user's organization. An admin subgroup path establishes the same eligibility as its parent, but it grants no admin role.

Login never creates a team. Login never adds, removes, or changes a membership. Existing local, config-declared, and identity-provider-backed teams keep their rows, memberships, and owned resources. Identity-provider-backed teams remain editable through the normal team administration gate.

The `team_join_eligibilities` table stores only `team_id`, `user_id`, and `observed_at`. It does not duplicate claim values or group paths. An absent, unreadable, or empty claim replaces the user's snapshot with no rows. This fail-closed replacement prevents an old claim from authorizing a later join.

Eligibility expires after seven days. This bound is the documented Better Auth default session lifetime, which Valet now configures explicitly. Valet does not extend eligibility when Better Auth refreshes a session. The user must complete another single-sign-on login to refresh the identity-provider claim and eligibility.

`GET /api/teams/suggestions` returns only fresh eligible teams in the caller's organization that the caller has not joined. Each item contains the team id, display name, and member count. The response does not contain a group path or unrelated team.

`POST /api/teams/:id/join` checks fresh server-held eligibility, team provenance, organization scope, and current `org_members` membership inside one transaction. A missing, stale, non-eligible, or foreign-organization id returns the same existence-hiding 404. A successful join inserts role `member`. An admin subgroup never escalates this role. An existing membership makes the action idempotent and keeps its current role.

The Organization → Teams page shows these candidates under **Suggested teams** with an explicit **Join** button. It has no Team sync switch, group-path field, per-group switch, or Add group control.

The older `features.ssoTeamSync` and `auth.sso.teams.groups` configuration shapes remain readable for backward compatibility. They do not enable login-time membership reconciliation. The product does not expose controls for them. The claim-name configuration remains active because eligibility refresh needs it.

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

### CLI device sign-in

`valet login <url>` signs in with OAuth device authorization (RFC 8628) and gets a CLI token, not an API key (`routes/cli-device.ts`, `auth/cli-tokens.ts`, `cli/device-login.ts`). The person never copies a secret, and nothing listens on the CLI's computer, so the browser can be on another computer.

1. The CLI reads `GET /api/auth-config`. A stub-auth instance needs no credential, so the CLI saves a keyless profile.
2. The CLI posts its computer name to `POST /api/cli/device/code`. One client may start ten sign-ins a minute. The client key cannot be forged: it is the TCP peer address, or, when the peer is a loopback or private address (a proxy), the last `X-Forwarded-For` hop, which that proxy appended. An IPv6 address counts as its /64 block. The instance keeps at most 10,000 waiting sign-ins; when the table is full, a new one evicts the oldest unapproved one, so a flood shortens how long an old code waits but cannot refuse every new login. The route stores a `cli_device_requests` row (device code as a SHA-256 hash, ten minutes) and returns the device code, a user code such as `BCDF-GHJK`, and the page path `/cli/device`.
3. The CLI prints the user code and opens `<instance>/cli/device`. The page does not read the code from its URL: the person types it, so a link from someone else cannot approve their CLI with one click. A signed-out visitor is sent to `/login?next=`.
4. The page reads `GET /api/cli/device?user_code=` and shows the account, the computer, and the code. Allow or Deny posts to `POST /api/cli/device`. Only a browser session can decide (`authVia === "session"`), from a Valet origin.
5. The CLI polls `POST /api/cli/device/token` every five seconds. The route answers `authorization_pending`, `slow_down` for a faster poll, `access_denied`, or `expired_token`. After Allow, it deletes the request once and returns a token pair.

The CLI saves a waiting sign-in in `pendingLogins` in its config file (owner-only permissions), keyed by profile. A later `valet login` for that profile resumes it instead of starting a new one, and its first poll is immediate. `--no-wait` starts a sign-in, prints the code, and exits. An agent runs `--no-wait`, gives the person the code, and runs `valet login` again to finish, so no command has to run for minutes.

A CLI token pair is an access token (`vltc_`, one day) and a refresh token (`vltr_`, 30 days from its last use). `cli_tokens` stores only hashes. The CLI sends the access token in `x-api-key`, so every command and the stream socket work unchanged. Before a command runs, the CLI refreshes a token that expires within 12 hours (`POST /api/cli/token/refresh`). A refresh replaces both tokens in one conditional `UPDATE`, so a refresh token works once. For two minutes after a refresh, the replaced access token still works, so a command that read it just before is not refused. In the same window, the replaced refresh token works once more while the new pair is unused, which recovers a refresh whose response was lost; the CLI retries a refresh that failed in transit once. A lock file next to the CLI config (`withConfigLock`) serializes every config write that can overlap with another command (login, logout, refresh), and each one reloads the config under the lock before it saves, so no command writes an old copy over a newer one. A refresh records the replaced access tokens in the profile, and a long command that started with one finds that profile, and only that profile, again (`latestCredential`), even when two people sign in to one instance from one computer. `valet logout`, and a new `valet login` for the same profile, revoke the old pair (`POST /api/cli/token/revoke`). Expired rows are deleted when that person signs in again.

The auth middleware sends a `vltc_` value to `verifyCliAccessToken` instead of better-auth, and sets `authVia: "cli"`. The onboarding has the person's coding agent run `valet login`, so `isAgentCaller` treats this token like an MCP token. `refuseAgentAuthority` lets an agent read what its person can read, but write only to `AGENT_WRITES`, the routes the CLI and the MCP tools use: start and continue threads and sessions, upload files, answer decisions (`resolveDecision` still refuses every gate but a question), invoke tools, write memory, run workflows, publish artifacts, and preview a policy. Every other write gets 403. It is an allow-list so that a new route that touches approvals, policies, grants, linked accounts, or settings stays closed to agents until someone adds it on purpose. A key created in Settings keeps full authority. `valet login <url> --api-key -` saves one. An agent that can read a person's Settings key on the same computer can still use it. The server cannot tell those callers apart.

`valet proxy setup` uses the same routes with `purpose: "proxy-key"` (`docs/specs/2026-10-27-cli-proxy-setup-design.md`). The CLI starts the request with its CLI token. Only that token's user can approve it. The approved poll returns an API key with `metadata.scope = "proxy"` instead of a token pair. `identityFromApiKey` refuses a proxy-scoped key, so the key works only at the LLM proxy gateway. `AGENT_WRITES` gets one route, `DELETE /api/proxy/keys/:id`, which deletes only proxy-scoped keys.

### CLI behind Cloudflare Access

An instance can sit behind a Cloudflare Access app that accepts only an Access session. Access redirects every other request to `<team>.cloudflareaccess.com`, and `fetch` follows the redirect to an HTML login page. Cloudflare's method for a person's CLI is `cloudflared access`: a browser sign-in once, then a token in a `cf-access-token` header (https://developers.cloudflare.com/cloudflare-one/tutorials/cli/).

`cli/cloudflare-access.ts` holds this logic. `withAccess` sends a request. If the response was redirected to an Access host, or is a 3xx whose `location` is one, it gets a token and sends the request once more with the header. If no token passes, it throws `AuthError` with the `cloudflared` steps. The token comes from `VALET_CF_ACCESS_TOKEN`, else `cloudflared access token -app=<origin>`. When that has no token and stdin and stderr are a terminal, the CLI runs `cloudflared access login <origin>` (its output goes to stderr), then asks for the token again. The process keeps one lookup and one token per origin.

`InstanceClient`, the device sign-in requests, and the `auth-config` read in `valet login` use `withAccess`, so an instance without Access never runs `cloudflared`. The stream socket sends the token on the upgrade when the process has one. A WebSocket client cannot read the upgrade's redirect, so when the first connection fails before any frame, the stream checks `GET /api/health` once with `withAccess` and connects again with the token. The `valet proxy` harnesses and `/mcp` clients do not send the header; the Access app must exempt `/proxy` and `/mcp`, which use Valet's own auth.

### Agent access

Settings > Agent access (`routes/agent-access.ts`, `GET /api/me/agent-access`) lists the MCP apps that hold OAuth tokens for the person and the CLIs signed in with `valet login`. Disconnect deletes the app's `oauthAccessToken` and `oauthConsent` rows, or the CLI's `cli_tokens` row, so it stops working at once. An agent credential cannot disconnect anything.

## Sandbox auth (`auth/sandbox-tokens.ts`)

Two credentials, one file, both independent of better-auth:

**Sandbox→api tokens.** The host uses `getOrCreateSandboxToken` to adopt a durable bearer for the session's full principal. It injects `VALET_SANDBOX_TOKEN` and `VALET_API_URL` into the sandbox. A random row ID and the stable instance encryption key recover the bearer after restart; the database stores only its SHA-256 hash. Teardown revokes every session token. The expiry sentinel is year 9999, compatible with older verifiers during rolling updates. Legacy credentials that remain valid are adopted at boot or first use. Expired and revoked credentials stay invalid. See [Durable sandbox tokens](2026-09-16-durable-sandbox-tokens-design.md).

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

### MCP client registration

Registration at `POST /api/auth/mcp/register` stays open and needs no session. The MCP authorization spec expects it: Claude Code, Codex, claude.ai, and the Claude app register before anyone signs in. The person's protection is the consent page, so the gate (`auth/mcp-registration.ts`, `mcpRegisterGate`, before better-auth) checks what a registration may hold and how many arrive. better-auth's plugin alone stores any redirect URI.

**Redirect URIs.** Each URI must be `https://` with a full host name (at least one dot), `http://` on `localhost`, `127.0.0.1`, or `[::1]` with any port, or `<app scheme>://<host>` for a scheme in `AUTH_MCP_APP_SCHEMES` (RFC 8252 private-use scheme; the Claude app registers `claude://claude.ai/mcp-auth-callback/sdk`). The gate refuses wildcards (`*`), user names (`user@host`), fragments, commas (the plugin stores the list comma-joined), spaces, and any other scheme, including `javascript:` and `data:`. A registration holds one URI up to `AUTH_MCP_MAX_REDIRECT_URIS` (default 5). The gate reads the body as JSON only, so the plugin cannot read a body the gate did not check. The authorize handler (`mcpAuthorizeGate`) applies the same URI check to the `redirect_uri` it receives, so a client registered before this check cannot receive a code.

**Limits.** Each address may register `AUTH_MCP_REGISTRATION_RATE_PER_HOUR` clients an hour (default 10, with the address rules of the CLI device sign-in). A client is unapproved until it has an `oauth_consent` row or an `oauth_access_token` row. When `AUTH_MCP_UNCONSENTED_CLIENT_CAP` clients from the last 24 hours are unapproved (default 200), the gate refuses new registrations until some age out or someone approves one. `0` turns either limit off. Both limits live in Postgres, so every api replica shares them. The gate checks both limits and records the registration in `mcp_registrations` in one transaction under one advisory lock, so a burst cannot pass the check together. The row stays pending until better-auth has inserted the client, and a pending row counts toward the cap for at most five minutes. The same transaction deletes rows older than an hour, because neither limit reads them. Over a limit, the gate returns 429. Nothing deletes unapproved clients (CLAUDE.md, "Invariants: alert, don't auto-repair"). The `valet.mcp.client_registration` counter reports each registration by `outcome`, and the api logs a warning when the daily cap refuses one.

**Turning registration off.** `AUTH_MCP_REGISTRATION=off` refuses every registration with a 403 that names the fix. Apps that already registered still authorize and refresh. Use it on a deployment that no new MCP app should join, for example one only reachable through a private network.

**Settings.** `auth/config.ts` (`parseMcpRegistration`) reads every `AUTH_MCP_*` variable at boot, and an invalid value stops the boot with a message that names the variable. The Helm chart sets them from `api.auth.mcp.*` (`registration`, `registrationRatePerHour`, `unconsentedClientCap`, `maxRedirectUris`, `appSchemes`), rendered only when set, so an unset value keeps the api default.

**Consent page.** The app chooses its own name, so the page labels the name as unverified and shows where the code goes: the redirect URI's scheme and full host with port (`redirect_origin`, for example `https://app.example.com:8443` or `claude://claude.ai`). It warns when the code leaves the computer, which is any `https://` redirect.

To find unapproved clients, run this query. Review the rows before you delete them:

```sql
SELECT a.client_id, a.name, a.redirect_urls, a.user_id, a.created_at
FROM oauth_application a
WHERE NOT EXISTS (SELECT 1 FROM oauth_consent c WHERE c.client_id = a.client_id)
  AND NOT EXISTS (SELECT 1 FROM oauth_access_token t WHERE t.client_id = a.client_id)
ORDER BY a.created_at;
```

## Frontend (`packages/web`)

- New public routes `/login` and `/signup` (and `/signup?invite=…`), designed under the frontend-design skill in the app's established idiom. Login shows only the methods `AUTH_METHODS` turns on: the email/password form when `password` is on, social buttons (Google/GitHub), and "Continue with {AUTH_OIDC_NAME}". The primary method comes first and takes the primary button style. With no method on, the page says sign-in is not set up. A tiny unauthenticated `GET /api/auth-config` returns `{ stub, password, primary, social: ("google"|"github")[], sso: { name } | null }` and drives which controls render. better-auth also refuses `/sign-up/email` and `/sign-in/email` when `password` is off, so hiding the form is not the only guard.
- When `password` is off, `/signup` says the deployment does not use passwords and links to `/login`: an account comes from the SSO or social provider.
- Signup accepts the invite code (prefilled from the URL); social/SSO buttons appear there too (social signup succeeds only with an email-targeted invite; copy explains a rejected social signup).
- Route guard: api 401 + stub off → redirect to `/login`. Stub on → unchanged (no login wall in `make dev-local`).
- Signed-in chrome: user menu gains Sign out (`authClient.signOut()`).
- Session transport is better-auth's cookie (`better-auth.session_token`, SameSite=Lax, httpOnly). The Vite dev proxy keeps everything same-origin; `AUTH_TRUSTED_ORIGINS` covers the direct-origin case. The WS upgrade rides the same cookie.

## Testing

- **Middleware matrix**: session cookie / api key / internal token / sandbox token / stub / nothing→401; stub disabled when `VALET_LOCAL_AUTH≠1`; rungs 2–3 absent in stub-only mode; sandbox principal never satisfies user-only routes.
- **Sandbox tokens**: mint→verify round-trip; expired/revoked fail; revocation on session stop; memory routes accept the sandbox principal and derive the owner tuple from it; JWT derivation/mint: derived-secret verify succeeds, cross-session and expired JWTs fail; container env carries `VALET_SANDBOX_TOKEN`/`VALET_SANDBOX_JWT_SECRET` (sandbox-docker unit test on the create env).
- **Domain admission**: matching email admitted without invite as member (password + social paths); non-matching still requires invite; case-insensitivity; unset → invite-only.
- **Signup gates**: the boot-time bootstrap invite code (password) → admin + org + membership; a first signup without it is not an admin; a password signup naming an administrator's email without an admin code is refused; second password signup without invite rejected; with code-invite joins with invite role; email-matched invite auto-consumes; expired/revoked/accepted invites rejected; single-use enforced. Social-path creation hook: rejected without email-matched invite, admitted with one (unit-tested by invoking the hook with a synthesized social context). SSO-path: admitted without invite as member.
- **Provisioning**: role stamping via `create.before` data; org_members rows; invite acceptance bookkeeping; account-token capture writes to the credential store (fake account row with tokens).
- **API keys**: create/list/revoke round-trip via plugin endpoints; revoked/expired key fails rung 3; `verifyApiKey` path sets the right user; secret never re-readable.
- **MCP registration** (`auth/mcp-registration.test.ts`): open registration for https, loopback, and app scheme redirects; each refused redirect shape (wildcard, `https://victim@evil.example/cb`, `javascript:`, fragment, comma, dotless host, unlisted app scheme); the list cap; the JSON-only body; the per-address and daily limits at their defaults, at configured values, and off at `0`; `AUTH_MCP_REGISTRATION=off`; the authorize refusal for a client with a stored wildcard or user-name redirect; and the consent page's `redirect_origin` for an app scheme and a port. `auth/mcp-registration.postgres.test.ts` races two replicas, each with its own pool and its own copy of the gate module, against real Postgres (CI sets `TEST_DATABASE_URL`): at `cap - 1` exactly one registration passes, and the per-address limit holds across both.
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
- Per-service integration OAuth connect flows (Linear, Notion, Google APIs, etc. beyond the login-doubles-as-connect hook above) — specified in `2026-07-20-integration-oauth-design.md`.

## Unrestricted signup

`AUTH_ALLOW_SIGNUP=1` admits uninvited users only when `AUTH_ALLOWED_EMAIL_DOMAINS` is empty. A configured domain allowlist still restricts signup. The default remains invitation/domain admission. Enable it only on a deployment that means to accept any account.

The first-user administrator bootstrap and explicit invitation roles keep their existing behavior. Other unrestricted signups receive the member role. Existing login, sessions, account records, and integration connections remain unchanged. Set the flag to `0` or remove it to require invitations again. Existing accounts remain valid after that change.
