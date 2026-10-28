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
