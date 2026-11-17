/**
 * Guards on better-auth's public api-key routes.
 *
 * Server-only team pin: `enableMetadata` lets a signed-in caller write
 * `metadata.teamId` on create/update; the auth ladder would then treat that
 * key as the team. These hooks refuse that stamp and refuse personal
 * get/update/delete of a key the team route already pinned.
 *
 * Org key policy (`services/api-key-policy.ts`): a browser create is refused
 * when the org turned personal keys off, and a create or update must keep
 * the key's lifetime within the org maximum.
 */
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { apikey } from "../schema/index.js";
import { clientMetadataHasTeamId, parseApiKeyMetadata, teamIdFromApiKeyMetadata } from "../lib/request-principal.js";
import { getInstanceApiKeyPolicy, PERSONAL_API_KEYS_OFF_MESSAGE, resolveKeyExpiry } from "../services/api-key-policy.js";

export const CLIENT_TEAM_KEY_METADATA_MESSAGE =
  "Team id on an API key is set by the team workspace. Create the key from Settings in that workspace.";

export const PERSONAL_TEAM_KEY_MUTATION_MESSAGE =
  "Revoke or inspect a team API key from the team workspace, not from personal keys.";

export interface ApiKeyHookContext {
  path?: string;
  body?: Record<string, unknown> | null;
  query?: Record<string, unknown> | null;
}

function keyIdFromContext(ctx: ApiKeyHookContext): string | undefined {
  const fromBody = ctx.body?.keyId ?? ctx.body?.id;
  if (typeof fromBody === "string" && fromBody.length > 0) return fromBody;
  const fromQuery = ctx.query?.id ?? ctx.query?.keyId;
  return typeof fromQuery === "string" && fromQuery.length > 0 ? fromQuery : undefined;
}

async function rowIsTeamScoped(db: AppDb, keyId: string): Promise<boolean> {
  const rows = await db.select({ metadata: apikey.metadata }).from(apikey).where(eq(apikey.id, keyId)).limit(1);
  return teamIdFromApiKeyMetadata(parseApiKeyMetadata(rows[0]?.metadata)) !== undefined;
}

export async function guardPersonalApiKeyRoutes(ctx: ApiKeyHookContext, db: AppDb): Promise<void> {
  const path = ctx.path;
  if (path === "/api-key/create" || path === "/api-key/update") {
    if (clientMetadataHasTeamId(ctx.body)) {
      throw new APIError("FORBIDDEN", { message: CLIENT_TEAM_KEY_METADATA_MESSAGE });
    }
  }
  if (path === "/api-key/delete" || path === "/api-key/update" || path === "/api-key/get") {
    const keyId = keyIdFromContext(ctx);
    if (keyId && (await rowIsTeamScoped(db, keyId))) {
      throw new APIError("FORBIDDEN", { message: PERSONAL_TEAM_KEY_MUTATION_MESSAGE });
    }
  }
}

/** What a policy guard hands back to better-auth: a body to use instead. */
export interface ApiKeyHookResult {
  context: { body: Record<string, unknown> };
}

/**
 * Org key policy on the browser's create and update calls. Server calls
 * (`auth.api.createApiKey` from the team route and the CLI device route)
 * carry no `Request` and apply the policy themselves, so this guard skips
 * them.
 *
 * A create that sends no `expiresIn` under an org maximum gets the maximum:
 * the guard returns a body with it set. An `expiresIn` that is not a number
 * or null passes through to better-auth, which refuses it.
 */
export async function guardApiKeyPolicy(
  ctx: ApiKeyHookContext & { fromRequest: boolean },
  db: AppDb,
): Promise<ApiKeyHookResult | undefined> {
  if (!ctx.fromRequest) return undefined;
  const path = ctx.path;
  if (path !== "/api-key/create" && path !== "/api-key/update") return undefined;
  const body = ctx.body ?? {};
  if (path === "/api-key/update" && !("expiresIn" in body)) return undefined;
  const policy = await getInstanceApiKeyPolicy(db);
  if (path === "/api-key/create" && !policy.allowPersonalKeys) {
    throw new APIError("FORBIDDEN", { message: PERSONAL_API_KEYS_OFF_MESSAGE });
  }
  const raw = body.expiresIn;
  if (raw !== undefined && raw !== null && typeof raw !== "number") return undefined;
  const decision = resolveKeyExpiry(policy, raw);
  if (!decision.ok) throw new APIError("BAD_REQUEST", { message: decision.message });
  if (raw === undefined && decision.expiresIn !== null) {
    return { context: { body: { ...body, expiresIn: decision.expiresIn } } };
  }
  return undefined;
}
