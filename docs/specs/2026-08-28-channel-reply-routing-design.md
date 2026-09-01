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
it directly: a mention that an assistant answers now carries origin and replies
to its Slack thread. `#443` already added the `slack.app_mention` trigger def;
an operator routes it to an assistant with a subscription. We do not add a
second, DM-style conversation door for channel mentions.

#### 1.4 Two reply mechanisms

**Auto-reply (safety net).** Extend `deliverAssistantMessage`
(`channels/host.ts:474`). Today it maps `thread.key → conversationKey` and skips
when the map fails. Add: if the finishing submission carries `origin`, resolve
`origin.threadKey → conversationKey` and post there, even though the `"events"`
thread key does not map. The existing guards hold (skip if already streamed,
skip empty messages). The safety net posts ONE message per gate segment: the
segment's first message that carries text or an attachment. A turn-final gate
would drop a reply the model fronts into its first tool-call message, and
posting every text round floods the thread with narration (see the Telegram
design's deviation 2). The slot is derived from the persisted entries, not
held in memory, so an api restart mid-submission cannot double-post. A
resolved decision gate re-opens the slot: the post-approval outcome reaches
the reader who approved it. Other later output reaches the thread only
through `reply_to_origin`. A failed or unroutable post is drop-logged
(`event_drop_log`), never swallowed, so the Problems tab shows it.

**Reply action (contract).** Add a `reply_to_origin` action. It reads the
current submission's origin and posts to that thread with no channel/thread
argument to guess. The team persona instructs the assistant to use it when it
answers a channel-originated message. The action is the primary path; the model
should reply through it.

**No double post.** An addressed turn (`reply: "auto"`, the default) auto-posts
only each segment's first text-bearing message; when the submission already
replied through `reply_to_origin`, the auto-post stands down
(`turnRepliedToOrigin` scans the submission's tool calls for a SUCCESSFUL
reply — `details.ok === true` on the persisted result). A failed reply must
not stand the net down: the action failure text goes to the model, and the
safety net still posts. An overheard turn (`reply: "manual"`) never
auto-posts, and the action is the only reply path. The streamed path obeys
the same contract: one streamed message per gate segment.

#### 1.5 Identity: team name and sender

- **Team name.** `buildAssistantSession` (`engine/host.ts:1368`) resolves the
  owner. When `principal.type === "team"`, look up `teams.name` and pass the
  display name into the persona (`orchestratorPersona(owner, displayName?)` or a
  one-line context prefix). The team persona states the team by name. No path
  emits `team_<uuid>` into model-visible text.
- **Sender.** `#441` renders a sender line for user messages. Confirm the
  channel-origin signal carries an author (1.2 sets it from `event.actor`) so
  the same line renders. If a gap remains on the events path, close it here.

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

The auto-reply is a feature, not an invariant repair — it delivers an intended
message, it does not silently paper over a broken state. Where it cannot deliver
(no transport, a Slack post failure, a missing credential), it drop-logs the
reason to `event_drop_log` and the Problems tab shows it. A channel-originated
turn that produces no reply at all is a reportable miss, not a silent drop.

## Testing

- **Engine.** `origin` round-trips submission → persisted entry;
  `renderSignalEnvelope` includes the origin attribute and the sender line.
  Regression suites named in CLAUDE.md's tool-call round-trip rule.
- **API.** The dispatcher stamps origin and a readable body for a channel-origin
  orchestrator delivery; the body holds no raw JSON. `deliverAssistantMessage`
  posts to the origin conversation when the thread key does not map.
  Double-post suppression: an action reply suppresses auto-reply; no action
  reply triggers auto-reply.
- **Slack.** `threadKeyFromEvent` for `message` and `app_mention`; end-to-end
  `app_mention` → assistant turn → one Slack post on the right thread.
- **Persona.** The team persona names the team; no code path emits `team_<uuid>`.
- **Web.** The filter editor auto-populates options from a provider source and
  stores the id with its label, reading it back as a name; a `dependsOn` field
  (`github.branches`) stays disabled until its repo is chosen; a source with no
  credential falls back to free text with a reason. The wizard branches event
  vs. schedule; the slash text-prefix input compiles to a `prefix` filter.
- **Provider resolvers.** Each option source (`slack.users`, `slack.channels`,
  `github.repos`, `github.branches`, `linear.teams`) returns named options and
  caches per org; a `dependsOn` source scopes to its parent value.
- **Full `make e2e` scorecard**, per CLAUDE.md, before claiming done.

## Deviations (Part 1, as built)

- **Auto-reply posts each segment's FIRST message, not the turn's final one.**
  The design assumed the final turn message was the reply. In practice the
  model fronts the reply into its first message (often beside its first tool
  call) and narrates every round after; posting the final message ghosts the
  reply and posting every round floods the thread. The safety net posts the
  first text-bearing message per gate segment, derived from the persisted
  entries (restart-safe, no delivery-state store). The "already replied"
  check scans the submission's entries for a SUCCESSFUL `….reply_to_origin`
  call (`details.ok === true`); the action is allowed on addressed turns as
  the sanctioned path for output after the segment's first message.
- **`child.settled` inherits the spawning submission's origin.** The spawn
  captures the running submission's `ChannelOrigin` (task builtin →
  `ChildSpawner` ctx) into `child_watches.origin_json`, durable across the
  boot `rearm()`. The settlement signal carries it verbatim, so the
  "ack → spawn child → report back" flow reaches the thread that asked: an
  `auto` origin auto-posts the report's first message, a `manual` origin
  keeps the report explicit-only.
- **Deferred: a channel-generic reply action.** Telegram has no
  `reply_to_origin`, so a Telegram-origin turn cannot send output after its
  segment's first message. A per-plugin action needs org-scope credential
  access that the action context does not have today (Slack's action uses
  the user integration token; Telegram only has the org bot token). The
  right shape is one host-level reply mechanism that resolves the origin's
  running transport — pair it with the engine-owned reply concept below.
- **Deferred: agent-visible delivery feedback.** A failed auto-post is
  drop-logged for operators; the agent never learns and can claim it
  replied. An injected "delivery failed" signal risks a failure loop (the
  failure turn's own reply also fails), so it needs a bounded design —
  one signal per submission, `reply: "manual"`.
- **Deferred: progress signal on the discrete path.** After the segment's
  first message, a long turn is silent: `sendTyping` fires once at submit
  and Slack has no bot-typing API for channel threads (`setStatus` covers
  only assistant DM threads). Accepted gap; the child.settled inheritance
  above removes the worst case (results that never arrive at all).
- **Follow-up: an engine-owned reply concept.** "Which message is the
  reply" has now been host-side heuristic three times (turn-final → every
  message → first per segment). A first-class reply marker (an entry flag
  the model or engine sets, or a capability flag on ActionPlugin manifests
  replacing the `….reply_to_origin` name convention) would let delivery
  read intent instead of inferring it. Do this before the next change to
  this subsystem.
- **Sender name is a handle, not a resolved display name.** The dispatcher sets
  the signal's `sender` attribute from `event.actor` (`login` or `externalId`).
  For a Slack `app_mention` this is the raw Slack user id, because the event
  carries no username. Resolving it to a display name reuses Part 2's
  name-resolution service; until then a channel-origin sender can surface as an
  id. The headline identity fix (the team name) is complete.

## Sequencing

One project, one PR onto `dev-v2`, built in this order so each step is
reviewable and the reply fix lands first:

1. Origin plumbing (1.1) + readable body (1.2) + identity (1.5). Closes the
   screenshot defect.
2. Reply mechanisms (1.4): auto-reply, then the action, then double-post
   suppression.
3. Name resolution service (2.1) + name-aware filters (2.2, 2.3).
4. The unified wizard (2.4).
