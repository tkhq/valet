# Channel reply routing, assistant identity, and a unified routing wizard

**Status: draft 2026-08-28.** Base branch `dev-v2`. Builds on `#441`
(sender attribution) and `#443` / TKAI-247 (Slack event triggers, the filter
editor, match-gated persistence).

## Problem

A Slack `@mention` reached a team assistant, the assistant answered inside its
session, and the person in Slack got nothing back. The web session showed the
raw Slack event JSON as the prompt. Two defects combined:

1. **No reply route.** An event delivered to an assistant lands on the owner's
   shared `"events"` thread with no channel origin. The outbound bridge that
   posts assistant replies to Slack keys off a thread whose key decodes to a
   Slack conversation; the `"events"` thread does not, so the reply never
   leaves the session. This holds for every channel-originated event on the
   orchestrator-target path, not only `app_mention`.

2. **No identity.** The prompt was `JSON.stringify(event.payload)`
   (`dispatcher.ts:172`), so the assistant had to parse Slack's event schema to
   read one sentence. The team persona (`persona.ts:127`) never receives the
   team's name, so the assistant called itself "the shared assistant for
   `team_c7268244-…`". It also had no reliable statement of who sent the
   message.

A third, related defect is in the routing UI the operator uses to decide which
events reach an assistant. `#443` gave the filter editor typed field/op/value
rows, but the value is still raw typed text: an operator types a Slack `C…` /
`U…` id by hand. There are also three separate creation surfaces (event
subscription dialog, workflow event-trigger dialog, workflow schedule dialog)
for what is one idea: "when X happens, do Y".

## Goals

- A channel-originated message that an assistant answers gets the answer back on
  the same channel and thread. Delivery does not depend on the model choosing to
  act.
- The assistant reads a clean message, knows its team by name, and knows who
  sent the message. It never surfaces a raw UUID or a raw Slack id.
- One wizard creates any routing rule. Its filters read and write human names,
  never raw ids, and auto-populate from the provider when a credential allows
  it. It matches on a user, a repository or branch, a slash command, or a text
  pattern.

## Non-goals

- Real Slack slash-command endpoint (the `/command` request URL + manifest
  `slash_commands` block + synchronous 3-second reply). Deferred per TKAI-247;
  this work covers the text-prefix convention only.
- Porting the full DM conversation model onto channel mentions. Per-submission
  origin routing (below) delivers the reply to the right Slack thread without a
  dedicated per-conversation session thread.
- Retro-triggering, multi-org workspace resolution (unchanged from `#443`).

## Design

### Part 1 — reliable replies and identity

#### 1.1 Origin travels with the submission

Add an optional `origin` to `SignalContent` and carry it onto the persisted
assistant `MessageEntry` for the turn:

```ts
interface ChannelOrigin {
  channelType: string;   // "slack"
  threadKey: string;     // "slack:{channelId}:{threadTs}" — teamId omitted, held by the credential
}
```

`threadKey`, not a full `conversationKey`, because the outbound bridge already
rebuilds the `conversationKey` from a thread key through
`transport.conversationKeyFromThreadKey` (`channels/host.ts:454`), which injects
the workspace `teamId` from the org credential. Reusing that hop means origin
routing shares one codec with the DM path and needs no `teamId` in the event.

The origin binds to the **submission**, not the thread. The `"events"` thread
aggregates every event for an owner; two mentions from two channels interleave
there. Each carries its own origin, so each reply routes to its own thread.

#### 1.2 The dispatcher stamps origin and a readable body

In `dispatcher.ts`, when `target.kind === "orchestrator"` and the event's
service is a channel transport that can locate a conversation:

- Compute `origin.threadKey` with a new transport hook
  `threadKeyFromEvent(eventKey, payload): string | null` (Slack builds
  `slack:{channelId}:{thread_ts ?? ts}`; returns null for events with no
  conversation, e.g. `team_join`). The dispatcher reaches transports through the
  same registry the channel host uses.
- Replace the body. Stop serializing the raw payload. Build the body from the
  transport's existing `event.summary` plus the message text
  (`payload.text` for a Slack message/mention), bounded. Raw payload stays in
  the `events` table for the Problems tab and debugging; it is not in the
  prompt.
- Set the signal's sender from `event.actor` so `formatSenderLine` (`#441`)
  attributes the message to the person, resolving the external id to a display
  name when a `user_identity_link` exists.

`renderSignalEnvelope` (`submission.ts:69`) already writes signal attributes
into the envelope. Origin renders as an attribute so the model can read where
the message came from; the sender line renders through the `#441` path.

#### 1.3 `app_mention` needs no separate port

The screenshot's mention reached the **orchestrator** target, so 1.1 + 1.2 fix
it directly: a mention now carries the origin needed for an explicit reply to
its Slack thread. `#443` already added the `slack.app_mention` trigger def;
an operator routes it to an assistant with a subscription. We do not add a
second, DM-style conversation door for channel mentions.

#### 1.4 First automatic reply, then explicit replies

**Addressed first reply.** For an addressed channel turn, `ChannelHost`
subscribes to `message_end`. It posts the first assistant message that has
text. This message is the immediate reply or acknowledgement.

**Later replies are explicit.** The host does not post later assistant messages
or the final result. The agent uses `reply_to_origin` for progress updates
and results. Slack also provides `reply_file_to_origin` for sandbox files.
The `react_to_origin` action remains the explicit reaction path.

**One delivery.** The host evaluates origin-reply calls across every
assistant entry in the submission, including text-less entries before the first
eligible text. Any completed call with persisted `details.ok=true` owns
delivery. Otherwise, any running call defers automatic delivery. Only after all
attempted origin replies become terminal failures does the host post the
original first eligible text once as a fallback. An aborted submission never
posts this fallback. Event redelivery cannot post it twice.

**Overheard turns stay silent.** A turn with `reply="manual"` has no automatic
reply. The agent must call a channel action when it chooses to participate.

Direct channel messages and channel events use `SignalContent`. It carries the
origin and supported image attachments. The engine gives this origin to the
tool context, so explicit origin actions work for both paths.

**No final fallback.** The failed-action fallback applies only to a deferred
first response. A reply action on a later message does not enable a host post.
Decision-gate cards, command results, attention messages, link-flow messages,
and other explicit host control messages keep their existing delivery
behavior.

**Submission surface (TKAI-323).** A bound thread stays bound for its whole
life. Gate cards and command results inspect the submission surface. A web
prompt stays in the web app. A channel prompt can still receive its explicit
control message. `MessageEntry.channel` records direct channel submissions,
and `signal` records engine-routed admissions.

#### 1.5 Identity: team name and sender

- **Team name.** `buildAssistantSession` (`engine/host.ts:1368`) resolves the
  owner. When `principal.type === "team"`, look up `teams.name` and pass the
  display name into the persona (`orchestratorPersona(owner, displayName?)` or a
  one-line context prefix). The team persona states the team by name. No path
  emits `team_<uuid>` into model-visible text.
- **Sender.** `#441` renders a sender line for user messages. Confirm the
  channel-origin signal carries an author (1.2 sets it from `event.actor`) so
  the same line renders. If a gap remains on the events path, close it here.
- **Outbound identity (TKAI-387).** Every gate card, command result,
  attention summary, and Slack outbound action carries the sending assistant's
  identity. This includes `reply_to_origin`, `send_message`, `dm_owner`, and
  `dm_user`. `ChannelHost` resolves the session's `assistants` row for host
  deliveries. The engine gives session actions a dynamic
  `resolveOutboundSender` callback. Headless workflow actions and workflow
  session nodes resolve the run owner's default assistant when they post.
  Child-agent sessions resolve the assistant that owns their parent session,
  then use the owner's default assistant when the parent has no assistant.
  Both paths read the current row, so profile edits apply without a
  cached-session rebuild. The Slack
  paths map `name` and `avatar_url` to `username` and `icon_url` on
  `chat.postMessage` with the `chat:write.customize` scope. They sanitize the
  name to Slack's 80-character limit and omit malformed avatar URLs. If Slack
  rejects an identity override, they retry once without it. A network failure
  does not retry because Slack might have accepted the first request. An
  assistant with neither field set posts under the bot's own identity.
  Resolution edits (`chat.update`) keep the identity the card posted with.
  File attachments keep the app identity because Slack's upload API has no
  equivalent override.

### Part 2 — one routing wizard, names not ids

#### 2.1 Provider-resolved filter options

The "no raw ids" fix is not Slack-specific. Each provider knows how to turn its
own filter fields into a list of named options: Slack resolves a user id to a
display name and a channel id to a channel name; GitHub lists the repositories
the app can see and the branches in a repository; Linear lists teams. The design
is a per-plugin **option source**, not a hardcoded set of Slack endpoints.

- **Catalog declares the source.** An `EventCatalogEntry` filter field grows an
  optional `options` descriptor: `{ source: string; dependsOn?: string[] }`.
  `source` names a resolver the owning plugin registers (`slack.users`,
  `slack.channels`, `github.repos`, `github.branches`, `linear.teams`).
  `dependsOn` names earlier filter fields whose chosen values scope this one —
  `github.branches` `dependsOn: ["repo"]`, because a branch list has no meaning
  until a repository is chosen.
- **One generic endpoint.** `GET /api/events/filter-options?source=…&q=…` plus
  the resolved `dependsOn` values as query params. It dispatches to the owning
  plugin's resolver, which calls the provider API (Slack Web API, the GitHub
  installation API, Linear) and returns `[{ id, label, hint? }]`. Results are
  cached per org with a TTL so a keystroke does not hit the provider. A source
  that cannot resolve right now (missing credential, provider error) returns an
  empty list plus a reason the picker shows, and the field falls back to free
  text so the rule is still creatable.
- **Plugin contract.** A plugin exports its resolvers alongside its trigger
  defs; the api registers them by `source` name the same way it registers
  transports. A new provider adds option sources without touching the api.

This is the backbone for "no raw ids": the picker shows names, stores ids, and
auto-populates from the provider whenever a credential lets it.

#### 2.2 Filters read and write names

- Persist an optional display `label` beside a filter value. `filters` is
  `jsonb`, so this adds no DDL — the wire type and the subscription validator
  grow a `label?: string`. The editor renders the label; matching still uses the
  id in `value`.
- `filter-editor.tsx`: when the selected field declares an `options` source
  (2.1), the value input becomes a searchable, auto-populated picker that
  records the id and its label. A `dependsOn` field disables until its parent is
  chosen (pick a repo, then its branches load). Fields with no source keep the
  free-text input.

#### 2.3 Match on user, slash command, or text pattern

- Add a `text` filterable field to the `slack.message` and `slack.app_mention`
  catalog entries (path `text`).
- Add a `regex` operator to the filter model and matcher, guarded against a bad
  pattern (a compile failure fails the filter closed and is reported, not
  thrown). "Pattern" in the wizard maps to `regex`; "contains" and "starts
  with" map to the existing `contains` / `prefix`.
- Text-prefix slash command is `{ field: "text", op: "prefix", value: "/deploy" }`,
  surfaced in the wizard as a "starts with command" input. This is the MVP
  slash-command support; the real endpoint stays deferred.

#### 2.4 One wizard, schedules folded in

Consolidate the three creation surfaces into one "New automation" wizard:

1. **When** — an event or a schedule.
2. **Match** — event: pick event keys, then friendly filters (2.2, 2.3);
   schedule: a cron expression and timezone.
3. **Then** — a target: an assistant/orchestrator (user, team, or org) or a
   workflow.
4. **Review** — a plain-language summary ("When someone mentions the app in
   #deploys, notify the Platform team's assistant").

The wizard writes to the existing models — `event_subscriptions` for an event
rule, the schedule model for a cron rule — and picks the right store per branch.
The old dialogs redirect to the wizard.

## Data and migrations

Pre-1.0 rules apply (edit `0000_app.sql` in place; `rm -rf ~/.valet/pg` after).
Expected footprint:

- No new column: `origin` and the filter `label` live inside existing `jsonb`
  (`SignalContent` / the signal entry; `filters`). Confirm during
  implementation; if `origin` needs a first-class engine column, edit the engine
  raw SQL and the `store-postgres` row mappers together (per CLAUDE.md).
- App-table changes, if any, need a matching `SCHEMA_REPAIRS` entry
  (`lib/drizzle.ts`) so a deployed database gets them.

## Invariants (alert, do not auto-repair)

An addressed turn has at most one automatic assistant-text delivery: its first eligible response. Later and final text requires an explicit channel action. An overheard turn has no automatic delivery.

## Testing

- **Engine.** Channel-signal origins reach the tool context.
- **API.** An addressed turn posts its first assistant text once. Later and final text stays internal. An overheard turn stays silent.
  Command results and gate cards retain their existing surface checks.
- **Slack.** `reply_to_origin` posts text exactly once.
  `reply_file_to_origin` uploads a sandbox file exactly once.
  `react_to_origin` still reacts to the triggering message.
- **Telegram.** `telegram.reply_to_origin` posts text exactly once to the
  origin DM.
- **Persona.** The channel instructions explain the automatic first reply and explicit later replies. They keep overheard chatter silent by default.
- **Full `make e2e` scorecard**, per CLAUDE.md, before claiming done.

## Deviations (Part 1, as built)

- **Only the first addressed response posts automatically.** Final-message fallback delivery remains removed. A successful explicit origin reply anywhere in the submission suppresses the automatic copy. A pending call anywhere in the submission defers it. When all calls fail, the host falls back to the original first text.
- **`child.settled` inherits the spawning submission's origin.** The parent
  can post the child result with `reply_to_origin`. The settlement itself does
  not post.
- **Telegram has an explicit text reply action.** `telegram.reply_to_origin`
  sends text to the origin DM through the organization bot credential.
- **Sender name is a handle, not a resolved display name.** The dispatcher sets
  the signal's `sender` attribute from `event.actor` (`login` or `externalId`).
  For a Slack `app_mention` this is the raw Slack user id, because the event
  carries no username. Resolving it to a display name reuses Part 2's
  name-resolution service; until then a channel-origin sender can surface as an
  id. The headline identity fix (the team name) is complete.
- **`slack.channels` reads the bot's joined channels, not the workspace
  directory.** The source first paged `conversations.list`. That offered
  channels a filter can never match — Slack sends `message`/`app_mention` only
  for channels the app has joined — and it made the picker fail at Turnkey
  scale. The scan stopped early only once a query collected 20 matches, so a
  BROAD query cost one API call while a NARROW one (the case that needs the
  lookup) paged the whole directory on every keystroke. That exhausted the
  Tier-2 rate limit, and `slackGet`'s three `Retry-After` sleeps turned each
  request into a 30-60s stall that resolved to nothing. `users.conversations`
  (Tier 3) returns the joined set instead, which is small enough to page in
  full, so the resolver ranks every match before it truncates to 100 rows. The
  old cap truncated in Slack's page order first and sorted the survivors, which
  could hide an exact-name match behind 20 arbitrary ones.
- **A failed option lookup is never memoized, and never reads as "no
  options".** Two bugs compounded the one above. The Slack resolvers caught
  their own provider errors and returned `[]`, so a rate-limited lookup and a
  name that does not exist were indistinguishable — the endpoint's `reason`
  never fired and the picker showed "No matches". The endpoint then cached that
  empty list for its full 60s TTL, so the next minute of retries answered from
  a poisoned entry. Resolvers now let provider failures propagate, and the
  endpoint caches only successful lookups.
- **Both pickers read a cached directory, so neither truncates before it
  ranks.** `slack.users` had the same truncate-before-sort flaw and no smaller
  set to read: `users.list` is the only member directory and offers no
  server-side search. Dropping its 20-match early return alone would have
  traded the truncation bug for the rate-limit bug above, so the directory
  moved behind a short-TTL, single-flight cache
  (`transport/directory-cache.ts`), keyed by a digest of the bot token. Each
  scan is now paid once per TTL instead of once per keystroke, which is what
  makes ranking every match affordable. `listWorkspaceMembers` therefore
  filters, sorts, and only then truncates, and the identity-link member search
  gets the same fix: a person could previously type their own name in full and
  not find themselves, behind 20 unrelated partial matches in Slack's page
  order.

  The cache also supplies the rate-limit backpressure that a negative cache in
  the endpoint would otherwise have to. A failing scan is never stored, but a
  scan IN FLIGHT is, so a workspace has exactly one attempt running however
  fast the reader types, and a failure is retryable on the next keystroke
  rather than sticky for a minute.

  What remains bounded is the SCAN, not the match count: past 10 pages the
  directory is incomplete, and a query matching only past that point reports no
  match. For `users.list` in a very large workspace that is a real limit with
  no API to fix it, so it is stated rather than hidden.

## Sequencing

One project, one PR onto `dev-v2`, built in this order so each step is
reviewable and the reply fix lands first:

1. Origin plumbing (1.1) + readable body (1.2) + identity (1.5). Closes the
   screenshot defect.
2. Reply mechanisms (1.4): explicit reply and reaction actions.
3. Name resolution service (2.1) + name-aware filters (2.2, 2.3).
4. The unified wizard (2.4).
