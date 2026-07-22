# Slack User Plugin (`plugin-slack-user`) — Design

Status: approved design, pre-implementation.
Companion spec: `2026-07-21-slack-channel-events-design.md` (org bot channel + events — lands first; this spec depends on nothing from it except the shared Slack app).

## Goal

Port `packages/plugin-slack-user` from `origin/main` to a v2 `ValetPlugin`: a
per-user OAuth client acting **as the user** (`xoxp` token) — search their full
message surface (private channels/DMs the bot can't see), and act on their behalf
(status, DND, posts, reactions, uploads, pins, bookmarks, reminders). Separate
consent and separate credential from the org bot; same Slack app.

## What's being ported (from `origin/main:packages/plugin-slack-user/`)

15 actions under service `slack-user`, namespace `slack_user.*`:

- **Reads** — `search_messages` (the headline: `search.messages` with `in:/from:/
  before:/after:/has:` operators), `list_channels`, `read_history`, `read_thread`.
- **Writes (act-as-user)** — `set_status`, `set_dnd`, `end_dnd`, `send_dm`,
  `post_message`, `add_reaction`, `upload_file` (external-upload flow), `add_pin`,
  `add_bookmark`, `add_reminder`.

Plus the `slack-user.md` skill and the `SLACK_USER_SCOPES` list (read/search +
write scope sets, no `admin.*`, no bot scopes).

## Decisions

### 1. v2 manifest, TypeBox actions, engine `ActionPlugin` shape

New-old package `packages/plugin-slack-user/` (restored, converted):
`plugin.yaml` gains `v2: true`; `src/plugin.ts` default-exports a `ValetPlugin`
`{ name: "slack-user", actions, credentials, skills }`. Actions are rewritten from
the legacy zod/`IntegrationPackage` shape to the TypeBox/`ActionPlugin` shape used
by `packages/plugin-slack/src/actions/` (which it already depends on for
`slackFetch`/`slackGet`/`slimMessage` — that dependency stays). Registry entry via
`make generate-registries` + `packages/api` dependency, per the standard v2 plugin
checklist in CLAUDE.md.

Risk levels preserved: reads `medium`, all writes `high` (impersonation +
exfiltration), except `list_channels` stays `low`.

### 2. User-scoped OAuth through the generic credential-connect flow

Credential declaration: `{ type: "oauth2", scope: "user" }` with an `oauth`
declaration of mode `authorization_code`, env keys `SLACK_CLIENT_ID` /
`SLACK_CLIENT_SECRET` (shared with the bot's Slack app — one app, two consent
surfaces).

Slack's OAuth is nonstandard in two ways the generic flow
(`packages/api/src/routes/credential-connect.ts` +
`services/integration-oauth.ts`) must accommodate:

1. **`user_scope` vs `scope`**: the authorize URL must send `scope=""` and
   `user_scope=<SLACK_USER_SCOPES>` so Slack issues a user token, not a bot token.
2. **Nested token in the exchange response**: `oauth.v2.access` returns the user
   token at `authed_user.access_token` (plus `authed_user.id`, `team.id`,
   `team.name`), not top-level; tokens are long-lived with no refresh token.

Rather than teaching the generic flow Slack's shapes via config knobs, the `oauth`
declaration grows **one optional hook**: `exchangeCode(params) →
{ accessToken, metadata }` (and a sibling `authorizeParams` override for the
`user_scope` query param). The plugin owns its provider weirdness; the generic
flow calls the hook when present and keeps its current behavior otherwise. This is
the same seam future nonstandard providers will use.

Stored credential: owner `{ type: "user", id }`, service `slack-user`,
`accessToken` = `xoxp`, `metadata` = `{ slackUserId, teamId, teamName,
connectedVia: "oauth" }`. The `/integrations` page already renders a Connect
button for any oauth-declaring service — no web work beyond the row appearing.

### 3. Revocation handling

Port the legacy `REVOKED_ERRORS` set (`token_revoked`, `invalid_auth`,
`account_inactive`, `not_authed`): on these Slack API errors the action deletes
the stored `slack-user` credential (via the credential store available to the
action context) and returns a clear "Slack (personal) disconnected — reconnect at
/integrations" error instead of retrying. If the v2 action-execution context has
no credential-store access, the fallback is returning the reconnect error without
auto-delete and recording the gap as a follow-up — do not build a new seam just
for this.

### 4. Org-workspace guard

At connect time, if the org bot credential exists and its `metadata.teamId`
differs from the user token's `team.id`, fail the connect with a clear error
("your Slack account belongs to workspace X; this org is connected to Y").
Prevents confusing cross-workspace state; users in orgs with no bot connected may
still connect (search-only usage is valid standalone).

### 5. Testing

- Action unit tests ported from legacy (`actions.test.ts`), rewritten for the
  TypeBox shape; revoked-error → credential-delete path covered with a fake store.
- OAuth: unit tests for the `authorizeParams`/`exchangeCode` hooks (authorize URL
  carries `user_scope`, exchange extracts `authed_user.access_token` + metadata)
  against a fake `oauth.v2.access` endpoint; generic-flow regression test that
  hookless providers behave exactly as before.
- Integration: connect → action resolve → 401-revoke → reconnect loop against a
  fake Slack API.
- Manual: real `user_scope` consent screen + `search.messages` round-trip (needs
  the real app; same tunnel/deploy caveat as everything OAuth).

## Non-goals

- Token rotation/refresh (Slack user tokens are long-lived; Slack's opt-in token
  rotation is out of scope).
- Enterprise Grid / `search:read.enterprise`, `admin.*` scopes.
- Any channel/transport behavior — this plugin is actions-only; inbound Slack
  traffic is the bot channel's domain.
- Per-user signing secrets or webhooks (none exist for user tokens).
