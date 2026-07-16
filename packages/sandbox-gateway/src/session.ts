/**
 * Cookie-session bookkeeping shared by the HTTP proxy (`gateway.ts`) and the
 * WebSocket proxy (`ws-proxy.ts`).
 *
 * Cookie contract: name `gateway_session`, 15-minute TTL,
 * `Path=/; SameSite=None; Secure`, backed by an in-memory `Map` (the gateway
 * is a single sandbox-local process — no cross-instance session sharing).
 */
import { randomBytes } from "node:crypto";
import { verifyGatewayJwt } from "./jwt.js";

export const SESSION_COOKIE = "gateway_session";
export const SESSION_TTL_MS = 15 * 60 * 1000;

export interface SessionPrincipal {
  sub: string;
  sid: string;
}

interface SessionRecord extends SessionPrincipal {
  expiresAt: number;
}

/** In-memory `token -> principal` map for cookie-authenticated requests. */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  /** Mints a new session token bound to `principal`, valid for `SESSION_TTL_MS`. */
  create(principal: SessionPrincipal): string {
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, { ...principal, expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
  }

  /** Returns the principal for a live session token, or `null` if missing/expired. */
  validate(token: string): SessionPrincipal | null {
    const record = this.sessions.get(token);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return { sub: record.sub, sid: record.sid };
  }
}

/** Parses a `Cookie` request header into a name -> value map. */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) cookies[key] = value;
  }
  return cookies;
}

/** Builds the `Set-Cookie` header value for a freshly minted session token. */
export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=None; Secure`;
}

/** Extracts a bearer token from an `Authorization: Bearer <token>` header value. */
export function bearerToken(authorizationHeader: string | null | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader);
  return match ? match[1] : undefined;
}

export interface ResolveAuthOpts {
  cookieHeader: string | null | undefined;
  token: string | undefined;
  secret: string;
  expectedSid: string;
  sessions: SessionStore;
}

export interface ResolveAuthResult {
  principal: SessionPrincipal;
  /** Set only when auth was resolved via a fresh JWT — the caller must mint
   * a `Set-Cookie` header from this token so subsequent requests can skip
   * the JWT round-trip. */
  newCookieToken?: string;
}

/**
 * Resolves the caller's principal: cookie-first (validated against the
 * in-memory session map), falling back to a `?token=`/`Bearer` JWT verified
 * against `secret` and `expectedSid`. Returns `null` if neither succeeds.
 */
export function resolveAuth(opts: ResolveAuthOpts): ResolveAuthResult | null {
  const cookies = parseCookies(opts.cookieHeader);
  const existingToken = cookies[SESSION_COOKIE];
  if (existingToken) {
    const principal = opts.sessions.validate(existingToken);
    if (principal) return { principal };
  }

  if (!opts.token) return null;
  const verified = verifyGatewayJwt(opts.secret, opts.token, opts.expectedSid);
  if (!verified) return null;
  const newCookieToken = opts.sessions.create(verified);
  return { principal: verified, newCookieToken };
}
