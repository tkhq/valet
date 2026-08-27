import type { ProviderKind, ProxyPrincipal } from "./types.js";

export function wireError(kind: ProviderKind, status: number, message: string): Response {
  const body = kind === "anthropic"
    ? { type: "error", error: { type: status === 401 ? "authentication_error" : "api_error", message } }
    : { error: { message, type: status === 401 ? "invalid_request_error" : "api_error", code: null } };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The better-auth apiKey plugin mints valet keys with this prefix
 * (`defaultPrefix`, see `auth/index.ts`). It is how the gateway tells a valet
 * key from a real provider key that a harness also sends. */
const VALET_KEY_PREFIX = "vlt_";

/**
 * Extracts the valet key from the request. A harness may present a credential
 * in `x-api-key` (Anthropic form) OR `Authorization: Bearer` (OpenAI/Codex
 * form, and Claude Code's `ANTHROPIC_AUTH_TOKEN`). Claude Code sends BOTH: the
 * valet key as the bearer AND — when `ANTHROPIC_API_KEY` is set in the user's
 * environment — the real provider key as `x-api-key`. So a naive
 * `x-api-key`-first rule would pick the real provider key (unverifiable here)
 * and 401. Prefer whichever candidate carries the `vlt_` prefix; fall back to
 * the first present candidate only when neither is a valet key.
 */
function credentialCandidates(headers: Headers): string[] {
  const candidates: string[] = [];
  const xApiKey = headers.get("x-api-key");
  if (xApiKey) candidates.push(xApiKey);
  const auth = headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) candidates.push(auth.slice(7).trim());
  return candidates;
}

function extractKey(headers: Headers): string | undefined {
  const candidates = credentialCandidates(headers);
  return candidates.find((c) => c.startsWith(VALET_KEY_PREFIX)) ?? candidates[0];
}

/**
 * The user's OWN provider key for pass-through credential mode: the first
 * request credential that is NOT a valet key. Claude Code sends the real
 * provider key as `x-api-key` (from `ANTHROPIC_API_KEY`) alongside the `vlt_`
 * bearer, so this returns that real key — which the gateway forwards upstream
 * instead of valet's org key, while the `vlt_` key still identifies the user.
 * Returns undefined when the harness sent only a valet key (no BYO credential).
 */
export function extractPassthroughKey(headers: Headers): string | undefined {
  return credentialCandidates(headers).find((c) => !c.startsWith(VALET_KEY_PREFIX));
}

export interface PrincipalDeps {
  verifyApiKey: (opts: { key: string }) => Promise<{ valid: boolean; key: { id: string; userId: string } | null }>;
  userOrg: (userId: string) => Promise<string | null>;
}

/**
 * Resolves a `vlt_` key (from `x-api-key` OR `Authorization: Bearer`) to a
 * principal. The org comes from the user row — verifyApiKey returns the key
 * record (userId), NOT an org (spec finding 2). Returns a wire-correct 401
 * Response on any failure so the harness shows a clean message.
 */
export async function resolveProxyPrincipal(
  headers: Headers, kind: ProviderKind, deps: PrincipalDeps,
): Promise<ProxyPrincipal | Response> {
  const key = extractKey(headers);
  if (!key) return wireError(kind, 401, "Missing API key. Create a proxy key in valet Settings.");
  const result = await deps.verifyApiKey({ key });
  if (!result.valid || !result.key) return wireError(kind, 401, "Invalid API key. Create a proxy key in valet Settings.");
  const orgId = await deps.userOrg(result.key.userId);
  if (!orgId) return wireError(kind, 401, "API key is not linked to an organization. Contact your organization administrator.");
  return { userId: result.key.userId, orgId, keyId: result.key.id };
}
