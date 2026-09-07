/**
 * Personal better-auth list still returns every row for `referenceId`,
 * including team-pinned keys. Drop those from the public list so a departed
 * admin cannot see or copy team key ids from Settings → You. `total` is
 * recomputed from the filtered rows: the plugin counts every row for the
 * reference id, so the raw count would tell the admin that hidden team
 * keys exist.
 *
 * A successful list whose body is not the `{ apiKeys, total }` shape this
 * filter knows is refused, not passed through. A pass-through would ship
 * every team key on the first better-auth upgrade that renames the field;
 * a loud failure names the fix instead.
 */
import { teamIdFromApiKeyMetadata } from "./request-principal.js";

const LIST_SHAPE_MESSAGE =
  "The api-key list answered in a shape this server does not know. Pin @better-auth/api-key to a version this server supports.";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTeamScopedListItem(key: unknown): boolean {
  if (!isPlainObject(key)) return false;
  return teamIdFromApiKeyMetadata(key.metadata) !== undefined;
}

function isListPath(path: string): boolean {
  return path === "/api/auth/api-key/list" || path.endsWith("/api-key/list");
}

export async function filterTeamKeysFromPersonalApiKeyList(path: string, res: Response): Promise<Response> {
  if (!res.ok) return res;
  if (!isListPath(path)) return res;
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return res;

  const data: unknown = await res.json();
  if (!isPlainObject(data) || !Array.isArray(data.apiKeys)) {
    return new Response(JSON.stringify({ error: LIST_SHAPE_MESSAGE }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  const apiKeys = data.apiKeys.filter((key) => !isTeamScopedListItem(key));
  const next = { ...data, apiKeys, total: apiKeys.length };
  return new Response(JSON.stringify(next), { status: res.status, headers: res.headers });
}
