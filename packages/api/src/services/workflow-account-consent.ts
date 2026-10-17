import { and, eq, sql } from "drizzle-orm";
import type { AppQueryable } from "../lib/drizzle.js";
import { workflowAccountGrants } from "../schema/index.js";

export interface WorkflowAccountConsent {
  orgId: string;
  workflowId: string;
  teamId: string;
  userId: string;
  services: readonly string[];
}

/** A human save authorizes only that person's current accounts for this workflow. */
export async function saveWorkflowAccountConsent(db: AppQueryable, scope: WorkflowAccountConsent): Promise<void> {
  const services = [...new Set(scope.services)];
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
      AND s.service IN (${sql.join(services.map(service => sql`${service}`), sql`, `)})
    ON CONFLICT (org_id, workflow_id, team_id, service, member_id) DO UPDATE
      SET share_generation = EXCLUDED.share_generation, created_at = EXCLUDED.created_at`);
}

/** Removes saved account consent for this workflow. */
export async function revokeWorkflowAccountConsent(db: AppQueryable, orgId: string, workflowId: string): Promise<void> {
  await db.delete(workflowAccountGrants).where(and(
    eq(workflowAccountGrants.orgId, orgId), eq(workflowAccountGrants.workflowId, workflowId),
  ));
}
