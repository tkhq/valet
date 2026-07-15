import type { MiddlewareHandler } from 'hono';
import { ErrorCodes, UnauthorizedError } from '@valet/shared';
import type { Env, Variables } from '../env.js';
import { extractBearerToken } from '../lib/ws-auth.js';

/**
 * Session lifetime. `SESSION_TTL_MS` is the single source of truth; the SQL
 * fragment is derived from it. Every authenticated request slides
 * `expires_at` forward when less than half the window remains, so an active
 * user stays logged in indefinitely without generating a D1 write per
 * request.
 */
export const SESSION_TTL_DAYS = 30;
export const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
export const SESSION_SLIDING_WINDOW_SQL = `datetime('now', '+${SESSION_TTL_DAYS} days')`;
const SESSION_SLIDE_THRESHOLD_MS = SESSION_TTL_MS / 2;

/**
 * Authentication middleware supporting:
 * 1. Server-issued session tokens (from OAuth login)
 * 2. API key tokens (for programmatic access)
 */
export const authMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (
  c,
  next
) => {
  // Runner WebSocket connections and large attachment fetches authenticate via
  // tokens validated by the DO itself.
  const url = new URL(c.req.url);
  if (url.searchParams.get('role') === 'runner' && url.pathname.endsWith('/ws')) {
    return next();
  }
  if (/^\/api\/sessions\/[^/]+\/runner-attachment$/.test(url.pathname)) {
    return next();
  }
  // Trigger webhooks authenticate via X-Valet-Trigger-Token validated
  // inside the route handler (constant-time compare against the
  // trigger's server-issued token).
  if (/^\/api\/triggers\/[^/]+\/webhook$/.test(url.pathname)) {
    return next();
  }

  // Extract bearer token from Authorization header, WebSocket subprotocol, or legacy ?token= query param
  const bearerToken = extractBearerToken(c.req.raw);

  if (!bearerToken) {
    throw new UnauthorizedError('Missing authentication', ErrorCodes.AUTH_MISSING);
  }

  const tokenHash = await hashToken(bearerToken);

  // Hono throws when `executionCtx` is unavailable (some test envs); the
  // waitUntil registration is best-effort so a missing ctx is fine.
  let ctx: ExecutionContext | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }

  // Try auth_sessions first (OAuth session tokens)
  const sessionUser = await validateAuthSession(tokenHash, c.env, ctx);
  if (sessionUser) {
    c.set('user', sessionUser);
    return next();
  }

  // Fall back to api_tokens (programmatic API keys)
  const apiKeyUser = await validateAPIKey(tokenHash, c.env, ctx);
  if (apiKeyUser) {
    c.set('user', apiKeyUser);
    return next();
  }

  throw new UnauthorizedError('Invalid or expired authentication', ErrorCodes.AUTH_INVALID);
};

/** Fire-and-forget a D1 write. Registers with waitUntil when available so
 *  Workers doesn't cancel the pending I/O when the response is sent. */
function scheduleWrite(ctx: ExecutionContext | undefined, promise: Promise<unknown>): void {
  const swallowed = promise.catch(() => {});
  if (ctx?.waitUntil) {
    ctx.waitUntil(swallowed);
  }
}

/** True when the row's `expires_at` is within the sliding-half-life of now.
 *  Handles both SQLite's `YYYY-MM-DD HH:MM:SS` (UTC) and ISO 8601 formats;
 *  the initial insert in oauth.ts writes ISO, subsequent slides write SQLite. */
function needsSlide(expiresAt: string): boolean {
  const iso = expiresAt.includes('T') ? expiresAt : expiresAt.replace(' ', 'T') + 'Z';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return true; // unparseable → slide defensively
  return ms - Date.now() < SESSION_SLIDE_THRESHOLD_MS;
}

async function validateAuthSession(
  tokenHash: string,
  env: Env,
  ctx: ExecutionContext | undefined,
): Promise<{ id: string; email: string; role: 'admin' | 'member' } | null> {
  try {
    const result = await env.DB.prepare(
      `SELECT u.id, u.email, u.role, s.expires_at
       FROM auth_sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token_hash = ?
         AND s.expires_at > datetime('now')`
    )
      .bind(tokenHash)
      .first<{ id: string; email: string; role: string; expires_at: string }>();

    if (result && needsSlide(result.expires_at)) {
      // Half-life gate: only slide when less than half the TTL remains.
      // Bounds writes to at most one per session per (TTL/2) days regardless
      // of request volume, while still guaranteeing an active user never
      // hits the expiry cliff.
      scheduleWrite(
        ctx,
        env.DB.prepare(
          `UPDATE auth_sessions
           SET last_used_at = datetime('now'),
               expires_at = ${SESSION_SLIDING_WINDOW_SQL}
           WHERE token_hash = ?`,
        )
          .bind(tokenHash)
          .run(),
      );
    }

    return result ? { id: result.id, email: result.email, role: (result.role || 'member') as 'admin' | 'member' } : null;
  } catch {
    return null;
  }
}

async function validateAPIKey(
  tokenHash: string,
  env: Env,
  ctx: ExecutionContext | undefined,
): Promise<{ id: string; email: string; role: 'admin' | 'member' } | null> {
  try {
    const result = await env.DB.prepare(
      `SELECT u.id, u.email, u.role
       FROM api_tokens t
       JOIN users u ON t.user_id = u.id
       WHERE t.token_hash = ?
         AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
         AND t.revoked_at IS NULL`
    )
      .bind(tokenHash)
      .first<{ id: string; email: string; role: string }>();

    if (result) {
      scheduleWrite(
        ctx,
        env.DB.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE token_hash = ?")
          .bind(tokenHash)
          .run(),
      );
    }

    return result ? { id: result.id, email: result.email, role: (result.role || 'member') as 'admin' | 'member' } : null;
  } catch {
    return null;
  }
}

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
