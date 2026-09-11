/** Durable readiness invalidation. Call with the mutation transaction when
 * available. The existing sweep consumes the work after a process restart. */
import { and, eq, sql } from "drizzle-orm";
import type { AppQueryable } from "../../lib/drizzle.js";
import { contentSources } from "../../schema/index.js";

export async function invalidateWorkflowSources(
  db: AppQueryable,
  owner: { teamId: string } | { orgId: string },
  now = Date.now(),
): Promise<number> {
  const rows = await db
    .update(contentSources)
    .set({
      syncRevision: sql`${contentSources.syncRevision} + 1`,
      discoveryScan: null,
      lastManifestHash: null,
      // Preserve transport-error backoff. Its retry already takes a full pass.
      nextAttemptAt: sql`CASE WHEN ${contentSources.status} = 'error' THEN ${contentSources.nextAttemptAt} ELSE ${now} END`,
      updatedAt: now,
    })
    .where(and(
      eq(contentSources.ownerType, "team"),
      "teamId" in owner ? eq(contentSources.ownerId, owner.teamId) : eq(contentSources.orgId, owner.orgId),
      eq(contentSources.enabled, true),
      sql`${contentSources.kinds} @> '["workflows"]'::jsonb`,
    ))
    .returning({ id: contentSources.id });
  return rows.length;
}

/** Suffix for a credential mutation CTE named `written`. One SQL statement
 * commits the credential and its invalidation, including personal delegates.
 * Used by the raw PostgreSQL credential store so refreshes and specialized
 * connection routes cannot omit the durable request. */
export const CREDENTIAL_INVALIDATION_SQL = `
UPDATE skill_sources AS source SET
  sync_revision = source.sync_revision + 1,
  discovery_scan = NULL,
  last_manifest_hash = NULL,
  next_attempt_at = CASE WHEN source.status = 'error' THEN source.next_attempt_at
    ELSE (extract(epoch FROM clock_timestamp()) * 1000)::bigint END,
  updated_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
FROM written
WHERE source.owner_type = 'team' AND source.enabled = true
  AND source.kinds @> '["workflows"]'::jsonb
  AND (
    (written.owner_type = 'team' AND source.owner_id = written.owner_id)
    OR (written.owner_type = 'org' AND source.org_id = written.owner_id)
    OR (written.owner_type = 'user' AND EXISTS (
      SELECT 1 FROM credentials AS delegation
      WHERE delegation.owner_type = 'team' AND delegation.owner_id = source.owner_id
        AND delegation.service = written.service
        AND delegation.metadata->>'delegatedFrom' = written.owner_id
    ))
  )`;
