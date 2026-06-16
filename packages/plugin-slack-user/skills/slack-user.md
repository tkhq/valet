# Slack (personal) — acting AS the user

This integration is **separate** from the org `slack` (bot) integration. It uses
a per-user OAuth (`xoxp`) token and exposes actions under the `slack_user.*`
namespace.

## When to use slack_user vs. slack

| Need                                              | Use         |
| ------------------------------------------------- | ----------- |
| Bot replies, channel binding, inbound routing     | `slack.*`   |
| Search the user's messages across their workspace | `slack_user.search_messages` |
| Read a private channel/DM the bot is NOT in       | `slack_user.read_history` / `read_thread` |
| Set the user's status, snooze DND                 | `slack_user.set_status` / `set_dnd` |
| Post on behalf of the user (delegated)            | `slack_user.post_message` / `send_dm` |
| Agent's own outbound communication                | `slack.send_message` / `slack.dm_owner` (NOT `slack_user.*`) |

`slack_user` actions ONLY run if the user has connected Slack (personal) at
`/integrations`. If not connected, you'll receive:
`Connect Slack (personal) at /integrations.`

## Search

`slack_user.search_messages` is the headline Phase-1 action. It uses
`search.messages` with the user's xoxp token, so results include private
channels and DMs they can see. Operators work as in the Slack UI
(`in:#channel`, `from:@user`, `before:`, `after:`, `has:link`).

```text
slack_user.search_messages { query: "in:#proj-valet from:@conner deploy", count: 50 }
```

Slim result shape: `{ channel, channel_name, user, ts, text, permalink, thread_ts?, score? }`
plus `next_cursor` for pagination.

## Read

`slack_user.read_history`, `slack_user.read_thread`, and
`slack_user.list_channels` mirror the bot equivalents but operate on the user's
full visible surface (public + private channels, DMs, group DMs).

## Write / act-as (Phase 2)

`set_status`, `set_dnd`, `end_dnd`, `send_dm`, `post_message`, `add_reaction`,
`upload_file`, `add_pin`, `add_bookmark`, `add_reminder` all act AS the user
(write to their profile, post under their identity, etc.). They are marked
`riskLevel: 'high'`, which means existing org / per-user / per-session
action-policy overrides gate them — by default these will require approval
or be denied unless explicitly allowed for the session.

Default rules:
- Only call Phase 2 actions when the user explicitly delegated the task.
- The agent's OWN routine outbound (DMs to the owner, channel updates) should
  continue to use the bot `slack.*` actions, not `slack_user.*`.

## Revocation

If the user revokes the app in Slack, calls will fail with
`token_revoked` / `invalid_auth`. The stored credential is cleared and you'll
get a structured `Slack (personal) token is no longer valid. Reconnect at
/integrations.` Tell the user to reconnect.
