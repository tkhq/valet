/**
 * Predicts the other half of a Slack mention (spec:
 * docs/specs/2026-10-16-delivery-threads-and-claims-design.md, Part C step 8,
 * Part D). Slack delivers a mention as two separate events, `slack.message`
 * and `slack.app_mention`, in either order. The twin lets ingest treat both
 * halves as one conversational event before the second one arrives.
 */
import type { NormalizedEvent } from "@valet/engine";

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

const MENTION_SUFFIX = ":mention";

/**
 * Builds the twin a Slack `slack.message` or `slack.app_mention` event
 * implies, or null when the event has no twin. The twin keeps the
 * original's channel, ts, user, text, subjects, refs, actor, and
 * occurredAt; only `key` and `dedupeKey` change.
 *
 * The twin is a prediction for matching only. Its `summary` and
 * `payload.type` are the original's, so it is never a delivery or digest body.
 */
export function slackConversationalTwin(
  event: NormalizedEvent,
  identity: { botUserId?: string },
): NormalizedEvent | null {
  if (event.key === "slack.message") {
    // No bot identity means no way to tell whether this message mentions
    // the bot, so it predicts no app_mention twin.
    if (!identity.botUserId) return null;
    const text = str(rec(event.payload)?.text);
    if (!text || !text.includes(`<@${identity.botUserId}>`)) return null;
    return { ...event, key: "slack.app_mention", dedupeKey: `${event.dedupeKey}${MENTION_SUFFIX}` };
  }
  if (event.key === "slack.app_mention") {
    const dedupeKey = event.dedupeKey.endsWith(MENTION_SUFFIX)
      ? event.dedupeKey.slice(0, -MENTION_SUFFIX.length)
      : event.dedupeKey;
    return { ...event, key: "slack.message", dedupeKey };
  }
  return null;
}
