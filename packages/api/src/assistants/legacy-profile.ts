/**
 * The name, avatar, and personality a workspace's assistant carried before
 * the workspace runtime replaced per-assistant profiles. The runtime dropped
 * `name`, `avatar_url`, and `personality` from the Drizzle model and from a
 * fresh database's schema, but an upgraded database still holds the values,
 * and nothing removes them. Without this read, a customized assistant lost
 * its name and avatar in channel replies, and its personality in the prompt,
 * on upgrade.
 *
 * Read-only, like `integration-limit.ts`: nothing writes a new value, so the
 * profile stays what it was at upgrade. `to_jsonb` reads a column that a
 * database created after the change does not have as null, rather than
 * failing the query.
 */
import { sql } from "drizzle-orm";
import type { Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";

export interface LegacyAssistantProfile {
  name?: string;
  avatarUrl?: string;
  personality?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** The workspace assistant's carried-over profile, or undefined when it has none. */
export async function loadLegacyAssistantProfile(
  db: AppDb,
  orgId: string,
  owner: Principal,
): Promise<LegacyAssistantProfile | undefined> {
  const result = await db.execute(sql`SELECT to_jsonb(a)->>'name' AS name,
      to_jsonb(a)->>'avatar_url' AS avatar_url, to_jsonb(a)->>'personality' AS personality
    FROM assistants a WHERE a.org_id = ${orgId} AND a.owner_type = ${owner.type}
      AND a.owner_id = ${owner.id} AND a.archived_at IS NULL LIMIT 1`) as {
    rows: Array<{ name: unknown; avatar_url: unknown; personality: unknown }>;
  };
  const row = result.rows[0];
  if (!row) return undefined;
  const profile: LegacyAssistantProfile = {
    ...(text(row.name) ? { name: text(row.name) } : {}),
    ...(text(row.avatar_url) ? { avatarUrl: text(row.avatar_url) } : {}),
    ...(text(row.personality) ? { personality: text(row.personality) } : {}),
  };
  return Object.keys(profile).length > 0 ? profile : undefined;
}
