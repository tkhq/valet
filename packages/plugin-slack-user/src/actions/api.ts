const SLACK_API = 'https://slack.com/api';

/** Authenticated POST against the Slack Web API. Retries 429s. */
export async function slackFetch(
  method: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: body ? JSON.stringify(body) : '{}',
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') || '2');
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }

    return res;
  }

  return new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), { status: 429 });
}

/** Authenticated GET against the Slack Web API. Retries 429s. */
export async function slackGet(
  method: string,
  token: string,
  params?: Record<string, unknown>,
): Promise<Response> {
  const url = new URL(`${SLACK_API}/${method}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  // Slack expects literal commas (not %2C) in CSV params like
  // types=public_channel,private_channel.
  const finalUrl = url.toString().replace(/%2C/gi, ',');

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(finalUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') || '2');
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }

    return res;
  }

  return new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), { status: 429 });
}

/** "Token revoked / no longer valid" errors that should clear stored credentials. */
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
