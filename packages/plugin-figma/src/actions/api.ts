export const FIGMA_API = 'https://api.figma.com/v1';

/** Authenticated GET against the Figma REST API. */
export function figmaGet(path: string, token: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${FIGMA_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
}

/** Turn a non-OK Figma API response into an error message the model can act on. */
export async function figmaErrorMessage(res: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as { err?: unknown; message?: unknown };
    const raw = body.err ?? body.message;
    if (typeof raw === 'string') detail = raw;
  } catch {
    // Non-JSON body; fall back to the status text.
  }
  const said = detail ? ` (Figma said: ${detail})` : '';

  switch (res.status) {
    case 403:
      // Worded without "token ... expired" so the shared 401 retry regex does not
      // treat every 403 (including no access to the file) as a refresh trigger.
      return `Figma returned 403: the Figma connection may have expired, or this account cannot open the file. Ask the user to reconnect Figma if they can open the file in Figma.${said}`;
    case 404:
      return `Figma returned 404: file or node not found. Check the file key and node ids.${said}`;
    case 429: {
      const retryAfter = res.headers.get('Retry-After');
      const wait = retryAfter ? ` Retry after ${retryAfter} seconds.` : ' Retry later.';
      return `Figma rate limit hit (429).${wait}${said}`;
    }
    default:
      return `Figma API ${res.status}: ${detail || res.statusText || 'request failed'}`;
  }
}
