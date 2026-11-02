const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const GMAIL_UPLOAD_API = 'https://gmail.googleapis.com/upload/gmail/v1';

/**
 * Messages larger than this go through Gmail's resumable upload endpoint.
 * Google recommends resumable uploads above 5 MB, and a JSON `raw` field
 * grows by a third in base64, so 3 MB keeps the simple request well under.
 */
export const SIMPLE_REQUEST_MAX_BYTES = 3 * 1024 * 1024;

/** Stateless authenticated fetch against the Gmail API. */
export async function gmailFetch(
  path: string,
  token: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`${GMAIL_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
}

/**
 * Create, replace, or send a message with its full RFC 5322 bytes. A small
 * message rides in the JSON `raw` field. A large one uses the resumable
 * upload protocol: the first request carries the metadata and returns a
 * session URL, and the second sends the bytes as message/rfc822.
 *
 * `path` is the API method path (`/users/me/drafts`,
 * `/users/me/drafts/{id}`, `/users/me/messages/send`). Draft methods take a
 * Draft resource, so the message fields go under `message`.
 */
export async function submitRawMessage(opts: {
  path: string;
  method: 'POST' | 'PUT';
  token: string;
  message: Uint8Array;
  threadId?: string;
  draft: boolean;
  signal?: AbortSignal;
}): Promise<Response> {
  const { path, method, token, message, threadId, draft, signal } = opts;
  const resource = (fields: Record<string, string>) => {
    const messageFields = { ...fields, ...(threadId ? { threadId } : {}) };
    return JSON.stringify(draft ? { message: messageFields } : messageFields);
  };
  if (message.byteLength <= SIMPLE_REQUEST_MAX_BYTES) {
    return gmailFetch(path, token, { method, body: resource({ raw: encodeBase64UrlBytes(message) }), signal });
  }
  const start = await fetch(`${GMAIL_UPLOAD_API}${path}?uploadType=resumable`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'message/rfc822',
      'X-Upload-Content-Length': String(message.byteLength),
    },
    body: resource({}),
    signal,
  });
  if (!start.ok) return start;
  const location = start.headers.get('location');
  const session = location ? new URL(location) : null;
  // The session URL receives the bearer token, so it must be Google's.
  if (!session || session.protocol !== 'https:' || !session.hostname.endsWith('.googleapis.com')) {
    throw new Error('Gmail did not return a valid upload URL. Retry the request.');
  }
  return fetch(session, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'message/rfc822' },
    // A copy typed over a plain ArrayBuffer, which BodyInit requires.
    body: new Uint8Array(message),
    signal,
  });
}

export function decodeBase64Url(data: string): string {
  return new TextDecoder().decode(decodeBase64UrlBytes(data));
}

export function decodeBase64UrlBytes(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64url'));
}

export function encodeBase64Url(data: string): string {
  return Buffer.from(data, 'utf8').toString('base64url');
}

export function encodeBase64UrlBytes(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64url');
}
