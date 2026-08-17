/**
 * Slack TriggerDefs — workspace events normalized into the generic event
 * pipeline. These are the event-system half of the Slack integration and are
 * independent of the agent DM surface: channel messages, reactions,
 * membership, channel lifecycle and files, for workflows to subscribe to.
 *
 * `verify` implements the full signing-secret HMAC even though the dedicated
 * api route short-circuits with pre-verified events. Keeping it complete
 * means the TriggerDef stays correct if it is ever driven directly.
 *
 * `payload` on the VerifiedEvent / NormalizedEvent is the INNER Events API
 * `event` object, so catalog filter dot-paths address the raw event directly
 * (e.g. "channel", "item.channel").
 */
import type { EventCatalogEntry, NormalizedEvent, TriggerDef, VerifiedEvent } from "@valet/engine";
import { verifySlackSignature } from "./transport/verify.js";
import { SKIP_SUBTYPES } from "./subtypes.js";

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** "slack.message" for plain message events; "slack.{type}" otherwise. */
function keyFor(eventType: string): string {
  return eventType === "message" ? "slack.message" : `slack.${eventType}`;
}

/** Slack seconds.decimal ("1773177297.231269") → ISO; wall clock fallback. */
function tsToIso(ts: string | undefined): string {
  if (ts !== undefined) {
    const seconds = Number.parseFloat(ts);
    if (Number.isFinite(seconds)) return new Date(seconds * 1000).toISOString();
  }
  return new Date().toISOString();
}

function makeVerify(eventTypes: readonly string[]): TriggerDef["verify"] {
  return async (req, secrets) => {
    const secret = secrets.webhookSecret;
    if (!secret) return null;

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) headers[key.toLowerCase()] = value;
    const bodyText = new TextDecoder().decode(req.rawBody);
    if (!(await verifySlackSignature(headers, bodyText, secret))) return null;

    let body: Record<string, unknown> | undefined;
    try {
      body = rec(JSON.parse(bodyText));
    } catch {
      return null;
    }
    if (!body || body.type !== "event_callback") return null;

    const event = rec(body.event);
    const eventType = str(event?.type);
    if (!event || eventType === undefined || !eventTypes.includes(eventType)) return null;

    // Message events only: suppress the app's own posts (bot_id) and the same
    // set of noise subtypes the channel transport drops (edits, deletes,
    // join/leave/topic system messages). Without the bot_id drop, a workflow
    // subscribed to slack.message that also posts to Slack self-triggers into
    // an unbounded loop. Using the shared SKIP_SUBTYPES — rather than
    // "everything except file_share" — keeps fully-populated human events like
    // thread_broadcast and me_message, which carry a real user/text/channel.
    if (eventType === "message") {
      if (str(event.bot_id) !== undefined) return null;
      const subtype = str(event.subtype);
      if (subtype !== undefined && SKIP_SUBTYPES.has(subtype)) return null;
    }

    const deliveryId = str(body.event_id);
    if (!deliveryId) return null;

    return { eventType, deliveryId, payload: event };
  };
}

function toEvent(event: VerifiedEvent): NormalizedEvent {
  const p = rec(event.payload) ?? {};
  const type = event.eventType;

  const refs: Record<string, string> = {};
  const item = rec(p.item);
  const channelRec = rec(p.channel);

  const channel =
    str(p.channel) ?? str(channelRec?.id) ?? str(p.channel_id) ?? str(item?.channel);
  if (channel) refs.channel = channel;
  const channelName = str(channelRec?.name);
  if (channelName) refs.channel_name = channelName;

  const userRec = rec(p.user);
  const user = str(p.user) ?? str(p.user_id) ?? str(userRec?.id);
  if (user) refs.user = user;

  const team = str(p.team) ?? str(userRec?.team_id);
  if (team) refs.team = team;

  const reaction = str(p.reaction);
  if (reaction) refs.reaction = reaction;
  const itemUser = str(p.item_user);
  if (itemUser) refs.item_user = itemUser;

  const creator = str(channelRec?.creator);
  if (creator) refs.creator = creator;

  const fileId = str(p.file_id) ?? str(rec(p.file)?.id);
  if (fileId) refs.file = fileId;

  let summary: string;
  switch (type) {
    case "message":
      summary = `message in ${channel ?? "unknown channel"} by ${user ?? "unknown user"}`;
      break;
    case "reaction_added":
    case "reaction_removed":
      summary = `reaction :${reaction ?? "?"}: ${type === "reaction_added" ? "added" : "removed"} in ${channel ?? "unknown channel"} by ${user ?? "unknown user"}`;
      break;
    case "member_joined_channel":
      summary = `${user ?? "unknown user"} joined ${channel ?? "unknown channel"}`;
      break;
    case "member_left_channel":
      summary = `${user ?? "unknown user"} left ${channel ?? "unknown channel"}`;
      break;
    case "channel_created":
      summary = `channel #${channelName ?? channel ?? "?"} created${creator ? ` by ${creator}` : ""}`;
      break;
    case "channel_rename":
      summary = `channel ${channel ?? "?"} renamed to #${channelName ?? "?"}`;
      break;
    case "channel_archive":
      summary = `channel ${channel ?? "?"} archived${user ? ` by ${user}` : ""}`;
      break;
    case "channel_unarchive":
      summary = `channel ${channel ?? "?"} unarchived${user ? ` by ${user}` : ""}`;
      break;
    case "file_shared":
      summary = `file ${fileId ?? "?"} shared in ${channel ?? "unknown channel"} by ${user ?? "unknown user"}`;
      break;
    case "team_join":
      summary = `${user ?? "unknown user"} joined the workspace`;
      break;
    default:
      summary = `slack ${type}${channel ? ` in ${channel}` : ""}${user ? ` by ${user}` : ""}`;
  }

  return {
    key: keyFor(type),
    dedupeKey: event.deliveryId,
    occurredAt: tsToIso(str(p.ts) ?? str(p.event_ts)),
    actor: user ? { externalId: user } : undefined,
    refs,
    summary,
    payload: event.payload,
  };
}

function def(
  id: string,
  eventTypes: readonly string[],
  description: string,
  catalog: EventCatalogEntry[],
): TriggerDef {
  return { id, service: "slack", description, verify: makeVerify(eventTypes), toEvent, catalog };
}

export const slackTriggerDefs: TriggerDef[] = [
  def("slack.message", ["message"], "Slack message posted in a conversation the app can see", [
    {
      key: "slack.message",
      description: "Message posted in a channel or DM visible to the Slack app",
      filters: [
        { field: "channel", path: "channel", description: "Slack channel id (C…/D…)" },
        { field: "channel_type", path: "channel_type", description: "Conversation type (channel, group, im, mpim)" },
        { field: "user", path: "user", description: "Slack user id of the sender" },
      ],
      // High-volume: only persisted when a subscription matches (match-gated).
      ephemeral: true,
    },
  ]),
  def("slack.reaction", ["reaction_added", "reaction_removed"], "Slack emoji reactions added or removed", [
    {
      key: "slack.reaction_added",
      description: "Emoji reaction added to a message",
      filters: [
        { field: "channel", path: "item.channel", description: "Slack channel id of the reacted message" },
        { field: "reaction", path: "reaction", description: "Emoji name without colons (e.g. tada)" },
        { field: "user", path: "user", description: "Slack user id of the reactor" },
        { field: "item_user", path: "item_user", description: "Slack user id of the message author" },
      ],
    },
    {
      key: "slack.reaction_removed",
      description: "Emoji reaction removed from a message",
      filters: [
        { field: "channel", path: "item.channel", description: "Slack channel id of the reacted message" },
        { field: "reaction", path: "reaction", description: "Emoji name without colons (e.g. tada)" },
        { field: "user", path: "user", description: "Slack user id of the reactor" },
        { field: "item_user", path: "item_user", description: "Slack user id of the message author" },
      ],
    },
  ]),
  def("slack.member", ["member_joined_channel", "member_left_channel"], "Slack channel membership changes", [
    {
      key: "slack.member_joined_channel",
      description: "User joined a channel",
      filters: [
        { field: "channel", path: "channel", description: "Slack channel id" },
        { field: "user", path: "user", description: "Slack user id who joined" },
      ],
    },
    {
      key: "slack.member_left_channel",
      description: "User left a channel",
      filters: [
        { field: "channel", path: "channel", description: "Slack channel id" },
        { field: "user", path: "user", description: "Slack user id who left" },
      ],
    },
  ]),
  def(
    "slack.channel",
    ["channel_created", "channel_rename", "channel_archive", "channel_unarchive"],
    "Slack channel lifecycle events",
    [
      {
        key: "slack.channel_created",
        description: "Channel created",
        filters: [
          { field: "channel", path: "channel.id", description: "New channel id" },
          { field: "creator", path: "channel.creator", description: "Slack user id of the creator" },
        ],
      },
      {
        key: "slack.channel_rename",
        description: "Channel renamed",
        filters: [{ field: "channel", path: "channel.id", description: "Renamed channel id" }],
      },
      {
        key: "slack.channel_archive",
        description: "Channel archived",
        filters: [{ field: "channel", path: "channel", description: "Archived channel id" }],
      },
      {
        key: "slack.channel_unarchive",
        description: "Channel unarchived",
        filters: [{ field: "channel", path: "channel", description: "Unarchived channel id" }],
      },
    ],
  ),
  def("slack.file", ["file_shared"], "Slack file shared", [
    {
      key: "slack.file_shared",
      description: "File shared into a conversation",
      filters: [
        { field: "channel", path: "channel_id", description: "Slack channel id the file was shared in" },
        { field: "user", path: "user_id", description: "Slack user id who shared the file" },
      ],
    },
  ]),
  def("slack.team", ["team_join"], "Slack workspace membership", [
    {
      key: "slack.team_join",
      description: "New member joined the workspace",
      filters: [],
    },
  ]),
];
