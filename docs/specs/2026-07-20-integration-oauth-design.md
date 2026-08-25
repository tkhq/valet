# Integration OAuth Connect Flow (v2)

Date: 2026-07-20
Status: implemented (this branch)
Depends on: plugin-system-v2 (`2026-07-13-plugin-system-v2-design.md`, shipped), auth-v2 (`2026-07-14-auth-v2-design.md`, shipped), GitHub repo integration (`2026-07-16-github-repo-integration-design.md`, shipped — pattern precedent)

## Problem

v2 has the full credential substrate — manifest `CredentialDeclaration`s, the encrypted `PgCredentialStore`, `/api/credentials` CRUD, runtime resolution in both live turns and workflow dispatch — but every service except GitHub is **paste-a-token only**. Most of the fleet's services don't even hand users a token to paste: Linear, Notion, Sentry, Stripe, Cloudflare, and Figma expose MCP OAuth servers, and Google's APIs require a real OAuth consent flow. The v1 worker had a comprehensive OAuth layer (`packages/worker/src/routes/integrations.ts`); v2 needs its equivalent.

## Decision summary

Server-side OAuth flow modeled on v2's existing GitHub connect flow (`routes/github-connect.ts`), not v1's SPA-driven flow. HMAC-signed stateless `state` (reusing `lib/oauth-state.ts`), server-side code exchange, tokens written straight into `PgCredentialStore` — secrets never transit the browser. Two provider branches, mirroring v1:

- **MCP dynamic registration** (RFC 8414 discovery + RFC 7591 registration + PKCE public client) for MCP-speaking services, reusing `@valet/sdk`'s `oauth.ts` helpers wholesale.
- **Confidential client from env vars** for services that need a pre-registered OAuth app (Google: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`).

GitHub keeps its dedicated App-mediated flow; it does not move onto this surface.

## What this spec does NOT cover

- GitHub connect/App setup (owned by `2026-07-16-github-repo-integration-design.md`).
- Login/social OAuth and SSO (owned by auth-v2).
- Org-scoped OAuth credentials — this phase connects `user`-owned credentials only; org-shared credentials stay manual-entry (`PUT /api/credentials/:service` with `scope: "org"`).
- The login-token→credential capture hook from auth-v2 (separate, already specced there).

## Manifest contract: `CredentialDeclaration.oauth`

`packages/engine/src/valet-plugin.ts` gains one optional field on `CredentialDeclaration`:

```ts
export type OAuthDeclaration =
  | { mode: "mcp"; serverUrl: string }
  | {
      mode: "authorization_code";
      authorizationUrl: string;
      tokenUrl: string;
      clientIdEnv: string;
      clientSecretEnv: string;
      /** Extra authorize-URL params, e.g. Google's access_type=offline&prompt=consent. */
      extraAuthParams?: Record<string, string>;
    };

export interface CredentialDeclaration {
  // ...existing fields...
  /** How the connect UI obtains this credential via OAuth. Absent = manual token entry only. */
  oauth?: OAuthDeclaration;
}
```

Structural validation in `validateValetPlugin` extends accordingly (mode discriminant, required URLs/env names per mode). `oauth` is only meaningful on `type: "oauth2"` declarations — validation rejects it elsewhere.

Plugin manifest updates in this change:

| Plugin | `oauth` |
|---|---|
| linear, notion, sentry, stripe, cloudflare, figma | `{ mode: "mcp", serverUrl: "<same mcpUrl the plugin's mcpActionPlugin uses>" }` |
| gmail, google-calendar, google-workspace | `{ mode: "authorization_code", authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", clientIdEnv: "GOOGLE_CLIENT_ID", clientSecretEnv: "GOOGLE_CLIENT_SECRET", extraAuthParams: { access_type: "offline", prompt: "consent" } }` — there is no separate google-drive/google-sheets plugin; google-workspace covers Drive/Docs/Sheets under one oauth2 credential |
| github | unchanged (dedicated App flow) |
| slack, telegram (bot_token), typefully (api_key), deepwiki (no creds) | unchanged — manual entry |

The `serverUrl` is declared on the credential rather than derived from the plugin's `ActionPlugin` internals: the connect layer stays manifest-driven and doesn't reach into action-source implementation details. The duplication with `mcpUrl` is one string per plugin, adjacent in the same file.

## API surface (`routes/credentials.ts` additions)

### `GET /api/credentials/:service/connect`

Authenticated. Finds the service's `CredentialDeclaration` across loaded plugin manifests; 404 if no oauth-capable declaration.

- **mcp mode**: `ensureMcpOAuthClient(service, serverUrl)` (below), `generatePkceChallenge()`, then 302 to `buildAuthorizationUrl({...})` with the declaration's scopes.
- **authorization_code mode**: resolve `process.env[clientIdEnv]`/`[clientSecretEnv]`; 503 `{ error: "oauth not configured", missing: [...] }` if absent. Build authorize URL with `client_id`, `redirect_uri`, `response_type=code`, `scope`, `state`, plus `extraAuthParams`.

`state` is HMAC-signed via `lib/oauth-state.ts` (same key derivation as every other flow), payload `{ u: userId, s: service, v?: codeVerifier, exp }` with the standard 15-minute TTL. The PKCE verifier rides inside the signed state — fully stateless between start and callback, nothing persisted. (The verifier is not secret from the user it belongs to; the HMAC prevents tampering and the code exchange happens server-side.)

Redirect URI is a single shared callback for all services: `${baseUrl}/api/credentials/oauth/callback`, where `baseUrl` is the same origin resolution the GitHub flows use (`BETTER_AUTH_URL` / `VALET_PUBLIC_URL` fallback chain — reuse the existing helper).

### `GET /api/credentials/oauth/callback`

Mounted behind the normal `/api/*` auth gate, same as the GitHub connect callback: the user just came from an in-app click, so their session cookie is present. Verifies signed state (signature, `exp`, and `u` === session user — a mismatch redirects with an error rather than writing another user's credential).

- Provider `error` query param (user denied consent, etc.) → redirect to `/integrations?error=<code>`.
- **mcp mode**: load registered client, `exchangeCodePkce({ tokenEndpoint, clientId, code, redirectUri, codeVerifier })`.
- **authorization_code mode**: form-POST `tokenUrl` with `grant_type=authorization_code`, `client_id`, `client_secret`, `code`, `redirect_uri`.

On success, persist directly (no browser round-trip):

```ts
credentials.set({ type: "user", id: userId }, service, {
  type: "oauth2",
  accessToken, refreshToken,          // refreshToken when present
  expiresAt: now + expires_in * 1000, // when present
  scopes, metadata: { connectedVia: "oauth" },
});
```

Then 302 to `/integrations?connected=<service>`. In prod the api serves the SPA same-origin, so a relative target is right. In dev the OAuth provider redirects the browser to the api origin (`:8788`) directly — the vite proxy is not in that path — so a bare relative redirect 404s as JSON (the same failure auth-v2's login `callbackURL` hit, live-verified). The connect route therefore captures the **Referer origin** at mint time, validates it against an allowlist (request origin, configured public URL, auth `trustedOrigins` — which always includes the dev vite origin), and carries it in the signed state as `returnTo`; the callback prefixes every success/error redirect with it. Untrusted or absent Referer → empty prefix (relative), so a crafted connect link cannot turn the callback into an open redirect.

Failure at any step logs the upstream error server-side and redirects to `/integrations?error=oauth_failed` — provider error bodies are never surfaced raw to the browser.

### `/api/plugins` (existing route, small addition)

Each credential entry in the response gains `connect: "oauth" | "manual"` so the web UI knows which affordance to render. Derived purely from `declaration.oauth` presence (for authorization_code mode, also env-var presence — a Google plugin with unset `GOOGLE_CLIENT_ID` reports `"manual"` so the UI doesn't render a Connect button that 503s).

> **Superseded (2026-08-17):** the manual fallback for authorization_code
> declarations with unset env vars is replaced by a third state,
> `"unconfigured"` — a pasted access token cannot refresh without the
> client secret, so token entry never produced a working credential. See
> `2026-08-17-integration-availability-design.md`.

## Registered-client storage: `mcp_oauth_clients`

New app table (pre-1.0: edit `packages/api/migrations/pg/0000_app.sql` in place + add Drizzle schema; local `rm -rf ~/.valet/pg` required after):

```sql
CREATE TABLE mcp_oauth_clients (
  service TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_secret_enc TEXT,           -- almost always NULL (public clients)
  authorization_endpoint TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  registration_endpoint TEXT,
  registered_scopes JSONB,           -- RFC 7591 scope set (sorted); NULL = registered pre-scopes
  metadata JSONB,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
```

One row per service, shared across all users (as in v1's D1 table). `ensureMcpOAuthClient` reads the row; on miss, runs `discoverAuthServer(serverUrl)` → `registerClient(registration_endpoint, { clientName: "Valet", redirectUris: [callbackUrl], scope })` → `INSERT ... ON CONFLICT (service) DO NOTHING` then re-reads (concurrent starts converge on one client). Discovery without a `registration_endpoint` is a hard error surfaced as `?error=oauth_failed`. Rows are never deleted on disconnect — client registration is reusable. If the deployment's public URL changes, the registered redirect URI goes stale; recovery is deleting the row (documented, not automated — same posture as v1).

Scopes ride the registration as well as the authorize request (TKAI-243): the declaration's scope set becomes the RFC 7591 `scope` string, and the row stores it (sorted) in `registered_scopes`. When the declared set changes, `ensureMcpOAuthClient` registers a replacement client and updates the row in place — refresh tokens issued to the old client stop refreshing, and the user reconnects. A `NULL` `registered_scopes` (row from before scopes support) compares as "no scopes", so existing rows re-register only when a declaration actually names scopes. When a declaration names no scopes but discovery advertises `scopes_supported`, the connect logs a warning naming the entry and the fix — a scope-gated server would grant a token with no scopes and list zero tools.

## Token refresh

A `RefreshingCredentialStore` decorator in `packages/api/src/plugins/` wraps the `PgCredentialStore` instance built in `providers/node.ts`, so every consumer (session `credentialProvider`, workflow `action-invoker`, channel host) gets refresh for free:

- On `get()`: if the stored credential is `oauth2`, has a `refreshToken`, and `expiresAt` is present and within a 60-second buffer → refresh, persist the new tokens (preserving the old `refreshToken` if the response omits one), return the fresh credential.
- Refresh dispatch mirrors the connect branches, resolved from the same manifest declarations: **mcp** → `refreshTokenPkce({ tokenEndpoint, clientId, refreshToken })` using the stored registered client; **authorization_code** → form-POST `tokenUrl` with `grant_type=refresh_token` + env client id/secret.
- On refresh failure: stamp `metadata.refreshFailedAt` (the field the credential-summary health surface already whitelists) and return the stored (likely expired) credential — the action fails with the provider's own 401 and the UI shows the unhealthy badge. No credential deletion (v1 deleted on GitHub refresh failure; GitHub keeps that behavior in its own service, untouched).
- `github` service is excluded from the decorator (its refresh lives in `services/github-tokens.ts`).
- No proactive cron sweep this phase (v1 had one); lazy refresh covers actual use. Sweep is a follow-up if idle-credential freshness ever matters.

## Web UI (`packages/web`)

- `integration-row.tsx`: **Connect** is a button that opens the pre-connect screen. It is no longer an anchor to `/api/credentials/:service/connect` — a bare anchor left no moment between the click and the redirect in which to tell the user what the credential gives away. The tile runs no connect path itself.
- `connect-dialog.tsx`: the pre-connect screen. A split pane — the decision on the left, the tools this credential unlocks on the right — that resumes one of three paths behind **Continue**: the org's GitHub App OAuth, the generic `/api/credentials/:service/connect` redirect, or token entry in a second step. Manual token entry stays available on OAuth services, behind the same disclosure rather than beside it.
- `connect-disclosure.ts`: derives every sentence on that screen from `PluginServiceSummary`. It has an explicit "cannot say" arm, and the screen renders it instead of filler. A service whose declared credential key no `ActionPlugin` reads (the google-calendar skew, below) resolves to that arm, and **Continue** is disabled.
- `integrations.tsx`: read `?connected=` / `?error=` search params on mount, surface a success/error toast, and strip the params from the URL.
- Disconnect is unchanged (`DELETE /api/credentials/:service`).

### Why the screen states facts and offers no visibility choice

The obvious design — two selectable cards, "only me" against "shared" — is not implementable today, so it is not offered. `Session.credentialProvider()` resolves every credential as `{ type: "user", id: userId }`, which means an org-scoped row is writable through `PUT /api/credentials/:service` but is never read by any plugin action; and `CredentialOwner` has no `team` arm at all. A control with those semantics would move a row between columns and change nothing about who can use the token. The second card states the exposure that is real instead: a team assistant runs on the credentials of whichever member starts it, and every member of that team can then instruct it and read its replies.

To make the choice real, both of these must land: add `"team"` to `CredentialOwner`, and give the session's credential resolution an owner order (session owner principal, then actor user).

## Error handling summary

| Failure | Behavior |
|---|---|
| Unknown/non-oauth service on `/connect` | 404 JSON |
| Env client vars missing (authorization_code) | 503 JSON on `/connect`; `/api/plugins` already reported `"manual"` so UI shouldn't hit this |
| MCP discovery/registration failure | redirect `/integrations?error=oauth_failed`, server log |
| State invalid/expired/user mismatch | redirect `/integrations?error=oauth_state` |
| Provider consent denied | redirect `/integrations?error=<provider code>` |
| Token exchange failure | redirect `/integrations?error=oauth_failed`, server log |
| Refresh failure at use time | stored credential returned; `metadata.refreshFailedAt` stamped |

## Testing

- **Engine**: `validateValetPlugin` accepts/rejects the new `oauth` shapes (mode discriminant, oauth2-only).
- **API unit/integration** (vitest, in-process Hono): a fake OAuth+MCP server fixture (serves `.well-known/oauth-authorization-server`, registration, authorize is not hit — we assert the 302 Location instead, token endpoint validates PKCE/client_secret). Covers: connect 302 URL shape for both modes, state round-trip, callback persistence into the credential store, user-mismatch rejection, denied-consent redirect, `ensureMcpOAuthClient` idempotency under concurrent calls, refresh-on-get including refresh-failure stamping.
- **Web**: `-integrations.test.tsx` — Connect opens the pre-connect screen rather than redirecting, manual fallback behind it, toast on `?connected=`. `connect-disclosure.test.ts` covers the derivation and its "cannot say" arm; `connect-dialog.test.tsx` covers the rendered claims, the identity chip, the team-versus-personal split, and the refusal to start a connection the metadata cannot describe.
- **Live pass** (human-in-the-loop, before merge): connect a real MCP service (Linear or Notion) end-to-end in the browser against `make dev-local`, verify the action actually runs with the stored token.

## Deviations / implementation notes

- **Refresh serialization**: `RefreshingCredentialStore` serializes concurrent refreshes per credential key in-process (a pending-refresh map keyed by `userId:service`), with a double-check re-read of the stored credential before refreshing — a request that lost the race picks up the winner's already-rotated tokens instead of firing its own redundant (and potentially clobbering) refresh call.
- **Missing `expires_in` on refresh**: if a token refresh response omits `expires_in`, the decorator stores `expiresAt: undefined` rather than guessing a TTL. This disables future auto-refresh for that credential (treated as non-expiring going forward) until the user reconnects. Accepted trade-off — no provider in the current fleet does this in practice, and guessing a TTL risks silently expiring a token that's actually still valid.
- **Engine test location**: the `validateValetPlugin` oauth-shape coverage lives at `packages/engine/test/valet-plugin.test.ts` (per the package's vitest config `include` path), not under a new file.
- **Per-service `actions` on `/api/plugins`**: each credential row carries the actions it unlocks, joined on `credentialService ?? service` — the same expression `invokeAction` uses to scope a credential provider. The join is what makes the pre-connect screen's central claim true by construction rather than by hand-maintained copy. `requiresApproval` is resolved server-side through the engine's exported `approvalModeForAction`, never re-derived from `riskLevel` by a client, because an `ActionPlugin` may pin `defaultApprovalMode` and override risk entirely.
- **Google Calendar's credential key is skewed, and the join exposes it.** The plugin's credential declaration omits `service`, so the connect UI and `credential-connect.ts` both write the plugin name `google-calendar`; its `ActionPlugin` declares `service: "google_calendar"` and its actions read that. Connecting Calendar from `/integrations` therefore shows Connected while the tools cannot use the token, and signing in with Google gives working tools while the card shows Disconnected (`auth/provisioning.ts` already writes the underscored key for this reason). The join reports zero actions for the row, the pre-connect screen says it cannot confirm what the connection unlocks, and Continue is disabled — the screen under-reports rather than inventing five calendar tools. Unifying the key is the fix, and it is not in this change.

## Out of scope / follow-ups

- Proactive refresh cron sweep.
- Org-owned OAuth connects.
- Per-org OAuth client configuration UI (env-only for confidential clients this phase).
- Slack OAuth (v2 bot-token entry stands until the Slack channel work lands).
