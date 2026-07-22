# 1Password Credential Provider — Design

**Date:** 2026-07-21
**Status:** Implemented (feat/onepassword-credentials)
**Branch:** `feat/onepassword-credentials` → PR against `dev-v2`

## Purpose

Let orgs and users store credentials as **1Password secret references** instead of
raw secrets. The credential row stores an `op://vault/item/field` reference; the
actual secret is resolved at tool-invocation time via the 1Password SDK using a
service-account token. Secrets are never persisted in Valet's database.

## Scope

- Reference-carrying credential rows in the existing credential store.
- Runtime resolution inside the api's `buildCredentialResolver` seam
  (`packages/api/src/engine/host.ts`) — **no engine changes**.
- Org-level and personal service-account tokens.
- Browse-and-pick selection UX (vault → item → field) backed by listing routes.
- Web UI: org settings page + You/Credentials additions.

**Non-goals:** sandbox-side `op://` env injection (legacy runner feature),
per-workflow token scoping, 1Password Connect server support (service-account
tokens only), syncing/mirroring 1Password items.

## Decisions (settled with user)

1. **Mapping lives in the credential row** — a new *kind* of credential row
   (reference-carrying), not a separate mapping table or org setting.
2. **Two token scopes** — an org service-account token (admin-managed; once set,
   any member's sessions resolve org-scoped references through it) and personal
   tokens (member-managed, resolve personally-scoped references).
3. **Selection UX is browse-and-pick** (option A): picker drills
   vault → item → field via listing endpoints; the composed reference is stored.
4. **Permissions:** org token CRUD and org-scoped credential creation are
   **org-admin-only**. Personal tokens and personal credentials are
   member-accessible, gated by an org toggle.
5. **Personal-token org toggle defaults to ENABLED** (single-user mode must work
   with zero org configuration).

## Data model

No schema changes. A 1Password-backed credential is an ordinary row in the
existing encrypted credential store, keyed `(owner, service)`, carrying no
secret material:

```ts
{
  type: "api_key" | "oauth2",          // the shape the secret RESOLVES to
  metadata: {
    onepassword: {
      reference: "op://Vault/Item/field",
      tokenScope: "org" | "personal",  // which service-account token resolves it
    }
  }
}
```

- `type` declares the synthesized shape: `api_key` fills `apiKey`, `oauth2`
  fills `accessToken`, on the resolved `StoredCredential`.
- Org-scoped rows use `owner: { type: "org" }`; personal rows
  `owner: { type: "user" }` — riding the existing owner read-union.
- Service-account tokens are also ordinary encrypted credential rows under the
  **reserved service name `onepassword`** (`type: "service_account"`,
  `apiKey: <token>`): org-owned for the org token, user-owned for personal.
  The reserved name is rejected as a target service for reference credentials.
- The org toggle `allowPersonalOnePassword` lives in org settings
  (default `true`).

## Resolution flow

`buildCredentialResolver`'s non-github branch gains one step:

1. Read the row from the store (unchanged).
2. If `metadata.onepassword` is absent → return as-is (byte-identical today).
3. Otherwise resolve: pick the token per `tokenScope` (org token from the
   org-owned `onepassword` row; personal token from the *session user's*
   user-owned row), call the 1Password SDK `secrets.resolve(reference)`, and
   return a synthesized `StoredCredential` with the secret filled per `type`.

**Caching:** in-memory resolve cache keyed
`(tokenScope, tokenOwnerId, reference)`, 5-minute TTL (mirrors the GitHub
mint-cache pattern). SDK clients are cached per token.

**Failure semantics:** typed `OnePasswordAuthError` with an actionable hint
(missing/revoked token, unresolvable reference, personal scope disabled by
org). It propagates the same way `GitHubAuthError` does — surfaced as the
tool's error result, never a session-level failure.

## API surface

Picker backend (new routes, `/api/onepassword/…`):

- `GET /api/onepassword/vaults?scope=org|personal`
- `GET /api/onepassword/vaults/:vaultId/items?scope=…`
- `GET /api/onepassword/vaults/:vaultId/items/:itemId?scope=…` (item detail
  incl. fields, for the field step of the picker)

Permission-checked per scope: `scope=org` is open to any authed org member
(once the org token is connected) — this matches decision 2's trust model:
the org service-account token is meant to give every member access to
whatever vaults the service account itself can read, so browsing with it
carries no additional privilege beyond what resolving a reference already
grants at session-run time. `scope=personal` requires the caller's own token
to exist and the org toggle to be on. Listing responses never include secret
values.

Credential CRUD rides the **existing credentials routes**, extended to accept
`metadata.onepassword` on create. **Save-time validation** performs one live
`secrets.resolve` so a bad reference or dead token fails at creation, not
mid-session. Org-scoped creation enforces org admin at the route.

Token CRUD also rides existing credential routes (service `onepassword`),
with the same admin/member split by owner type.

## Web UI

- **Org settings → 1Password:** org token card (set/rotate/remove, health
  badge from a live probe), org-scoped credential list with the
  vault → item → field picker, personal-token toggle.
- **You → Credentials:** personal token card (visible only when the org toggle
  is on), personal credential creation with the same picker component.
- Reference-backed rows show a 1Password badge (reference visible, no secret).

## Packaging

- `packages/api/src/services/onepassword.ts` is the **only** file importing
  `@1password/sdk` (mirrors the legacy `packages/runner/src/onepassword-provider.ts`
  isolation). Exposes: client cache, `listVaults`, `listItems`, `getItem`,
  `resolveReference`, plus the resolve cache. A fake client backs all tests.
- `@1password/sdk` added to `packages/api` dependencies (current major; the
  legacy runner pins v0.3.x — verify current SDK item-field surface during
  implementation).

## Testing

- Resolver unit tests: scope routing (org vs personal), synthesized shape per
  `type`, cache TTL behavior, failure → typed error, byte-identical passthrough
  for non-1Password rows.
- Route permission matrix: admin/member × org/personal for listing routes,
  token CRUD, and credential creation (incl. toggle-off personal denial).
- Save-time validation (bad reference → 4xx with hint; no row persisted).
- Live-gated e2e behind `OP_SERVICE_ACCOUNT_TOKEN` exercising the real SDK
  (skip-clean without the env var, matching existing key-gated suites).

## Review class

No engine surface changes (the `credentialResolver` seam already exists and is
api-owned) → standard review, no adversarial engine gate.

## Deviations

Facts that diverged from this doc during implementation, verified against the
code as of the implementing commits:

- **SDK version:** `@1password/sdk` is pinned `^0.4.0` in `packages/api/package.json`,
  not the `^0.3.1` this doc originally floated (the legacy runner's pin). The
  adapter in `packages/api/src/services/onepassword.ts` (`defaultCreateClient`)
  was verified against 0.4.x's `.d.ts` — `client.vaults.list()`,
  `client.items.list(vaultId)`, `client.items.get(vaultId, itemId)`, and
  `client.secrets.resolve(reference)` all match the shapes this module adapts.
- **`metadata.onepassword` is a reserved key on the plain credential PUT path.**
  `packages/api/src/routes/credentials.ts`'s `PUT /api/credentials/:service`
  rejects any request whose `body.metadata` contains an `onepassword` key with
  400 `"metadata.onepassword is reserved; use the onepassword request field"`,
  regardless of whether the validated `body.onepassword` field is also present.
  This closes a smuggle path found in Task 3 review: without it, a caller could
  hand-write `metadata.onepassword = {reference, tokenScope}` through the plain
  path and skip the save-time `resolveReference` validation and reserved
  service-name checks below, since the resolver seam (`onePasswordMeta`) reads
  `metadata.onepassword` directly off whatever is stored.
- **Ordering: reserved-service 400 precedes the personal-toggle 403.** When
  `body.onepassword` is present and `service === ONEPASSWORD_SERVICE`, the
  route 400s ("onepassword is a reserved service name") before it evaluates
  `tokenScope === "personal"` against the org's `allowPersonalOnePassword`
  toggle — a structurally malformed request (naming the reserved service as
  the credential target) is rejected independent of policy state.
- **Web: `apiErrorMessage` helper.** Error-message extraction for 1Password
  UI surfaces was pulled into a shared `apiErrorMessage(err, fallback)` helper
  in `packages/web/src/api/client.ts` (exported alongside `ApiError`) rather
  than inlined per-component. `packages/web/src/api/integrations.ts`'s
  `useCredentials`/`qkIntegrations.credentials` also gained a `scope: "user" |
  "org"` parameter (default `"user"`) so the org settings page and the
  personal connected-accounts page read independent cache entries; both
  pre-existing call sites (`routes/settings.connected-accounts.tsx` and the
  credentials list) were updated to pass it explicitly where non-default.
- **Org settings page has a component-level admin check in addition to the
  layout guard.** `packages/web/src/routes/settings.organization.onepassword.tsx`
  re-checks `orgQ.data.callerRole !== "admin"` itself (showing the same "managed
  by your org admins" copy as `OrgRouteGuard`) rather than relying solely on
  the route-level guard, so a mid-session role change or direct navigation
  can't render admin controls to a non-admin before the guard re-evaluates.
- **`onepassword.live.test.ts`** (Task 5) uses the real default `createClient`
  (no fake), gated on `OP_SERVICE_ACCOUNT_TOKEN` (skip-clean without it,
  verified locally). Live execution against a real 1Password service account
  is deferred — no token was available in the implementation environment; the
  coordinator/user should run it before merge if live SDK verification is
  desired.
- **`scope=org` browsing was relaxed from admin-only to any org member**
  (fix-wave post-review, after this doc's "Permission-checked per scope" line
  originally said `scope=org` requires org admin). Final review flagged that
  as inconsistent with decision 2's stated trust model — the org
  service-account token is meant to give org members access to whatever
  vaults it can read, not to gate browsing behind admin while every member's
  session resolves org-scoped references through that same token anyway.
  `packages/api/src/routes/onepassword.ts`'s `requireScopeAccess` now lets
  `scope=org` through for any authed member once the token is connected
  (`OnePasswordAuthError`'s 400 "no organization 1Password service account
  token" still applies when it isn't). `PUT /settings` (connecting/rotating
  the org token, flipping the personal-toggle) and creating an org-**owned**
  credential row are unaffected — those stay admin-only.
- **`github` rejects `body.onepassword` unconditionally.**
  `packages/api/src/routes/credentials.ts`'s `PUT /api/credentials/github`
  now 400s with `"github credentials cannot be 1Password references; use the
  GitHub connect flow"` whenever `body.onepassword` is present, checked
  alongside the reserved-service-name structural check. `host.ts`'s
  `buildCredentialResolver` routes `service === "github"` through
  `resolveSessionGitHubToken` unconditionally (when `githubTokenDeps` + `db`
  are wired) — it never reaches the `onePasswordMeta` branch, so a stored
  1Password-reference row on `github` would silently never resolve. Reject
  at write time instead of persisting a credential nothing reads.
- **Known gap (follow-up): reference credentials only resolve through the
  session `credentialResolver` seam.** Two other readers of credential rows
  bypass it and will treat a reference-carrying row as if it were simply
  unconnected (no secret, no error surfaced) rather than resolving it:
  - Workflow tool-node invocation (`packages/api/src/plugins/action-invoker.ts`,
    `buildCredentialProvider`), which reads the credential store directly
    rather than through `host.ts`'s `buildCredentialResolver`.
  - `packages/api/src/channels/host.ts`'s `ChannelHost.start` org bot-token
    reads (`engineCredentials.get({type:"org",...}, factory.channelType)`),
    which also read the store directly.
  Follow-up: route both through the same resolution helper `host.ts`'s
  `buildCredentialResolver` uses (or extract it into a shared function both
  call), so a reference-carrying row behaves identically no matter which
  subsystem reads it.
