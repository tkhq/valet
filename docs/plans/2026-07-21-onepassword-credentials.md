# 1Password Credential Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Credentials stored as `op://` references, resolved at tool-invocation time via 1Password service-account tokens (org-level + personal), with a vault/item/field picker UI.

**Architecture:** A single api-side service module (`services/onepassword.ts`) owns all `@1password/sdk` contact, client + resolve caching, and token lookup. `EngineHost.buildCredentialResolver` (the existing engine seam — NO engine changes) detects `metadata.onepassword` on stored credential rows and swaps in the resolved secret. New `/api/onepassword/*` routes back the picker; credential CRUD rides the existing `/api/credentials` routes with save-time validation.

**Tech Stack:** Hono routes, Drizzle (`orgs.features` jsonb), `@1password/sdk`, React 19 + TanStack Query (web), vitest.

**Spec:** `docs/specs/2026-07-21-onepassword-credentials-design.md` — read it first.

## Global Constraints

- Node 22 (`source ~/.nvm/nvm.sh && nvm use 22`) for every test run.
- No `any`, no `as unknown as`, no `@ts-ignore` (CLAUDE.md Type Safety rules).
- Secrets NEVER logged, never returned by listing routes, never persisted.
- Reserved service name: `onepassword` (holds tokens; rejected as a reference-credential target).
- Personal-token org toggle key: `allowPersonalOnePassword` in `orgs.features` jsonb; **absent reads as `true`**.
- Error copy `"org admin required"` for admin 403s (matches `routes/org.ts` / `routes/credentials.ts`).
- Commit after each task; run `pnpm typecheck` before each commit.

---

### Task 1: OnePassword service module

**Files:**
- Create: `packages/api/src/services/onepassword.ts`
- Create: `packages/api/src/services/onepassword.test.ts`
- Modify: `packages/api/package.json` (add `"@1password/sdk": "^0.3.1"` — bump to latest published version if newer; run `pnpm install`)

**Interfaces (Produces — later tasks rely on these exact names):**

```ts
export interface OpVault { id: string; title: string }
export interface OpItem { id: string; title: string; vaultId: string }
export interface OpItemField { id: string; title: string; fieldType: string }
export interface OpItemDetail { id: string; title: string; fields: OpItemField[] }

/** Narrow view of @1password/sdk's client — the only shape this module needs. */
export interface OpClient {
  secrets: { resolve(reference: string): Promise<string> };
  vaults: { list(): Promise<OpVault[]> };
  items: {
    list(vaultId: string): Promise<OpItem[]>;
    get(vaultId: string, itemId: string): Promise<OpItemDetail>;
  };
}

export type OnePasswordScope = "org" | "personal";
export interface OnePasswordCtx { orgId: string; userId: string }

export class OnePasswordAuthError extends Error {}

export interface OnePasswordDeps {
  credentials: CredentialStore;                       // from @valet/engine
  getAllowPersonal: (orgId: string) => Promise<boolean>;
  createClient?: (token: string) => Promise<OpClient>; // default: real SDK (lazy import)
  now?: () => number;                                  // default Date.now
}

export interface OnePasswordService {
  tokenConnected(scope: OnePasswordScope, ctx: OnePasswordCtx): Promise<boolean>;
  listVaults(scope: OnePasswordScope, ctx: OnePasswordCtx): Promise<OpVault[]>;
  listItems(scope: OnePasswordScope, ctx: OnePasswordCtx, vaultId: string): Promise<OpItem[]>;
  getItem(scope: OnePasswordScope, ctx: OnePasswordCtx, vaultId: string, itemId: string): Promise<OpItemDetail>;
  resolveReference(scope: OnePasswordScope, ctx: OnePasswordCtx, reference: string): Promise<string>;
  /** The resolver-seam entry: fills the secret into a reference-carrying row. */
  resolveCredential(row: StoredCredential, ctx: OnePasswordCtx): Promise<StoredCredential>;
}

export function createOnePasswordService(deps: OnePasswordDeps): OnePasswordService
/** Type guard used by host + routes. */
export function onePasswordMeta(row: StoredCredential): { reference: string; tokenScope: OnePasswordScope } | null
export const ONEPASSWORD_SERVICE = "onepassword";
```

- [ ] **Step 1: Write failing tests** (`onepassword.test.ts`, fake client + in-memory `CredentialStore` stub — build a `Map`-backed object literal implementing get/save/delete/list). Cover:

```ts
import { describe, expect, it, vi } from "vitest";
import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import {
  createOnePasswordService, onePasswordMeta, OnePasswordAuthError, ONEPASSWORD_SERVICE,
  type OpClient,
} from "./onepassword.js";

function memStore(): CredentialStore {
  const m = new Map<string, StoredCredential>();
  const k = (o: CredentialOwner, s: string) => `${o.type}:${o.id}:${s}`;
  return {
    get: async (o, s) => m.get(k(o, s)) ?? null,
    save: async (o, s, c) => { m.set(k(o, s), c); },
    delete: async (o, s) => { m.delete(k(o, s)); },
    list: async () => [],
  };
}

function fakeClient(overrides?: Partial<OpClient>): OpClient {
  return {
    secrets: { resolve: vi.fn(async (ref: string) => `secret-for-${ref}`) },
    vaults: { list: async () => [{ id: "v1", title: "Vault One" }] },
    items: {
      list: async () => [{ id: "i1", title: "Item One", vaultId: "v1" }],
      get: async () => ({ id: "i1", title: "Item One", fields: [{ id: "f1", title: "credential", fieldType: "Concealed" }] }),
    },
    ...overrides,
  };
}
```

  Test cases (each a real `it()` with assertions):
  1. `resolveReference("org", …)` uses the ORG-owned `onepassword` token row; missing row → throws `OnePasswordAuthError` with message containing `"no organization 1Password service account token"`.
  2. `resolveReference("personal", …)` uses the USER-owned token row; missing → `OnePasswordAuthError` containing `"no personal 1Password service account token"`.
  3. Personal scope with `getAllowPersonal` resolving `false` → `OnePasswordAuthError` containing `"disabled by your organization"` (checked BEFORE token lookup).
  4. Resolve cache: two `resolveReference` calls same ref within TTL → underlying `secrets.resolve` called once; advance injected `now` past 5 min → called again. (Inject `now` via a mutable `let t = 0; now: () => t`.)
  5. Client cache: two calls with the same token → `createClient` called once; changing the stored token value → new client created (cache key includes the token).
  6. `resolveCredential` on `{ type: "api_key", metadata: { onepassword: { reference, tokenScope: "org" } } }` → returns `{ type: "api_key", apiKey: "secret-for-…", metadata: <original> }`; on `type: "oauth2"` → fills `accessToken` instead.
  7. `resolveCredential` on a row WITHOUT `metadata.onepassword` → returns the row unchanged (same object).
  8. `onePasswordMeta` narrows correctly: valid meta → object; absent/malformed (`reference` not a string, bad `tokenScope`) → `null`.
  9. SDK failure (fake `secrets.resolve` rejects) → wrapped in `OnePasswordAuthError` whose message includes the reference but NOT any secret.

- [ ] **Step 2: Run to verify failure** — `cd packages/api && pnpm test -- src/services/onepassword` → FAIL (module not found).

- [ ] **Step 3: Implement `onepassword.ts`.** Key mechanics:

```ts
const RESOLVE_TTL_MS = 5 * 60_000;

function tokenOwner(scope: OnePasswordScope, ctx: OnePasswordCtx): CredentialOwner {
  return scope === "org" ? { type: "org", id: ctx.orgId } : { type: "user", id: ctx.userId };
}

async function defaultCreateClient(token: string): Promise<OpClient> {
  const sdk = await import("@1password/sdk");
  // The SDK client structurally satisfies OpClient's used surface; adapt
  // (do NOT double-cast — wrap methods if the shapes differ, and verify
  // items.get(vaultId, itemId) field shape against the installed version).
  const client = await sdk.createClient({ auth: token, integrationName: "Valet", integrationVersion: "2.0.0" });
  return { /* wrap sdk client methods into OpClient shape, mapping fields to {id,title,fieldType} and STRIPPING field values */ } satisfies OpClient;
}
```

  - `clientFor(scope, ctx)`: read token row (`type: "service_account"`, secret in `apiKey`) → `OnePasswordAuthError` if absent → `createClient` memoized in a `Map<string, Promise<OpClient>>` keyed by the token string.
  - `resolveReference`: personal-scope toggle check first; cache `Map<string, { value: string; at: number }>` keyed `${scope}:${owner.id}:${reference}`.
  - `resolveCredential`: `onePasswordMeta(row)` → null passthrough; else resolve and fill `apiKey` (type `api_key`) or `accessToken` (any other type incl. `oauth2`).
  - All SDK rejections wrapped: `new OnePasswordAuthError(\`1Password resolution failed for ${reference}: ${msg}\`)` where `msg` is `err instanceof Error ? err.message : String(err)`.

- [ ] **Step 4: Run tests** — all pass. `pnpm typecheck` clean.
- [ ] **Step 5: Commit** — `feat(api): 1Password service module (SDK isolation, token lookup, resolve cache)`

---

### Task 2: Resolver wiring in EngineHost

**Files:**
- Modify: `packages/api/src/engine/host.ts` (`buildCredentialResolver`, ~line 655; `EngineHostOptions`)
- Modify: `packages/api/src/providers/types.ts` + `packages/api/src/providers/node.ts` (add `onePassword: OnePasswordService` to providers, constructed with real deps: `engineCredentials` + `getAllowPersonal` reading `getOrgFeatures`-style from `orgs.features`)
- Modify: `packages/api/src/main.ts` (thread `onePassword` into `EngineHost` opts — follow how `githubTokenDeps` is threaded)
- Create: `packages/api/src/engine/host.onepassword-credential.test.ts` (model on `host.github-credential.test.ts`)

**Interfaces:**
- Consumes: Task 1's `OnePasswordService`, `onePasswordMeta`.
- Produces: `EngineHostOptions.onePassword?: OnePasswordService`.

- [ ] **Step 1: Write failing tests** (follow `host.github-credential.test.ts`'s harness for building a host with stubbed opts):
  1. Session resolver returns a 1Password-backed row with the secret filled (`apiKey === "secret-for-…"`), given a store row with `metadata.onepassword` and a fake `OnePasswordService`.
  2. A non-1Password service/row passes through byte-identical (same object as the raw store read).
  3. `OnePasswordAuthError` from the service propagates unchanged (same instance).
  4. Host with NO `onePassword` opt and no `githubTokenDeps` → `buildCredentialResolver` yields `undefined` (options stay byte-identical, pre-existing contract).
  5. Host with `onePassword` but no `githubTokenDeps` → resolver IS defined and 1Password rows resolve; `github` falls through to the raw store read.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** In `buildCredentialResolver`:

```ts
const onePassword = this.opts.onePassword;
if ((!tokenDeps || !db) && !onePassword) return undefined;
return async (owner, service) => {
  if (service === "github" && tokenDeps && db) {
    /* existing github branch, unchanged */
  }
  const stored = await credentials.get(owner, service);
  if (stored && onePassword && onePasswordMeta(stored)) {
    return onePassword.resolveCredential(stored, { orgId, userId });
  }
  return stored;
};
```

  Update the method's doc comment (it currently says "SINGLE decision point… github → …, every OTHER service → raw read") to document the 1Password branch and its failure semantics (typed error → tool error result, mirrors `GitHubAuthError`).

- [ ] **Step 4: Run** `pnpm test -- src/engine/host.onepassword` + the existing `host.github-credential` suite (must stay green) + `pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(api): resolve 1Password reference credentials in the session credential resolver`

---

### Task 3: Routes — picker backend, settings, credential CRUD extension

**Files:**
- Create: `packages/api/src/routes/onepassword.ts` + `packages/api/src/routes/onepassword.test.ts`
- Modify: `packages/api/src/routes/credentials.ts` + `credentials.test.ts`
- Modify: `packages/api/src/services/org.ts` (`OrgFeatures` gains `allowPersonalOnePassword: boolean`; `getOrgFeatures` reads absent as `true`: `(row.features).allowPersonalOnePassword !== false`; `setOrgFeatures` merge already handles it)
- Modify: `packages/api/src/wire/types.ts` (types below)
- Modify: `packages/api/src/app.ts` (`app.route("/api/onepassword", onePasswordRouter)` — mount alongside `credentialsRouter`)

**Interfaces (Produces — wire types Task 4 consumes):**

```ts
export interface OnePasswordSettingsResponse {
  allowPersonal: boolean;
  orgTokenConnected: boolean;
  personalTokenConnected: boolean;
}
export interface PutOnePasswordSettingsRequest { allowPersonal: boolean }
export interface ListOpVaultsResponse { vaults: { id: string; title: string }[] }
export interface ListOpItemsResponse { items: { id: string; title: string; vaultId: string }[] }
export interface OpItemDetailResponse { id: string; title: string; fields: { id: string; title: string; fieldType: string }[] }
// CredentialSummary gains: onepasswordRef?: string  (the reference; display-only, not secret)
// PutCredentialRequest gains: onepassword?: { reference: string; tokenScope: "org" | "personal" }
```

Routes (all authed; `scope` query param `org`|`personal`, default `personal`):
- `GET /api/onepassword/settings` — any member.
- `PUT /api/onepassword/settings` — admin only; writes `allowPersonalOnePassword` via `setOrgFeatures`.
- `GET /api/onepassword/vaults`, `GET /api/onepassword/vaults/:vaultId/items`, `GET /api/onepassword/vaults/:vaultId/items/:itemId` — `scope=org` requires admin (`ORG_ADMIN_REQUIRED` copy); `scope=personal` requires toggle on. `OnePasswordAuthError` → 400 `{ error: err.message }`; other errors → 502 `{ error: "1Password request failed" }`.

`credentials.ts` PUT extension — when `body.onepassword` is present:
- `service === "onepassword"` → 400 `"onepassword is a reserved service name"`.
- `accessToken`/`apiKey` must BOTH be absent → else 400 `"onepassword reference and inline secret are mutually exclusive"`.
- `type` must be `api_key` or `oauth2` → else 400.
- `tokenScope: "org"` + `scope !== "org"`: allowed (a personal credential may resolve via the org token — org members have read access by design). `tokenScope: "personal"` requires toggle on → else 403 `"personal 1Password tokens are disabled by your organization"`.
- **Save-time validation:** `await onePassword.resolveReference(tokenScope, ctx, reference)` — `OnePasswordAuthError` → 400 with its message, and NO row saved.
- Persist `{ type, metadata: { ...body.metadata, onepassword: body.onepassword } }` (no secret fields).
- Also in PUT: plain token writes to service `onepassword` with `scope: "user"` are 403'd when the toggle is off (same copy as above).
- GET summary: add `onepasswordRef` from `metadata.onepassword.reference` (string-typed check — named-field whitelist, keep the no-wholesale-spread rule).

- [ ] **Step 1: Write failing route tests.** Follow `credentials.test.ts`'s app-boot pattern, overriding the `onePassword` provider with a fake service. Matrix:
  - settings: member GET ok; member PUT 403; admin PUT flips and GET reflects; defaults `allowPersonal: true` on a fresh org.
  - vault listing: `scope=org` as member → 403; as admin → vaults from fake; `scope=personal` with toggle off → 403; with no personal token → 400 with hint.
  - item detail: response has fields WITHOUT any `value` key (assert on serialized JSON string, mirroring the 3-layer leakage test pattern in `prebuilds` for-repo tests).
  - PUT credential: happy path org-scoped by admin (fake resolve called once — save-time validation); bad reference (fake throws) → 400 + store `get` returns null; reserved service 400; inline-secret conflict 400; member + `tokenScope: "personal"` + toggle off → 403; member creating org-SCOPED credential still 403 (existing check, re-pin with `onepassword` body present).
  - GET credentials: reference row summary carries `onepasswordRef`, and never `apiKey`/`accessToken` keys (serialized-string assertion).
- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement** routes + credentials.ts changes + org.ts + wire types + app.ts mount.
- [ ] **Step 4: Run** the two route suites + full `pnpm --filter @valet/api test -- src/routes` + `pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(api): 1Password picker routes, org/personal settings, reference-credential CRUD`

---

### Task 4: Web UI

**Files:**
- Create: `packages/web/src/api/onepassword.ts` (query hooks: `useOnePasswordSettings`, `usePutOnePasswordSettings`, `useOpVaults(scope)`, `useOpItems(scope, vaultId)`, `useOpItemDetail(scope, vaultId, itemId)` — query-key factory `onePasswordKeys`, follow `packages/web/src/api/integrations.ts` patterns)
- Create: `packages/web/src/components/settings/onepassword-picker.tsx` (three-step cascade: vault select → item select → field select; emits `{ reference, tokenScope }` composed as `op://${vault.title}/${item.title}/${field.title}`; disabled states while loading; error text from `apiErrorMessage`)
- Create: `packages/web/src/routes/settings.organization.onepassword.tsx` — org token card (set/rotate/remove via existing credentials API, service `onepassword`, `scope: "org"`; "connected" badge from `orgTokenConnected`), personal-token toggle (Radix Switch → `PUT /api/onepassword/settings`), org-scoped reference-credential list + create dialog (service name input + type select `api_key`/`oauth2` + picker with `tokenScope: "org"`)
- Modify: `packages/web/src/routes/settings.connected-accounts.tsx` — personal 1Password token card (hidden entirely when `allowPersonal` is false), personal reference-credential creation using the picker with a `tokenScope` selector (`personal`, plus `org` when `orgTokenConnected`), 1Password badge (reference text) on reference-backed rows via `onepasswordRef`
- Modify: org settings nav (follow how `settings.organization.sandbox-images.tsx` registered its tab/link)
- Create: `packages/web/src/routes/-settings.organization.onepassword.test.tsx` + extend `-settings.connected-accounts.test.tsx`

**Interfaces:** Consumes Task 3's wire types verbatim (import from the web's wire-type mirror the same way existing pages import `CredentialSummary`).

- [ ] **Step 1: Write failing component tests** (follow `-settings.organization.test.tsx` MSW/fetch-stub conventions): admin sees token card + toggle and toggling fires the PUT; member does not see the org page's admin controls; picker cascade — selecting vault loads items, selecting item loads fields, selecting field calls `onCompose` with the exact `op://Vault One/Item One/credential` string; connected-accounts hides the personal card when `allowPersonal: false`; reference row renders the badge text.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @valet/web test`.
- [ ] **Step 3: Implement** hooks, picker, pages, nav entry.
- [ ] **Step 4: Run web suite + `pnpm typecheck`.**
- [ ] **Step 5: Commit** — `feat(web): 1Password org settings page, personal token card, vault/item/field picker`

---

### Task 5: Live-gated e2e, docs, PR

**Files:**
- Create: `packages/api/src/integration/onepassword.live.test.ts` — gated on `OP_SERVICE_ACCOUNT_TOKEN` (skip-clean without it, matching the `ANTHROPIC_API_KEY`-gated suites in `src/integration/`): real SDK client, list vaults, resolve one reference supplied via `OP_TEST_REFERENCE` env, assert non-empty secret without printing it.
- Modify: `docs/specs/2026-07-21-onepassword-credentials-design.md` — status → Implemented; add a Deviations section for anything that diverged during implementation (SDK version/API-shape adjustments go here).

- [ ] **Step 1: Write the live-gated test** (skip-clean verified in a keyless run).
- [ ] **Step 2: Full battery:** `pnpm typecheck`; `pnpm --filter @valet/api test`; `pnpm --filter @valet/web test`; `pnpm --filter @valet/engine test` (must be untouched/green — this arc makes zero engine changes).
- [ ] **Step 3: Update the spec, commit** — `docs(specs): mark 1Password credential provider implemented`
- [ ] **Step 4: Push + PR** against `dev-v2`, title `v2: 1Password credential provider (org + personal service accounts, reference credentials)`. Body: summary, spec/plan links, test evidence. Do NOT merge.
