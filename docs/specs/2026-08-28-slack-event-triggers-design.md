# Slack event sources for workflow triggers

**Status: implemented 2026-08-28.** Linear issue TKAI-247. Sister issue TKAI-246 (Linear event sources).

## Problem

Valet workflows can trigger on GitHub and Linear events, but not Slack. A user
wants a workflow to run when the Valet app is @-mentioned, when a message is
posted in a watched channel, or when a reaction is added. The generic event
rail already exists (webhook → normalized event → subscription match → run),
and the Slack plugin already declares trigger definitions for six event
families. This work is an audit of that rail plus the one change that makes it
fire end to end.

## Audit results

The task started as an audit of two open questions. Both resolve to
already-correct, so this spec records the evidence and the one real gap.

### 1. The signing secret is persisted at connect time

`PUT /api/credentials/slack?scope=org` (`packages/api/src/routes/credentials.ts:193`)
refuses to save the org Slack credential unless `metadata.webhookSecret` is set,
and returns a corrective error naming where to copy the Signing Secret from. The
same handler verifies the bot token against Slack and records `teamId`,
`teamName`, and `botUserId` on the credential. There is no second path that
creates the org Slack credential, so the secret can never be absent on a
connected org. No change needed.

The webhook route reads both fields it depends on and acks (200) with a
`unknown_org` drop-log entry when either is missing
(`packages/api/src/routes/slack-webhook.ts:229`), rather than 401-looping Slack
against a half-configured org.

### 2. The webhook route is mounted before auth, with the dispatcher threaded

`app.ts:173` mounts `slackWebhookRouter` at `SLACK_WEBHOOK_MOUNT`
(`/api/channels/slack`), before the more general `channelsRouter` and before
`buildAuthMiddleware` at `app.ts:272`. The route is public because the caller is
Slack, and the signing-secret HMAC is the whole authentication. The route calls
`eventDispatcher.nudge` after ingest (`slack-webhook.ts:285`), so a matched
delivery wakes the dispatcher without waiting for its 1-second poll. No change
needed.

### 3. The gap: the app manifest did not subscribe to the trigger events

Slack delivers only the event types an app subscribes to in its manifest. The
manifest (`SLACK_BOT_EVENTS`, `packages/api/src/services/slack-app.ts`) declared
three bot events for the agent DM surface: `app_home_opened`,
`app_context_changed`, `message.im`. The trigger definitions matched six event
families, but Slack was never told to deliver them. Every trigger except a DM
`slack.message` was a silent no-op: the catalog surfaced it, a user could
subscribe to it, and it could never fire.

This is the fix. `SLACK_BOT_EVENTS` now subscribes to every event type the
trigger defs match: `message.channels` / `message.groups` / `message.mpim` (DM
already rode `message.im`), `app_mention`, `reaction_added` /
`reaction_removed`, `member_joined_channel` / `member_left_channel`, the four
`channel_*` lifecycle events, `file_shared`, and `team_join`. The scopes these
events read with were already declared in `SLACK_OPTIONAL_BOT_SCOPES`, so an
operator who already installed the app must reinstall to widen event delivery,
but no scope grant changes.

A drift guard pins this: the plugin exports `slackTriggerEventTypes`
(`packages/plugin-slack/src/triggers.ts`), and `slack-app.test.ts` asserts every
entry is subscribed in `SLACK_BOT_EVENTS`. `message` is delivered as one bot
event per channel type, so the guard checks all four `message.*` variants are
present, not just one. A new trigger def that ships a catalog entry Slack never
delivers now fails a test instead of failing silently in production.

**Deployment note.** `SLACK_BOT_EVENTS` is the app manifest's event
subscription list. An already-installed workspace app keeps its old event set
until an operator re-pushes the updated manifest from Settings → Organization →
Slack (the paste-in flow). No user reinstall is needed, because the scopes were
already granted, but until the app's Event Subscriptions are updated in Slack,
the new triggers do not fire for that workspace.

### 4. New: the `app_mention` trigger

The issue named `app_mention` as a first target, but no trigger def matched it.
This work adds `slack.app_mention` to the trigger defs. The `app_mentions:read`
scope was already in the manifest (held for V1 parity), so the def needed no
scope change. `app_mention` carries `channel` and `user` directly, which the
shared `toEvent` normalizer already reads.

## The Slack trigger-match contract

For workflow authors and future maintainers, the exact contract a Slack event
travels:

- **Signature.** HMAC-SHA256 over `v0:{timestamp}:{rawBody}`, keyed by the org
  credential's signing secret, checked against `X-Slack-Signature`
  (`packages/plugin-slack/src/transport/verify.ts`). The trigger defs re-verify
  over the same raw bytes so their extraction stays authoritative
  (`triggers.ts:makeVerify`).
- **Replay window.** 5 minutes on `X-Slack-Request-Timestamp`. A stale timestamp
  is a 401.
- **Workspace scope.** A shared app's signing secret is valid for every
  workspace that installs the app, so a valid signature alone does not prove
  ownership. The route drops any update whose `team_id` is not the connected
  workspace's (`slack-webhook.ts:297`, `foreign_workspace`). Two orgs connected
  to Slack never cross-fire.
- **Dedup key.** The Events API `event_id`, carried as `deliveryId` and used as
  `dedupeKey`. Ingest holds `ON CONFLICT DO NOTHING` on `(service, dedupeKey)`,
  so a redelivery produces zero extra events and zero extra deliveries.
- **Match-gated persistence.** Ingest persists an event only when it matches an
  enabled subscription. See the privacy section below. This is also why the
  manifest can subscribe to `message.channels` without flooding the events
  table: an unsubscribed channel message is dropped at ingest.
- **Payload shape.** The normalized event's `payload` is the inner Events API
  `event` object, so a subscription filter dot-path addresses the raw event
  directly (for example `item.channel` for a reaction).
- **Self-trigger guard.** The `slack.message` and `slack.app_mention` defs both
  drop the app's own posts (`bot_id` present), so a workflow that posts to Slack
  cannot loop: its own channel post cannot re-fire `slack.message`, and a post
  whose text @-mentions the bot cannot re-fire `slack.app_mention`. `slack.message`
  additionally drops the noise subtypes the channel transport drops.
- **Double delivery of a channel mention.** An @-mention of the bot in a channel
  produces two Slack events with distinct `event_id`s: an `app_mention` and a
  `message`. An org subscribed to both `slack.app_mention` and `slack.message`
  therefore runs its workflow twice for one mention. Each event is a real,
  separately-subscribed delivery, so this is correct, not a duplicate. An author
  who wants one run subscribes to one key.

## Message events and the agent surface

Subscribing to `message.channels` means the agent DM consumer also sees channel
messages. It ignores them safely: `transport.parseUpdate` returns null for any
message whose `channel_type` is not `im` (`transport.ts:286`), so a channel
message reaches only the event pipeline, never a DM agent session.

## Privacy: events are stored only when a subscription matches

Ingest is match-gated for every event, not only high-volume ones
(`packages/api/src/events/ingest.ts`). Before any insert, ingest matches the
event against the org's enabled subscriptions. An event that matches nothing is
dropped and never touches the events table. The match is the full key-and-filter
test, so an event a subscription excludes by filter is dropped the same as one
no subscription names at all: the filter is a privacy boundary, not only a
delivery boundary.

This changed the prior behavior, where only the `ephemeral` `slack.message` key
was gated and every other event (GitHub, Linear, and the rest of Slack)
persisted on arrival. The rule now holds across all services. The `ephemeral`
catalog flag is removed, because universal gating makes it a no-op.

Two consequences a reader should know:

- **The event feed shows only subscribed events.** `GET /api/events` reads the
  events table, which now holds only matched events. An org that watches one
  repo no longer accumulates every other event its webhook delivers. The feed
  read logic is unchanged; there is simply less to read.
- **Redelivery covers only stored events.** `POST /api/events/:id/redeliver`
  replays a stored event through the subscriptions that match now. An event that
  matched nothing at arrival was never stored, so it cannot be replayed to a
  subscription created later. This is the intended trade: Valet does not retain
  data no subscription asked for so that it can be delivered retroactively.

## Debuggability: the Problems tab

Match-gating means an unmatched event leaves the events table empty, so "I set
up a trigger and nothing happened" has to be answerable somewhere. The Events
page gains a **Problems** tab (`GET /api/events/drops`) that surfaces the
`event_drop_log` the webhook routes already write — bad signature, wrong
workspace, missing credential, slow-ack retry — plus a "last event received"
timestamp (the max of the newest events row and the newest drop-log row). That
timestamp answers "is anything arriving at all?" without exposing any payload.

Ingest also drop-logs one match-gated miss: an event whose key a subscription
**names** but whose filter excluded this occurrence (`filter_excluded`). That is
the high-signal "my trigger didn't fire" case, and it is bounded by user intent
(a subscription must exist). It is throttled per (org, event key) at one row a
minute, and records only the event key — never the payload or refs, so the
privacy rule holds.

An event that **no** subscription names is deliberately NOT drop-logged. For a
high-volume key like `slack.message` that is every message in the workspace, so
logging it would re-flood the drop-log the privacy design keeps small. The "last
event received" signal covers that case instead.

## Mention scoping (TKAI-299, added 2026-09-01)

A `slack.app_mention` subscription started with unsafe defaults: no user
filter (anyone's mention fired it) and no channel filter (it listened across
the whole workspace). Both defaults are now closed at write time
(`packages/api/src/events/mention-scope.ts`). A subscription whose event keys
select `slack.app_mention` — the exact key or a trailing wildcard — is a
**mention subscription**, and every write to one passes two gates:

1. **User scope.** The stored filters must carry a `user` filter equal to the
   creator's linked Slack user id (`user_identity_links`). The server injects
   the filter when it is absent, and refuses a filter that names anyone else.
   A creator with no linked Slack account cannot create one; the error names
   the corrective action (Settings → Connected accounts).
2. **Channel scope.** The stored filters must carry at least one `channel`
   filter with op `eq` or `in` (`prefix`/`contains`/`regex` do not count — a
   prefix is still the whole workspace). The explicit `anyChannel: true`
   request flag waives the requirement. The flag is not persisted: a stored
   mention subscription with no channel filter IS the any-channel state, and
   the UI derives the display from that.

Every subscription writer shares the gate: the subscriptions CRUD routes
(`routes/events.ts`), the workflow trigger service
(`workflows/trigger-service.ts`), and the template installer
(`workflows/templates.ts`). On PATCH the gate re-runs only when the
patch changes `filters` or `eventKeys`, and it keys to the row's CREATOR
(`created_by`), not the caller — an enable/disable toggle still works after
the creator unlinks Slack, and a colleague's edit of an org-owned row cannot
re-point the scope at themselves.

One consequence: because filters apply to every key a subscription selects, a
mention subscription cannot mix in a key whose catalog entry declares no
`user` field (for example `slack.channel_created`) — the injected filter
would never match it. The gate refuses the mix and tells the author to
create a separate subscription. This also covers `slack.*` wildcards.

Surfaces: the AutomationWizard's reply step requires a multi-channel
selection (or the explicit "Any channel" checkbox, off by default) and states
that only the creator's own mentions fire the rule; the raw event picker and
the workflow TriggerDialog show the same checkbox when `slack.app_mention` is
selected; the subscriptions list labels each mention row "only #channel",
"N channels", or "any channel". Rows created before this change are
untouched until their filters are next edited.

## Custom slash commands that route to triggers or assistants

This was an investigation request alongside the issue. Two distinct systems
carry the "slash command" name in Valet; the request could mean either.

### System A: Valet in-app slash commands (`CommandDef`)

`ValetPlugin.commands` (`packages/engine/src/commands/types.ts`) declares typed
`/command`s that the web composer surfaces (`command-popup.tsx`). A `CommandDef`
maps its arguments to one plugin **action**. Sources today are `builtin`,
`skill`, and `plugin`. This system routes a command to an action, not to a
workflow trigger or an assistant/orchestrator start.

To route in-app commands to triggers or assistants, add a resolved-command
variant (for example `{ source: "workflow", workflowId }` or
`{ source: "assistant", assistantId }`) and a config surface that maps a command
name to that target. This is a self-contained follow-up on the in-app command
registry; it does not touch the Slack rail.

### System B: Slack slash commands (`/valet-deploy ...`)

A Slack slash command is a third body shape Slack posts to the same app request
URL: `application/x-www-form-urlencoded` with `command`, `text`, `user_id`,
`channel_id`, `team_id`, `response_url`, and `trigger_id`. The signing-secret
HMAC is identical to the Events API path, so verification reuses
`verifySlackSignature` unchanged.

What slash commands do **not** reuse:

- **A synchronous reply.** Slack wants a response inside 3 seconds and shows it
  to the user. The events path acks empty and works asynchronously; a slash
  command wants an immediate acknowledgement plus optional later posts to
  `response_url`.
- **Manifest declaration.** Each command is declared under `features.slash_commands`
  in the app manifest (name, request URL, description). The manifest builder
  (`buildSlackAppManifest`) would grow a `slash_commands` block, and adding one
  forces an app reinstall.
- **A command-to-target map.** New config: which `/command` fires which workflow
  or messages which assistant, per org, with a UI to manage it. This is the bulk
  of the work and has no analog in the event rail.
- **A new body branch.** The webhook route detects Events API JSON and
  interactivity `payload=` bodies today; a `command=` form body is a third
  branch with its own verification-then-dispatch path.

**Decision: fast-follow, not in this issue.** Slash-command routing is a feature
with its own config, UI, and manifest surface, not a trivially reusable
extension of the event rail. The issue's open question set the same bar ("land
in this issue if plumbing is trivially reusable, otherwise fast-follow"). The
signature and workspace-scope machinery are reusable; the target-mapping and
synchronous-response surfaces are new. File a follow-up issue for System B, and
a separate one for System A if in-app command routing is wanted.

## What changed

- `packages/api/src/events/ingest.ts` — match-gates persistence for every
  event, not only `ephemeral` keys (the privacy change above).
- `packages/engine/src/valet-plugin.ts` — removed the now-unused `ephemeral`
  flag from `EventCatalogEntry`.
- `packages/plugin-slack/src/triggers.ts` — added the `slack.app_mention`
  trigger def and its summary case; refactored the defs to a spec table;
  exported `slackTriggerEventTypes`; dropped the `ephemeral` marker.
- `packages/plugin-slack/src/plugin.ts` — re-exported `slackTriggerEventTypes`.
- `packages/api/src/services/slack-app.ts` — `SLACK_BOT_EVENTS` subscribes to
  every trigger event type.
- Tests: `packages/plugin-slack/src/triggers.test.ts`,
  `packages/api/src/services/slack-app.test.ts`,
  `packages/api/src/routes/slack-webhook.test.ts`,
  `packages/api/src/routes/events.e2e.test.ts` — coverage for `app_mention`, the
  manifest drift guard, end-to-end `reaction_added` / `app_mention` ingest and
  delivery, and the drop-not-store behavior for filter-excluded GitHub and
  Linear events.

## Out of scope

- Outbound Slack actions from workflows (existing plugin actions).
- Retro-triggering on historical events.
- Slash-command routing (System A and System B above).
- Multi-org workspace resolution (the deployment resolves one org, per
  `lib/org.ts`; the webhook route notes the single lookup a multi-org deployment
  would add).
