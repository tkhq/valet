/**
 * The exact DM the bot posts to a Slack user during identity linking.
 *
 * Broken out into its own file (no imports, no side effects) so the connect
 * card's "exact DM text" preview and the initiate endpoint's outbound
 * `chat.postMessage` render byte-identical strings — the card can promise
 * the user what they will see in Slack.
 *
 * Keep this pure. The wider `slack.ts` service pulls in D1 bindings, so
 * anything importing it here would drag in a live worker environment.
 */

/**
 * Build the verification DM.
 *
 * @param code — the 6-character alphanumeric code produced by `initiateSlackLink`.
 */
export function slackLinkDmText(code: string): string {
  return `Your Valet verification code is: *${code}*. Paste this in Valet to link your account. Expires in 10 minutes.`;
}
