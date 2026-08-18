# Slack user integration and identity linking (v2)

Date: 2026-08-17
Status: approved design
Relates to: `docs/specs/2026-07-20-integration-oauth-design.md`,
`docs/specs/2026-03-16-slack-private-channel-auth-design.md`

## Problem

V1 (`main`) has two Slack features that v2 does not:

1. **Slack (personal)** — `packages/plugin-slack-user` on `main`. A per-user
   OAuth integration that stores a user token (`xoxp`) and exposes
   `slack_user.*` actions that act AS the user: search, read history, set
   status, DND, post, react, upload, pin, bookmark, remind.
2. **Identity linking** — a flow that maps a Slack user id to a Valet user.
   The link powers inbound DM routing and private-channel access checks.

In v2, neither exists. `packages/api/src/routes/slack-webhook.ts` documents
the result: every Slack DM stops at `unlinked_sender`, because
`routes/identity-links.ts` mints link codes for `telegram` only and the
Slack transport emits no `command` event. The private-channel check in
`packages/plugin-slack/src/actions/actions.ts` is dormant behind a `V2-GAP`
comment: no host populates `owner_slack_user_id`.

V1's OAuth flow also cannot be ported as-is. It is a 435-line dedicated
router (`packages/worker/src/routes/slack-user.ts`) with a claim-blob
finalization dance. v2 already has a generic, plugin-driven OAuth surface
(`routes/credential-connect.ts`), and this design extends that surface
instead of adding another provider-specific router.

## Decision summary

- Extend `OAuthDeclaration` (authorization_code mode) with two optional
  fields: `scopesParam` and `interpretTokenResponse`. All Slack-specific
  knowledge lives in the plugin manifest.
- Port `packages/plugin-slack-user` as a standard v2 plugin. Delete the V1
  claim-blob route: the v2 callback runs behind the auth gate with
  user-bound HMAC state, which covers the same CSRF threat.
- A successful connect also writes the identity link. One consent gives the
  user both the act-as actions and DM routing.
- Generalize `/api/me/identity-links` from Telegram-hardcoded routes to
  provider-parameterized routes. The Slack transport emits a `command`
  event for `link <code>` DMs, so `ChannelHost.handleStart` consumes it
  with no host changes. This is the fallback for users who do not want to
  grant act-as scopes.
- Activate the `V2-GAP`: the session credential resolver enriches the org
  `slack` credential with `owner_slack_user_id` from `user_identity_links`.
- Compliance rule going forward: user-scoped credential connects have
  exactly one home — the generic surface plus plugin declarations. New
  provider-specific connect routers for user credentials are not accepted.

## 1. Engine contract — `OAuthDeclaration` extensions

`packages/engine/src/valet-plugin.ts`, authorization_code mode:

```ts
{
  mode: "authorization_code";
  authorizationUrl: string;
  tokenUrl: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  extraAuthParams?: Record<string, string>;
  /** Query param that carries the scope list. Default "scope".
   *  Slack user tokens use "user_scope". */
  scopesParam?: string;
  /** Interpret a non-standard token response. Absent → the standard
   *  OAuth2 shape applies. Throw OAuthInterpretError to fail the flow. */
  interpretTokenResponse?(raw: unknown): TokenInterpretation;
}

interface TokenInterpretation {
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
  /** Scopes the provider actually granted (not requested). */
  grantedScopes?: string[];
  /** Provider facts stored on the credential (team_id, slack_user_id…). */
  metadata?: Record<string, string>;
  /** Present → the connect flow also writes a user_identity_links row. */
  identity?: {
    provider: string;
    externalId: string;
    externalName?: string;
    teamId?: string;
  };
}
```

`interpretTokenResponse` is a pure function: data in, data out. The engine
stays free of HTTP-framework knowledge. Manifests already carry functions
(`execute`, `verify`, `toEvent`), so validation follows the same pattern:
`validateValetPlugin` checks that `scopesParam` is a non-empty string when
present and that `interpretTokenResponse` is a function when present.

`OAuthInterpretError` carries a user-facing message. Per the repo error
rule, the message names the corrective action (for example: "Slack granted
fewer scopes than Valet requested. Reinstall the Slack app for this
workspace, then connect again.").

## 2. Core — `credential-connect.ts` changes

Three additions, all generic:

1. **Authorize URL**: the scope list goes into the query param named by
   `scopesParam` (default `scope`).
2. **Token interpretation**: when the declaration has
   `interpretTokenResponse`, the raw exchange JSON goes through it. When
   absent, the current standard path runs unchanged. The saved credential
   records `grantedScopes` and `metadata` from the interpretation. This
   also fixes an existing inaccuracy: today the callback records the
   *requested* scopes (`found.decl.scopes`) as if granted.
3. **Identity auto-link**: when the interpretation returns `identity`, the
   callback writes the link via `channels/identity-links.ts#linkIdentity`
   BEFORE it saves the credential. The two writes cannot share a
   transaction: the credential goes through the engine store contract
   (`engineCredentials.save`), the link lives in the app schema. Ordering
   plus compensation covers the gap:
   - The callback calls `identityForExternal` first; a hit for a different
     Valet user stops the flow before any write (`linkIdentity` must never
     run on a cross-user hit — it deletes-then-inserts, so it would steal
     the identity). The unique index remains a backstop against races. Same
     user reconnecting → flow continues.
     Identity already linked to a different Valet user → stop before any
     credential write and redirect to
     `/integrations?error=identity_conflict`.
   - Link succeeds but the credential save throws → best-effort
     compensating `unlinkIdentity` (only when the link was newly created,
     never on a same-user re-link), then `error=oauth_failed`.

The failure residue is therefore at worst a missing link with no
credential — a state the code flow (section 4) can repair — never a stored
xoxp credential bound to a conflicting identity.

## 3. `packages/plugin-slack-user` — the port

Standard v2 plugin package: `plugin.yaml` with `v2: true`, `package.json`
with the `./plugin` export and `"valet": { "plugin": "./dist/plugin.js" }`,
tsconfig referencing workspace deps, root tsconfig reference,
`packages/api/package.json` dep, `make generate-registries`.

Contents:

- **Actions**: port `slack_user.*` from `main` (search messages, list
  channels, read history, read thread, set status, snooze/end DND, send
  DM, post message, add reaction, upload file, pin, bookmark, reminder).
  They are already an `ActionPlugin` over an injected credential. Apply
  the current type-safety rules during the port (no `any`, no double
  casts).
- **Credential declaration**: service `slack-user`, type `oauth2`, the
  full V1 user-scope bundle (read/search + act-as; bot-only and admin
  scopes excluded — see `provider.ts` on `main` for the list and the
  exclusion rationale), and:

  ```ts
  oauth: {
    mode: "authorization_code",
    authorizationUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    clientIdEnv: "SLACK_CLIENT_ID",
    clientSecretEnv: "SLACK_CLIENT_SECRET",
    scopesParam: "user_scope",
    interpretTokenResponse,
  }
  ```

  The interpreter:
  1. Rejects `ok: false` responses with the provider error name.
  2. Reads the token from `authed_user.access_token` (Slack nests user
     tokens; the top-level `access_token` is the bot token and must not
     be stored here).
  3. Parses `authed_user.scope` and rejects the response when a requested
     scope is missing.
  4. Returns metadata `{ slack_user_id, team_id, team_name }` and
     `identity: { provider: "slack", externalId: authed_user.id, teamId }`.

  Slack user tokens do not expire unless token rotation is enabled, so
  `expiresInSec` stays unset and the refresh decorator never fires.
- **Skill**: port `skills/slack-user.md`.
- **Deleted, deliberately**: V1's claim-blob route
  (`packages/worker/src/routes/slack-user.ts`). It existed because V1's
  callback ran unauthenticated at the app root. The v2 callback runs
  behind the `/api/*` auth gate, and the HMAC state binds the flow to the
  signed-in user (`verified.userId !== user.id` → reject). The claim
  redemption step adds nothing on top of that.

## 4. Identity-link generalization

### Routes

`routes/identity-links.ts` replaces the Telegram-hardcoded handlers with
provider-parameterized ones:

- `GET  /api/me/identity-links` — link status for every declaring provider.
- `POST /api/me/identity-links/:provider/start` — mint a link code.
- `DELETE /api/me/identity-links/:provider` — unlink.

Valid providers resolve from plugin manifests. A plugin declares
linkability with a manifest field:

```ts
identityLink?: {
  /** Shown in the web UI, tells the user how to deliver the code. */
  instructions: string;
}
```

Telegram and Slack both declare it. The Telegram-specific `PATCH` route
(if still needed by its flow) generalizes the same way.

### Slack transport

`packages/plugin-slack/src/transport/transport.ts` parses an inbound DM
whose text matches `link <code>` (case-insensitive, optional whitespace)
into the same event shape Telegram emits
(`plugin-telegram/src/transport/transport.ts:166`):

```ts
{ kind: "command", command: { name: "start", args: code } }
```

`ChannelHost.handleStart` already consumes this shape and already treats
an unlinked sender's first message as the link command. No host changes.

This closes the exact gap the `slack-webhook.ts` docblock names. Update
that docblock in the same commit.

## 5. V2-GAP activation — `owner_slack_user_id`

`buildCredentialResolver` (`packages/api/src/engine/host.ts`) is the
single decision point for a session's credentials and already branches on
`service === "github"`. Add a branch: for `service === "slack"`, after the
raw store read, look up the session user's `user_identity_links` row for
provider `slack` and merge `owner_slack_user_id: externalId` into the
credential metadata. Unlinked user → no metadata key, and the plugin's
existing behavior (deny private-channel reads) holds.

The identity link is the single source of truth, whether it arrived via
OAuth auto-link or the code flow. The resolver never reads the
`slack-user` credential for this purpose.

## 6. Compliance sweep

| Router | Disposition |
| --- | --- |
| `identity-links.ts` Telegram routes | Migrate to the generic provider-parameterized routes; delete the hardcoded handlers. |
| `github-connect.ts`, `github-app.ts` | Stay. Locked constraint from the integration-oauth design: the GitHub App flow (installations, repo bindings, token tiers) is not a credential connect. |
| `linear-connect.ts` | Stays, as a documented exception. It is org-admin-gated and its callback performs app-table side effects (`linear_installations` upsert, workspace webhook creation) that a plugin manifest cannot reach. Making it plugin-forward needs an org-scoped connect variant with a host-side post-connect capability — a separate design if ever wanted. |
| `slack-app.ts` | Stays. Org manifest handout, not OAuth. |
| `slack-webhook.ts` | Stays. Dedicated for documented reasons (challenge echo, dedupe, workspace gate). |

**Rule**: user-scoped credential connects have exactly one home — the
generic connect surface plus plugin declarations. A PR that adds a new
provider-specific connect router for a user credential is wrong by
default; extend the declaration instead.

## 7. Web UI (minimal)

- The `/integrations` card for Slack (personal) lights up through the
  existing generic connect flow once the declaration exists. Verify the
  card renders and that `error=identity_conflict` surfaces a message
  naming the corrective action ("This Slack account is already linked to
  another Valet user. Unlink it there first, or sign in as that user.").
- Generalize the Telegram link-account card into a provider-driven
  component fed by `GET /api/me/identity-links` plus each provider's
  `identityLink.instructions`.

## 8. Error handling

Callback redirect error codes (all land on `/integrations?error=…`):

- `oauth_failed` — exchange or interpretation threw. Detail is logged
  server-side, never echoed to the browser.
- `oauth_state` — missing/expired/foreign state.
- `identity_conflict` — cross-user identity collision (section 2).

Every user-facing message names the corrective action when one exists.

## 9. Testing

- **Engine**: `validateValetPlugin` accepts/rejects the new fields
  (`scopesParam` non-empty string; `interpretTokenResponse` function).
- **API — connect callback** (fake Slack token endpoint): nested
  `authed_user` extraction; bot-token-only response rejected; scope
  shortfall rejected; metadata + grantedScopes persisted;
  identity_conflict rolls back the credential save; same-user reconnect
  upserts.
- **API — identity links**: generic routes re-cover the Telegram cases;
  Slack provider start/unlink; unknown provider → 404.
- **Plugin**: port the `slack_user.*` action tests from `main`; new
  transport test for `link <code>` command parsing (match, case, non-DM
  ignored).
- **Host**: resolver enrichment — linked user gets
  `owner_slack_user_id`, unlinked does not, non-slack services untouched.
- **Validation**: full `make e2e` scorecard before calling any of it done.

## Out of scope

- Migrating `linear-connect.ts` (section 6).
- Slack token rotation (Slack-side opt-in; xoxp tokens are non-expiring
  without it).
- Multi-workspace (Enterprise Grid) — the deployment resolves one
  workspace, same as the webhook route's team gate.
- Persona posting (`chat:write.customize` username/icon overrides) — a
  separate V1 feature, not part of this port.
