/**
 * In-process identity for MCP tool calls.
 *
 * MCP tools call the app's own `/api` routes, so every access rule those
 * routes enforce (private threads, team membership, decision approvers)
 * also applies to an MCP client. The `/mcp` handler has already verified the
 * OAuth bearer token, so it attaches the verified user to the exact `Request`
 * object it dispatches. The auth middleware reads that attachment.
 *
 * The attachment lives in a `WeakMap` keyed by the `Request` object. An
 * external caller cannot create an entry: no header, cookie, or body value
 * maps to one. Only code that holds the `Request` before `app.fetch` can.
 *
 * The identity is accepted only on `MCP_ALLOWED_ROUTES`, the routes the MCP
 * tools use. Add a route here when a tool needs it.
 */
import type { AuthUser } from "../middleware/auth.js";

export interface McpCaller {
  user: AuthUser;
  /** The OAuth client the token was issued to. */
  clientId: string;
}

const callers = new WeakMap<Request, McpCaller>();

/** Attach a verified MCP user to a request before the app handles it. */
export function attachMcpCaller(req: Request, caller: McpCaller): Request {
  callers.set(req, caller);
  return req;
}

/** The verified MCP caller attached to this exact request, if any. */
export function mcpCallerFor(req: Request): McpCaller | undefined {
  return callers.get(req);
}

const MCP_ALLOWED_ROUTES: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: "GET", pattern: /^\/api\/me$/ },
  { method: "GET", pattern: /^\/api\/teams$/ },
  { method: "GET", pattern: /^\/api\/threads$/ },
  { method: "POST", pattern: /^\/api\/threads$/ },
  { method: "GET", pattern: /^\/api\/threads\/[^/]+$/ },
  { method: "GET", pattern: /^\/api\/threads\/[^/]+\/messages$/ },
  { method: "POST", pattern: /^\/api\/threads\/[^/]+\/messages$/ },
  { method: "GET", pattern: /^\/api\/threads\/[^/]+\/decisions$/ },
  { method: "POST", pattern: /^\/api\/threads\/[^/]+\/decisions\/[^/]+\/resolve$/ },
  { method: "POST", pattern: /^\/api\/threads\/[^/]+\/abort$/ },
  { method: "GET", pattern: /^\/api\/actions$/ },
  { method: "GET", pattern: /^\/api\/actions\/[^/]+$/ },
  { method: "POST", pattern: /^\/api\/actions\/[^/]+\/invoke$/ },
  { method: "GET", pattern: /^\/api\/skills$/ },
  { method: "GET", pattern: /^\/api\/skills\/[^/]+$/ },
  { method: "GET", pattern: /^\/api\/memory$/ },
  { method: "GET", pattern: /^\/api\/memory\/search$/ },
  { method: "PUT", pattern: /^\/api\/memory$/ },
  { method: "DELETE", pattern: /^\/api\/memory$/ },
  { method: "POST", pattern: /^\/api\/memory\/(patch|move)$/ },
  { method: "GET", pattern: /^\/api\/workflows$/ },
  { method: "GET", pattern: /^\/api\/workflows\/action-required$/ },
  { method: "POST", pattern: /^\/api\/workflows\/[^/]+\/runs$/ },
  { method: "GET", pattern: /^\/api\/workflows\/runs\/[^/]+$/ },
  { method: "POST", pattern: /^\/api\/workflows\/runs\/[^/]+\/(cancel|retry)$/ },
  { method: "GET", pattern: /^\/api\/notifications\/decisions$/ },
  { method: "GET", pattern: /^\/api\/artifacts$/ },
  { method: "POST", pattern: /^\/api\/artifacts\/share$/ },
  { method: "DELETE", pattern: /^\/api\/artifacts\/[^/]+$/ },
];

/** Whether an MCP caller may use this route. */
export function mcpRouteAllowed(method: string, path: string): boolean {
  return MCP_ALLOWED_ROUTES.some((route) => route.method === method && route.pattern.test(path));
}
