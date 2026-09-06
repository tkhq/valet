/**
 * Server-only team pin on better-auth's public api-key routes. `enableMetadata`
 * lets a signed-in caller write `metadata.teamId` on create/update; the auth
 * ladder would then treat that key as the team. These hooks refuse that stamp
 * and refuse personal get/update/delete of a key the team route already pinned.
 */
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { apikey } from "../schema/index.js";
import { clientMetadataHasTeamId, parseApiKeyMetadata, teamIdFromApiKeyMetadata } from "../lib/request-principal.js";

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
