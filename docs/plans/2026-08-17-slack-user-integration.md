# Slack User Integration + Identity Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the V1 Slack (personal) per-user OAuth integration and the Slack identity-link flow to v2, plugin-forward: all Slack knowledge in plugin manifests, zero new provider-specific core routers.

**Architecture:** Extend `OAuthDeclaration` (authorization_code mode) with `scopesParam` + `interpretTokenResponse`; the generic `credential-connect.ts` callback applies them and auto-writes the identity link. Generalize `/api/me/identity-links` to provider-parameterized routes driven by a new `identityLink` manifest field. The Slack transport emits a `command` event for `link <code>` DMs. The session credential resolver enriches the org `slack` credential with `owner_slack_user_id`.

**Tech Stack:** Hono 4 (packages/api), TypeBox action schemas, Drizzle/PGlite, React 19 + TanStack Query (packages/web), vitest.

**Spec:** `docs/specs/2026-08-17-slack-user-integration-design.md` — read it before starting any task.

## Global Constraints

- Work in worktree `/Users/conner/code/valet/.claude/worktrees/slack-user-integration`, branch `conner/slack-user-integration`, PR against `dev-v2`, title prefixed `v2:`. Never merge without user approval.
- Node 22 for all test runs: `source ~/.nvm/nvm.sh && nvm use 22`.
- No `any`, no `as unknown as`, no `@ts-ignore` (CLAUDE.md Type Safety). Parsed JSON is `unknown`; narrow it.
- No Co-Authored-By trailers. Commit subjects ≤72 chars.
- Every user-facing error message names the corrective action when one exists (CLAUDE.md Writing).
- V1 source of truth is `origin/main` — read files with `git show origin/main:<path>`. Never modify `packages/worker` (frozen legacy).
- Vitest filters: `pnpm --filter @valet/<pkg> test <filter>` with NO `--` before the filter.
- Before any `git push`/`fetch` over SSH, run `say "yubikey"` first so the user can tap the key.

## Known deviations from V1 (do not "fix" these)

- V1's `ActionResult.revokeCredential` flag has no v2 equivalent (`PluginActionResult` is `{ success, data?, error?, attachments? }`). On revoked-token errors, return the reconnect error string only. Note carried in the spec's port section.
- V1's claim-blob route (`packages/worker/src/routes/slack-user.ts`) is deliberately NOT ported (spec section 3).

---

### Task 1: Engine — `OAuthDeclaration` extensions + `identityLink` manifest field

**Files:**
- Modify: `packages/engine/src/valet-plugin.ts` (types at :21-51, `ValetPlugin` at :352-367, validation at :503+)
- Test: `packages/engine/src/valet-plugin.test.ts` (exists; append describe blocks)

**Interfaces:**
- Produces (exported from `@valet/engine`; every later task consumes these exact names):

```ts
export interface OAuthIdentity {
  provider: string;
  externalId: string;
  externalName?: string;
  teamId?: string;
}

export interface TokenInterpretation {
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
  /** Scopes the provider actually granted (not requested). */
  grantedScopes?: string[];
  /** Provider facts stored on the credential (team_id, slack_user_id, …). */
  metadata?: Record<string, string>;
  /** Present → the connect flow also writes a user_identity_links row. */
  identity?: OAuthIdentity;
}

/** Thrown by interpretTokenResponse. `message` is user-facing: name the corrective action. */
export class OAuthInterpretError extends Error {}
```

- The `authorization_code` variant of `OAuthDeclaration` gains:

```ts
      /** Query param that carries the scope list. Default "scope".
       *  Slack user tokens use "user_scope". */
      scopesParam?: string;
      /** Interpret a non-standard token response. Absent → standard OAuth2
       *  shape. Throw OAuthInterpretError to fail the flow. */
      interpretTokenResponse?: (raw: unknown) => TokenInterpretation;
```

- `ValetPlugin` gains:

```ts
  /** Declares this plugin's provider supports code-based identity linking. */
  identityLink?: IdentityLinkDeclaration;
```

```ts
export interface IdentityLinkDeclaration {
  /** Identity provider key in user_identity_links (e.g. "slack", "telegram"). */
  provider: string;
  /** Shown in the web UI; tells the user how to deliver the code. */
  instructions: string;
  /** Optional deep link for one-tap delivery (Telegram's t.me URL). Return
   *  null when the transport is not ready. */
  deepLink?: (ctx: { botUsername: string | null; code: string }) => string | null;
}
```

- [ ] **Step 1: Write the failing tests**

Append to `packages/engine/src/valet-plugin.test.ts` (reuse the existing `manifestWith` helper):

```ts
describe("validateValetPlugin oauth authorization_code extensions", () => {
  it("accepts scopesParam and interpretTokenResponse", () => {
    const result = validateValetPlugin(
      manifestWith({
        type: "oauth2",
        configKeys: ["accessToken"],
        oauth: {
          mode: "authorization_code",
          authorizationUrl: "https://example.com/authorize",
          tokenUrl: "https://example.com/token",
          clientIdEnv: "X_ID",
          clientSecretEnv: "X_SECRET",
          scopesParam: "user_scope",
          interpretTokenResponse: () => ({ accessToken: "tok" }),
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an empty scopesParam", () => {
    const result = validateValetPlugin(
      manifestWith({
        type: "oauth2",
        configKeys: ["accessToken"],
        oauth: {
          mode: "authorization_code",
          authorizationUrl: "https://example.com/authorize",
          tokenUrl: "https://example.com/token",
          clientIdEnv: "X_ID",
          clientSecretEnv: "X_SECRET",
          scopesParam: "",
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a non-function interpretTokenResponse", () => {
    const result = validateValetPlugin(
      manifestWith({
        type: "oauth2",
        configKeys: ["accessToken"],
        oauth: {
          mode: "authorization_code",
          authorizationUrl: "https://example.com/authorize",
          tokenUrl: "https://example.com/token",
          clientIdEnv: "X_ID",
          clientSecretEnv: "X_SECRET",
          interpretTokenResponse: "not a function",
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects scopesParam on mcp mode", () => {
    const result = validateValetPlugin(
      manifestWith({
        type: "oauth2",
        configKeys: ["accessToken"],
        oauth: { mode: "mcp", serverUrl: "https://mcp.example.com", scopesParam: "user_scope" },
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("validateValetPlugin identityLink", () => {
  it("accepts provider + instructions, with optional deepLink function", () => {
    const result = validateValetPlugin({
      name: "fixture",
      version: "0.1.0",
      identityLink: {
        provider: "slack",
        instructions: "DM the Valet app: link <code>",
        deepLink: () => null,
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects missing instructions", () => {
    const result = validateValetPlugin({
      name: "fixture",
      version: "0.1.0",
      identityLink: { provider: "slack" },
    });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @valet/engine test valet-plugin`
Expected: FAIL (unknown-field rejections or validation gaps).

- [ ] **Step 3: Implement**

In `valet-plugin.ts`: add the three exported types + `OAuthInterpretError` above `OAuthDeclaration`; add the two fields to the authorization_code variant; add `identityLink?: IdentityLinkDeclaration` to `ValetPlugin`. In the validation oauth block (around :503), inside the `mode === "authorization_code"` branch add:

```ts
if (oauth.scopesParam !== undefined && (typeof oauth.scopesParam !== "string" || oauth.scopesParam === "")) {
  issues.push({ path: `${path}.oauth.scopesParam`, message: "must be a non-empty string when present" });
}
if (oauth.interpretTokenResponse !== undefined && typeof oauth.interpretTokenResponse !== "function") {
  issues.push({ path: `${path}.oauth.interpretTokenResponse`, message: "must be a function when present" });
}
```

and in the `mode === "mcp"` branch reject both fields:

```ts
for (const field of ["scopesParam", "interpretTokenResponse"] as const) {
  if (oauth[field] !== undefined) {
    issues.push({ path: `${path}.oauth.${field}`, message: "only valid on authorization_code mode" });
  }
}
```

Add top-level `identityLink` validation next to the other optional-field checks:

```ts
if (v.identityLink !== undefined) {
  const link = asRecord(v.identityLink, "identityLink", issues);
  if (link) {
    if (typeof link.provider !== "string" || !NAME_RE.test(link.provider)) {
      issues.push({ path: "identityLink.provider", message: "required string matching /^[a-z][a-z0-9-]*$/" });
    }
    if (typeof link.instructions !== "string" || link.instructions === "") {
      issues.push({ path: "identityLink.instructions", message: "required non-empty string" });
    }
    if (link.deepLink !== undefined && typeof link.deepLink !== "function") {
      issues.push({ path: "identityLink.deepLink", message: "must be a function when present" });
    }
  }
}
```

Check `packages/engine/src/index.ts` exports the new names (follow how `OAuthDeclaration` is exported; add to the same export statement if named).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @valet/engine test valet-plugin`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/valet-plugin.ts packages/engine/src/valet-plugin.test.ts packages/engine/src/index.ts
git commit -m "feat(engine): oauth interpretTokenResponse/scopesParam + identityLink manifest field"
```

---

### Task 2: API service — raw token exchange

**Files:**
- Modify: `packages/api/src/services/integration-oauth.ts` (`tokenPost` at :112-131, `exchangeAuthorizationCode` at :133-147)
- Test: `packages/api/src/services/integration-oauth.test.ts` (create if absent; check first)

**Interfaces:**
- Consumes: `AuthCodeDecl` (existing internal alias for the authorization_code variant).
- Produces: `exchangeAuthorizationCodeRaw(params: { oauth: AuthCodeDecl; env: Record<string, string | undefined>; code: string; redirectUri: string }): Promise<unknown>` — same POST as `exchangeAuthorizationCode` but returns the parsed JSON without requiring a top-level `access_token`. Task 3 consumes it.

Slack's `oauth.v2.access` response for a user-scope-only app has NO top-level `access_token` (the xoxp token nests under `authed_user`), so the existing `tokenPost` narrowing would throw before the interpreter ever runs. Split the fetch from the narrowing:

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { exchangeAuthorizationCodeRaw } from "./integration-oauth.js";

const DECL = {
  mode: "authorization_code" as const,
  authorizationUrl: "https://slack.test/authorize",
  tokenUrl: "https://slack.test/oauth.v2.access",
  clientIdEnv: "SLACK_CLIENT_ID",
  clientSecretEnv: "SLACK_CLIENT_SECRET",
};
const ENV = { SLACK_CLIENT_ID: "cid", SLACK_CLIENT_SECRET: "secret" };

afterEach(() => vi.unstubAllGlobals());

describe("exchangeAuthorizationCodeRaw", () => {
  it("returns the parsed JSON without requiring top-level access_token", async () => {
    const body = { ok: true, authed_user: { id: "U1", access_token: "xoxp-1", scope: "chat:write" } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    const raw = await exchangeAuthorizationCodeRaw({ oauth: DECL, env: ENV, code: "c", redirectUri: "https://api.test/cb" });
    expect(raw).toEqual(body);
  });

  it("throws on a non-2xx token response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(
      exchangeAuthorizationCodeRaw({ oauth: DECL, env: ENV, code: "c", redirectUri: "https://api.test/cb" }),
    ).rejects.toThrow(/token request failed/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @valet/api test integration-oauth`
Expected: FAIL — `exchangeAuthorizationCodeRaw` not exported.

- [ ] **Step 3: Implement**

Refactor `tokenPost` into two functions:

```ts
async function tokenPostRaw(tokenUrl: string, form: Record<string, string>): Promise<unknown> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OAuth token request failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function tokenPost(tokenUrl: string, form: Record<string, string>): Promise<TokenResponse> {
  const payload = await tokenPostRaw(tokenUrl, form);
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as { access_token?: unknown }).access_token !== "string"
  ) {
    throw new Error("OAuth token response missing access_token"); // keep the existing message verbatim
  }
  return payload as TokenResponse;
}
```

(Keep the exact existing error message in the narrowing branch — read the current file first and preserve it.) Then:

```ts
export async function exchangeAuthorizationCodeRaw(params: {
  oauth: AuthCodeDecl;
  env: Record<string, string | undefined>;
  code: string;
  redirectUri: string;
}): Promise<unknown> {
  const { clientId, clientSecret } = resolveClientEnv(params.oauth, params.env);
  return tokenPostRaw(params.oauth.tokenUrl, {
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
  });
}
```

- [ ] **Step 4: Run tests** — `pnpm --filter @valet/api test integration-oauth` — PASS, and the pre-existing tests in that file still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/integration-oauth.ts packages/api/src/services/integration-oauth.test.ts
git commit -m "feat(api): raw authorization-code exchange for non-standard token responses"
```

---

### Task 3: API — connect/callback honors `scopesParam` + `interpretTokenResponse`

**Files:**
- Modify: `packages/api/src/routes/credential-connect.ts` (connect at :133-148, callback at :150-209)
- Test: `packages/api/src/routes/credential-connect.test.ts` (exists — extend; copy its existing fixture pattern for plugins/state)

**Interfaces:**
- Consumes: `exchangeAuthorizationCodeRaw` (Task 2), `TokenInterpretation`/`OAuthInterpretError` (Task 1).
- Produces: callback behavior Tasks 4/7 rely on — an interpreted credential is saved as `{ type: "oauth2", accessToken, refreshToken?, expiresAt?, scopes: grantedScopes ?? decl.scopes, metadata: { connectedVia: "oauth", ...interp.metadata } }`.

- [ ] **Step 1: Write the failing tests**

Extend the existing test file with a fixture plugin whose declaration mirrors slack-user's shape (do not import the real plugin — the route test owns its own fixture):

```ts
const slackish = {
  name: "slackish",
  version: "0.0.1",
  credentials: [{
    type: "oauth2" as const,
    configKeys: ["accessToken"],
    scopes: ["chat:write", "search:read"],
    oauth: {
      mode: "authorization_code" as const,
      authorizationUrl: "https://slack.test/authorize",
      tokenUrl: "https://slack.test/oauth.v2.access",
      clientIdEnv: "SLACKISH_ID",
      clientSecretEnv: "SLACKISH_SECRET",
      scopesParam: "user_scope",
      interpretTokenResponse: (raw: unknown): TokenInterpretation => {
        const r = raw as { ok?: boolean; authed_user?: { id?: string; access_token?: string; scope?: string } };
        if (!r.ok || typeof r.authed_user?.access_token !== "string") {
          throw new OAuthInterpretError("Slack returned no user token. Reinstall the Slack app, then connect again.");
        }
        return {
          accessToken: r.authed_user.access_token,
          grantedScopes: r.authed_user.scope?.split(",") ?? [],
          metadata: { slack_user_id: r.authed_user.id ?? "" },
          identity: { provider: "slack", externalId: r.authed_user.id ?? "" },
        };
      },
    },
  }],
};
```

Tests (follow the file's existing request/response harness):

1. `GET /api/credentials/slackish/connect` → 302 whose Location query contains `user_scope=chat%3Awrite+search%3Aread` (or the `+`/`%20` encoding the existing tests assert — match their style) and NO `scope=` param.
2. Callback with a stubbed fetch returning `{ ok: true, authed_user: { id: "U9", access_token: "xoxp-9", scope: "chat:write,search:read" } }` → 302 to `…connected=slackish`, and the saved credential (read back via the test's engineCredentials fake) has `accessToken: "xoxp-9"`, `scopes: ["chat:write", "search:read"]`, `metadata.slack_user_id: "U9"`.
3. Callback where the interpreter throws (`{ ok: false, error: "access_denied" }` body) → 302 to `…error=oauth_failed`, and NO credential saved.
4. A declaration WITHOUT `interpretTokenResponse` still works end to end (regression on the standard path).

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @valet/api test credential-connect` — new cases FAIL.

- [ ] **Step 3: Implement**

Connect route (authorization_code branch): replace the hardcoded scope key:

```ts
const scopesKey = found.oauth.scopesParam ?? "scope";
const query = new URLSearchParams({
  client_id: process.env[found.oauth.clientIdEnv] ?? "",
  redirect_uri: redirectUri,
  response_type: "code",
  state,
  ...(found.decl.scopes?.length ? { [scopesKey]: found.decl.scopes.join(" ") } : {}),
  ...found.oauth.extraAuthParams,
});
```

Callback: in the authorization_code branch, fork on the interpreter:

```ts
let saved: {
  accessToken: string; refreshToken?: string; expiresAt?: number;
  scopes?: string[]; metadata: Record<string, string>;
  identity?: OAuthIdentity;
};
if (found.oauth.mode !== "mcp" && found.oauth.interpretTokenResponse) {
  const raw = await exchangeAuthorizationCodeRaw({ oauth: found.oauth, env: process.env, code, redirectUri });
  const interp = found.oauth.interpretTokenResponse(raw); // throws → outer catch → error=oauth_failed
  saved = {
    accessToken: interp.accessToken,
    refreshToken: interp.refreshToken,
    expiresAt: typeof interp.expiresInSec === "number" ? now + interp.expiresInSec * 1000 : undefined,
    scopes: interp.grantedScopes ?? found.decl.scopes,
    metadata: { connectedVia: "oauth", ...interp.metadata },
    identity: interp.identity,
  };
} else {
  // existing standard path, reshaped into `saved` with metadata: { connectedVia: "oauth" }
}
await engineCredentials.save({ type: "user", id: user.id }, verified.service, {
  type: "oauth2",
  accessToken: saved.accessToken,
  refreshToken: saved.refreshToken,
  expiresAt: saved.expiresAt,
  scopes: saved.scopes,
  metadata: saved.metadata,
});
```

(`now` already exists; keep the existing try/catch → `error=oauth_failed` around the exchange AND the interpretation. `saved.identity` is consumed in Task 4 — until then it is unused; that is fine for this commit.)

- [ ] **Step 4: Run tests** — `pnpm --filter @valet/api test credential-connect` — PASS including pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/credential-connect.ts packages/api/src/routes/credential-connect.test.ts
git commit -m "feat(api): connect flow honors scopesParam and interpretTokenResponse"
```

---

### Task 4: API — identity auto-link in the callback

**Files:**
- Modify: `packages/api/src/routes/credential-connect.ts` (callback, after Task 3's `saved`)
- Modify: `docs/specs/2026-08-17-slack-user-integration-design.md` (section 2, bullet 3 — see Step 0)
- Test: `packages/api/src/routes/credential-connect.test.ts`

**Interfaces:**
- Consumes: `identityForExternal`, `identityForUser`, `linkIdentity`, `unlinkIdentity` from `../channels/identity-links.js` (exact signatures in that file), and `saved.identity` from Task 3.

**IMPORTANT — spec deviation found during planning:** the spec says the unique index is the collision check, but `linkIdentity` (`channels/identity-links.ts:59`) deletes any row with the same `(provider, externalId)` OR `(provider, userId)` before inserting — it would silently STEAL a linked identity. The conflict gate must be an explicit `identityForExternal` pre-check.

- [ ] **Step 0: Amend the spec**

In section 2 bullet 3, replace the sentence naming the unique index as the collision check with: "The callback calls `identityForExternal` first; a hit for a different Valet user stops the flow before any write (`linkIdentity` must never run on a cross-user hit — it deletes-then-inserts, so it would steal the identity). The unique index remains a backstop against races." Commit together with Step 5.

- [ ] **Step 1: Write the failing tests**

Using the Task 3 `slackish` fixture:

1. **Auto-link on success:** after a successful callback, `user_identity_links` has a row `(provider: "slack", externalId: "U9", userId: <session user>)`.
2. **Cross-user conflict:** seed a link for `("slack", "U9")` to a DIFFERENT user id, run the callback → 302 to `…error=identity_conflict`, no credential saved, the existing link untouched.
3. **Same-user reconnect:** seed a link for `("slack", "U9")` to the SAME user, run the callback → success, credential saved, link still present.
4. **Compensation:** make the test's `engineCredentials.save` throw once; callback → `error=oauth_failed` and NO new link row remains (seedless case).

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @valet/api test credential-connect`.

- [ ] **Step 3: Implement** (after building `saved`, before `engineCredentials.save`):

```ts
let restoreLink: (() => Promise<void>) | null = null;
if (saved.identity) {
  const identity = saved.identity;
  const existing = await identityForExternal(db, identity.provider, identity.externalId);
  if (existing && existing.userId !== user.id) {
    return c.redirect(`${returnTo}/integrations?error=identity_conflict`, 302);
  }
  const prior = await identityForUser(db, identity.provider, user.id);
  await linkIdentity(db, { provider: identity.provider, externalId: identity.externalId, userId: user.id });
  restoreLink = prior
    ? () => linkIdentity(db, { provider: identity.provider, externalId: prior.externalId, userId: user.id })
    : () => unlinkIdentity(db, identity.provider, user.id);
}
try {
  await engineCredentials.save(/* Task 3 shape */);
} catch (err) {
  console.error(`oauth callback: credential save failed for ${verified.service}:`, err);
  if (restoreLink) await restoreLink().catch(() => undefined); // best-effort compensation
  return c.redirect(`${returnTo}/integrations?error=oauth_failed`, 302);
}
```

- [ ] **Step 4: Run tests** — PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/credential-connect.ts packages/api/src/routes/credential-connect.test.ts docs/specs/2026-08-17-slack-user-integration-design.md
git commit -m "feat(api): oauth connect auto-links identity with conflict gate"
```

---

### Task 5: API — provider-parameterized identity-link routes

**Files:**
- Modify: `packages/api/src/routes/identity-links.ts` (full rewrite of the route bodies; keep the mount)
- Modify: `packages/api/src/wire/types.ts` (`StartIdentityLinkResponse` at :2152-2155)
- Modify: `packages/plugin-telegram/src/plugin.ts` (add `identityLink` declaration)
- Test: `packages/api/src/routes/identity-links.test.ts` (exists? check; else create following sibling route tests)

**Interfaces:**
- Consumes: `IdentityLinkDeclaration` (Task 1); `channelHost.isRunning(provider)`, `channelHost.botUsername(provider)` (existing); `c.var.providers.plugins: ValetPlugin[]`.
- Produces: routes the web (Task 9) consumes:
  - `GET /api/me/identity-links` → `{ links: IdentityLinkStatus[] }`, one entry per declaring plugin.
  - `POST /api/me/identity-links/:provider/start` → `StartIdentityLinkResponse`.
  - `PATCH /api/me/identity-links/:provider` / `DELETE /api/me/identity-links/:provider`.
- Wire change:

```ts
export interface StartIdentityLinkResponse {
  /** The link code, for providers where the user types it (e.g. Slack DM). */
  code: string;
  /** One-tap delivery URL when the provider supports it (Telegram t.me). */
  deepLink?: string;
  /** How to deliver the code — from the plugin's identityLink.instructions. */
  instructions: string;
  expiresInSeconds: number;
}
```

- [ ] **Step 1: Write the failing tests**

Fixture plugins: one with `identityLink: { provider: "telegram", instructions: "Tap the link or send /start <code> to the bot.", deepLink: ({ botUsername, code }) => botUsername ? `https://t.me/${botUsername}?start=${code}` : null }` and one with `identityLink: { provider: "slack", instructions: "In Slack, open a DM with the Valet app and send: link <code>" }`. Fake channelHost: `isRunning` true for both, `botUsername("telegram") === "valetbot"`.

1. `GET /` returns two links, providers `telegram` and `slack`, both `linked: false`, `channelReady: true`.
2. `POST /telegram/start` → 200 with `code` non-empty, `deepLink` starting `https://t.me/valetbot?start=`, `instructions` from the manifest.
3. `POST /slack/start` → 200 with `code`, NO `deepLink`, slack instructions.
4. `POST /nope/start` → 404 `{ error: "unknown identity provider \"nope\"" }`.
5. `POST /telegram/start` when `isRunning("telegram")` is false → 409 with an error naming the corrective action (`"telegram transport is not running. Configure the telegram bot token, then retry."`).
6. `DELETE /slack` after seeding a link → 200 `{ ok: true }` and the row is gone.
7. `PATCH /slack` with `{ notifyAttention: false }` after seeding → 200; without a link → 404.

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @valet/api test identity-links`.

- [ ] **Step 3: Implement**

Rewrite `identity-links.ts`: a helper resolves declarations once per request:

```ts
function linkDeclarations(plugins: ValetPlugin[]): Map<string, IdentityLinkDeclaration> {
  const map = new Map<string, IdentityLinkDeclaration>();
  for (const plugin of plugins) {
    if (plugin.identityLink) map.set(plugin.identityLink.provider, plugin.identityLink);
  }
  return map;
}
```

`GET /` iterates `linkDeclarations(...)`, builds each `IdentityLinkStatus` exactly as the current telegram block does (`identityForUser` + `channelHost.isRunning(provider)`). `POST /:provider/start`: 404 on unknown provider; 409 when `!channelHost.isRunning(provider)`; mint via `mintLinkCode(db, user.id, provider)`; response `{ code, instructions: decl.instructions, expiresInSeconds: 600, ...(decl.deepLink ? (() => { const dl = decl.deepLink({ botUsername: channelHost.botUsername(provider), code }); return dl ? { deepLink: dl } : {}; })() : {}) }`. `PATCH`/`DELETE` are the current telegram bodies with `"telegram"` replaced by the validated `:provider` param (404 on unknown provider). Update the file's docblock (it says "Just telegram this pass").

In `plugin-telegram/src/plugin.ts`, add the `identityLink` declaration from the fixture above (real values). The web telegram flow keeps working: `deepLink` still present in the response.

- [ ] **Step 4: Run tests** — identity-links suite PASS; also `pnpm --filter @valet/api test` for the router-level regressions and `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/identity-links.ts packages/api/src/wire/types.ts packages/plugin-telegram/src/plugin.ts packages/api/src/routes/identity-links.test.ts
git commit -m "feat(api): provider-parameterized identity-link routes"
```

---

### Task 6: plugin-slack — `link <code>` DM command + webhook docblock

**Files:**
- Modify: `packages/plugin-slack/src/transport/transport.ts` (parseMessage, before the `kind: "message"` return around :290-302)
- Modify: `packages/plugin-slack/src/plugin.ts` (add `identityLink` declaration)
- Modify: `packages/api/src/routes/slack-webhook.ts` (docblock :51-56)
- Test: the transport's existing test file (find with `ls packages/plugin-slack/src/transport/*.test.ts`)

**Interfaces:**
- Produces: for a DM whose text matches `/^\s*link\s+(\S+)\s*$/i`, parseMessage returns the Telegram-identical command shape (`plugin-telegram/src/transport/transport.ts:166`):

```ts
{ ...base, kind: "command", text, command: { name: "start", args: code } }
```

`ChannelHost.handleStart` (`packages/api/src/channels/host.ts:614`) already consumes `command.name === "start"` — no host changes.

- [ ] **Step 1: Write the failing tests** (in the transport test file, following its existing parse fixtures):

1. DM text `link AbC123xyz` → `kind: "command"`, `command: { name: "start", args: "AbC123xyz" }`.
2. Case/whitespace: `  LINK   AbC123xyz  ` → same command, args exact.
3. `linked you a doc` and `link` (no code) → still `kind: "message"`.

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @valet/plugin-slack test transport`.

- [ ] **Step 3: Implement**

Module-level `const LINK_COMMAND_RE = /^\s*link\s+(\S+)\s*$/i;`. In parseMessage, after `text` is derived and before the `kind: "message"` inbound is built:

```ts
const linkCmd = text !== "" ? LINK_COMMAND_RE.exec(text) : null;
if (linkCmd) {
  const inbound: InboundChannelEvent = {
    dispatchId: `slack:${eventId}`,
    conversationKey,
    sender: { externalId: user },
    kind: "command",
    text,
    command: { name: "start", args: linkCmd[1] },
    raw: update,
  };
  return inbound;
}
```

(Match the surrounding construction style — reuse the same fields the message branch sets; `threadTs`/context are not needed on a command.) In `plugin.ts` add:

```ts
identityLink: {
  provider: "slack",
  instructions: "In Slack, open a DM with the Valet app and send: link <code>",
},
```

Rewrite `slack-webhook.ts` :51-56: the paragraph now states that linking works two ways (OAuth auto-link via the slack-user connect flow; the `link <code>` DM command consumed by `ChannelHost.handleStart`) and that an unlinked sender's DMs drop at `unlinked_sender` until one of them runs.

- [ ] **Step 4: Run tests** — plugin-slack suite PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/plugin-slack/src/transport/transport.ts packages/plugin-slack/src/plugin.ts packages/api/src/routes/slack-webhook.ts packages/plugin-slack/src/transport/*.test.ts
git commit -m "feat(slack): link <code> DM command for identity linking"
```

---

### Task 7: `packages/plugin-slack-user` — the port

**Files:**
- Create: `packages/plugin-slack-user/{plugin.yaml,package.json,tsconfig.json,vitest.config.ts}`
- Create: `packages/plugin-slack-user/src/{plugin.ts,oauth.ts,oauth.test.ts,actions/actions.ts,actions/actions.test.ts,actions/api.ts}`
- Create: `packages/plugin-slack-user/skills/slack-user.md` (port from main)
- Modify: root `tsconfig.json` (references), `packages/api/package.json` (dep), regenerate `packages/api/src/plugins/registry.gen.ts`

**Interfaces:**
- Consumes: `TokenInterpretation`/`OAuthInterpretError`/`OAuthIdentity` (Task 1); `slackFetch`/`slackGet` from `@valet/plugin-slack` (check its package.json `exports` — if `./actions` is not exported in v2, add that export in the same commit); `PluginAction`/`ActionPlugin`/`ValetPlugin` from `@valet/engine`.
- Produces: `slackUserPlugin: ValetPlugin` with `name: "slack-user"`, one `ActionPlugin` (`service: "slack-user"`, `requiresCredential: true`), the credential declaration with the oauth block, and the skill.

V1 source (read each with `git show origin/main:packages/plugin-slack-user/<path>`): `src/actions/actions.ts` (758 lines, 13 actions), `src/actions/api.ts` (33), `src/actions/provider.ts` (173 — the scope bundle + comments), `skills/slack-user.md` (61).

- [ ] **Step 1: Scaffold the package**

`plugin.yaml`:

```yaml
name: slack-user
version: 0.0.1
description: "Slack (personal) — per-user OAuth acting AS the user: search, read, status, post."
icon: "\U0001F464"
iconSlug: slack
v2: true
```

`package.json` (mirror a sibling like `packages/plugin-telegram/package.json` exactly for scripts/exports; deps: `@valet/engine`, `@valet/plugin-slack`, `typebox` — NO zod, NO `@valet/sdk`):

```json
{
  "name": "@valet/plugin-slack-user",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { "./plugin": "./dist/plugin.js" },
  "valet": { "plugin": "./dist/plugin.js" }
}
```

(Copy the sibling's `scripts`, `main`, `types`, `devDependencies` verbatim.) `tsconfig.json`: copy from `packages/plugin-telegram`, adjust references to `../engine` and `../plugin-slack`.

- [ ] **Step 2: Write the failing oauth interpreter tests** (`src/oauth.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { SLACK_USER_SCOPES, interpretSlackUserTokenResponse } from "./oauth.js";

const OK = {
  ok: true,
  app_id: "A1",
  authed_user: { id: "U7", access_token: "xoxp-7", token_type: "user", scope: SLACK_USER_SCOPES.join(",") },
  team: { id: "T7", name: "Acme" },
};

describe("interpretSlackUserTokenResponse", () => {
  it("extracts the nested user token, metadata, and identity", () => {
    const r = interpretSlackUserTokenResponse(OK);
    expect(r.accessToken).toBe("xoxp-7");
    expect(r.metadata).toEqual({ slack_user_id: "U7", team_id: "T7", team_name: "Acme" });
    expect(r.identity).toEqual({ provider: "slack", externalId: "U7", teamId: "T7" });
    expect(r.grantedScopes).toEqual([...SLACK_USER_SCOPES]);
    expect(r.expiresInSec).toBeUndefined();
  });

  it("rejects ok:false with the provider error and a corrective action", () => {
    expect(() => interpretSlackUserTokenResponse({ ok: false, error: "access_denied" }))
      .toThrow(/access_denied.*try connecting again/i);
  });

  it("rejects a bot-token-only response (no authed_user token)", () => {
    expect(() => interpretSlackUserTokenResponse({ ok: true, access_token: "xoxb-1", authed_user: { id: "U7" } }))
      .toThrow(/user token/i);
  });

  it("rejects a scope shortfall naming the reinstall fix", () => {
    const short = { ...OK, authed_user: { ...OK.authed_user, scope: "chat:write" } };
    expect(() => interpretSlackUserTokenResponse(short)).toThrow(/Reinstall the Slack app/);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `pnpm --filter @valet/plugin-slack-user test oauth` (after `pnpm install` picks up the new package).

- [ ] **Step 4: Implement `src/oauth.ts`**

Port `SLACK_USER_SCOPES` verbatim from `git show origin/main:packages/plugin-slack-user/src/actions/provider.ts` (the full read/search + write/act-as bundle WITH its exclusion comments). Then:

```ts
import { OAuthInterpretError, type TokenInterpretation } from "@valet/engine";

export function interpretSlackUserTokenResponse(raw: unknown): TokenInterpretation {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (r.ok !== true) {
    const err = typeof r.error === "string" ? r.error : "unknown_error";
    throw new OAuthInterpretError(`Slack rejected the authorization (${err}). Try connecting again from /integrations.`);
  }
  const authed = (typeof r.authed_user === "object" && r.authed_user !== null ? r.authed_user : {}) as Record<string, unknown>;
  const token = authed.access_token;
  const userId = authed.user_id ?? authed.id;
  if (typeof token !== "string" || token === "" || typeof userId !== "string" || userId === "") {
    throw new OAuthInterpretError(
      "Slack returned no user token. Enable user scopes on the Slack app, then connect again.",
    );
  }
  const granted = typeof authed.scope === "string" ? authed.scope.split(",").filter((s) => s !== "") : [];
  const grantedSet = new Set(granted);
  const missing = SLACK_USER_SCOPES.filter((s) => !grantedSet.has(s));
  if (missing.length > 0) {
    throw new OAuthInterpretError(
      `Slack granted fewer scopes than Valet requested (missing: ${missing.join(", ")}). ` +
        "Reinstall the Slack app for this workspace, then connect again.",
    );
  }
  const team = (typeof r.team === "object" && r.team !== null ? r.team : {}) as Record<string, unknown>;
  const teamId = typeof team.id === "string" ? team.id : "";
  return {
    accessToken: token,
    grantedScopes: granted,
    metadata: {
      slack_user_id: userId,
      team_id: teamId,
      team_name: typeof team.name === "string" ? team.name : "",
    },
    identity: { provider: "slack", externalId: userId, ...(teamId ? { teamId } : {}) },
  };
}
```

(NOTE: Slack's response uses `authed_user.id`; the `user_id` fallback covers older payload shapes seen in V1 tests — check `git show origin/main:packages/worker/src/routes/slack-user.test.ts:227,302` and keep whichever keys those fixtures use.)

- [ ] **Step 5: Run oauth tests** — PASS. Commit:

```bash
git add packages/plugin-slack-user pnpm-lock.yaml
git commit -m "feat(plugin-slack-user): package scaffold + oauth token interpreter"
```

- [ ] **Step 6: Port the actions**

Read `git show origin/main:packages/plugin-slack-user/src/actions/actions.ts`. Port ALL 13 actions into `src/actions/actions.ts` as v2 `PluginAction`s, ids `slack_user.<snake_case>`:

| V1 action | v2 id | riskLevel |
| --- | --- | --- |
| Search Messages | `slack_user.search_messages` | low |
| List Channels | `slack_user.list_channels` | low |
| Read History | `slack_user.read_history` | low |
| Read Thread | `slack_user.read_thread` | low |
| Set Status | `slack_user.set_status` | medium |
| Snooze DND | `slack_user.snooze_dnd` | medium |
| End DND | `slack_user.end_dnd` | medium |
| Send DM | `slack_user.send_dm` | high |
| Post Message | `slack_user.post_message` | high |
| Add Reaction | `slack_user.add_reaction` | medium |
| Upload File | `slack_user.upload_file` | high |
| Pin Message | `slack_user.pin_message` | medium |
| Add Bookmark | `slack_user.add_bookmark` | medium |
| Add Reminder | `slack_user.add_reminder` | medium |

(That table is 14 rows because V1's list in `actions.ts` includes both pin and bookmark — port every action exported in V1's `slackUserActions` array; the array is the source of truth.)

Transformation rules (mechanical, apply to each action):

1. Zod schema → TypeBox, following the `action(Type.Object({...}))({...})` helper pattern at `packages/plugin-slack/src/actions/actions.ts:315-342` (copy that file's `action` helper and `slackError` helper into this package, or import if plugin-slack exports them).
2. `ctx.credentials.access_token` → `const cred = await ctx.credentials.get(); const token = cred?.accessToken ?? "";` and on empty token return `{ success: false, error: "Connect Slack (personal) at /integrations." }`.
3. `revokeCredential: true` results → plain `{ success: false, error: "Slack (personal) token is no longer valid. Reconnect at /integrations." }` (see Known deviations).
4. Keep V1's response-slimming and pagination logic verbatim — behavior, limits, and descriptions unchanged.
5. `slimMessage` came from `@valet/plugin-slack/actions` in V1 — check the v2 plugin-slack `package.json` exports; if `./actions` is absent, add `"./actions": "./dist/actions/index.js"` (and an `src/actions/index.ts` barrel if missing) in the same commit.

Export:

```ts
export const slackUserActionPlugin: ActionPlugin = {
  service: "slack-user",
  description: "Slack (personal) — acts AS the connected user (xoxp token)",
  requiresCredential: true,
  actions: [/* all ported actions */],
};
```

Port V1's action tests (`git show origin/main:packages/plugin-slack-user/src/actions/actions.test.ts`) to `src/actions/actions.test.ts`, adapting the ctx fake to the v2 `PluginActionContext` (credentials.get async).

- [ ] **Step 7: `src/plugin.ts`**

```ts
import type { ValetPlugin } from "@valet/engine";
import { loadSkillFromMarkdown } from "@valet/engine";
import { slackUserActionPlugin } from "./actions/actions.js";
import { SLACK_USER_SCOPES, interpretSlackUserTokenResponse } from "./oauth.js";

const plugin: ValetPlugin = {
  name: "slack-user",
  version: "0.0.1",
  description: "Slack (personal) — per-user OAuth client acting AS the user.",
  actions: [slackUserActionPlugin],
  credentials: [
    {
      service: "slack-user",
      type: "oauth2",
      scopes: [...SLACK_USER_SCOPES],
      configKeys: ["accessToken"],
      connectLabel: "Connect Slack (personal)",
      oauth: {
        mode: "authorization_code",
        authorizationUrl: "https://slack.com/oauth/v2/authorize",
        tokenUrl: "https://slack.com/api/oauth.v2.access",
        clientIdEnv: "SLACK_CLIENT_ID",
        clientSecretEnv: "SLACK_CLIENT_SECRET",
        scopesParam: "user_scope",
        interpretTokenResponse: interpretSlackUserTokenResponse,
      },
    },
  ],
  skills: [loadSkillFromMarkdown(/* match how sibling plugins load skills/slack-user.md */)],
};
export default plugin;
```

(Check a sibling — `packages/plugin-slack/src/plugin.ts` — for the exact `loadSkillFromMarkdown` call shape and copy it.) Port `skills/slack-user.md` from main verbatim, updating any V1-era route references (`/integrations` naming stays).

- [ ] **Step 8: Wire the workspace**

Root `tsconfig.json`: add the package to `references`. `packages/api/package.json`: add `"@valet/plugin-slack-user": "workspace:*"`. Run `pnpm install`, `make generate-registries`, then `pnpm typecheck`.

- [ ] **Step 9: Run everything** — `pnpm --filter @valet/plugin-slack-user test` PASS; `pnpm typecheck` clean.

- [ ] **Step 10: Commit**

```bash
git add packages/plugin-slack-user packages/plugin-slack tsconfig.json packages/api/package.json packages/api/src/plugins/registry.gen.ts pnpm-lock.yaml
git commit -m "feat(plugin-slack-user): port act-as-user actions and oauth declaration"
```

---

### Task 8: Host — `owner_slack_user_id` enrichment

**Files:**
- Modify: `packages/api/src/engine/host.ts` (`buildCredentialResolver`, the `service !== "github"` branch at ~:996-999)
- Test: `packages/api/src/engine/host.slack-credential.test.ts` (create; model on `host.github-credential.test.ts`)

**Interfaces:**
- Consumes: `identityForUser` from `../channels/identity-links.js`.
- Produces: the resolver returns, for `service === "slack"` when the session user has a `slack` identity link, the stored credential with `metadata.owner_slack_user_id` merged in. This activates the dormant branch at `packages/plugin-slack/src/actions/actions.ts:39-46` untouched.

- [ ] **Step 1: Write the failing tests** (fixture pattern from `host.github-credential.test.ts` — seeded store + resolver invocation):

1. Linked user, stored org `slack` credential → resolved credential has `metadata.owner_slack_user_id === "U42"` and every original field intact.
2. Unlinked user → resolved credential identical to the stored one (no `owner_slack_user_id` key).
3. `service === "slack"` with no stored credential → `null` (no throw).
4. Another service (e.g. `"linear"`) with a linked user → metadata untouched.

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @valet/api test host.slack-credential`.

- [ ] **Step 3: Implement** — replace the plain store read branch:

```ts
if (service !== "github") {
  const stored = await credentials.get(owner, service);
  if (service === "slack" && stored) {
    // Activates plugin-slack's dormant private-channel check (its V2-GAP
    // comment): the identity link is the single source of truth for the
    // owner's Slack user id, regardless of how the link was created.
    const identity = await identityForUser(db, "slack", userId);
    if (identity) {
      return { ...stored, metadata: { ...stored.metadata, owner_slack_user_id: identity.externalId } };
    }
  }
  return stored;
}
```

Also update the resolver's docblock list (it enumerates the per-service branches). Remove the now-stale half of the `V2-GAP` comment in `packages/plugin-slack/src/actions/actions.ts:39-46` (the "No v2 host populates this yet" sentence — the lookup mechanism description stays).

- [ ] **Step 4: Run tests** — new suite PASS plus `pnpm --filter @valet/api test host.github-credential` (no regression).
- [ ] **Step 5: Commit**

```bash
git add packages/api/src/engine/host.ts packages/api/src/engine/host.slack-credential.test.ts packages/plugin-slack/src/actions/actions.ts
git commit -m "feat(api): enrich slack credential with owner_slack_user_id from identity link"
```

---

### Task 9: Web — provider-driven link cards + conflict error

**Files:**
- Modify: `packages/web/src/routes/settings.connected-accounts.tsx` (telegram block at :46-135)
- Modify: `packages/web/src/routes/integrations.tsx` (callback error mapping — find the `error=` query handling its docblock at :15 describes)
- Modify: `packages/web/src/api/integrations.ts` or the identity-links hooks file (find with `grep -rn "identity-links" packages/web/src/api/`) — response type picks up the new `StartIdentityLinkResponse`
- Test: `packages/web/src/routes/-settings.connected-accounts.test.tsx` (extend), integrations route test if present

**Interfaces:**
- Consumes: Task 5's `GET /api/me/identity-links` (multi-provider) + `StartIdentityLinkResponse { code, deepLink?, instructions, expiresInSeconds }`.

- [ ] **Step 1: Write the failing tests**

1. Connected-accounts renders one link card per entry in `links` (mock two providers), not just telegram.
2. A provider without `deepLink` shows the `code` and the `instructions` text after Start; a provider with `deepLink` shows the link (existing telegram assertions keep passing).
3. Integrations route: landing with `?error=identity_conflict` renders "This Slack account is already linked to another Valet user. Unlink it there first, or sign in as that user."

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @valet/web test connected-accounts` (and the integrations test filter).

- [ ] **Step 3: Implement**

Refactor the telegram JSX block into a `LinkAccountCard({ link, onStart })` component rendered per `linksQ.data.links` entry: the not-ready branch, the start-link branch (render `pendingLink.deepLink` as an anchor when present, always render `pendingLink.code` in the existing mono style plus `pendingLink.instructions`), and the linked branch (externalId, linked-since, notifyAttention toggle, disconnect) — all existing markup, parameterized by `link.provider`. Provider display names go through the existing `components/integrations/display-name.ts` helper. In `integrations.tsx`, add `identity_conflict` to the error→message mapping with the string from the test.

- [ ] **Step 4: Run tests** — web suites PASS; `pnpm typecheck`.
- [ ] **Step 5: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): provider-driven link-account cards + identity_conflict message"
```

---

### Task 10: Validation + PR

**Files:** none new (fixes only, if the scorecard demands them).

- [ ] **Step 1: Full typecheck + targeted suites**

```bash
source ~/.nvm/nvm.sh && nvm use 22
pnpm typecheck
pnpm --filter @valet/engine test
pnpm --filter @valet/api test
pnpm --filter @valet/plugin-slack test
pnpm --filter @valet/plugin-slack-user test
pnpm --filter @valet/web test
```

- [ ] **Step 2: Full e2e scorecard**

```bash
make e2e 2>&1 | tee /tmp/e2e-slack-user.log
```

Capture the FULL output (never pipe through tail/head/grep). Every red row must be either fixed or named as a pre-existing environmental failure unrelated to this change (note: `model-resolution`/`llm-providers` fail with `ANTHROPIC_API_KEY` exported — only `make e2e` scrubbing is authoritative). Docker-suite flakes: re-run in isolation with `make e2e E2E_ARGS="--only <suite-id>"` before treating as real.

- [ ] **Step 3: Push + PR**

```bash
say "yubikey"
git push -u origin conner/slack-user-integration
gh pr create --base dev-v2 --title "v2: slack user integration + identity linking" --body "$(cat <<'EOF'
Implements docs/specs/2026-08-17-slack-user-integration-design.md.

- OAuthDeclaration gains scopesParam + interpretTokenResponse; the generic
  connect callback applies them and auto-links identity (conflict-gated).
- packages/plugin-slack-user ported from main as a v2 plugin (13+ act-as-user
  actions, full V1 scope bundle, no claim route — v2's authenticated callback
  covers the CSRF threat).
- /api/me/identity-links generalized to provider-parameterized routes;
  telegram migrated; slack links via OAuth auto-link or a `link <code>` DM.
- Session credential resolver enriches the org slack credential with
  owner_slack_user_id, activating the dormant private-channel checks.
- Web: provider-driven link cards; identity_conflict callback message.

Deviations from V1 are listed in the plan (docs/plans/2026-08-17-slack-user-integration.md):
no revokeCredential equivalent in v2 action results; claim-blob route dropped.
EOF
)"
```

- [ ] **Step 4: Report the scorecard and PR URL to the user.** Never merge without approval.
