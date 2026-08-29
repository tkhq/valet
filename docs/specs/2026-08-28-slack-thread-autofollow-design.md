# Slack thread auto-follow and outcome-first automations

**Status: draft 2026-08-28.** Base branch: `fix/channel-thread-binding` (needs
its per-Slack-thread valet-thread binding). Builds on `#445` (channel replies),
`#443` (Slack event triggers).

## Problem

Setting up "the assistant answers in Slack" means hand-assembling a
`slack.app_mention` rule and reasoning about raw event keys. And the assistant
only answers a message that @-mentions it: a follow-up in the same thread, with
no mention, is dropped. A person in a thread should not have to re-mention the
bot on every line.

## Goals

- A person picks an **outcome** ("Reply to Slack mentions"), not an event key.
- Once engaged in a thread, the bot keeps up with new messages there without a
  re-mention, and decides for itself whether each one deserves a reply.
- The bot can answer with text or acknowledge with an emoji reaction, or stay
  silent.

## Non-goals

- A time limit on following. Following is unbounded; the bot's judgment, not a
  TTL, decides whether to reply (per the product decision). No silent expiry.
- Changing which assistant answers a channel mention (still the rule's target).

## Design

### 1. Two reply modes, keyed by how the message arrived

- **Addressed** — a direct @-mention (or a DM). The assistant auto-replies, as
  it does today. A direct address deserves an answer.
- **Overheard** — a message in a thread the bot follows, with no mention. The
  message is delivered as something the assistant **observes**. It replies only
  if it chooses to, through an action. The default is silence. No auto-reply
  fires for an overheard turn, so there is no double-post.

The mode rides on the signal's origin: `ChannelOrigin.reply: "auto" | "manual"`
(default `"auto"`; overheard sets `"manual"`). `ChannelOrigin` also gains
`messageTs` — the specific message that triggered the turn — so the bot can
react to it.

`ChannelHost.deliverAssistantMessage` reads the finishing turn's origin (via
`originFromEntries`) and skips the auto-post when `reply === "manual"`.

### 2. The follow record

A new app table `followed_threads`:

```
id            text pk
org_id        text
channel_type  text        -- "slack"
channel_id    text
thread_ts     text
owner_type    text        -- user | team | org (the bound assistant's owner)
owner_id      text
created_by    text        -- the actor user the session runs as
created_at    bigint
last_activity_at bigint
UNIQUE (org_id, channel_type, channel_id, thread_ts)
```

Pre-1.0: edit `0000_app.sql` in place, add the Drizzle schema, add a
`SCHEMA_REPAIRS` entry (`lib/drizzle.ts`), and `rm -rf ~/.valet/pg`.

**Write.** When the dispatcher delivers a **follow-enabled** orchestrator
subscription's channel mention, it upserts a `followed_threads` row keyed by the
origin's `(channel_id, thread_ts)`, bound to the subscription's owner. Following
begins the moment the bot is mentioned, not after it replies.

### 3. Follow-enabled rules

The orchestrator target's jsonb gains `follow?: boolean` (no DDL — it lives in
the existing `target` column). A rule created by the "Reply to Slack mentions"
outcome sets `follow: true`.

### 4. Inbound follow-routing

The Slack webhook already receives channel messages (`message.channels`). A new
consumer, alongside the channel-host and event-trigger consumers, handles a
channel message that carries a `thread_ts`:

1. Look up `followed_threads` by `(org, channel_id, thread_ts)`. A miss is
   ignored and nothing is stored (privacy: an unfollowed thread's messages are
   never acted on).
2. A hit delivers the message to the bound owner's default assistant, on thread
   `slack:{channel}:{thread_ts}` (the same key the mention bound), as a signal
   with `origin.reply = "manual"` and `origin.messageTs` set. It updates
   `last_activity_at`.
3. The bot's own posts are dropped (`bot_id`), so a follow cannot self-loop.

The bound assistant reads the message on the same valet thread the mention
started, so it has the thread's context.

### 5. The reply and react actions

Two small Slack actions, both pre-filled from the turn's origin so the model
supplies no ids:

- `reply_to_origin({ text })` — posts `text` to the origin thread.
- `react_to_origin({ emoji })` — adds an emoji reaction to `origin.messageTs`
  (reuses the existing `slack.add_reaction` / `reactions.add`).

`ChannelOrigin` is exposed on `ToolContext.origin`, populated from the running
submission's signal origin, so the actions read it without the model guessing.
An action called with no origin returns a corrective error.

### 6. Persona guidance for a followed thread

Appended when the turn is overheard: "You are following this thread. Reply with
reply_to_origin only when you can add something useful; a light acknowledgement
can be react_to_origin. Otherwise, do nothing." So silence is the easy default.

### 7. Outcome-first wizard

Step 1 of the automation wizard becomes "What should happen?":

- **Reply to Slack mentions** — a channel (or any) + which assistant answers +
  a "Keep following the thread" toggle. Writes a `slack.app_mention` rule with
  the orchestrator target and `follow` set from the toggle. No raw event keys.
- **Run a workflow on an event** / **Send a notification** — the existing
  orchestrator/workflow targets over the event picker.
- **Advanced / custom trigger** — today's raw event + filter builder, unchanged,
  for reactions, lifecycle events, and power users.

The wizard maps an outcome to the existing `event_subscriptions` create; no new
create endpoint.

## Invariants (alert, do not auto-repair)

- A follow record has one owner: the subscription that created it. The
  follow-router never guesses an owner for an unfollowed thread.
- No TTL sweep deletes follow records. Records are removed only by an explicit
  end (a future "stop following") or when their thread's channel is deleted;
  `last_activity_at` is a reported gauge, not a reaper input.
- A failed overheard delivery drop-logs (`event_drop_log`), never silently
  swallows.

## Testing

- Origin `reply`/`messageTs` round-trip; `deliverAssistantMessage` skips
  auto-post for `reply: "manual"`.
- Dispatcher writes a `followed_threads` row for a follow-enabled mention;
  writes none when `follow` is off.
- Follow-router: a threaded channel message on a followed thread delivers to the
  bound assistant thread as an overheard signal; an unfollowed thread is
  ignored; a bot-authored message is dropped.
- `reply_to_origin` / `react_to_origin` post and react to the origin; error
  without an origin.
- Wizard: the "Reply to Slack mentions" outcome posts a `slack.app_mention`
  subscription with `follow` set.
- Full `make e2e` before done.

## Sequencing

One project, one PR onto `dev-v2` (after the thread-binding fix lands), built in
this order:

1. `ChannelOrigin.reply` + `messageTs`; auto-post suppression for `manual`.
2. `reply_to_origin` + `react_to_origin` actions + `ToolContext.origin`.
3. `followed_threads` table + follow flag + dispatcher write.
4. The follow-router consumer + overheard delivery + persona guidance.
5. The outcome-first wizard.
