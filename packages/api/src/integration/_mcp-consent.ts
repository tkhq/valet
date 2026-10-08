/**
 * Test seed: an MCP app and this user's consent to it. `/mcp` refuses a
 * token without a consent record (`hasMcpConsent`), so a test that inserts
 * an `oauth_access_token` row directly seeds both first.
 */
import { randomUUID } from "node:crypto";
import type { AppDb } from "../lib/drizzle.js";
import { oauthApplication, oauthConsent } from "../schema/index.js";

export async function seedMcpConsent(db: AppDb, userId: string, clientId: string): Promise<void> {
  const now = new Date();
  await db.insert(oauthApplication).values({ id: `app-${clientId}`, name: "Test Agent", clientId, type: "public", createdAt: now, updatedAt: now }).onConflictDoNothing();
  await db.insert(oauthConsent).values({ id: randomUUID(), clientId, userId, scopes: "openid", consentGiven: true, createdAt: now, updatedAt: now });
}
