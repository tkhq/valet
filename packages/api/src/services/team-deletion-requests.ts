import { isOrgMember } from "./org.js";
import { randomUUID } from "node:crypto";
import { and, desc, eq, lte } from "drizzle-orm";
import { NotFoundError, RepoOwnedWorkflowError } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import { apikey, contentSources, credentials, skills, teamDeletionRequests, teams, users, workflowDefinitions } from "../schema/index.js";
import { canViewTeam, ConfigManagedTeamError, getTeamInOrg, IdpManagedTeamError, isLiveIdpMirror, isTeamMember } from "./teams.js";
import { lockTeamDeletionAccess, type DeletionResourceType } from "./team-deletion-access.js";
import { deleteSkill } from "./skills.js";
import { deleteContentSource } from "./content-sources.js";
import { deleteWorkflowDefinition, type WorkflowServiceDeps } from "../workflows/service.js";
import { deleteTeamApiKey, deleteTeamCredential, deleteTeamResources } from "./team-resource-deletion.js";
import { markAttentionNotificationsRead, routeAttention } from "../orchestrator/attention.js";

export type RequestActor = { orgId: string; userId: string; teamId: string };
export type DeletionRequestRow = typeof teamDeletionRequests.$inferSelect;
export class DeletionRequestError extends Error {
  readonly code = "deletion_request_refused";
  constructor(message: string, readonly statusCode: 400 | 403 | 409 = 409) { super(message); }
}
const activeRunRefusal = "workflow has runs that are not settled. Cancel them first, then delete.";
interface ResourceAdapter {
  read(db: AppDb, actor: RequestActor, id: string): Promise<string>;
  delete(deps: WorkflowServiceDeps, actor: RequestActor, id: string): Promise<string[]>;
}
function missing(): never { throw new NotFoundError("resource", "requested resource"); }
function checkResult(result: string | boolean) {
  if (result === "not_found" || result === false) missing();
  if (result === "has_active_runs") throw new DeletionRequestError(activeRunRefusal);
  if (result === "not_local") throw new DeletionRequestError("this skill comes from a repository. Remove it in the repository it came from.");
}
/** Each entry checks exact team ownership, then calls the ordinary delete service. */
export const deletionResourceRegistry: Record<DeletionResourceType, ResourceAdapter> = {
  workflow: {
    async read(db, a, id) {
      const [row] = await db.select().from(workflowDefinitions).where(and(eq(workflowDefinitions.id, id), eq(workflowDefinitions.orgId, a.orgId), eq(workflowDefinitions.ownerType, "team"), eq(workflowDefinitions.ownerId, a.teamId))).limit(1).for("update");
      if (!row) missing();
      if (row.origin === "repo") {
        const [source] = row.sourceId ? await db.select().from(contentSources).where(and(eq(contentSources.id, row.sourceId), eq(contentSources.orgId, a.orgId))).limit(1) : [];
        throw new RepoOwnedWorkflowError(source?.repoFullName ?? "its repository", row.upstreamPath ?? "its workflow file");
      }
      return row.name;
    },
    async delete(deps, a, id) { checkResult(await deleteWorkflowDefinition(deps, a, id)); return []; },
  },
  skill: {
    async read(db, a, id) {
      const [row] = await db.select().from(skills).where(and(eq(skills.id, id), eq(skills.orgId, a.orgId), eq(skills.ownerType, "team"), eq(skills.ownerId, a.teamId))).limit(1).for("update");
      if (!row) missing();
      if (row.origin !== "local") checkResult("not_local");
      return row.name;
    },
    async delete(deps, a, id) { checkResult(await deleteSkill(deps.db, a, id)); return []; },
  },
  content_source: {
    async read(db, a, id) {
      const [row] = await db.select().from(contentSources).where(and(eq(contentSources.id, id), eq(contentSources.orgId, a.orgId), eq(contentSources.ownerType, "team"), eq(contentSources.ownerId, a.teamId))).limit(1).for("update");
      if (!row) missing();
      return row.repoFullName;
    },
    async delete(deps, a, id) { checkResult(await deleteContentSource(deps.db, a, id)); return []; },
  },
  credential: {
    async read(db, a, id) {
      // Reserved connection state has its own lifecycle and is outside this flow.
      if (id === "onepassword") throw new DeletionRequestError("Manage this connection in team settings.", 400);
      const [row] = await db.select({ service: credentials.service }).from(credentials).where(and(eq(credentials.ownerType, "team"), eq(credentials.ownerId, a.teamId), eq(credentials.service, id))).limit(1).for("update");
      if (!row) missing();
      return row.service;
    },
    async delete(deps, a, id) { await deleteTeamCredential(deps.db, a, a.teamId, id); return []; },
  },
  api_key: {
    async read(db, a, id) {
      const [row] = await db.select({ name: apikey.name }).from(apikey).where(and(eq(apikey.id, id), eq(apikey.teamId, a.teamId))).limit(1).for("update");
      if (!row) missing();
      return row.name ?? "API key";
    },
    async delete(deps, a, id) { await deleteTeamApiKey(deps.db, a, a.teamId, id); return []; },
  },
  team: {
    async read(db, a, id) {
      if (id !== a.teamId) missing();
      const row = await getTeamInOrg(db, a.orgId, id);
      if (!row) missing();
      if (await isLiveIdpMirror(db, row)) throw new IdpManagedTeamError(row, "delete");
      if (row.origin === "config") throw new ConfigManagedTeamError(row.name);
      return row.name;
    },
    async delete(deps, a, id) { return deleteTeamResources(deps.db, a, id); },
  },
};
export function isDeletionResourceType(value: unknown): value is DeletionResourceType {
  return typeof value === "string" && Object.hasOwn(deletionResourceRegistry, value);
}
function requestScope(a: RequestActor) { return and(eq(teamDeletionRequests.orgId, a.orgId), eq(teamDeletionRequests.teamId, a.teamId)); }
export async function listDeletionRequests(db: AppDb, a: RequestActor) {
  if (!(await isOrgMember(db, a.orgId, a.userId)) || !(await getTeamInOrg(db, a.orgId, a.teamId)) || !(await canViewTeam(db, a.teamId, a.userId))) missing();
  const rows = await db.select({ request: teamDeletionRequests, requesterName: users.name }).from(teamDeletionRequests)
    .leftJoin(users, eq(users.id, teamDeletionRequests.requestedBy)).where(requestScope(a)).orderBy(desc(teamDeletionRequests.requestedAt)).limit(100);
  return Promise.all(rows.map(async ({ request, requesterName }) => ({ ...request,
    status: request.status === "pending" && request.expiresAt <= Date.now() ? "expired" as const : request.status,
    requesterName: requesterName ?? "Former member", requesterIsMember: await isTeamMember(db, a.teamId, request.requestedBy),
  })));
}
export async function submitDeletionRequest(db: AppDb, a: RequestActor, resourceType: DeletionResourceType, resourceId: string, reason?: string) {
  return db.transaction(async (tx) => {
    await lockTeamDeletionAccess(tx, a, a.teamId);
    const resourceLabel = await deletionResourceRegistry[resourceType].read(tx, a, resourceId);
    const now = Date.now();
    const target = and(requestScope(a), eq(teamDeletionRequests.resourceType, resourceType), eq(teamDeletionRequests.resourceId, resourceId), eq(teamDeletionRequests.status, "pending"));
    const expired = await tx.update(teamDeletionRequests).set({ status: "declined", decidedAt: now, decisionNote: "Expired. Open a new request if deletion is still needed." })
      .where(and(target, lte(teamDeletionRequests.expiresAt, now))).returning({ id: teamDeletionRequests.id });
    for (const row of expired) await markAttentionNotificationsRead(tx, "review", row.id);
    const [existing] = await tx.select().from(teamDeletionRequests).where(target).limit(1);
    if (existing) return { request: existing, created: false };
    const [request] = await tx.insert(teamDeletionRequests).values({ id: `dreq_${randomUUID()}`, orgId: a.orgId, teamId: a.teamId,
      resourceType, resourceId, resourceLabel, requestedBy: a.userId, reason, requestedAt: now, expiresAt: now + 14 * 86400000,
    }).returning();
    if (!request) throw new Error("Deletion request insert failed.");
    // Web only. Never invoke provider channel delivery from this flow.
    await routeAttention({ db: tx }, { kind: "review", owner: { type: "team", id: a.teamId }, dedupeKey: request.id,
      title: `Review deletion of ${resourceLabel}`, href: `/settings/organization/teams?teamId=${encodeURIComponent(a.teamId)}` });
    return { request, created: true };
  });
}
export async function decideDeletionRequest(deps: WorkflowServiceDeps, a: RequestActor, id: string, decision: "approve" | "decline" | "withdraw", note?: string) {
  return deps.db.transaction(async (tx) => {
    const admin = await lockTeamDeletionAccess(tx, a, a.teamId);
    const where = and(requestScope(a), eq(teamDeletionRequests.id, id));
    const [row] = await tx.select().from(teamDeletionRequests).where(where).for("update");
    if (!row) missing();
    if (decision === "withdraw" ? row.requestedBy !== a.userId : !admin) throw new DeletionRequestError("Ask a team admin to decide this request.", 403);
    if (row.status !== "pending") throw new DeletionRequestError("This request is already decided. Reload the request list.");
    if (row.expiresAt <= Date.now()) throw new DeletionRequestError("This deletion request expired. Open a new request if deletion is still needed.");
    let sessions: string[] = [];
    if (decision === "approve") {
      try {
        // A savepoint rolls back partial cascades while retaining the refusal on the request.
        sessions = await tx.transaction(async (inner) => {
          await deletionResourceRegistry[row.resourceType].read(inner, a, row.resourceId);
          return deletionResourceRegistry[row.resourceType].delete({ ...deps, db: inner }, a, row.resourceId);
        });
      } catch (err) {
        if (!(err instanceof Error)) throw err;
        // Only deliberate service refusals become user-visible request state.
        if (!(err instanceof DeletionRequestError || err instanceof RepoOwnedWorkflowError || err instanceof IdpManagedTeamError || err instanceof ConfigManagedTeamError || ("code" in err && typeof err.code === "string" && err.code === "team_has_active_runs"))) throw err;
        await tx.update(teamDeletionRequests).set({ lastRefusal: err.message }).where(where);
        return { refusal: err.message, sessions: [], resourceType: row.resourceType };
      }
    }
    await tx.update(teamDeletionRequests).set({ status: decision === "approve" ? "approved" : decision === "decline" ? "declined" : "withdrawn",
      decidedBy: a.userId, decidedAt: Date.now(), decisionNote: note, lastRefusal: null }).where(where);
    await markAttentionNotificationsRead(tx, "review", row.id);
    return { sessions, resourceType: row.resourceType };
  });
}

/** Safe labels only; the request form never reads credential or key material. */
export async function listDeletionTargets(db: AppDb, a: RequestActor) {
  const team = await getTeamInOrg(db, a.orgId, a.teamId);
  if (!team || !(await isOrgMember(db, a.orgId, a.userId)) || !(await canViewTeam(db, a.teamId, a.userId))) missing();
  const targets: { resourceType: DeletionResourceType; resourceId: string; label: string }[] = [];
  const workflows = await db.select({ id: workflowDefinitions.id, name: workflowDefinitions.name }).from(workflowDefinitions).where(and(eq(workflowDefinitions.orgId, a.orgId), eq(workflowDefinitions.ownerType, "team"), eq(workflowDefinitions.ownerId, a.teamId), eq(workflowDefinitions.origin, "local"))).limit(200);
  targets.push(...workflows.map((r) => ({ resourceType: "workflow" as const, resourceId: r.id, label: r.name })));
  const storedSkills = await db.select({ id: skills.id, name: skills.name }).from(skills).where(and(eq(skills.orgId, a.orgId), eq(skills.ownerType, "team"), eq(skills.ownerId, a.teamId), eq(skills.origin, "local"))).limit(200);
  targets.push(...storedSkills.map((r) => ({ resourceType: "skill" as const, resourceId: r.id, label: r.name })));
  const sources = await db.select({ id: contentSources.id, name: contentSources.repoFullName }).from(contentSources).where(and(eq(contentSources.orgId, a.orgId), eq(contentSources.ownerType, "team"), eq(contentSources.ownerId, a.teamId))).limit(200);
  targets.push(...sources.map((r) => ({ resourceType: "content_source" as const, resourceId: r.id, label: r.name })));
  const creds = await db.select({ service: credentials.service }).from(credentials).where(and(eq(credentials.ownerType, "team"), eq(credentials.ownerId, a.teamId))).limit(200);
  targets.push(...creds.filter((r) => r.service !== "onepassword").map((r) => ({ resourceType: "credential" as const, resourceId: r.service, label: r.service })));
  const keys = await db.select({ id: apikey.id, name: apikey.name }).from(apikey).where(eq(apikey.teamId, a.teamId)).limit(200);
  targets.push(...keys.map((r) => ({ resourceType: "api_key" as const, resourceId: r.id, label: r.name ?? "API key" })));
  if (team.origin !== "config" && !(await isLiveIdpMirror(db, team))) targets.push({ resourceType: "team", resourceId: team.id, label: team.name });
  return targets;
}
