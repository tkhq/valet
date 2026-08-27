/**
 * /proxy/* recording gateway.
 *
 * Authenticates a vlt_ API key, resolves the org's real upstream provider,
 * forwards the request verbatim, tees the streamed response to the recorder,
 * and streams it back to the client. Recordable paths (/v1/messages,
 * /v1/responses, /v1/chat/completions, /v1/completions) write one row to
 * llm_proxy_requests; all other subpaths forward without recording.
 */
import type { Hono, Context } from "hono";
import type { AppEnv } from "../env.js";
import type { ProviderKind } from "../proxy/types.js";
import { resolveProxyPrincipal, extractPassthroughKey, wireError } from "../proxy/principal.js";
import { resolveUpstream, DEFAULT_BASE } from "../proxy/upstream.js";
import { getProxySettings } from "../services/org.js";
import type { Upstream } from "../proxy/types.js";
import { recordProxyCall } from "../proxy/recorder.js";
import { recordProxySpend, recordProxyUnpriced } from "../proxy/metrics.js";
import { OPENAI_CHAT_ENDPOINTS, isChatCompletionsEndpoint } from "../proxy/usage-parser.js";
import { llmProxyRequests } from "../schema/index.js";
import { orgMembers } from "../schema/index.js";
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

/** Subpaths that get a recorder row; all others forward without recording.
 * Anthropic Messages + OpenAI Responses (the harness paths) and OpenAI Chat
 * Completions / legacy Completions (the self-service SDK paths). */
const RECORDABLE = new Set(["/v1/messages", "/v1/responses", ...OPENAI_CHAT_ENDPOINTS]);

/**
 * For a streaming OpenAI Chat Completions / Completions request, force
 * `stream_options.include_usage = true` so the provider appends a terminal
 * usage chunk. Without it, streamed chunks carry no usage and the call records
 * as unbilled. Returns the body unchanged for every other case (non-openai,
 * other endpoints, non-JSON body, non-streaming, or already opted in). The
 * forwarded AND recorded body is the mutated one, so the stored request matches
 * the response it produced.
 */
export function injectIncludeUsage(kind: ProviderKind, subpath: string, body: string): string {
  if (kind !== "openai" || !isChatCompletionsEndpoint(subpath)) return body;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return body;
  }
  if (parsed.stream !== true) return body;
  const existing = parsed.stream_options as Record<string, unknown> | undefined;
  if (existing?.include_usage === true) return body;
  return JSON.stringify({ ...parsed, stream_options: { ...(existing ?? {}), include_usage: true } });
}

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
        // The user's org comes from their org_members row. NO fallback: every
        // legitimate user gets a row at provisioning (auth signup) or seed
        // (local dev), so an ABSENT row means the user was REMOVED from the org
        // (or never provisioned). Return null → the proxy 401s, so a removed
        // member's still-valid vlt_ key stops working immediately, even before
        // the key is revoked. orderBy is deterministic for a multi-org user.
        const rows = await db
          .select({ orgId: orgMembers.orgId })
          .from(orgMembers)
          .where(eq(orgMembers.userId, userId))
          .orderBy(asc(orgMembers.createdAt), asc(orgMembers.orgId))
          .limit(1);
        return rows[0]?.orgId ?? null;
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

    // Credential strategy. Centralized (default): use the org's stored key at
    // the org's configured endpoint (which may be a custom/Azure host).
    // Pass-through: forward the user's OWN provider key (the non-vlt_ credential
    // the harness sent) to the PUBLIC provider — a personal key is valid at the
    // public API, not at an org's corporate gateway that expects org-level auth.
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
      upstream = { baseUrl: DEFAULT_BASE[kind], apiKey: userKey };
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
    const rawBody = hasBody ? await c.req.text() : "";
    // For streaming Chat/Completions, force include_usage so usage is captured.
    // The forwarded and recorded body are the same mutated string.
    const reqText = injectIncludeUsage(kind, subpath, rawBody);
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
        unpriced: recordProxyUnpriced,
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
