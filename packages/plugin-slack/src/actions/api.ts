export const SLACK_API = 'https://slack.com/api';

function waitForRetryAfter(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Request was aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Request was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Authenticated POST against the Slack Web API. Automatically retries on 429 rate limits. */
export async function slackFetch(
  method: string,
  token: string,
  body?: Record<string, unknown>,
  baseUrl: string = SLACK_API,
  signal?: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${baseUrl}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: body ? JSON.stringify(body) : '{}',
      signal,
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') || '2');
      await waitForRetryAfter(retryAfter * 1000, signal);
      continue;
    }

    return res;
  }

  // Return a synthetic 429 if all retries exhausted
  return new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), { status: 429 });
}

/** Authenticated GET against the Slack Web API. For read methods (conversations.list, etc.). Automatically retries on 429. */
export async function slackGet(
  method: string,
  token: string,
  params?: Record<string, unknown>,
  baseUrl: string = SLACK_API,
): Promise<Response> {
  const url = new URL(`${baseUrl}/${method}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  // URLSearchParams encodes commas to %2C, but Slack expects literal commas
  // in list params like types=public_channel,private_channel
  const finalUrl = url.toString().replace(/%2C/gi, ',');

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(finalUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') || '2');
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }

    return res;
  }

  return new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), { status: 429 });
}
