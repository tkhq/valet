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
import { PRESENCE_DISPLAY_NAME_MAX_LENGTH, validatePresence } from "@valet/shared";
import { LEGACY_RUNTIME_MARKER, type AppDb } from "../lib/drizzle.js";

export interface LegacyAssistantProfile {
  name?: string;
  avatarUrl?: string;
  /** Trimmed. `""` is an explicitly neutral persona: the old editor stored
   * it when someone cleared the personality. Absent means never set. */
  personality?: string;
  /** When this database was upgraded to the workspace runtime (epoch ms). */
  upgradedAt?: number;
}

/**
 * The stored name as one trimmed line of at most 80 UTF-16 units: Slack's
 * `username` limit, and the cap `validatePresence` applies to every other
 * display name. The old API stored any string, so a stored name can hold
 * line breaks or run long. Control and line-separator characters become
 * spaces, so the name cannot break out of the "You are <name>." line into
 * a new prompt section or a new Slack line. Its words still reach the
 * prompt: the same owners and the assistant itself wrote both the name and
 * the personality, which is instruction text by design.
 */
function displayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
  let capped = "";
  for (const char of line) {
    if (capped.length + char.length > PRESENCE_DISPLAY_NAME_MAX_LENGTH) break;
    capped += char;
  }
  return capped.trim() || undefined;
}

/** A trimmed https URL that `validatePresence` accepts, without the inner
 * whitespace the old API also refused. */
function avatarUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const url = value.trim();
  return url && !/\s/.test(url) && validatePresence({ avatarUrl: url }) === null ? url : undefined;
}

/** The workspace assistant's carried-over profile, or undefined when it has none. */
export async function loadLegacyAssistantProfile(
  db: AppDb,
  orgId: string,
  owner: Principal,
): Promise<LegacyAssistantProfile | undefined> {
  const result = await db.execute(sql`SELECT p->>'name' AS name, p->>'avatar_url' AS avatar_url,
      p->>'personality' AS personality,
      (SELECT m.applied_at FROM __valet_app_migrations m WHERE m.filename = ${LEGACY_RUNTIME_MARKER}) AS upgraded_at
    FROM (SELECT to_jsonb(a) AS p FROM assistants a WHERE a.org_id = ${orgId} AND a.owner_type = ${owner.type}
      AND a.owner_id = ${owner.id} AND a.archived_at IS NULL LIMIT 1) live`) as {
    rows: Array<{ name: unknown; avatar_url: unknown; personality: unknown; upgraded_at: unknown }>;
  };
  const row = result.rows[0];
  if (!row) return undefined;
  const profile: LegacyAssistantProfile = {
    ...(displayName(row.name) ? { name: displayName(row.name) } : {}),
    ...(avatarUrl(row.avatar_url) ? { avatarUrl: avatarUrl(row.avatar_url) } : {}),
    ...(typeof row.personality === "string" ? { personality: row.personality.trim() } : {}),
  };
  if (Object.keys(profile).length === 0) return undefined;
  const upgradedAt = Number(row.upgraded_at);
  return row.upgraded_at !== null && Number.isFinite(upgradedAt) ? { ...profile, upgradedAt } : profile;
}

/**
 * The personality text for the prompt, from the `assistant/personality.md`
 * memory file and the carried-over column.
 *
 * Before the workspace runtime, a set column won over the file, and `""`
 * in the column was an explicitly neutral persona. The file could already
 * exist then: `PATCH /api/orchestrator/info` wrote it on every personality
 * save, and the assistant could write it with its memory tools. After the
 * upgrade the file is the only personality anyone can change, through the
 * assistant's memory tools or the memory API.
 *
 * So the column keeps winning while the file is unchanged since the
 * upgrade, which reproduces what the workspace had. A file written after
 * the upgrade is a newer edit, and it wins. The upgrade marker and the
 * file's `updated_at` both come from the API's clock. A database without
 * the marker cannot show a later edit, so the column wins there.
 */
export function effectivePersonality(
  file: { content: string; updatedAt: number } | null,
  legacy: LegacyAssistantProfile | undefined,
): string {
  if (legacy?.personality === undefined) return file?.content ?? "";
  if (file && file.updatedAt > (legacy.upgradedAt ?? Number.POSITIVE_INFINITY)) return file.content;
  return legacy.personality;
}
