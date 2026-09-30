# Channels

Status: built on the XORS branch, 2026-09-30.

## Problem

A channel is an outside conversation surface that Valet reads and writes: a Slack channel, or the comment thread of a GitHub pull request. Today Valet has no channel object. Listening to a Slack channel is a mention subscription with a channel filter. Replies in a Slack thread that Valet joined go through a `followed_threads` row that no page shows. Valet keeps no record of its automatic Slack replies, and the action log stores tool sends without their thread. GitHub pull request events all land in the shared `events` thread, so a review comment never reaches the thread that opened the pull request.

The result is two dead ends. From a channel, a person cannot find which Valet listens there or change it. From a Valet thread, a person cannot get to the channel conversation or the messages Valet posted there.

## Model

A channel has a key: `slack:<channel id>` or `github:<owner>/<repo>#<number>`. A conversation is one Slack thread inside a channel (`slack:<channel id>:<thread ts>`, the engine thread key). A pull request channel has one conversation, the pull request itself.

A channel is derived, not stored. The channel list is the union of four sources for the selected workspace owner:

1. Mention subscriptions with an orchestrator target and a `channel` filter (the listeners).
2. Engine threads whose key names a Slack conversation, in the owner's runtime session.
3. Pull requests in `thread_pull_requests` for the owner's runtime session.
4. `channel_messages` rows for the owner's runtime session.

## Channel messages

`channel_messages` is the one new table. It records each message that Valet sends to a channel or receives from one, with the engine thread it belongs to.

| Column | Meaning |
|---|---|
| `id` | Row id. |
| `org_id`, `session_id`, `thread_id` | The engine thread the message belongs to. |
| `channel_key` | `slack:C123` or `github:acme/app#12`. |
| `conversation_key` | The Slack thread (`slack:C123:<ts>`), or the channel key for a pull request. |
| `provider_message_id` | Slack `ts` or GitHub comment id. Unique per org and provider with `channel_key`. |
| `direction` | `in` or `out`. |
| `author` | Display name of the sender. Null for Valet's own messages. |
| `text` | The first 500 characters. |
| `url` | Permalink to the message. |
| `created_at` | Milliseconds. |

Writers:

- Outbound: the first addressed reply (`ChannelHost.deliverFirstAssistantReply`), a streamed reply when its stream closes (`ChannelStreamBridge`), and completed `slack.send_message`, `slack.reply_to_origin`, and `github.create_comment` invocations (the policy audit sink, which knows the thread).
- Inbound: a Slack mention delivered to an orchestrator, a followed-thread message, and a GitHub pull request comment or review routed to a thread.

A write failure logs and never fails the delivery. The table is a view aid, not a delivery ledger.

## Pull request routing

A GitHub pull request event for an orchestrator subscription goes to the thread that opened the pull request when one exists in the subscriber's runtime session (a `thread_pull_requests` row with the same URL). Otherwise it goes to the `events` thread as before. The events are `github.issue_comment.created` on a pull request, `github.pull_request_review.submitted`, and `github.pull_request_review_comment.created`. The agent answers with `github.create_comment`; there is no automatic reply to GitHub.

## API

- `GET /api/workspaces/:workspace/channels` lists channels: key, provider, name, URL, listeners, conversation count, message count, last activity, and a pull request's state. `:workspace` is `user` or a team id.
- `GET /api/workspaces/:workspace/channel?key=<channel key>` returns one channel: the summary, its conversations (each with the Valet thread and the provider URL), and the latest 50 channel messages. The key is a query value because it holds `/` and `#`.
- `ThreadSummary.channel` names the channel of a thread: key, provider, and the conversation URL. A Slack thread gets it from its key. A thread that opened pull requests gets the most recent one.
- `GET /api/sessions/:id/threads/:threadId/channel-messages` lists that thread's channel messages.

Slack channel names come from the Slack channel option resolver, cached per org for five minutes. Without a Slack credential, a name comes from the label a listener rule stored, or stays the channel id.

## Web

- The Events page gets a Channels tab, first and default. Each row shows the channel, who listens, the conversation count, and an "Open in Slack" or "Open on GitHub" link. A row opens the channel page.
- The channel page (`/channel?key=`) shows the listeners with Listen, Stop, and Edit controls, the conversations with links to both the Valet thread and the provider, and the message timeline with a permalink on each message.
- The thread header shows the channel name, which opens the channel page, and an "Open in Slack" or "Open on GitHub" link to the thread's own conversation.
- The thread context panel gets a Channel section with the messages Valet posted and received, each with its permalink.

Listen controls reuse the existing editors: a team opens the team Slack setup dialog, a personal workspace opens the automation wizard, and a listener row edits or pauses its rule.

## Out of scope

Telegram and Slack DMs are not channels in this view. A DM is a personal conversation, and the thread already names it. Gate prompt cards are not recorded; the decision gate and its resolution are already on the thread.

## Demo data

`scripts/seed-threads-demo.mjs channels` (API running), then `offline` (API stopped), seeds a Slack channel thread with a personal listener and messages both ways. With `pull-requests` seeded first, it also adds a review comment and a reply on the open pull request.
