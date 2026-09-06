/**
 * Personal better-auth list still returns every row for `referenceId`,
 * including team-pinned keys. Drop those from the public list so a departed
 * admin cannot see or copy team key ids from Settings → You.
 */
import { teamIdFromApiKeyMetadata } from "./request-principal.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTeamScopedListItem(key: unknown): boolean {
  if (!isPlainObject(key)) return false;
  return teamIdFromApiKeyMetadata(key.metadata) !== undefined;
}

export async function filterTeamKeysFromPersonalApiKeyList(path: string, res: Response): Promise<Response> {
  if (!res.ok) return res;
  if (path !== "/api/auth/api-key/list" && !path.endsWith("/api-key/list")) return res;
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return res;

  const data: unknown = await res.json();
  if (!isPlainObject(data) || !Array.isArray(data.apiKeys)) {
    return new Response(JSON.stringify(data), { status: res.status, headers: res.headers });
  }
  const next = { ...data, apiKeys: data.apiKeys.filter((key) => !isTeamScopedListItem(key)) };
  return new Response(JSON.stringify(next), { status: res.status, headers: res.headers });
}
