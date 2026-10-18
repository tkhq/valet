import { and, eq, sql } from "drizzle-orm";
import type { AppQueryable } from "../lib/drizzle.js";
import { workflowAccountGrants } from "../schema/index.js";

export interface WorkflowAccountConsent {
  orgId: string;
  workflowId: string;
  teamId: string;
  userId: string;
  services: readonly string[];
  /** Write only for this share generation: the one a person approved. */
  shareGeneration?: string;
}

/** A person's explicit approval allows only their own current shares for this workflow. */
export async function saveWorkflowAccountConsent(db: AppQueryable, scope: WorkflowAccountConsent): Promise<void> {
  const services = [...new Set(scope.services)].filter(service => service !== "github");
  if (services.length === 0) return;
  await db.execute(sql`INSERT INTO workflow_account_grants
    (org_id, workflow_id, team_id, service, member_id, share_generation, created_at)
    SELECT ${scope.orgId}, d.id, s.team_id, s.service, s.user_id, s.generation, ${Date.now()}
    FROM credential_shares s
    JOIN team_members m ON m.team_id = s.team_id AND m.user_id = s.user_id
    JOIN teams t ON t.id = s.team_id AND t.org_id = ${scope.orgId}
    JOIN workflow_definitions d ON d.id = ${scope.workflowId} AND d.org_id = t.org_id
      AND d.owner_type = 'team' AND d.owner_id = t.id
    JOIN credentials c ON c.owner_type = 'user' AND c.owner_id = s.user_id AND c.service = s.service
    WHERE s.team_id = ${scope.teamId} AND s.user_id = ${scope.userId}
      ${scope.shareGeneration === undefined ? sql`` : sql`AND s.generation = ${scope.shareGeneration}`}
      AND s.service IN (${sql.join(services.map(service => sql`${service}`), sql`, `)})
    ON CONFLICT (org_id, workflow_id, team_id, service, member_id) DO UPDATE
      SET share_generation = EXCLUDED.share_generation, created_at = EXCLUDED.created_at`);
}

/** The services in `scope.services` that this person shares with the team
 * and has not allowed for this workflow's current share generation. */
export async function pendingWorkflowAccountConsent(db: AppQueryable, scope: WorkflowAccountConsent): Promise<string[]> {
  const services = [...new Set(scope.services)].filter(service => service !== "github");
  if (services.length === 0) return [];
  const result = await db.execute(sql`SELECT DISTINCT s.service FROM credential_shares s
    JOIN team_members m ON m.team_id = s.team_id AND m.user_id = s.user_id
    JOIN credentials c ON c.owner_type = 'user' AND c.owner_id = s.user_id AND c.service = s.service
    LEFT JOIN workflow_account_grants g ON g.org_id = ${scope.orgId} AND g.workflow_id = ${scope.workflowId}
      AND g.team_id = s.team_id AND g.service = s.service AND g.member_id = s.user_id AND g.share_generation = s.generation
    WHERE s.team_id = ${scope.teamId} AND s.user_id = ${scope.userId} AND g.workflow_id IS NULL
      AND s.service IN (${sql.join(services.map(service => sql`${service}`), sql`, `)})`) as { rows: Array<{ service: string }> };
  return result.rows.map(row => row.service).sort();
}

/** Removes saved account consent for this workflow. */
export async function revokeWorkflowAccountConsent(db: AppQueryable, orgId: string, workflowId: string, memberId?: string): Promise<void> {
  await db.delete(workflowAccountGrants).where(and(
    eq(workflowAccountGrants.orgId, orgId), eq(workflowAccountGrants.workflowId, workflowId),
    memberId === undefined ? undefined : eq(workflowAccountGrants.memberId, memberId),
  ));
}
