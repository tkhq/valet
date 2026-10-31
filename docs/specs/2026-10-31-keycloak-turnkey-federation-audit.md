# Keycloak to Turnkey Federation: Audit, Threat Model, and Gated Plan

**Date:** 2026-10-31
**Status:** Proposed. This document changes no code and no configuration.
**Scope:** How a Keycloak login could become a Turnkey-verifiable credential through Valet, what exists today, and what must exist first.

## Audit basis

- Valet: `origin/dev-v2` at `9a11bb0d2`. The first audit found the default checkout was legacy `main`. Every Valet fact below comes from the `dev-v2` tree.
- Turnkey mono: commit `177132f27a`, clean checkout.
- No tests ran during the audits. File reads and PR state are the only evidence.
- An open pull request is a proposal. This document does not treat one as current behavior.

## 1. Current architecture

### 1.1 Browser login to Valet principal

1. The browser calls better-auth through `packages/web/src/lib/auth-client.ts`. The client uses the `ssoClient` and `apiKeyClient` plugins and the same origin.
2. The better-auth instance is built in `packages/api/src/auth/index.ts`. It mounts at `/api/auth`. The SSO plugin has one default provider with `providerId: "oidc"`, `pkce: true`, and discovery at `{issuer}/.well-known/openid-configuration`.
3. `packages/api/src/auth/config.ts` reads `AUTH_OIDC_ISSUER`, `AUTH_OIDC_CLIENT_ID`, and `AUTH_OIDC_CLIENT_SECRET`. Set all three or none. The same file reads the team claim names (`groups`, `groups_asserted`, admin sub-group `admins`).
4. Keycloak authenticates the user and redirects to `/api/auth/sso/callback/*`. better-auth exchanges the code server-side and creates a session row.
5. `packages/api/src/auth/provisioning.ts` admits the user. Admission order: first user is admin, then invite, then open signup, then allowed email domain. A new SSO user is always created. If admission denies the user, the stamped role is `member`.
6. `provisionUser` runs on every SSO login. It reads the group claim and refreshes team join eligibility. It creates no team and changes no membership. The explicit join route grants the member role only.
7. `packages/api/src/middleware/auth.ts` resolves each request. The ladder, first match wins:
   1. `x-valet-internal` token (process-internal).
   2. MCP caller attached in-process by `auth/mcp-caller.ts`.
   3. `x-valet-sandbox` token.
   4. better-auth session (cookie or session header).
   5. `x-api-key` (`vlt_` key or `valet login` CLI token).
   6. Local stub, only when no auth instance exists and `VALET_LOCAL_AUTH=1`.
   7. 401.
8. `packages/api/src/lib/request-principal.ts` defines `RequestPrincipal` as `{type: "user"|"team", id}`. `AuthVia` is `session`, `apiKey`, `cli`, `stub`, or `mcp`. `isAgentCaller` is true for `mcp` and `cli`. Agent callers cannot approve gates or change policy.

### 1.2 Org and role model

- Valet has one org per deployment. `packages/api/src/lib/org.ts` resolves it with `resolveOrgId`. The session rung sets `AuthUser.orgId` from that call, not from a per-user lookup.
- `AuthUser.role` is the global `users.role` value (`admin` or `member`). The session rung reads it from the better-auth user.
- `org_members` (`packages/api/src/schema/index.ts`) holds a per-org `role` of `admin` or `member`. The request ladder does not read it for the session rung.
- There is no permission vocabulary. There is no mapping from a Keycloak role claim to a Valet role. The only IdP-derived data is the group claim, and it feeds team join eligibility only.

### 1.3 Credential boundaries

| Surface | Files | What the caller holds | What leaves Valet |
| --- | --- | --- | --- |
| Sandbox bearer | `auth/sandbox-tokens.ts`, `engine/host.ts`, `middleware/auth.ts` | `st_` token in env `VALET_SANDBOX_TOKEN` and file `/etc/valet/creds/token` | Nothing by itself. It authorizes calls to Valet. |
| Secret broker | `routes/sandbox-secrets.ts`, `engine/secrets-cli-script.ts` | Sandbox bearer | Resolved `op://` values, one time, into a child process environment |
| Git credential broker | `routes/sandbox-git-credential.ts` | Sandbox bearer | A git token for the repo owner |
| Workflow actions | `routes/sandbox-actions.ts` | Sandbox bearer of a running workflow step | The action result only. No credential reaches the sandbox. |
| MCP | `auth/mcp.ts`, `routes/oauth-consent.ts`, `auth/mcp-caller.ts` | OAuth access token from the better-auth `mcp` plugin | Tool results. Tools call Valet routes in-process as the token's user. |
| Stored credentials | `schema/index.ts` (`credentials`), `lib/secret-crypto.ts`, `services/credential-resolution.ts` | None. The server holds them. | AES-256-GCM at rest. Resolution applies owner precedence. |

Sandbox bearer facts:

- `getOrCreateSandboxToken` derives the token with HMAC from the master key. The token binds to session, user, and org. Valet stores only the SHA-256 hash.
- The expiry is the sentinel `9999-12-31`. Only `revokeSandboxTokens` at teardown ends it. It is long-lived.
- Any code in the sandbox can read the env var and the file. `valet-secrets` unsets the env var for its child, but its own comment states that the file stays readable.
- `SANDBOX_ALLOWED_PATH_PREFIXES` limits the bearer to `/api/memory`, `/api/sandbox/`, and `/api/sandbox-secrets/`. Other paths return 403.
- The bearer authenticates a session principal `{sessionId, userId, orgId}`. It does not represent a live Keycloak session.

### 1.4 Keycloak harness

PR #149 is merged. It provides:

- `docker/keycloak/valet-realm.json`: realm `valet`, client `valet` (confidential, standard flow), users `alice` and `bob`, groups `platform` and `research`, a group membership mapper, and a hardcoded `groups_asserted` mapper.
- `Makefile` targets `dev-keycloak` and `dev-keycloak-down`. Keycloak listens on port 8081.
- `packages/api/src/integration/oidc-keycloak.e2e.test.ts`: a live code-flow test that skips when the realm is not reachable.

The realm has no service-account client, no token-exchange configuration, and no ID-JAG configuration.

### 1.5 Open Valet work

- #151 is open and dirty. Review blockers: a missing role claim silently demotes a user, role sync is not org-scoped, a stale read, and a global admin gate. Do not build on it until these are fixed.
- #671 is an open draft.

## 2. Trust boundaries and threat model

### 2.1 Boundaries

1. Browser to Valet API: session cookie.
2. Keycloak to Valet: OIDC code flow, server-side token exchange.
3. Sandbox workload to Valet API: the sandbox bearer. This boundary is weak because the workload holds the bearer.
4. MCP client to Valet: OAuth token plus consent.
5. Valet to Turnkey: not present today. This document proposes it.
6. Turnkey to downstream resource: not present today.

### 2.2 Assets

- A Turnkey-verifiable token naming a user and org.
- The sandbox bearer.
- Stored credentials and the encryption key.
- The Keycloak client secret.

### 2.3 Threats

| ID | Threat | Today | Required control |
| --- | --- | --- | --- |
| T1 | Code in a sandbox reads the bearer and replays it from outside the sandbox. | Possible. The bearer has no expiry and no sender binding. Reach is limited by the path allow-list. | Never mint a Turnkey token from the bearer alone. Re-check the live user session and membership on each broker call. Roadmap: DPoP or workload identity. |
| T2 | A sandbox supplies its own user, org, subject, issuer, audience, or scope. | Brokers read the principal from the verified bearer, not from the body. | Keep this rule. The new broker must ignore any such field in the request. |
| T3 | A removed or demoted user keeps access. | The bearer stays valid until teardown. A session role is read per request for the session rung only. | Broker re-validates session and membership on each call. A direct token stays valid until expiry unless an online revocation check exists. |
| T4 | A missing or malformed IdP role claim changes a role. | No role sync exists on `dev-v2`. #151 has this defect. | Treat an absent claim as no change. Alert on mapping gaps. Do not demote silently. |
| T5 | Role sync crosses org boundaries. | Single org today. | Scope every role write to one org. |
| T6 | A reusable Turnkey token reaches the sandbox, then leaks into logs or a transcript. | Not applicable today. | Return results, not tokens. |
| T7 | An ordinary Keycloak access token is accepted as a Turnkey grant. | Not applicable today. | Do not accept it. See section 4. |
| T8 | Confused deputy: the broker calls Turnkey with more scope than the user holds. | Not applicable today. | Bind resource and scope to a Valet permission. Downstream verifies independently. |
| T9 | The stub identity grants admin. | `VALET_LOCAL_AUTH=1` is an admin. The API refuses to boot with real auth and the stub together. | Keep that guard. Never run the federation demo in stub mode. |
| T10 | Key or secret leakage through the Keycloak harness. | Dev-only secret `valet-dev-secret` in the realm file. | Never reuse harness secrets outside local dev. |

## 3. Current state and proposed state

| Area | Current on `dev-v2` | Proposed |
| --- | --- | --- |
| Login | Keycloak OIDC through better-auth, PKCE, one default provider | Unchanged |
| Principal | User or team principal. Sandbox principal on three path prefixes. | Unchanged. Add a broker route that accepts the sandbox principal. |
| Role model | Global `users.role`. Per-org `org_members.role`. No permissions. | A small permission vocabulary bound to resource and scope. No IdP role mapping until #151 blockers are fixed. |
| Sandbox credential | Long-lived bearer, readable by the workload | Same bearer authenticates the call. It never becomes a Turnkey token. |
| Valet to Turnkey | None | A broker route that acts as the authenticated user and runs read-only operations |
| Turnkey token | None | Short-lived access token from the Turnkey token endpoint. Held by the broker only. |
| Downstream | None | Verifies the Turnkey token independently and keeps its own object and tenant checks |

## 4. Feasibility: ID-JAG and RFC 7523

ID-JAG here means an Identity Assertion JWT Authorization Grant, which a client presents to an authorization server through the RFC 7523 jwt-bearer grant.

### 4.1 Turnkey side, commit `177132f27a`

- Merged: MINT_JWT `http-authz/v1` (#9013) only.
  - Header `typ` is `application/vnd.turnkey.http-authz-v1+jwt`. It is not an RFC 9068 access token.
  - No `scope` claim and no `jti` claim.
  - Audience is an origin only.
- Absent on this commit: identity service, discovery document, JWKS, token endpoint, access-token profile, RFC 7523 authorization grant.
- Open:
  - #8866: discovery and JWKS.
  - #8867: `client_credentials` endpoint. No minter exists, so it returns 503 after its checks. It accepts an RFC 7523 `client_assertion` for client authentication only. It does not implement the jwt-bearer authorization grant.
  - #9032: adds the `access-token/v1` ID-JAG profile to MINT_JWT. It is profile logic only. No endpoint accepts a grant.
  - #9022: draft, policy parameter exposure. It has a commit-signing or build check failure, described in the audit.

Conclusion: no Turnkey endpoint can accept an ID-JAG or a jwt-bearer grant today. No full proof of concept can run. The gate in section 6 stays closed until the items below merge and deploy.

### 4.2 Keycloak side

- Current evidence cannot confirm that Keycloak issues a standards-compliant ID-JAG. This document does not assert it.
- Required test, before any design depends on it: against the current Keycloak release and a test realm, request an ID-JAG and check these points.
  1. The token endpoint or token-exchange flow can return a JWT with the ID-JAG header `typ` and claims the Turnkey profile requires.
  2. The `iss`, `aud`, `sub`, `client_id`, `jti`, `exp`, and any resource or scope claims match the Turnkey #9032 profile.
  3. Keycloak signs with a key that Turnkey can fetch and trust.
  4. Record the Keycloak version, realm configuration, and request and response (without secrets).
- Do not use an ordinary Keycloak access token as an ID-JAG. It lacks the profile, and a token minted for one audience must not be a grant for another.

### 4.3 Fallback

If Keycloak cannot issue an ID-JAG, a fallback adapter may exist only if all hold:

- Turnkey confirms a supported validation path in writing.
- The adapter is a replaceable module, named as non-ID-JAG in code and docs.
- The adapter does not claim ID-JAG compliance.

Do not design the adapter now. No claim or endpoint is invented here.

### 4.4 Feasibility summary

| Item | Status |
| --- | --- |
| Turnkey RFC 9068 access token | Not merged (#9032 open) |
| Turnkey discovery and JWKS | Not merged (#8866 open) |
| Turnkey token endpoint | Not merged (#8867 open, returns 503, no minter) |
| Turnkey jwt-bearer grant (RFC 7523 authorization grant) | Absent. No open PR in this audit adds it. |
| Turnkey `client_assertion` client authentication | Open in #8867 |
| Keycloak ID-JAG issuance | Unconfirmed. Test required. |
| Valet broker | Not built. Proposed. |

## 5. Broker-executed operation and direct bearer access

| Property | Broker-executed operation | Direct token access |
| --- | --- | --- |
| Who holds the Turnkey token | Valet API only | The sandbox |
| What the sandbox receives | The operation result | A reusable token |
| Revocation | Each call re-validates the current session and org membership. Removal takes effect on the next call. | The token stays valid until `exp`, unless an online revocation check exists |
| Replay by a compromised workload | Limited to broker routes and the bearer's checks | Replay to any audience in the token until `exp` |
| Audit | One Valet log row per call | The downstream sees the call. Valet does not. |
| Operation type | Read-only first | Any |

Decision: the first stage uses broker execution only. Do not return a reusable Turnkey token to the sandbox.

### 5.1 Broker rules

1. Derive user and org only from the authenticated principal. Ignore any user, org, subject, issuer, audience, or scope in the request body, headers, or query.
2. Check an active org membership and role for the user on each call.
3. Bind the resource and scope to a Valet permission. Refuse a call whose permission the user lacks.
4. Execute the read-only operation in Valet. Return the result.
5. Downstream verifies the Turnkey token on its own and keeps its existing Valet-side object and tenant checks. Valet checks do not replace downstream checks.
6. A sandbox bearer alone is not proof of a live user. The route must also confirm that the user is still active and a member of the org.

## 6. Staged implementation plan

Do not write code until Gate 0 opens.

### Gate 0: external blockers (all required)

1. Turnkey identity service, discovery, and JWKS merged (#8866).
2. Token endpoint with a real minter merged (#8867 and follow-up). It must not return 503 for valid requests.
3. RFC 9068 access-token profile merged (#9032).
4. An RFC 7523 jwt-bearer grant endpoint merged. No open PR in this audit provides it.
5. A deployed dev or test environment with a known issuer and audience.
6. The Keycloak ID-JAG test in section 4.2 completed, or Turnkey written confirmation of the section 4.3 path.
7. #151 blockers fixed, if any IdP role mapping is in scope.

### Stage 0: local setup and demo intent (no Turnkey)

Intent: prove login and principal wiring with no new code.

1. Run `make dev-keycloak`.
2. Add the environment variables the target prints to `.env`. Comment out `VALET_LOCAL_AUTH`.
3. Run `make dev-local`. Sign in as `alice@valet.test`.
4. Acceptance: `GET /api/me` returns alice. The live e2e `oidc-keycloak.e2e.test.ts` passes when run through `make e2e`.

### Stage 1: documentation of the permission vocabulary

Files: this document, `docs/specs/2026-07-14-auth-v2-design.md` (add a link), `docs/security-model.md` (add the sandbox-bearer statement).
Acceptance: `make e2e E2E_ARGS="--only docs-lint"` passes.

### Stage 2: Keycloak ID-JAG experiment (test realm only)

Files: a new realm file next to `docker/keycloak/valet-realm.json`, and one new test file beside `oidc-keycloak.e2e.test.ts`. Do not edit `valet-realm.json`.
Acceptance: the checks in section 4.2 pass or fail with recorded evidence. A failure ends this path and starts the section 4.3 decision.

### Stage 3: broker skeleton with a stub Turnkey client

Files:

- `packages/api/src/routes/sandbox-turnkey.ts` (new): the broker route.
- `packages/api/src/middleware/auth.ts`: add the route prefix to `SANDBOX_ALLOWED_PATH_PREFIXES`.
- `packages/api/src/services/turnkey-broker.ts` (new): membership check, permission binding, client interface.

Acceptance:

- A request with a body `userId`, `orgId`, `aud`, or `scope` has no effect on the result. A test proves it.
- A removed member gets a refusal on the next call.
- A sandbox bearer for another session cannot read this session's data.
- `pnpm --filter @valet/api test <filter>` and `make e2e` pass.

### Stage 4: real Turnkey client (only after Gate 0)

Exchange through the Turnkey grant endpoint. Cache a token in memory with a TTL below `exp`. Do not persist it. Do not return it. Run one read-only operation against the dev environment.
Acceptance: the downstream rejects a token with a wrong audience, wrong issuer, or expired `exp`. Valet's object and tenant checks still apply.

### Stage 5: widen scope

Add operations one at a time, each with its permission binding and a negative test. Writes need a separate review and a gate for human approval.

## 7. Roadmap

| Item | Reason | Prerequisite |
| --- | --- | --- |
| DPoP (RFC 9449) | Bind a token to a holder key, so a leaked bearer is not replayable | Turnkey support for DPoP-bound tokens |
| SPIFFE or workload identity | Replace the shared-secret sandbox bearer with a workload attestation | A sandbox provider that issues workload identity |
| CIBA | Ask the user to approve a sensitive operation out of band | Keycloak CIBA configuration and a Valet approval gate mapping |
| AuthZEN | Standard authorization decision API between Valet and a policy point | A policy service and a defined permission vocabulary |
| Turnkey sessions | Tie operations to a Turnkey session instead of a bare token | Turnkey session design, not in the audited commits |

Each item is a direction only. None has a design or an implementation in either repository.

## 8. Open questions

1. Does Turnkey plan an RFC 7523 jwt-bearer grant endpoint, and in which PR?
2. Which Keycloak release and which feature (token exchange or a custom mapper) can issue the #9032 profile?
3. Which Valet permission names map to which Turnkey resources and scopes?
