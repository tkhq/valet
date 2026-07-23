# Slack Channel + Slack Events — Design

Status: approved design, pre-implementation.
Companion spec: `2026-07-21-slack-user-plugin-design.md` (the per-user `xoxp` plugin — separate PR).
Builds on: `2026-07-15-telegram-channel-design.md` (ChannelTransport/ChannelHost), `2026-07-20-event-system-design.md` (TriggerDef/events/subscriptions).

## Goal

Port the legacy Slack channel from `main` onto the v2 stack and expose Slack webhook
events to the generic event system. One Slack app per org delivers a single webhook
stream that feeds two consumers:

- **Channel**: DMs and `@mentions` become orchestrator prompts; replies, decision
  gates (Block Kit), and media flow back out — Telegram parity plus shared-channel
  mentions.
- **Events**: reactions, membership, channel lifecycle, and (match-gated) messages
  become `events` rows that `event_subscriptions` route to workflows/orchestrators.

The v2 `packages/plugin-slack` already ships the 11 bot actions, the `slack-tools`
skill, and a `bot_token` credential declaration. This spec adds the missing halves:
`transports` and `triggers`.

## What already exists (do not rebuild)

| Piece | Where |
|---|---|
| Bot actions (`slack.dm_owner` … `slack.get_reactions`), 429-retrying API client, private-channel guard, message chunking | `packages/plugin-slack/src/actions/`, `src/message-chunking.ts` |
| `ChannelTransport` / `ChannelTransportFactory` contract | `packages/engine/src/valet-plugin.ts` |
| `ChannelHost` (dedup, identity routing, orchestrator prompts, gate delivery, attention router, drop_log) | `packages/api/src/channels/host.ts` |
| `TriggerDef` contract, `ingestEvent`, dispatcher, subscriptions CRUD | engine + `packages/api/src/events/` |
| Identity-link tables + code mint/consume (`user_identity_links`, `identity_link_codes`) | `packages/api/src/channels/identity-links.ts` |
| Legacy channel code to port from `origin/main` | `packages/plugin-slack/src/channels/{transport,verify,format}.ts`, `slack-app-manifest.json`, `packages/worker/src/routes/slack-events.ts` |

## Decisions

### 1. One Slack workspace per org, credential-resident install state — no new tables

The org credential (`owner {type:"org"}`, service `slack`, type `bot_token`) holds:
`accessToken` = `xoxb` bot token; `metadata` = `{ webhookSecret` (the app signing
secret)`, teamId, teamName, botUserId, appId, appToken? }`. `teamId` is captured at
connect time via `auth.test`. Inbound events whose `team_id` doesn't match are
drop-logged (`unknown_org`). Parity with the Linear one-workspace-per-org rule; no
`slack_installations` table, **zero migrations** for this spec (the `ephemeral`
catalog flag in decision 7 is code-only).

Connect UX: manual entry on `/integrations` — bot token + signing secret (+ optional
app-level token, decision 5). The signing secret is app configuration Slack never
returns via OAuth, so manual entry is required regardless; OAuth bot-install is a
non-goal. The repo ships an updated `slack-app-manifest.json` (v2 URLs, scopes, event
subscriptions) so app creation is copy-paste. Saving the credential runs `auth.test`
to validate the token and populate `metadata` (team/bot ids); the existing
`PUT /api/credentials/slack?scope=org` route grows this service-specific enrichment
hook, or a small dedicated `POST /api/org/slack/connect` route does — implementer's
choice, but validation-on-save is required (a bad signing secret otherwise fails
silently as 403s on every webhook).

### 2. Dedicated ingress: verify once, fan out to both consumers

`POST /api/channels/slack/webhook` — public, 1 MiB cap, replaces nothing (the generic
`/api/channels/:channelType/webhook` route stays Telegram-shaped; Slack gets its own
handler module `packages/api/src/routes/slack-webhook.ts` for the same reason
`github-app.ts` exists: provider-shaped verification and fan-out that the generic
routes shouldn't absorb).

Request handling, in order:

1. **Content-type branch**: `application/x-www-form-urlencoded` with `payload=` →
   interactivity branch (step 7 below). Otherwise JSON Events API.
2. **`url_verification`** → echo `{challenge}` (before signature check, matching
   legacy and Slack's setup flow).
3. **Retry drop**: `x-slack-retry-num` present → `200` immediately. Slack retries on
   slow acks; our durable idempotency (engine `dispatchId`, events `dedupeKey`)
   makes redelivery safe to drop, and processing can exceed Slack's 3s window.
4. **Org + secret resolution**: single-org (`resolveOrgId()`), load org `slack`
   credential; missing → `200` no-op + drop_log. `team_id` mismatch → `200` +
   drop_log `unknown_org`.
5. **Signature verification**: `v0:{timestamp}:{rawBody}` HMAC-SHA256 against
   `x-slack-signature`, constant-time compare, 300s replay window (port
   `channels/verify.ts` from main verbatim, with its tests). Fail → `401` +
   drop_log `bad_signature` (rate-limited like the host's verify_failed logging).
6. **Ack, then fan out**: return `200` as soon as verification passes; the fan-out
   runs after the response (fire-and-forget with error logging), keeping us inside
   Slack's 3-second ack window regardless of downstream latency. Both consumers see
   every event — the channel decides route-or-drop, the event side decides
   ingest-or-skip; a channel message can legitimately also be an ingested event.
   - **Channel path**: `transport.parseUpdate(update)` → non-null →
     `channelHost.handleUpdate("slack", event)` (host method made callable for
     externally-verified ingress).
   - **Event path**: build `VerifiedEvent { eventType: event.type, deliveryId:
     event_id, payload }` directly and call `ingestEvent` with the matching
     TriggerDef's `toEvent` — same pre-verified pattern as the GitHub App forwarder,
     and the same recorded follow-up applies (unify via a `resolveInstall`-style hook
     on `TriggerDef` later). Missing def or `event_id` → drop_log
     `event_not_ingestable`.

### 3. `SlackTransport` in `packages/plugin-slack`

Add `transports: [slackTransportFactory]` to the existing manifest. Port from
`origin/main`'s `channels/` with these mappings onto the v2 contract:

- `channelType: "slack"`. Factory requires `accessToken` and
  `metadata.webhookSecret`; throws otherwise.
- **Conversation keys** (transport-owned codec):
  `slack:{teamId}:{channelId}` and `slack:{teamId}:{channelId}:{threadTs}`.
  Thread keys given to the engine: `slack:{channelId}:{threadTs || ts}` — legacy
  semantics preserved: each top-level message starts its own engine thread; replies
  inside a Slack thread continue that engine thread.
- **`parseUpdate`**: handles `event_callback` inner events.
  - Drop anything carrying `event.bot_id` (bot-echo suppression) and the legacy
    `SKIP_SUBTYPES` set (message_changed/deleted, joins/leaves, etc.; allow null
    subtype and `file_share`).
  - `message` with `channel_type: "im"` → `kind: "message"` (DM).
  - `app_mention` in any channel → `kind: "message"` with mention context.
    `InboundChannelEvent` gains an optional `context?: { mention?: boolean;
    channelLabel?: string }` (additive engine change; Telegram ignores it) — this
    is what the host's channel-header formatting (decision 4) reads. Mention
    markup stripped via the ported `cleanSlackText`.
  - `assistant_thread_started` / `assistant_thread_context_changed` → `null` for
    now (assistant surface is decision 9).
  - `dispatchId = slack:{event_id}` (durable dedup key for `submitPrompt`).
- **Inbound media**: `InboundChannelMedia` from `event.files`; `fetchMedia`
  downloads `url_private` with the bot token (prefer `thumb_1024…360` for images,
  10 MB image / 25 MB file caps — port from legacy).
- **Outbound `send`**: `chat.postMessage`, `unfurl_links: false`, `thread_ts` from
  the conversation key. Markdown → mrkdwn via ported `format.ts`; > 4000 chars →
  blocks path via the existing `message-chunking.ts` (single call, not message
  splitting). `sendMedia` → v2 external-upload flow.
- **Gates**: `sendGatePrompt` → Block Kit `section` + `actions` buttons, button
  `value = g|{gateId}|{actionId}` (Slack's 2000-char value limit means we can embed
  the real gate id — unlike Telegram's 64-byte `callback_data`). The interactivity
  branch produces `kind: "gate_callback"` with the gateId decoded from the value;
  the host prefers an explicit gateId when the transport supplies one and falls
  back to the in-memory `gateRefs` map otherwise (small additive change to
  `handleGateCallback`). `updateGatePrompt` → `chat.update` with `parse: "none"`
  and the ✅/❌ resolution line.
  **Restart semantics:** the embedded gate id lets a user resolve their own gate
  after an api restart (the decision is re-armed on session rehydrate), but the
  prompt-message *edit* and the in-memory prompt text are lost with the restart,
  so the Slack message keeps its (now inert-on-resolve) buttons until the next
  interaction — resolution is correct, the visual state may lag. Resolution is
  always attempted on the *clicker's own* orchestrator session, so a stale click
  can only no-op, never resolve someone else's gate.
- **`sendTyping`**: no-op outside DMs (Slack bots have no typing indicator);
  in assistant DM threads, `assistant.threads.setStatus` shimmer (decision 9).
- No `registerWebhook` (Slack's URL is app-level config) — see decision 6.

### 4. Routing: DMs and mentions, both to the sender's orchestrator

- **DM** (`channel_type: "im"`): identical to Telegram — resolve sender via
  `user_identity_links (provider "slack")`, prompt
  `ensureOrchestratorSession(user)` on thread `slack:{channel}:{ts…}`. Unlinked
  sender → drop_log `unlinked_sender` + rate-limited DM reply with linking
  instructions (once/hr/conversation, reusing the host's rate-limit map).
- **`app_mention` in a shared channel**: resolve the *mentioning user* the same
  way; linked → prompt their orchestrator on the channel-thread key. The prompt is
  prefixed with channel context: the transport's `parseUpdate` includes
  channel/thread identifiers in metadata, and the host formats a one-line header
  ("via Slack #channel-id, thread …") the way channel context reached the legacy
  orchestrator. Unlinked → drop_log + rate-limited in-thread reply pointing at
  account linking.
- **Explicitly deferred**: channel↔session bindings (`channel_bindings` stays
  shape-only), `triggerMode: all` (responding to non-mention channel traffic), org
  orchestrator routing of unattributed senders, slash commands (`/status` etc. —
  message text starting with `/` is treated as plain text).

Outbound: the existing `eventStream` subscription delivers end-turn assistant
messages, gate prompts/resolutions, and attention pings through the transport;
nothing Slack-specific beyond the transport methods above.

### 5. Ingress modes: webhook (primary) + Socket Mode `poll` (local dev)

Slack cannot long-poll, but Socket Mode fits the existing `poll(signal)` contract:
when the credential has `metadata.appToken` (`xapp-…`, `connections:write` scope),
the transport implements `poll` by opening `apps.connections.open` WebSocket,
acking envelopes, and yielding the inner Events API payloads — so `make dev-local`
gets a real Slack loop with no tunnel, exactly like Telegram's long-poll. Without
`appToken`, Slack is webhook-only and requires `VALET_PUBLIC_URL`; the host logs a
clear "slack: no public URL and no poll support — inbound disabled" instead of
starting a broken transport.

**Known limitation (Socket Mode = channel-only for now):** the poll path runs
through `ChannelHost` (`parseUpdate → handleUpdate`), which is the *channel*
consumer only. The *event* pipeline (`ingestEvent` → subscriptions → workflows)
is wired solely into the dedicated webhook route, so under Socket Mode DMs and
mentions work but `slack.*` event subscriptions do not fire. Production runs in
webhook mode (public URL) where both consumers see every event. Wiring the event
fan-out into the poll path is the recorded follow-up.

### 6. ChannelHost refactors (the recorded pre-reqs for a second transport)

Both were flagged in the Telegram spec's deviations; they land in this pass:

- **Conversation-key ↔ thread-key mapping moves behind the transport, both
  directions.** `channelThreadFor` hardcoded `telegram:dm:{chatId}`, and the
  host's forward derivation took the substring after the last `:` — which
  would collapse Slack's `slack:{teamId}:{channelId}:{threadTs}` down to the
  ts alone. New optional transport methods
  `threadKeyFromConversationKey(conversationKey): string` and its inverse
  `conversationKeyFromThreadKey(threadKey): string | null`; Telegram and
  Slack implement both; the host's `:dm:` fallback remains only for stub
  transports in tests.
- **Per-transport webhook secret sourcing.** The host's webhook mode currently
  generates a per-boot secret and calls `registerWebhook`. The factory grows a
  discriminator (e.g. `ingress: "registered-webhook" | "external-webhook" |
  "poll-capable"`); for `external-webhook` transports the host neither generates a
  secret nor registers anything — verification happens in the dedicated route with
  secrets from credential metadata. `startIngress` picks: Slack = external-webhook
  (or poll via Socket Mode when available and no public URL); Telegram unchanged.
- **`handleUpdate` becomes callable for externally-verified ingress** (the Slack
  route path in decision 2). Dedup, identity routing, drop_log all stay in one
  place.

### 7. Slack TriggerDefs + match-gated (`ephemeral`) event persistence

`packages/plugin-slack/src/triggers.ts`, exported as `triggers:` from the manifest.
`service: "slack"`. Families and keys:

| TriggerDef | Event keys | Catalog filters | ephemeral |
|---|---|---|---|
| `slack.message` | `slack.message` | `channel` (id), `channel_type`, `user` | **yes** |
| `slack.reaction` | `slack.reaction_added`, `slack.reaction_removed` | `channel`, `reaction`, `user`, `item_user` | no |
| `slack.member` | `slack.member_joined_channel`, `slack.member_left_channel` | `channel`, `user` | no |
| `slack.channel` | `slack.channel_created`, `slack.channel_rename`, `slack.channel_archive`, `slack.channel_unarchive` | `channel`, `creator` | no |
| `slack.file` | `slack.file_shared` | `channel`, `user` | no |
| `slack.team` | `slack.team_join` | — | no |

- `verify` implements the full signing-secret HMAC (contract completeness +
  testability against the generic ingress), even though the dedicated route
  short-circuits with pre-verified events. The `slack.message` verify
  additionally drops events carrying `bot_id` and non-`file_share` subtypes —
  without this, a workflow subscribed to `slack.message` that also posts to
  Slack would ingest its own output and self-trigger a loop (the channel
  transport suppresses the same echo independently).
- `dedupeKey = event_id`; `occurredAt` from `event.ts`/`event_ts` (seconds.decimal →
  ISO), wall-clock fallback; `refs` carry channel/user/team ids; `summary` is a
  one-liner ("reaction :tada: added in C0123 by U0456").
- **`ephemeral?: boolean` is an additive field on the engine's
  `EventCatalogEntry`** (default false — GitHub/Linear untouched). On a matching
  entry it changes `ingestEvent` ordering: match
  enabled subscriptions *first*; zero matches → return without inserting anything
  (no event row, no drop_log spam — a debug counter at most). One-plus matches →
  insert event + deliveries in the same transaction as today. Non-ephemeral entries
  keep the current insert-then-match behavior. This is the general answer to
  high-volume keys: `slack.message` only lands in the events table when a
  subscription actually wants it (e.g. "messages in #alerts"), so subscribing is
  what turns the firehose on, per-channel.
- Message events are ingested for **all** conversational traffic the app can see
  (DMs included) — subscriptions + filters decide what persists; ACL-wise this is
  org-admin-visible data identical to what `slack.read_history` already exposes.

### 8. Identity linking, parameterized by provider

`/api/me/identity-links` routes and the connected-accounts UI are currently
hardcoded to `"telegram"`. They become provider-parameterized with a per-provider
link strategy:

- **telegram** (unchanged): deep-link `t.me/{bot}?start={code}`, code consumed by
  the inbound `/start` command.
- **slack** (ported legacy flow, direction reversed vs Telegram): web UI offers a
  workspace-member typeahead (`users.list` via the bot token, existing
  `listSlackWorkspaceUsers` logic), user picks their handle → api mints a code
  (`identity_link_codes`, provider `slack`, 10-min TTL) and **DMs it to that Slack
  user** via the bot → user types the code back into the web UI → `linkIdentity`.
  Proves control of the Slack account; no inbound-command parsing needed.
- `GET /api/me/identity-links` returns per-provider status (`channelReady`,
  `linked`, provider-specific hints); the connected-accounts page renders a block
  per ready channel.

### 9. Assistant surface (Slack "Agents & AI Apps") — minimal port

`assistant.threads.setStatus` ("is thinking…") is wired as the DM `sendTyping`
implementation. Suggested prompts and `assistant_thread_started` handling are
**deferred** — they're cosmetic and the v2 host has no suggested-prompt concept.

### 10. Testing

- Transport unit tests: parseUpdate kinds/skips/bot-echo, key codec round-trip,
  mrkdwn conversion (port legacy tests), gate value encode/decode.
- `verify.ts` port keeps its signature/replay tests.
- Fake Slack API server (Hono, modeled on `plugin-telegram/test/fake-bot-api.ts`)
  for outbound: postMessage/update/uploads/typeahead.
- API integration: signed webhook fixtures → (a) DM → orchestrator prompt e2e,
  (b) app_mention → prompt with channel header, (c) reaction event + subscription →
  workflow start, (d) `slack.message` with no subscription → **no** events row,
  with subscription → row + delivery, (e) url_verification challenge, retry-drop,
  bad signature 401, team mismatch drop, (f) interactivity payload → gate resolved.
- Ingest unit tests for the `ephemeral` ordering change (including dedupe on
  concurrent ephemeral inserts).
- Manual (needs tunnel or deploy, same caveat as Linear): real workspace connect,
  DM round-trip, mention round-trip, Socket Mode local loop with an `xapp` token.

## Non-goals

- OAuth bot install (manual token + signing secret only; signing secret is
  unobtainable via OAuth anyway).
- Channel↔session bindings, `triggerMode: all`, unattributed-sender routing to the
  org orchestrator (`channel_bindings` remains shape-only).
- Slash commands (`/status`, `/sessions`, …).
- Suggested prompts / full assistant-surface UX.
- Multi-workspace per org; Enterprise Grid.
- Interactive free-text prompt replies (legacy `InteractivePrompt` reply-in-thread
  hint) — gates are button-only, matching Telegram.

## Deltas from legacy worth calling out

- Legacy routed **only DMs** in practice (mentions parsed then ignored); this pass
  routes mentions.
- Legacy correlated interactive buttons via `value = sessionId:promptId`; v2 embeds
  `g|{gateId}|{actionId}` and verifies ownership at resolution, plus survives api
  restarts (Telegram gates don't — its in-memory `gateRefs` remains its limit).
- Legacy stored install state in `org_service_configs`/`org_slack_installs`; v2
  uses the org credential row + metadata, no tables.
- Legacy dropped all retries and so does v2, but v2's durable idempotency
  (`dispatchId`-keyed admission, event `dedupeKey`) makes that safe rather than
  merely pragmatic.
