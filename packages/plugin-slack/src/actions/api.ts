export const SLACK_API = 'https://slack.com/api';

/** Bounds each API call, including rate-limit waits and response body reads. */
export const SLACK_REQUEST_TIMEOUT_MS = 10_000;

async function waitForRetry(res: Response, signal: AbortSignal): Promise<void> {
  const seconds = Number(res.headers.get('Retry-After') || '2');
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.max(0, seconds) * 1000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Authenticated POST against the Slack Web API. Automatically retries on 429 rate limits. */
export async function slackFetch(
  method: string,
  token: string,
  body?: Record<string, unknown>,
  baseUrl: string = SLACK_API,
): Promise<Response> {
  const signal = AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${baseUrl}/${method}`, {
      signal,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: body ? JSON.stringify(body) : '{}',
    });

    if (res.status === 429) {
      await res.body?.cancel();
      await waitForRetry(res, signal);
      continue;
    }

    return res;
  }

  // Return a synthetic 429 if all retries exhausted
  return new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), { status: 429 });
}

/** The URL for a Slack Web API GET, with `params` as the query string. */
function slackGetUrl(method: string, params: Record<string, unknown> | undefined, baseUrl: string): string {
  const url = new URL(`${baseUrl}/${method}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  // URLSearchParams encodes commas to %2C, but Slack expects literal commas
  // in list params like types=public_channel,private_channel
  return url.toString().replace(/%2C/gi, ',');
}

/** Authenticated GET against the Slack Web API. For read methods (conversations.list, etc.). Automatically retries on 429. */
export async function slackGet(
  method: string,
  token: string,
  params?: Record<string, unknown>,
  baseUrl: string = SLACK_API,
): Promise<Response> {
  const finalUrl = slackGetUrl(method, params, baseUrl);

  const signal = AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(finalUrl, {
      signal,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 429) {
      await res.body?.cancel();
      await waitForRetry(res, signal);
      continue;
    }

    return res;
  }

  return new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), { status: 429 });
}

/**
 * One authenticated GET against the Slack Web API, with no retry. A 429 comes
 * back to the caller, and the request aborts after `timeoutMs`. Use it for a
 * best-effort check that must not delay the work it checks.
 */
export async function slackGetOnce(
  method: string,
  token: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  baseUrl: string = SLACK_API,
): Promise<Response> {
  return fetch(slackGetUrl(method, params, baseUrl), {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
}
