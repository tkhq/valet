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

### 1. Two attention modes with hybrid replies

- **Addressed**: a direct mention or DM. The host posts the first assistant
  text once. Later updates use `reply_to_origin`.
- **Overheard**: a message in a followed thread without a mention. The assistant
  stays silent unless it can add something useful. It uses
  `reply_to_origin` or `react_to_origin` when it chooses to participate.

The mode rides on `ChannelOrigin.reply: "auto" | "manual"`. The `auto` value
enables one automatic first reply. The `manual` value keeps the turn silent
unless an explicit Slack action posts or reacts.

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

### 8. First-turn thread-context hydration

A mention often lands mid-thread, so the trigger message alone leaves the
assistant blind — it would have to call `read_thread` before it can act, and
without that it answers itself. On the assistant's FIRST turn in a channel
thread, the delivery path seeds the thread's earlier messages instead.

- `ChannelTransport.fetchThreadContext(channelId, threadTs)` returns the prior
  messages as a plain attributed transcript, one line per message, `Name: text`,
  oldest first. Slack backs it with `conversations.replies` + `users.info`
  (`packages/plugin-slack/src/transport/thread-context.ts`); names resolve
  best-effort and fall back to `@id`. A long thread drops its oldest lines under
  a `[N earlier message(s) omitted]` note.
- `deliverToAssistantThread` seeds only when the target valet thread has no
  entries yet, so a re-mention or a followed message never re-seeds. The
  transcript is prepended to the delivered body under "Conversation so far in
  this thread", split from the trigger message by a `---` rule.
- Wired on the mention path only (`buildOrchestratorTarget` ->
  `channelThreadContextFetcher(channelHost)`). The follow path never delivers
  first, so it leaves the hook unset.
- The persona's `## Channels` block frames a thread as a group conversation:
  read who said what, answer the addressed person by name, act on the request
  from the thread rather than asking for context it already holds.

### 9. Overheard-digest coalescing (TKAI-297)

When the assistant is busy, follow-ups in one followed thread used to queue as
separate overheard submissions. The assistant then drained them one by one,
answering messages a later message had already resolved.

Now the engine coalesces them (`Thread.submitPrompt`,
`packages/engine/src/thread.ts`). After it admits an overheard signal
(`origin.reply === "manual"`, followup mode), it merges the signal with every
other queued overheard item that carries the same `origin.threadKey`. The merge
reuses the collect-flush shape: admit one digest item, then settle each
constituent `merged` pointing at it. Properties:

- The digest body is a mini transcript: the header "Conversation in this thread
  while you were working:" then one `Name: message` line per overheard message,
  oldest first — the same line shape the first-turn seed uses. Pure builders
  live in `packages/engine/src/submission.ts` (`overheardCoalesceKey`,
  `buildOverheardDigest`).
- The engine marks line breaks in both sender and body with `⏎`, including
  senderless bodies. Re-merges sanitize each stored metadata line separately,
  including lines from older digests. They preserve message order and counts
  without parsing the rendered body or changing stored input metadata.
- The envelope drops the per-message `sender` attribute and gains
  `digest="<N>"`. The origin (and `messageTs`) comes from the newest
  constituent, so `react_to_origin` targets the latest message.
- Constituents are never claimed, so they write no user entries, and a Slack
  redelivery of a constituent's `dispatchId` dedups against its settled row.
  A dedup replay never re-digests.
- Coalescing is keyed on `reply: "manual"` + a shared `origin.threadKey`, so it
  applies to any channel that produces overheard signals, and only within one
  external thread. Addressed messages never coalesce; an addressed message in
  the same thread queues normally and does not flush the digest.
- The persona's `addressed="false"` guidance tells the model to read the digest
  as the thread's current state and reply at most once.
- A crash between the digest admission and the constituent settlements leaves
  both queued. `Thread.repairOverheardDigests` (run by the session sweep and by
  restore-time reconcile, before their kicks) re-settles the leftover
  constituents — the sanctioned crash-window auto-repair.
- The coalesce scan is serialized per thread in-process. Like the collect-window
  flush, it has no cross-process guard; the engine's single-owner session
  contract is what prevents two replicas from scanning one thread.

### 10. Agent-readable inbound messages

The event->signal path used to hand the agent raw ids and Slack markup, while
the transport path resolved them — so the agent saw `sender="U0AJ…"`, a machine
summary (`app mentioned in C.. by U..`), and `<@U07BOT>` markup, and could not
follow the persona's "answer by name". These fixes make one inbound view:

- `ChannelTransport.normalizeForAgent({ userId, text })` resolves the sender's
  display name and cleans the text: strip the bot's own mention, resolve other
  `<@U…>` mentions to names, collapse channel and url markup. The event
  dispatcher and the follow-router stamp the result, so `sender` is a name and
  the body is clean prose. Backed by `users.info` (cached per client) and a
  shared `enrichSlackText`, which the transcript also uses.
- `ChannelTransport.messageTsFromEvent` gives `channelOriginResolver` the
  triggering message ts, so a mention's `ChannelOrigin` carries `messageTs` and
  `react_to_origin` has a target. The resolver stamps `reply: "auto"` to mark the turn as addressed.
- `renderSignalEnvelope` renders `addressed="true"|"false"` from the origin's
  reply mode, so the agent tells an addressed mention (answer normally) from an
  overheard follow (reply only via `reply_to_origin`) without guessing.
- The transcript resolves in-text mentions to names, keeps a `[shared: file]`
  marker for a file-only message, attributes the bot's own prior posts as "You",
  and preserves the thread's opening message when it trims a long thread.

### Gap re-hydration (TKAI-284, added 2026-09-01)

`followed_threads.last_seen_ts` records the provider ts of the last message
delivered through the follow (seeded with the binding mention's ts; advanced
monotonically after each delivery — an out-of-order or retried older event
never rewinds it, and neither does a re-mention). On each overheard delivery,
the follow-router fetches the thread window STRICTLY BETWEEN `last_seen_ts`
and the new message's ts (`fetchThreadWindow` on the transport) and prepends
it to the signal body when it is non-empty. The window excludes the bot's own
posts — the agent holds its own replies as tool calls. A full window page ends
with a "[more recent messages not shown]" marker instead of a silent cut. In
live traffic the window is empty (every human message was itself delivered);
it fills after api downtime and around other bots' posts, which never route.
A null `last_seen_ts` (a pre-column row) starts tracking at the next delivery
instead of guessing a window.

Routing is serialized per followed thread (in-process chain, single-replica
api), so two rapid messages cannot hydrate overlapping windows. A hydrated
signal carries `attributes.rehydrated` and never coalesces into an overheard
digest. A redelivery whose recomputed body differs from the first delivery
(the cursor advanced, so the prefix is gone) hits the dispatchId content
check; the follow-router swallows that `ConflictError` as a clean dedup.

### First-turn seed hardening (TKAI-284, added 2026-09-01)

`deliverToAssistantThread` serializes deliveries per assistant thread with an
in-process promise chain (single-replica api), and the seed gate requires the
thread to have no entries AND no unsettled submissions — an admitted-but-
unclaimed submission has written no entry yet, and covers a restart between
admit and claim. Two rapid mentions on one new thread seed the transcript once.

## Invariants (alert, do not auto-repair)

- A follow record has one owner: the subscription that created it. The
  follow-router never guesses an owner for an unfollowed thread.
- No TTL sweep deletes follow records. Records are removed only by an explicit
  end (a future "stop following") or when their thread's channel is deleted;
  `last_activity_at` is a reported gauge, not a reaper input.
- A failed overheard delivery drop-logs (`event_drop_log`), never silently
  swallows.

## Testing

- Origin `reply`/`messageTs` round-trip. Addressed turns post only the first
  assistant text. Overheard turns stay internal without an explicit action.
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

## Known limitations (as built)

- **Follow is set at create, not toggled on an existing rule.** `PATCH
  /event-subscriptions/:id` does not mutate `target` (it never did — a target
  change can reassign the owner, which needs the create-time owner scoping).
  To change following, recreate the rule through the wizard. A target-aware
  PATCH is a separate, owner-scoped change.
- **No unfollow endpoint yet.** Per the product decision, following is unbounded
  in time and there is no TTL reaper. A record is removed only manually today; a
  "stop following" action and a channel-deletion cascade are a planned
  follow-up. `last_activity_at` is written so a future surface can list stale
  follows. A busy workspace should expect `followed_threads` to grow with the
  number of distinct threads the bot is engaged in.
- **Wizard recomputation is not memoized.** The wizard rebuilds its filter-field
  union per render; it is a config dialog, not a hot path, so this is left as a
  minor future cleanup rather than risk a stale-render change.

## Sequencing

One project, one PR onto `dev-v2` (after the thread-binding fix lands), built in
this order:

1. `ChannelOrigin.reply` + `messageTs`; explicit action delivery for both modes.
2. `reply_to_origin` + `react_to_origin` actions + `ToolContext.origin`.
3. `followed_threads` table + follow flag + dispatcher write.
4. The follow-router consumer + overheard delivery + persona guidance.
5. The outcome-first wizard.


### Transcript line boundaries (TKAI-434)

Thread hydration replaces line breaks in message text, speaker names, and file markers with a visible `⏎` separator. Each Slack message occupies one attributed line. This prevents embedded newlines from creating a second speaker line; it does not make message content trusted.

Thread hydration and overheard digests share the engine's `formatTranscriptText` helper through Slack's existing engine dependency.
The helper scans whitespace runs in linear time, including long runs with no line break.
Runs containing CR, LF, VT, FF, NEL, LS, or PS become one visible `⏎` separator.
It preserves internal whitespace without line breaks and trims outer whitespace. Legitimate multiline lists retain visible boundaries between steps.
