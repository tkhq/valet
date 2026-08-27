import type { ProviderKind, ProxyPrincipal } from "./types.js";

export function wireError(kind: ProviderKind, status: number, message: string): Response {
  const body = kind === "anthropic"
    ? { type: "error", error: { type: status === 401 ? "authentication_error" : "api_error", message } }
    : { error: { message, type: status === 401 ? "invalid_request_error" : "api_error", code: null } };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function extractKey(headers: Headers): string | undefined {
  const xApiKey = headers.get("x-api-key");
  if (xApiKey) return xApiKey;
  const auth = headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return undefined;
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
