/**
 * Message subtypes that carry no user turn. Slack sends edits, deletes and
 * system notices through the same `message` event as real text, so both
 * consumers must drop the same set: the transport (which would otherwise
 * re-submit an edited message as a new prompt) and the event triggers (where
 * a workflow subscribed to `slack.message` would fire on channel joins).
 *
 * This list lives on its own rather than in either consumer. The transport
 * serves the agent DM surface and the triggers serve the event pipeline; a
 * shared constant that one imports from the other couples two subsystems that
 * are otherwise independent.
 */
export const SKIP_SUBTYPES = new Set([
  "message_changed",
  "message_deleted",
  "bot_message",
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
  "file_comment",
  "file_mention",
  "pinned_item",
  "unpinned_item",
]);
