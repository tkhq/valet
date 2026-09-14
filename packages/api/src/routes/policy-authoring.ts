import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import type { AppTx } from "../lib/drizzle.js";
import { requireActingUser } from "../middleware/auth.js";
import { isOrgAdmin } from "../services/org.js";
import { canViewTeam, getTeamInOrg } from "../services/teams.js";
import { lockTeamDeletionAccess } from "../services/team-deletion-access.js";
import { PolicyAuthoringError, PolicyAuthoringService, type PolicyAuthoringAuthorizer } from "../authorization/builder/service.js";
import type { PolicyAuthoringScope } from "../authorization/builder/types.js";
import { CanonicalPolicyConfigManagedError, CanonicalPolicySourceReadOnlyError } from "../authorization/canonical-policy-manager.js";

export const policyAuthoringRouter = new Hono<AppEnv>();
const MAX_BODY = 256 * 1024;
const authorizer: PolicyAuthoringAuthorizer = {
  async authorize(operation, actorId, scope, db) {
    if (!scope.teamId) return isOrgAdmin(db, scope.organizationId, actorId);
    if (!(await getTeamInOrg(db, scope.organizationId, scope.teamId))) return "not_found";
    if (!(await canViewTeam(db, scope.teamId, actorId))) return "not_found";
    if (operation === "view") return true;
    // Mutation calls authorize from inside PolicyAuthoringService's transaction.
    return Boolean(await lockTeamDeletionAccess(db as AppTx, { orgId: scope.organizationId, userId: actorId }, scope.teamId));
  },
};

type RouteContext = Context<AppEnv>;
function session(c: RouteContext) {
  const user = requireActingUser(c);
  if (!user) throw new PolicyAuthoringError("forbidden", "Sign in as a policy administrator.", 403);
  const teamId = c.req.param("teamId");
  return {
    actor: user.id,
    scope: {
      organizationId: user.orgId,
      ...(teamId ? { teamId } : {}),
    } satisfies PolicyAuthoringScope,
    service: new PolicyAuthoringService({ db: c.var.providers.db, authorizer, canonicalPolicyManager: c.var.providers.canonicalPolicyManager }),
  };
}
async function body(c: RouteContext): Promise<unknown> {
  const length = Number(c.req.header("content-length") ?? 0);
  if (length > MAX_BODY) throw new PolicyAuthoringError("invalid", "Reduce the request body to 256 KiB or less.", 400);
  const text = await c.req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY) throw new PolicyAuthoringError("invalid", "Reduce the request body to 256 KiB or less.", 400);
  try {
    return JSON.parse(text);
  } catch {
    throw new PolicyAuthoringError("invalid", "Send a valid JSON request body.", 400);
  }
}
function ints(c: RouteContext, ...names: string[]) {
  return names.map((name) => {
    const value = Number(c.req.query(name));
    if (!Number.isSafeInteger(value) || value < 1) throw new PolicyAuthoringError("invalid", `Set ${name} to a positive integer.`, 400);
    return value;
  });
}
function routes(prefix: "/org/policy-drafts" | "/teams/:teamId/policy-drafts") {
  policyAuthoringRouter.get(prefix, async (c) => {
    const s = session(c);
    const limit = c.req.query("limit") === undefined ? undefined : Number(c.req.query("limit"));
    return c.json(await s.service.list(s.actor, s.scope, c.req.query("cursor"), limit));
  });
  policyAuthoringRouter.get(`${prefix}/:documentId`, async (c) => {
    const s = session(c);
    return c.json(await s.service.get(s.actor, s.scope, c.req.param("documentId")));
  });
  policyAuthoringRouter.post(prefix, async (c) => {
    const s = session(c);
    return c.json(await s.service.create(s.actor, s.scope, (await body(c)) as never), 201);
  });
  policyAuthoringRouter.patch(`${prefix}/:documentId`, async (c) => {
    const s = session(c);
    return c.json(await s.service.edit(s.actor, s.scope, c.req.param("documentId"), (await body(c)) as never));
  });
  policyAuthoringRouter.post(`${prefix}/:documentId/submit-review`, async (c) => {
    const s = session(c);
    return c.json(await s.service.submit(s.actor, s.scope, c.req.param("documentId"), (await body(c)) as never));
  });
  policyAuthoringRouter.post(`${prefix}/:documentId/reviews`, async (c) => {
    const s = session(c);
    return c.json(await s.service.review(s.actor, s.scope, c.req.param("documentId"), (await body(c)) as never));
  });
  policyAuthoringRouter.post(`${prefix}/:documentId/restore/:revision`, async (c) => {
    const s = session(c),
      revision = Number(c.req.param("revision"));
    if (!Number.isSafeInteger(revision) || revision < 1) throw new PolicyAuthoringError("invalid", "Select a valid revision to restore.", 400);
    return c.json(await s.service.restore(s.actor, s.scope, c.req.param("documentId"), revision, (await body(c)) as never));
  });
  policyAuthoringRouter.post(`${prefix}/preview`, async (c) => {
    const s = session(c);
    return c.json(await s.service.preview(s.actor, s.scope, (await body(c)) as never));
  });
  policyAuthoringRouter.get(`${prefix}/:documentId/diff`, async (c) => {
    const s = session(c),
      [from, to] = ints(c, "from", "to");
    return c.json(await s.service.diff(s.actor, s.scope, c.req.param("documentId"), from, to));
  });
  policyAuthoringRouter.post(`${prefix}/:documentId/prepare-publication`, async (c) => {
    const s = session(c),
      raw = await body(c);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((k) => !["schemaVersion", "expectedRevision", "expectedStateVersion"].includes(k)))
      throw new PolicyAuthoringError("invalid", "Send only the expected revision and state version.", 400);
    const value = raw as Record<string, unknown>;
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.expectedRevision) || !Number.isSafeInteger(value.expectedStateVersion))
      throw new PolicyAuthoringError("invalid", "Send version 1 and integer expected versions.", 400);
    return c.json(
      await s.service.prepare(s.actor, s.scope, c.req.param("documentId"), {
        expectedRevision: Number(value.expectedRevision),
        expectedStateVersion: Number(value.expectedStateVersion),
      }),
    );
  });
}
policyAuthoringRouter.onError((error, c) => {
  if (error instanceof PolicyAuthoringError || error instanceof CanonicalPolicyConfigManagedError || error instanceof CanonicalPolicySourceReadOnlyError)
    return c.json({ error: error.message, code: error.code }, error.statusCode);
  console.error(`policy authoring route failed: ${c.req.method} ${c.req.path}`);
  return c.json({ error: "Policy authoring failed. Retry the request. If it fails again, contact support.", code: "internal" }, 500);
});

routes("/org/policy-drafts");
routes("/teams/:teamId/policy-drafts");
