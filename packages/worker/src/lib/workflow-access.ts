/**
 * Workflow access control.
 *
 * Single helper called by every workflow API endpoint
 * (read/draft/publish/test-run/cancel/approve/restore/etc) before doing
 * work. All three roles (viewer/editor/publisher) are satisfied by
 * ownership of `workflows.user_id`. The signature accommodates future
 * additions: org sharing, reviewer/approver splits.
 */

import { eq, or, and } from 'drizzle-orm';
import { workflows } from './schema/workflows.js';
import type { AppDb } from './drizzle.js';

export type WorkflowRole = 'viewer' | 'editor' | 'publisher';

export interface AccessedWorkflow {
  id: string;
  userId: string;
}

/**
 * Throw NotFoundError if the user lacks the requested role on the
 * workflow. Returns a lightweight workflow stub on success. Accepts ID
 * or slug — same form as the existing getWorkflowByIdOrSlug helper.
 */
export async function assertWorkflowAccess(
  db: AppDb,
  user: { id: string },
  workflowIdOrSlug: string,
  // Role is accepted but not fully used — the owner (or, for team-owned
  // workflows, any current team member) satisfies all three. Kept so call
  // sites declare intent and real role gating can land without changing them.
  _role: WorkflowRole = 'viewer',
): Promise<AccessedWorkflow> {
  const row = await db
    .select({ id: workflows.id, userId: workflows.userId, ownerType: workflows.ownerType, ownerId: workflows.ownerId })
    .from(workflows)
    .where(or(eq(workflows.id, workflowIdOrSlug), eq(workflows.slug, workflowIdOrSlug)))
    .get();

  const notFound = async (): Promise<never> => {
    const { NotFoundError } = await import('@valet/shared');
    throw new NotFoundError('Workflow', workflowIdOrSlug);
  };

  if (!row) return notFound();

  // Team-owned workflows: membership is the path in (collaborative — the
  // whole team can watch and edit, teams design §5). No existence disclosure
  // to outsiders, mirroring assertSessionAccess.
  if (row.ownerType === 'team' && row.ownerId) {
    const { getTeamMembership } = await import('./db/teams.js');
    const membership = await getTeamMembership(db, row.ownerId, user.id);
    if (!membership) return notFound();
    return { id: row.id, userId: row.userId };
  }

  if (row.userId !== user.id) return notFound();
  return { id: row.id, userId: row.userId };
}
