/**
 * /proxy/* recording gateway.
 *
 * Authenticates a vlt_ API key, resolves the org's real upstream provider,
 * forwards the request verbatim, tees the streamed response to the recorder,
 * and streams it back to the client. Recordable paths (/v1/messages,
 * /v1/responses) write one row to llm_proxy_requests; all other subpaths
 * forward without recording.
 */
import type { Hono, Context } from "hono";
import type { AppEnv } from "../env.js";
import type { ProviderKind } from "../proxy/types.js";
import { resolveProxyPrincipal, extractPassthroughKey, wireError } from "../proxy/principal.js";
import { resolveUpstream, resolveUpstreamBase } from "../proxy/upstream.js";
import { getProxySettings } from "../services/org.js";
import type { Upstream } from "../proxy/types.js";
import { recordProxyCall } from "../proxy/recorder.js";
import { recordProxySpend } from "../proxy/metrics.js";
import { llmProxyRequests } from "../schema/index.js";
import { orgMembers } from "../schema/index.js";
import { resolveOrgId } from "../lib/org.js";
import { asc, eq } from "drizzle-orm";
import type { PrincipalDeps } from "../proxy/principal.js";

/** Hop-by-hop headers stripped before forwarding to the upstream provider. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "host",
  "te",
  "trailer",
  "upgrade",
]);

/**
 * Strip-list, NOT allowlist: forward every incoming header except hop-by-hop
 * + the valet key headers, then set the real upstream auth. This preserves
 * unenumerated provider beta headers (e.g. anthropic-beta, openai-beta)
 * without needing an explicit allowlist.
 */
export function outboundHeaders(raw: Headers, kind: ProviderKind, apiKey: string): Headers {
  const out = new Headers();
  for (const [k, v] of raw.entries()) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk === "x-api-key" || lk === "authorization") continue;
    out.set(k, v);
  }
  if (kind === "anthropic") {
    out.set("x-api-key", apiKey);
  } else {
    out.set("authorization", `Bearer ${apiKey}`);
  }
  return out;
}

/**
 * Response headers forwarded to the client. Strips hop-by-hop headers (the tee
 * decodes the body, so content/transfer-encoding no longer apply) AND any
 * `set-cookie` the upstream provider set — the harness authenticates with its
 * valet key, and forwarding an upstream session cookie would hand the client
 * provider-side session material it must never see.
 */
export function sanitizeResponseHeaders(res: Response): Headers {
  const h = new Headers(res.headers);
  for (const name of HOP_BY_HOP) h.delete(name);
  h.delete("set-cookie");
  return h;
}

/** Classify the client harness from the User-Agent header. */
function harnessFrom(ua: string | null): string {
  if (!ua) return "unknown";
  if (/claude-cli|claude-code/i.test(ua)) return "claude-code";
  if (/codex/i.test(ua)) return "codex";
  return "unknown";
}

/** Subpaths that get a recorder row; all others forward without recording. */
const RECORDABLE = new Set(["/v1/messages", "/v1/responses"]);

/** Deps injected at registration time and captured in the handler closure. */
export interface ProxyGatewayDeps {
  verifyApiKey: PrincipalDeps["verifyApiKey"];
}

export function registerProxyGateway(app: Hono<AppEnv>, deps: ProxyGatewayDeps): void {
  /**
   * Core handler for both /proxy/anthropic/* and /proxy/openai/*.
   * Defined inside `registerProxyGateway` so it captures `deps` via closure —
   * avoids widening AppVariables with a per-request context var.
   */
  async function handle(c: Context<AppEnv>, kind: ProviderKind): Promise<Response> {
    const db = c.var.providers.db;

    const principal = await resolveProxyPrincipal(c.req.raw.headers, kind, {
      verifyApiKey: deps.verifyApiKey,
      userOrg: async (userId) => {
        // Single-org system: look up the user's org_members row, fall back to
        // the org-wide default (resolveOrgId) when the row is absent.
        // orderBy createdAt asc, orgId asc: deterministic result for multi-org users.
        const rows = await db
          .select({ orgId: orgMembers.orgId })
          .from(orgMembers)
          .where(eq(orgMembers.userId, userId))
          .orderBy(asc(orgMembers.createdAt), asc(orgMembers.orgId))
          .limit(1);
        return rows[0]?.orgId ?? (await resolveOrgId(db));
      },
    });
    if (principal instanceof Response) return principal;

    // One read of the org's gateway governance (enabled + mode) for the whole
    // request, not two round-trips on the hot path.
    const settings = await getProxySettings(db, principal.orgId);

    // Master on/off (org-level, default off). When disabled, the gateway
    // records nothing and forwards nothing — a wire-correct 403 tells the user.
    if (!settings.enabled) {
      return wireError(kind, 403, "The recording gateway is disabled for your org. An admin can enable it in Settings → Proxy.");
    }

    // Credential strategy. Centralized (default): use the org's stored key.
    // Pass-through: forward the user's OWN provider key (the non-vlt_ credential
    // the harness sent) so per-user keys/billing are preserved and valet only
    // observes. Both modes resolve the SAME base URL (honoring an org's custom
    // provider endpoint, e.g. Azure) — only the key differs.
    let upstream: Upstream;
    if (settings.mode === "passthrough") {
      const userKey = extractPassthroughKey(c.req.raw.headers);
      if (!userKey) {
        const envVar = kind === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
        return wireError(
          kind,
          400,
          `Pass-through credential mode is on for your org: set your own ${envVar} in the harness alongside your valet key.`,
        );
      }
      upstream = { baseUrl: await resolveUpstreamBase(db, principal.orgId, kind), apiKey: userKey };
    } else {
      const resolved = await resolveUpstream(db, c.var.providers.engineCredentials, principal.orgId, kind);
      if (!resolved) {
        const envVar = kind === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
        return wireError(kind, 502, `No ${kind} provider configured. Add one in valet Settings, or set the ${envVar} env var.`);
      }
      upstream = resolved;
    }

    const url = new URL(c.req.url);
    const subpath = url.pathname.replace(new RegExp(`^/proxy/${kind}`), "") || "/";
    // Reject path-traversal attempts (spec finding: reject .. segments).
    if (subpath.split("/").some((s) => s === "..")) {
      return wireError(kind, 400, "Invalid path.");
    }

    const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
    const reqText = hasBody ? await c.req.text() : "";
    const start = Date.now();

    let res: Response;
    try {
      res = await fetch(`${upstream.baseUrl}${subpath}${url.search}`, {
        method: c.req.method,
        headers: outboundHeaders(c.req.raw.headers, kind, upstream.apiKey),
        body: hasBody ? reqText : undefined,
      });
    } catch {
      return wireError(kind, 502, "Upstream provider unreachable.");
    }

    const recordable = RECORDABLE.has(subpath) && !!res.body;
    if (!recordable) {
      return new Response(res.body, { status: res.status, headers: sanitizeResponseHeaders(res) });
    }

    const [toClient, toRecorder] = res.body!.tee();
    void recordProxyCall(
      {
        // The recorder's insert dep accepts Record<string,unknown>; narrow to
        // the Drizzle insert type so the db call is type-checked end-to-end.
        insert: async (row) => {
          await db.insert(llmProxyRequests).values(row as typeof llmProxyRequests.$inferInsert);
        },
        now: () => Date.now(),
        id: () => crypto.randomUUID(),
        metric: recordProxySpend,
      },
      {
        principal,
        kind,
        endpoint: subpath,
        harness: harnessFrom(c.req.header("user-agent") ?? null),
        requestBody: reqText,
        stream: toRecorder,
        statusCode: res.status,
        startMs: start,
      },
    );

    return new Response(toClient, { status: res.status, headers: sanitizeResponseHeaders(res) });
  }

  app.all("/proxy/anthropic/*", (c) => handle(c, "anthropic"));
  app.all("/proxy/openai/*", (c) => handle(c, "openai"));
}
