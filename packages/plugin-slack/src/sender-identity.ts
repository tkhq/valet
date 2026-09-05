import type { ChannelSenderIdentity } from "@valet/engine";

/** Slack documents an 80-character limit for chat.postMessage.username. */
const SLACK_USERNAME_LIMIT = 80;

/**
 * Convert an assistant identity to Slack's message override fields.
 * Invalid decoration is omitted so it cannot block the message body.
 */
export function slackIdentityOverride(
  sender: ChannelSenderIdentity | undefined,
): { username?: string; iconUrl?: string } {
  if (!sender) return {};

  const username = sender.displayName
    ?.replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const safeUsername = username
    ? Array.from(username).slice(0, SLACK_USERNAME_LIMIT).join("")
    : undefined;

  const candidate = sender.avatarUrl?.trim();
  let iconUrl: string | undefined;
  if (candidate && !/\s/.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "https:" && parsed.hostname) iconUrl = candidate;
    } catch {
      // Invalid identity decoration must not block the message body.
    }
  }

  return {
    ...(safeUsername ? { username: safeUsername } : {}),
    ...(iconUrl ? { iconUrl } : {}),
  };
}
