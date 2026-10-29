# Slack conversations and Home

Status: implementation. This design keeps the Home and mobile changes from
the mobile Home spec. The desktop Home entry remains available.

## Decisions

1. A new Slack DM root starts a separate Valet chat. Replies continue that chat.
2. Home remains the person's private conversation on phone and desktop.
   Home can list and start tasks across workspaces the person can access.
3. Existing Slack conversations keep their destination. A conversation that
   already reached Home stays there. Existing dedicated chats stay separate.
4. An immutable binding records the destination. Its scope includes the
   organization, user, assistant session, channel type, and full conversation
   key. The Slack key includes the Slack workspace, channel, and root timestamp.
5. The first lookup can recover a legacy destination from a dedicated thread
   or stored Home submission provenance. It never matches message text.
   Later lookups use the binding, including edits and question answers.
6. An unknown edit cannot create a chat. Repeated edits append notes to the
   bound chat. They do not call the model or undo external actions.
7. Each submission retains its reply origin and author. A web follow-up does
   not gain permission to post to Slack. Gate cards keep their saved references.
8. Independent chats keep separate histories and queues. This change does not
   create separate filesystems or merge memories across audiences.

## Group DMs

A group DM message that mentions the app follows the DM route. The Slack
transport accepts a `message.mpim` event only when its text contains the app's
own mention. A group DM message without a mention stays with the event
pipeline. Each mention goes to the sender's own assistant. The Slack thread of
the mention is the conversation, so a later mention in that thread continues
the same chat. A second person who mentions the app in that thread gets a chat
with their own assistant, because the binding scope includes the user.

Everyone in a group DM reads the reply. The host adds a line to each group
prompt that says so, and that earlier messages from other people are context,
not instructions. On every turn the host adds the thread's messages since that
assistant's last turn there: the whole thread on the first turn, then only what
is new. The thread stores the last message it read (`slackGroupReadThroughTs`)
before it fetches, so two quick mentions do not read the same window twice.
Every person's assistant posts as the same app, so the window keeps the app's
replies to other people, labeled "Valet (answering someone else)", and drops
this thread's own replies (its outbound `channel_messages` rows), which the
assistant already holds. Each person's sandbox, files and memory stay their
own; the Slack thread is the record they share.

A group turn is never the person's own direct channel message, because other
people's words ride in its context. The host sets `directChannel: false` on its
author, so tools that act only on a message the person wrote themself refuse
the turn. The person is still interactive, so approval cards work as usual.

The host refuses a group DM shared with another organization (Slack Connect,
`is_ext_shared_channel` on the event envelope). It replies with a notice and
writes an `external_group` drop-log row, because people outside the
organization would read the reply.

A stream into a group DM needs a recipient, which Slack requires outside a 1:1
DM. The recipient travels with the turn (`StreamTurn.recipient`, passed to
`startStream`), because two people's turns can share one conversation key. A
group turn sets the thread status like a DM turn. Slack accepts the status call
outside the assistant view with the `chat:write` scope.

Replies in the thread that do not mention the app reach no assistant.

A rule that would answer the mention takes it, as in a channel. Before it
resolves the sender, the host runs the event pipeline's matcher
(`subscriptionMatchOutcome`) over the organization's enabled rules for
`slack.app_mention` and `slack.message`, with the group DM's channel id. A
match means the pipeline delivers the mention, so the host writes a
`group_rule_answers` drop-log row and stops. A team rule that refuses this
sender does not count, and the sender gets their own assistant. To give a
group DM one shared assistant, a team admin points a team rule at it.

## Compatibility

No transcript moves or disappears. Old Slack links and pending questions keep
their destination. Binding creation uses insert-on-conflict and reads the
winning row. A missing bound thread is an error, not permission to reroute.
Native threads take precedence when no binding exists and both native and
Home histories contain that origin. This preserves the earlier native route.

Destination discovery reads at most two persisted thread rows. It does not
rely on one API host's cache. `Session.loadThread(id)` attaches a saved thread
with lazy transcript restoration. It never creates a replacement row or takes
over another host's active work. The route checks the saved destination before
attachment and fails when that destination is gone.
The personal owner controls the binding. Legacy personal sessions with an
empty owner ID retain their stored user as owner. An older acting-user field
does not replace an explicit owner. These are the existing session access rules.

The older `channel_bindings` table describes owner and trigger templates.
The new destination table records concrete thread IDs for each user and session.

Home keeps its existing queue settings. New dedicated chats use the existing
channel queue policy. The interruption change continues to scope Slack steering
to the source conversation when that feature is present.

The engine still requires one live owner per session. Loading a saved thread
does not transfer a running turn or its question waiter to another host.
Deployments with concurrent owners need owner-directed ingress separately.

## User flow

Send a new top-level Slack DM to start a chat. Reply in that Slack thread to
continue it. Open the same chat in Valet on phone or desktop. Home remains a
separate entry and can show permitted task summaries and links.

## Validation

Test fresh roots, two roots with pending questions, Home compatibility,
dedicated chat compatibility, repeated edits, retries, concurrent binding
creation, restart recovery, tenant boundaries, and deleted destinations.
Retain sidebar tests for Home, phone navigation, search, and existing chats.
Run root and web typechecks, focused suites, full channel suites, and the end
to end scorecard. Validate the local UI before the pilot.

## Sources

- [Slack agent sessions](https://docs.slack.dev/ai/agent-sessions/): native sessions belong to a thread.
- [Cursor Slack](https://cursor.com/docs/integrations/slack): DM roots start separate agents; replies continue them.
- [Claude Tag](https://claude.com/docs/claude-tag/concepts/how-it-works): working threads have separate sessions.
- [OpenClaw Slack](https://docs.openclaw.ai/channels/slack/threads-and-sessions): Agent View roots stay separate from its main conversation.
