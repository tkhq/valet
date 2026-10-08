---
name: slack-tools
description: How to effectively use Slack tools to read, understand, and interact with Slack channels and threads
---

# Using Slack Tools

## Reading Channels

Use `slack.search_channels` with `query` to find channel IDs. Pass the original channel name or keyword.
Search normalizes casing and a leading `#`. Exact names rank before substring matches.
For example, `query="ACME"` can find `lead-acme`; the legacy `prefix="ACME"` cannot.
Resolve ambiguous matches before posting. An empty search does not establish a permissions problem.
Use `slack.list_channels` to browse channels. Read its `access_note` before concluding that a channel is missing.
`scope="all"` lists public channels only. Use `scope="joined"` (the default) to find private channels where Valet is a member.
Team and organization runs use the connected bot’s membership for private channels. Personal runs also require their linked owner to be a channel member. Direct messages remain restricted.
Use a channel authorized for this run. Do not borrow a member's credentials for a team workflow.

Use `slack.read_history` to read messages. Key parameters:

- **`filter`** -- case-insensitive keyword filter, useful for finding specific topics in noisy channels
- **`threads_only`** -- only return messages with thread replies, good for finding discussions in alert channels
- **`oldest` / `latest`** -- narrow to a time window instead of paging through everything
- System messages (joins, topic changes) are filtered out by default. Pass `include_subtypes: true` if you need them.

## Channel Names

`read_history`, `read_thread`, and `get_pins` return the channel ID in `channel` and the readable name in `channel_name`. Name the channel by `channel_name` when you write to a person, for example `#alerts`. Keep the ID for tool arguments and for a follow-up read. Never show a raw `C...` ID as the name of a channel.

`channel_name` is absent when Slack gives the conversation no name, such as a direct message. In that case describe the conversation instead of printing the ID.

A channel mention inside message text reads as `#name (C...)` when Valet could look the name up. A mention that Valet could not look up keeps the label the message author typed, which can be an old name. Use the name in what you write, and keep the ID if you must read that channel next.

## Understanding Context Signals

Messages include **reactions** (name + count) that signal consensus and attention. A message with 5 thumbsup is important; one with no reactions may not be. Use reactions to prioritize what to read deeper.

**Pins** are channel-curated important items. Use `slack.get_pins` to see what a channel considers worth preserving.

## Threads

`read_history` shows thread parents with `reply_count`. Use `slack.read_thread` to read replies on threads that matter. Don't read every thread -- prioritize by:

1. High `reply_count` -- active discussions
2. Reactions on the parent -- signals importance
3. Relevance to your current task

## Images and Files

Messages include a `files` array with ID, name, mimetype, size, and URL.
Use `slack.fetch_file` with `file_id` to read an attachment. A Slack file URL also works.
The tool reads images, text, PDF, and DOCX files in personal, team, and organization runs.
It verifies a channel share before downloading. Personal private-file access requires a linked channel member. Shared runs cannot read DM-only files.
To edit a document, set `output_path` to save the original bytes in the sandbox (maximum 25 MB).
For example, use `file_id="F123"` and `output_path="/workspace/proposal.docx"`. Work on a copy to preserve the original.
Use document editing tools on the saved file. Do not ask for a re-upload before trying this tool.
If Slack reports `missing_scope`, ask an administrator to reinstall the app with `files:read`.
For externally hosted files, use the connected provider tools.

Don't fetch every file. Read the filename and surrounding message context first -- only fetch when visual understanding actually matters for the task.

## Channel Research

First time reading a channel, use `slack.get_channel_info` to understand its topic, purpose, and who created it. Check `slack.get_pins` for curated important messages.

**Save what you learn to memory** -- channel purpose, norms, key context. Don't re-fetch this every time you read the channel. Only re-check if the channel content seems inconsistent with what you remember.

## People

Messages include `user_display` (e.g., `@handle <Display Name> (U123)`) and `bot_display` fields. These tell you who said what without needing to call `slack.list_users`.

Use `slack.get_reactions` when you need to know **who specifically** agreed or acknowledged something, not just the count.

## Posting, Editing, and Deleting

Pick the send tool by where the message goes:

- **`slack.reply_to_origin`** -- reply in the thread this turn came from. Use it for later updates and final results. On an addressed turn, the first assistant text posts automatically. An explicit first reply suppresses that automatic copy. It needs no approval and cannot reach the wrong channel.
- **`slack.reply_file_to_origin`**: upload a sandbox file to the origin thread. Use it for generated images, documents, and other file results.
- **`slack.send_message`** -- post to any other channel or thread by ID. This can ping a channel outside the current conversation, such as a customer channel, so it requires approval on every call. Prefer `reply_to_origin` when you are staying in the same thread.

`send_message`, `reply_to_origin`, `dm_owner`, and `dm_user` return the message `ts` and `channel`. Save both. You need them to edit or delete the message later.

Fix a mistake with your own message:

- **`slack.update_message`** -- edit a message Valet sent. Pass the `channel` and `ts` from the send result and the full replacement `text`. To blank a message you cannot delete, send a single space. Slack rejects edits to messages Valet did not send.
- **`slack.delete_message`** -- delete a message Valet sent. This requires approval and is irreversible. If the content only needs a correction, use `update_message` instead. Slack rejects deletes of messages Valet did not send.

## Private Channels

Access is scoped to channels the session owner is a member of. If access is denied, tell the user rather than guessing at content.

## Pagination

Large channels require paging via `cursor` / `next_cursor`. Prefer narrowing with `oldest` / `latest` over paging through the full history.

## Custom sender identity

When asked to send as an identity, set `sender_name` on `dm_user`, `dm_owner`, `send_message`, or `reply_to_origin`.
For an uploaded photo, call `profile_pictures.publish_avatar` in the chat containing it.
The tool publishes a resized copy of the selected image. It does not publish the chat or other attachments.
Use its returned `avatar_url` as `sender_avatar_url` for a single message, or save it as workflow `presence.avatarUrl` for future runs.
Use `image_index` to select among multiple photos, or `message_id` to select a recent upload.
Alternatively, use a public HTTPS image URL. Do not invent an image URL.
For example, use `sender_name: "Hestia · People"` and the user-provided image URL.
These fields affect that message only. They do not change the bot account, credentials, or DM conversation.
If omitted, message fields inherit from the subscription presence, then workflow presence, then workspace name or bot identity.
Slack requires `chat:write.customize`. If Slack rejects customization, Valet retries with the bot identity to deliver the message.

For a workflow, set top-level `definition.presence: { displayName: "Hestia · People", avatarUrl: "<supplied HTTPS URL>" }`.
Omit `avatarUrl` if no image was supplied. `patch_workflow` accepts `presence` directly; `null` clears it.
An event subscription may set `target.presence` (or pass `presence` to `propose_subscription`) to override individual fields for that subscription.
These defaults apply to tool steps, agent tool calls, automatic replies, and approval cards.
Use explicit `sender_name` / `sender_avatar_url` only when one message should differ from those defaults.
File uploads and Slack's DM header/sidebar retain the underlying bot identity.

For an existing event subscription, call `events.list_subscriptions` in its personal or team workspace.
Use the exact `name` filter or follow `nextOffset` with `offset` to find its ID.
Call `events.set_subscription_presence` with `subscription_id` and `presence: { displayName?, avatarUrl? }`.
This replaces the override. Send `presence: null` to clear it. The tool preserves matching rules, target, and enabled state.
`workflows.create_trigger` and `workflows.propose_trigger` also accept optional `presence`.
