import { useAuthStore } from '@/stores/auth';
import { router } from '@/app';
import { shouldClearAuthOn401 } from '@valet/shared';

// In production, use the worker URL. In development, proxy through Vite.
const API_BASE = import.meta.env.VITE_API_URL || '/api';

/**
 * Derive the WebSocket base URL from the API base.
 * In dev: /api → ws://localhost:8787/api (via Vite proxy, resolved from window.location.origin)
 * In prod: https://worker.dev/api → wss://worker.dev/api
 */
export function getWebSocketUrl(path: string): string {
  if (API_BASE.startsWith('http')) {
    // Absolute URL — replace protocol and append path
    const url = new URL(path, API_BASE.replace(/\/api$/, ''));
    url.protocol = url.protocol.replace('http', 'ws');
    return url.toString();
  }
  // Relative URL (dev) — resolve against current origin
  const url = new URL(path, window.location.origin);
  url.protocol = url.protocol.replace('http', 'ws');
  return url.toString();
}

/**
 * Read a `Response` body as text AND parse it as a JSON object. Both are
 * returned so callers that want a friendly-error fallback (the raw text)
 * don't have to re-read the stream. `parsed` is null for non-JSON bodies,
 * empty bodies, and valid JSON that isn't a plain object (`null`,
 * primitives, arrays) — otherwise a naive `.code` / `.error` access on
 * the caller side would throw or return misleading values.
 *
 * `apiClient` and the copilot streaming client both gate auth-clear on
 * `parsed` (via `shouldClearAuthOn401`), so they must agree on this
 * shape — a null `parsed` means the response wasn't a Valet JSON body
 * and the 401 likely came from an intermediary.
 */
export async function readErrorBody(
  response: Response
): Promise<{ text: string; parsed: Record<string, unknown> | null }> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return { text: '', parsed: null };
  }
  if (!text) return { text: '', parsed: null };
  try {
    const raw = JSON.parse(text);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return { text, parsed: raw as Record<string, unknown> };
    }
  } catch {
    /* fall through */
  }
  return { text, parsed: null };
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions extends Omit<RequestInit, 'body' | 'headers'> {
  body?: unknown;
  headers?: Record<string, string>;
}

export async function apiClient<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const { body, headers: customHeaders, ...rest } = options;

  const token = useAuthStore.getState().token;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...customHeaders,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...rest,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const { parsed } = await readErrorBody(response);
    const errorData: { error?: string; code?: string; details?: unknown } = parsed ?? {};

    // Clear local auth on 401 only with evidence the response came from
    // Valet itself: an auth-tier code (AUTH_MISSING / AUTH_INVALID) or a
    // JSON-shaped body from the app (even with no code field). A non-JSON
    // 401 body indicates a Cloudflare WAF interstitial or a proxy — we
    // must not log the user out on those. Explicit `UNAUTHORIZED`
    // (route-level authorization denial) also does not clear.
    if (
      response.status === 401 &&
      shouldClearAuthOn401({ code: errorData.code, hasJsonBody: parsed !== null })
    ) {
      useAuthStore.getState().clearAuth();
      router.navigate({ to: '/login' });
    }

    throw new ApiError(
      errorData.error || response.statusText,
      response.status,
      errorData.code,
      errorData.details
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

export const api = {
  get: <T>(endpoint: string, options?: RequestOptions) =>
    apiClient<T>(endpoint, { ...options, method: 'GET' }),

  post: <T>(endpoint: string, body?: unknown, options?: RequestOptions) =>
    apiClient<T>(endpoint, { ...options, method: 'POST', body }),

  put: <T>(endpoint: string, body?: unknown, options?: RequestOptions) =>
    apiClient<T>(endpoint, { ...options, method: 'PUT', body }),

  patch: <T>(endpoint: string, body?: unknown, options?: RequestOptions) =>
    apiClient<T>(endpoint, { ...options, method: 'PATCH', body }),

  delete: <T>(endpoint: string, options?: RequestOptions) =>
    apiClient<T>(endpoint, { ...options, method: 'DELETE' }),

  /**
   * Lower-level fetch wrapper for callers that need the raw Response —
   * streaming endpoints, file uploads, or anything that doesn't return
   * JSON. Adds auth + base URL, doesn't parse the body.
   */
  fetch: (endpoint: string, init?: RequestInit): Promise<Response> => {
    const token = useAuthStore.getState().token;
    const headers = new Headers(init?.headers);
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    return fetch(`${API_BASE}${endpoint}`, { ...init, headers });
  },
};
