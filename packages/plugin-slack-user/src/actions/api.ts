/**
 * Slack Web API helpers for the `slack-user` plugin.
 *
 * The HTTP client itself (`slackFetch` / `slackGet`, with 429 retry) is
 * imported from `@valet/plugin-slack/actions` so bug fixes and behavior
 * changes stay in one place. What lives here is the small user-token
 * revocation vocabulary that only makes sense for the xoxp flow — the
 * bot-token side has different failure modes.
 */
export { slackFetch, slackGet } from '@valet/plugin-slack/actions';

/** Slack `error` codes that indicate the stored xoxp token is permanently
 *  invalid and must be cleared from D1 (see ActionResult.revokeCredential). */
const REVOKED_ERRORS = new Set([
  'token_revoked',
  'invalid_auth',
  'account_inactive',
  'not_authed',
]);

export function isRevokedError(err: string | undefined): boolean {
  return !!err && REVOKED_ERRORS.has(err);
}

/** Standard "reconnect" error returned to the agent on token_revoked / invalid_auth. */
export function reconnectError(): string {
  return 'Slack (personal) token is no longer valid. Reconnect at /integrations.';
}

/** Standard "not connected" error returned when no user xoxp credential is present. */
export function notConnectedError(): string {
  return 'Connect Slack (personal) at /integrations.';
}
