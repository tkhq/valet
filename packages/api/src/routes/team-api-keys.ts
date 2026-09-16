import { deleteTeamApiKey } from "../services/team-resource-deletion.js";
/**
 * Team-scoped `vlt_` keys (TKAI-396). Create, list, and revoke live on
 * `/api/teams/:id/api-keys`. The better-auth `apikey` table stays; `{ teamId,
 * createdBy }` go in metadata, and the same team id lands in the indexed
 * `team_id` column. The auth ladder reads the metadata (it is what
 * `verifyApiKey` returns); the list and revoke paths read the column. One
 * UPDATE writes both, and create re-reads both before it returns the
 * secret, so the two cannot disagree on a row this route made. Revoke is
 * a row delete so a later team admin can kill a key the creating admin no
 * longer owns.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import type { AppQueryable } from "../lib/drizzle.js";
import { requireActingUser } from "../middleware/auth.js";
import { apikey } from "../schema/index.js";
import { canAdministerTeam, getTeamInOrg, isTeamMember, lockTeamForOwnership } from "../services/teams.js";
import { TEAM_ADMIN_REQUIRED_CODE } from "../services/team-deletion-access.js";
import { isOrgAdmin } from "../services/org.js";
import { parseApiKeyMetadata, teamIdFromApiKeyMetadata } from "../lib/request-principal.js";
import type { CreateTeamApiKeyResponse, ListTeamApiKeysResponse, TeamApiKeySummary } from "../wire/types.js";

export const teamApiKeysRouter = new Hono<AppEnv>();

const TEAM_KEY_AUTH_REQUIRED =
  "Team API keys need a signed-in session. Sign in and open the team workspace.";

/**
 * Refusal copy for a team member who is not an admin. The member already
 * knows the team exists, so the answer names the rule and the two actions
 * that get them a key. A caller who cannot see the team at all keeps the
 * 404 that hides it.
 */
export const TEAM_KEY_ADMIN_REQUIRED =
  "Only a team admin or an organization admin can create a key for this team. " +
  "Ask an admin of this team to create the key. " +
  "To create your own key, set the workspace switcher to Personal.";

/**
 * The refusal body for that member. It carries the shared
 * `team_admin_required` code, the same discriminator the delete path on this
 * resource sends, so one client branch answers both. It carries no
 * `requestId`: a deletion request has no create counterpart.
 */
function adminRequiredBody(teamId: string) {
  return { error: TEAM_KEY_ADMIN_REQUIRED, code: TEAM_ADMIN_REQUIRED_CODE, teamId };
}

/** What the caller may do with team keys on this team. */
type TeamKeyCreateAccess = "allowed" | "member-only" | "hidden";

/**
 * One definition of the create gate, used by the first check and by the
 * re-check inside the ownership lock, so the two cannot drift.
 */
async function teamKeyCreateAccess(
  db: AppQueryable,
  orgId: string,
  teamId: string,
  userId: string,
): Promise<TeamKeyCreateAccess> {
  const team = await getTeamInOrg(db, orgId, teamId);
  if (!team) return "hidden";
  if (await canAdministerTeam(db, teamId, userId)) return "allowed";
  return (await isTeamMember(db, teamId, userId)) ? "member-only" : "hidden";
}

async function canViewTeamKeys(
  db: AppEnv["Variables"]["providers"]["db"],
  teamId: string,
  userId: string,
  orgId: string,
): Promise<boolean> {
  if (await isOrgAdmin(db, orgId, userId)) return true;
  return isTeamMember(db, teamId, userId);
}

function createdByFromMetadata(metadata: Record<string, unknown> | null): string | null {
  const raw = metadata?.createdBy;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** The summary columns, and nothing else: the hash never leaves the table. */
const SUMMARY_COLUMNS = {
  id: apikey.id,
  name: apikey.name,
  start: apikey.start,
  createdAt: apikey.createdAt,
  lastRequest: apikey.lastRequest,
  metadata: apikey.metadata,
};

type SummaryRow = {
  id: string;
  name: string | null;
  start: string | null;
  createdAt: Date;
  lastRequest: Date | null;
  metadata: string | null;
};

function toSummary(row: SummaryRow): TeamApiKeySummary {
  const metadata = parseApiKeyMetadata(row.metadata);
  return {
    id: row.id,
    name: row.name,
    start: row.start,
    createdAt: row.createdAt.getTime(),
    lastRequest: row.lastRequest ? row.lastRequest.getTime() : null,
    createdBy: createdByFromMetadata(metadata),
  };
}

teamApiKeysRouter.get("/:id/api-keys", async (c) => {
  const user = requireActingUser(c);
  if (!user) return c.json({ error: TEAM_KEY_AUTH_REQUIRED }, 403);
  const { db } = c.var.providers;
  const teamId = c.req.param("id");
  const team = await getTeamInOrg(db, user.orgId, teamId);
  if (!team || !(await canViewTeamKeys(db, teamId, user.id, user.orgId))) {
    return c.json({ error: "team not found" }, 404);
  }

  const rows = await db.select(SUMMARY_COLUMNS).from(apikey).where(eq(apikey.teamId, teamId));
  const body: ListTeamApiKeysResponse = { keys: rows.map(toSummary) };
  return c.json(body);
});

teamApiKeysRouter.post("/:id/api-keys", async (c) => {
  const user = requireActingUser(c);
  if (!user) return c.json({ error: TEAM_KEY_AUTH_REQUIRED }, 403);
  const auth = c.var.auth;
  if (!auth) {
    return c.json(
      { error: "Team API keys need real auth. Set BETTER_AUTH_SECRET and sign in." },
      503,
    );
  }
  const { db } = c.var.providers;
  const teamId = c.req.param("id");
  const access = await teamKeyCreateAccess(db, user.orgId, teamId, user.id);
  if (access === "hidden") return c.json({ error: "team not found" }, 404);
  if (access === "member-only") return c.json(adminRequiredBody(teamId), 403);

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const name = raw && typeof raw === "object" && !Array.isArray(raw) && "name" in raw ? raw.name : undefined;
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return c.json({ error: "name is required. Send a non-empty key name." }, 400);
  }

  // No metadata on the plugin call: better-auth treats that field as
  // client-writable. The SQL stamp below is the only writer of the team
  // pin, in both places at once.
  const created = await auth.api.createApiKey({
    body: { name: name.trim() },
    headers: c.req.raw.headers,
  });
  if (!created?.key) {
    return c.json({ error: "Couldn't create the API key. Sign in again and retry." }, 500);
  }
  let pinResult: "pinned" | "not-found" | "forbidden" | "failed" = "failed";
  try {
    pinResult = await db.transaction(async (tx) => {
      // Serialize the final pin with deleteTeam. All reads use tx: an outer
      // database call here would deadlock PGlite's single writer.
      await lockTeamForOwnership(tx, teamId);
      // A demotion that lands between the first check and the lock gets the
      // same answer the first check gives, so the caller reads one rule.
      const current = await teamKeyCreateAccess(tx, user.orgId, teamId, user.id);
      if (current === "hidden") return "not-found";
      if (current === "member-only") return "forbidden";

      const pin = JSON.stringify({ teamId, createdBy: user.id });
      await tx.update(apikey).set({ metadata: pin, teamId }).where(eq(apikey.id, created.id));
      const stamped = await tx
        .select({ metadata: apikey.metadata, teamId: apikey.teamId })
        .from(apikey)
        .where(eq(apikey.id, created.id))
        .limit(1);
      return stamped[0]?.teamId === teamId &&
        teamIdFromApiKeyMetadata(parseApiKeyMetadata(stamped[0].metadata)) === teamId
        ? "pinned"
        : "failed";
    });
  } finally {
    // better-auth minted outside this transaction. Clean up only after the
    // transaction settles, including when a write or commit throws.
    if (pinResult !== "pinned") {
      await db.delete(apikey).where(eq(apikey.id, created.id));
    }
  }
  if (pinResult === "not-found") return c.json({ error: "team not found" }, 404);
  if (pinResult === "forbidden") return c.json(adminRequiredBody(teamId), 403);
  if (pinResult === "failed") {
    return c.json({ error: "Couldn't pin the API key to this team. Retry the create." }, 500);
  }

  const resp: CreateTeamApiKeyResponse = {
    id: created.id,
    name: created.name,
    start: created.start,
    createdAt: created.createdAt.getTime(),
    key: created.key,
    createdBy: user.id,
  };
  return c.json(resp, 201);
});

teamApiKeysRouter.delete("/:id/api-keys/:keyId", async (c) => {
  const user = requireActingUser(c);
  if (!user) return c.json({ error: TEAM_KEY_AUTH_REQUIRED }, 403);
  const { db } = c.var.providers;
  const teamId = c.req.param("id");
  const keyId = c.req.param("keyId");
  await deleteTeamApiKey(db, { orgId: user.orgId, userId: user.id }, teamId, keyId);
  return c.json({ ok: true as const });
});
