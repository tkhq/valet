import { visibleThreadIds } from "./thread-access.js";
import { sql, eq, and } from "drizzle-orm";
import type { Providers } from "../providers/types.js";
import { productAnnouncements, productAnnouncementAcknowledgements } from "../schema/index.js";
import type { ProductAnnouncement } from "../wire/types.js";

type AnnouncementDeps = Pick<Providers, "db" | "engineCredentials" | "onePassword">;

export const WORKFLOW_THREADS_ANNOUNCEMENT: ProductAnnouncement = {
  id: "workflow-run-threads-in-automations-v1",
  title: "Workflow run threads moved to Automations",
  body: "Open Automations to find workflow runs and their conversations. Your existing run history is still available.",
  action: { label: "Open Automations", href: "/workflows" },
};

async function hasExistingWorkflowThread(deps: AnnouncementDeps, userId: string, orgId: string, activatedAt: number): Promise<boolean> {
  const { db } = deps;
  // Check current ownership and membership. No private thread content leaves this query.
  let afterId = "";
  for (;;) {
    const candidates = await db.execute(sql`SELECT t.id, t.session_id, s.owner_type FROM engine_threads t
      JOIN agent_sessions s ON s.id=t.session_id
      JOIN "user" u ON u.id=${userId}
      WHERE s.org_id=${orgId} AND s.status <> 'deleted'
        AND t.created_at < ${activatedAt}
        AND u.created_at < to_timestamp(${activatedAt} / 1000.0)
        AND EXISTS (SELECT 1 FROM org_members om WHERE om.org_id=${orgId} AND om.user_id=${userId})
        AND (s.owner_type='user' AND COALESCE(NULLIF(s.owner_id,''),s.user_id)=${userId}
          OR s.owner_type='team' AND EXISTS (
            SELECT 1 FROM team_members tm JOIN teams team ON team.id=tm.team_id
            WHERE tm.team_id=s.owner_id AND tm.user_id=${userId} AND team.org_id=${orgId}))
        AND (t.key ~ '^(signal:workflow:|slack-events:[^:]+:workflow:)[A-Za-z0-9_-]+$'
          OR s.id ~ '^wf:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+(:[0-9]+)?$')
        AND t.id > ${afterId}
      ORDER BY t.id LIMIT 100`) as { rows: Array<{ id: string; session_id: string; owner_type: string }> };
    if (candidates.rows.some(row => row.owner_type === "user")) return true;
    const visible = await visibleThreadIds(deps, { ownerType: "team" }, { orgId, userId },
      candidates.rows.map(row => ({ sessionId: row.session_id, threadId: row.id })));
    if (visible.size > 0) return true;
    if (candidates.rows.length < 100) return false;
    afterId = candidates.rows[candidates.rows.length - 1]!.id;
  }
}

interface AnnouncementDefinition {
  notice: ProductAnnouncement;
  eligible: (deps: AnnouncementDeps, userId: string, orgId: string, activatedAt: number) => Promise<boolean>;
}

// Add a catalog entry and a one-time activation seed for each future release notice.
const catalog: readonly AnnouncementDefinition[] = [
  { notice: WORKFLOW_THREADS_ANNOUNCEMENT, eligible: hasExistingWorkflowThread },
];

export async function pendingProductAnnouncements(deps: AnnouncementDeps, userId: string, orgId: string): Promise<ProductAnnouncement[]> {
  const { db } = deps;
  const pending: ProductAnnouncement[] = [];
  for (const definition of catalog) {
    const { notice } = definition;
    const [release] = await db.select().from(productAnnouncements).where(eq(productAnnouncements.id, notice.id));
    if (!release) continue;
    const [ack] = await db.select().from(productAnnouncementAcknowledgements).where(and(
      eq(productAnnouncementAcknowledgements.announcementId, notice.id),
      eq(productAnnouncementAcknowledgements.userId, userId),
    ));
    if (!ack && await definition.eligible(deps, userId, orgId, release.activatedAt)) pending.push(notice);
  }
  return pending;
}

export async function acknowledgeProductAnnouncement(deps: AnnouncementDeps, userId: string, orgId: string, id: string): Promise<boolean> {
  const { db } = deps;
  if (!catalog.some(definition => definition.notice.id === id)) return false;
  const [existing] = await db.select().from(productAnnouncementAcknowledgements).where(and(
    eq(productAnnouncementAcknowledgements.announcementId, id), eq(productAnnouncementAcknowledgements.userId, userId),
  ));
  if (existing) return true;
  if (!(await pendingProductAnnouncements(deps, userId, orgId)).some(item => item.id === id)) return false;
  await db.insert(productAnnouncementAcknowledgements).values({ announcementId: id, userId, acknowledgedAt: Date.now() }).onConflictDoNothing();
  return true;
}
