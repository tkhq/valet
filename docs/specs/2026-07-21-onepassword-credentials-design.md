# 1Password Credential Provider — Design

**Date:** 2026-07-21
**Status:** Approved (brainstorm with user)
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

Permission-checked per scope: `scope=org` requires org admin; `scope=personal`
requires the caller's own token to exist and the org toggle to be on. Listing
responses never include secret values.

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
