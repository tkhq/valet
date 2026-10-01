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
| `provider_message_id` | Slack `ts` or GitHub comment id. Unique with the org, session, `channel_key`, and direction, so a message that reached two workspaces is recorded once for each. |
| `direction` | `in` or `out`. |
| `author` | Display name of the sender. Null for Valet's own messages. |
| `text` | The first 500 characters. |
| `url` | Permalink to the message. |
| `created_at` | Milliseconds. |

Writers:

- Outbound: the first addressed reply (`ChannelHost.deliverFirstAssistantReply`), a streamed reply when its stream closes (`ChannelStreamBridge`), and completed `slack.send_message`, `slack.reply_to_origin`, and `github.create_comment` invocations (the policy audit sink, which knows the thread).
- Inbound: a Slack mention delivered to an orchestrator, a followed-thread message, and a GitHub pull request comment or review routed to a thread.

A write failure logs and never fails the delivery, and it never makes Valet report a posted reply as failed. The table is a view aid, not a delivery ledger.

## Pull request routing

A GitHub pull request event for an orchestrator subscription goes to the thread that opened the pull request when one exists in the subscriber's runtime session (a `thread_pull_requests` row with the same URL). An archived thread does not count, because work there would run where no list shows it. Otherwise it goes to the `events` thread as before. The events are `github.issue_comment.created` on a pull request, `github.pull_request_review.submitted`, and `github.pull_request_review_comment.created`. The agent answers with `github.create_comment`; there is no automatic reply to GitHub. A comment or review by a bot stays on the `events` thread. Valet posts with a person's GitHub token, so its own comment arrives as that person: a comment already recorded in `channel_messages` as one Valet sent also stays on the `events` thread, so the agent does not wake on the comment it just posted. The record is written when the comment action returns. A webhook that arrives before that write is not recognized, which is rare, since GitHub sends the webhook after the API call completes.

## API

- `GET /api/workspaces/:workspace/channels` lists channels: key, provider, name, URL, listeners, conversation count, message count, last activity, and a pull request's state. `:workspace` is `user` or a team id.
- `GET /api/workspaces/:workspace/channel?key=<channel key>` returns one channel: the summary, its conversations (each with the Valet thread and the provider URL), and the latest 50 channel messages. The key is a query value because it holds `/` and `#`.
- `ThreadSummary.channel` names the channel of a thread: key, provider, and the conversation URL. A Slack thread gets it from its key. A thread that opened pull requests gets the most recent one.
- `GET /api/sessions/:id/threads/:threadId/channel-activity` returns that thread's channel message count and its newest message. It is a fixed-size summary, so a long thread costs one row.

Slack channel names come from the Slack channel option resolver, cached per org for five minutes. Without a Slack credential, a name comes from the label a listener rule stored, or stays the channel id.

## Web

- The Events page gets a Channels tab, first and default. Each row shows the channel, who listens, the conversation count, and an "Open in Slack" or "Open on GitHub" link. A row opens the channel page.
- The channel page (`/channel?key=`) shows one listening line, because a workspace has one Valet: "Valet is listening here" with Edit and Pause, or "Valet is not listening here" with Listen here. Another workspace's Valet that also listens is noted under it. Below are the conversations, with links to both the Valet thread and the provider, and the message timeline with a permalink on each message.
- The thread header shows the channel name, which opens the channel page, and an "Open in Slack" or "Open on GitHub" link to the thread's own conversation.
- The thread context panel gets a Channel section with one summary: the message count, the newest message with its permalink, and a link to the channel page. The transcript already holds every message, so the section does not grow with the thread.

Listen controls reuse the existing editors: a team opens the team Slack setup dialog, a personal workspace opens the automation wizard, and a listener row edits or pauses its rule.

## Out of scope

Telegram and Slack DMs are not channels in this view. A DM is a personal conversation, and the thread already names it. Gate prompt cards are not recorded; the decision gate and its resolution are already on the thread.

## Demo data

`scripts/seed-threads-demo.mjs channels` (API running), then `offline` (API stopped), seeds a Slack channel thread with a personal listener and messages both ways. With `pull-requests` seeded first, it also adds a review comment and a reply on the open pull request.

## Events page Log

The Events page has three tabs: Channels, Log, and Subscriptions. The Log replaced the Activity and Event Logs tabs, which showed stored events and recorded problems as two unrelated lists, one above the other.

`GET /api/events/log?ownerType=&ownerId=` returns the workspace's stored events from the last 30 days and the organization's `event_drop_log` problems in one timeline, newest first. Problems carry no owner, so every workspace sees the organization's. Each source is read in `(time, id)` keyset order and merged, so one cursor pages the combined list. Each row has one status:

| Status | Source |
|---|---|
| Delivered, In progress, Failed | A stored event, from its deliveries: a failure wins, then work in flight. |
| Filtered out | `filter_excluded`. |
| No match | `no_subscription_match`. |
| Rejected | Verification, workspace, classification, and duplicate reasons. |
| Failed | Every other problem reason, such as a reply that was not posted. |

Two chips choose the view: All, or Problems (`problems=1`: failed events and every problem). Each row already shows its status, so the Log has no per-status filter, and it has no organization-wide scope: an event that matched nothing is never stored, so it appears only as a problem. The chip and search live in the URL. Members do not see the two Slack form diagnostics. A stored event opens its own page for deliveries, the payload, and redelivery.

Raw incoming receipts stay admin-only. They open from their own chip, in place of the list. The old `tab=activity`, `logs`, `problems`, and `receipts` links open the Log, and `problemsQ` becomes its search. The `GET /api/events` list and `GET /api/events/drops` routes were removed with the tabs that used them.

