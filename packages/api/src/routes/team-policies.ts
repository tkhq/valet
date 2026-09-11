import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { requireActingUser } from "../middleware/auth.js";
import { canViewTeam, getTeamInOrg } from "../services/teams.js";
import { validateOverrideBounds, upsertSimpleTeamPolicy, listTeamGrants, revokeTeamGrant, createPolicy, updatePolicy, revokePolicy, listPolicies, type UpdateOrgPolicyInput, isApprovalMode, isRiskLevel, validateTarget } from "../policies/admin.js";
import { validateParamMatchers } from "../policies/matchers.js";
import { lockTeamDeletionAccess } from "../services/team-deletion-access.js";
import { toGrantWire } from "./me-policies.js";
import { toPolicyWire } from "./policies.js";

export const teamPoliciesRouter = new Hono<AppEnv>();
const NOT_FOUND = { error: "Team or policy not found. Open a team you belong to." };

function parsePolicyFields(raw: unknown): Omit<UpdateOrgPolicyInput, "now"> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Send a policy as a JSON object.");
  const mode = "mode" in raw ? raw.mode : undefined;
  const appliesIn = "appliesIn" in raw ? raw.appliesIn : undefined;
  const expiresAt = "expiresAt" in raw ? raw.expiresAt : undefined;
  if (mode !== undefined && !isApprovalMode(mode)) throw new Error("Choose allow, require_approval, or deny.");
  if (appliesIn !== undefined && appliesIn !== "any" && appliesIn !== "session" && appliesIn !== "workflow") throw new Error("Choose any, session, or workflow for appliesIn.");
  if (expiresAt !== undefined && expiresAt !== null && (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt))) throw new Error("Set expiresAt to an epoch-millisecond integer or null.");
  const paramMatchers = "paramMatchers" in raw ? validateParamMatchers(raw.paramMatchers) : undefined;
  return { mode, appliesIn, expiresAt, paramMatchers };
}

function parseTarget(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Send a policy as a JSON object.");
  const service = "service" in raw ? raw.service : undefined;
  const actionId = "actionId" in raw ? raw.actionId : undefined;
  const riskLevel = "riskLevel" in raw ? raw.riskLevel : undefined;
  if (service !== undefined && (typeof service !== "string" || !service.trim())) throw new Error("Enter a service name.");
  if (actionId !== undefined && (typeof actionId !== "string" || !actionId.trim())) throw new Error("Enter an action name.");
  if (riskLevel !== undefined && !isRiskLevel(riskLevel)) throw new Error("Choose low, medium, high, or critical risk.");
  const target = { service, actionId, riskLevel };
  const check = validateTarget(target);
  if (!check.ok) throw new Error(check.error);
  return target;
}

teamPoliciesRouter.get("/:id/policies", async (c) => {
  const user = requireActingUser(c);
  if (!user) return c.json({ error: "Sign in to view team policies." }, 403);
  const { db } = c.var.providers;
  const id = c.req.param("id");
  if (!(await getTeamInOrg(db, user.orgId, id)) || !(await canViewTeam(db, id, user.id))) return c.json(NOT_FOUND, 404);
  const rows = await listPolicies(db, { orgId: user.orgId, type: "team", id });
  return c.json({ policies: rows.map(toPolicyWire) });
});

teamPoliciesRouter.on(["POST", "PATCH", "DELETE"], ["/:id/policies", "/:id/policies/:policyId"], async (c) => {
  const user = requireActingUser(c);
  if (!user) return c.json({ error: "Sign in as a team admin to manage policies." }, 403);
  const { db } = c.var.providers;
  const id = c.req.param("id");
  const policyId = c.req.param("policyId");
  const method = c.req.method;
  if ((method === "POST") === (policyId !== undefined)) return c.json(NOT_FOUND, 404);
  // Serialize creation with team deletion, and check roles inside the write.
  return db.transaction(async (tx) => {
    if (!(await lockTeamDeletionAccess(tx, { orgId: user.orgId, userId: user.id }, id))) return c.json({ error: "Ask a team admin to change action policies." }, 403);
    const scope = { orgId: user.orgId, type: "team" as const, id };
    if (method === "DELETE" && policyId) {
      const row = await revokePolicy(tx, scope, policyId, Date.now());
      return row ? c.json(toPolicyWire(row)) : c.json(NOT_FOUND, 404);
    }
    let fields: ReturnType<typeof parsePolicyFields>;
    let target: ReturnType<typeof parseTarget> | undefined;
    try {
      const raw: unknown = await c.req.json();
      fields = parsePolicyFields(raw);
      if (method === "POST") target = parseTarget(raw);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Send a valid policy JSON object." }, 400);
    }
    if (method === "POST" && target) {
      if (!fields.mode) return c.json({ error: "Choose allow, require_approval, or deny." }, 400);
      const row = await createPolicy(tx, scope, { ...target, ...fields, mode: fields.mode, managedBy: user.id, now: Date.now() });
      return c.json(toPolicyWire(row), 201);
    }
    if (!policyId) return c.json(NOT_FOUND, 404);
    const row = await updatePolicy(tx, scope, policyId, { ...fields, now: Date.now() });
    return row ? c.json(toPolicyWire(row)) : c.json(NOT_FOUND, 404);
  });
});

teamPoliciesRouter.get("/:id/grants", async (c) => {
  const user = requireActingUser(c);
  if (!user) return c.json({ error: "Sign in to view team grants." }, 403);
  const { db } = c.var.providers;
  const id = c.req.param("id");
  if (!(await getTeamInOrg(db, user.orgId, id)) || !(await canViewTeam(db, id, user.id))) return c.json(NOT_FOUND, 404);
  return c.json({ grants: (await listTeamGrants(db, user.orgId, id)).map(toGrantWire) });
});

teamPoliciesRouter.on(["PUT", "DELETE"], ["/:id/policy-overrides", "/:id/grants/:grantId"], async (c) => {
  const user = requireActingUser(c);
  if (!user) return c.json({ error: "Sign in as a team admin." }, 403);
  const id = c.req.param("id");
  const grantId = c.req.param("grantId");
  if ((c.req.method === "DELETE") !== (grantId !== undefined)) return c.json(NOT_FOUND, 404);
  return c.var.providers.db.transaction(async (tx) => {
    // Shared authority lock protects against role revocation and team deletion.
    if (!(await lockTeamDeletionAccess(tx, { orgId: user.orgId, userId: user.id }, id))) return c.json({ error: "Ask a team admin to change policies or grants." }, 403);
    if (grantId) {
      return await revokeTeamGrant(tx, user.orgId, id, grantId, Date.now()) ? c.json({ ok: true }) : c.json(NOT_FOUND, 404);
    }
    let target: ReturnType<typeof parseTarget>;
    let fields: ReturnType<typeof parsePolicyFields>;
    try {
      const raw: unknown = await c.req.json();
      target = parseTarget(raw);
      fields = parsePolicyFields(raw);
      if (!fields.mode || (fields.appliesIn !== undefined && fields.appliesIn !== "any") || fields.expiresAt != null || (fields.paramMatchers?.length ?? 0) > 0) {
        return c.json({ error: "Choose a mode for a simple, unconditional override." }, 400);
      }
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Send a valid override." }, 400);
    }
    if (!fields.mode) return c.json({ error: "Choose a mode." }, 400);
    const bounds = await validateOverrideBounds(tx, user.orgId, target, fields.mode, Date.now(), c.var.providers.actionPluginByService);
    if (!bounds.ok) return c.json({ error: bounds.error }, 400);
    const row = await upsertSimpleTeamPolicy(tx, { orgId: user.orgId, type: "team", id }, { ...target, mode: fields.mode, managedBy: user.id, now: Date.now() });
    return row ? c.json(toPolicyWire(row)) : c.json(NOT_FOUND, 404);
  });
});
