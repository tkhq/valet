/**
 * `/api/org` — settings-shell org surface (split-settings design).
 *
 *   GET   /api/org                   → org member: id/name/createdAt/features/callerRole
 *   PATCH /api/org                   → org admin: rename and/or flip features.organizations
 *   GET   /api/org/members           → org admin + gate on: member roster
 *   PATCH /api/org/members/:userId   → org admin + gate on: set a member's role
 *
 * `PATCH /api/org` is deliberately reachable regardless of the gate's own
 * state — it's the toggle for the gate. Every other org route 404s with
 * `{error:"organizations not enabled"}` when the gate is off, admin or not
 * (spec: "the gate toggle must always be reachable by admins").
 */
import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { orgs } from "../schema/index.js";
import {
  getOrgFeatures,
  isOrgAdmin,
  listOrgMembers,
  renameOrg,
  setOrgFeatures,
  setOrgMemberRole,
  type OrgFeatures,
  type OrgRole,
} from "../services/org.js";
import type {
  OrgMembersResponse,
  OrgResponse,
  PatchOrgMemberRequest,
  PatchOrgMemberResponse,
  PatchOrgResponse,
} from "../wire/types.js";

export const orgRouter = new Hono<AppEnv>();

const GATE_OFF_ERROR = { error: "organizations not enabled" } as const;

function isOrgRole(v: unknown): v is OrgRole {
  return v === "admin" || v === "member";
}

async function loadOrgResponse(db: AppDb, orgId: string, callerRole: OrgRole): Promise<OrgResponse | undefined> {
  const row = await db.select().from(orgs).where(eq(orgs.id, orgId)).get();
  if (!row) return undefined;
  const features = await getOrgFeatures(db, orgId);
  return { id: row.id, name: row.name, createdAt: row.createdAt, features, callerRole };
}

/** Org-admin gate applied to every route below GET /api/org. */
async function requireOrgAdmin(c: Context<AppEnv>) {
  const { db } = c.var.providers;
  const user = c.var.user;
  if (!(await isOrgAdmin(db, user.orgId, user.id))) {
    return c.json({ error: "org admin required" }, 403);
  }
  return undefined;
}

// ── GET /api/org — any org member ────────────────────────────────────────

orgRouter.get("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const admin = await isOrgAdmin(db, user.orgId, user.id);
  const body = await loadOrgResponse(db, user.orgId, admin ? "admin" : "member");
  if (!body) return c.json({ error: "org not found" }, 404);
  return c.json(body);
});

// ── PATCH /api/org — org admin only, always reachable ───────────────────

orgRouter.patch("/", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const user = c.var.user;

  let raw: Record<string, unknown>;
  try {
    raw = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const allowed = new Set(["name", "features"]);
  const unknownFields = Object.keys(raw).filter((k) => !allowed.has(k));
  if (unknownFields.length > 0) {
    return c.json({ error: `unknown field(s): ${unknownFields.join(", ")}` }, 400);
  }

  if ("name" in raw) {
    if (typeof raw.name !== "string") {
      return c.json({ error: "name must be a string" }, 400);
    }
    await renameOrg(db, user.orgId, raw.name);
  }

  if ("features" in raw) {
    const features = raw.features;
    if (typeof features !== "object" || features === null || Array.isArray(features)) {
      return c.json({ error: "features must be an object" }, 400);
    }
    const featuresRecord = features as Record<string, unknown>;
    const featureFields = new Set(["organizations"]);
    const unknownFeatureFields = Object.keys(featuresRecord).filter((k) => !featureFields.has(k));
    if (unknownFeatureFields.length > 0) {
      return c.json({ error: `unknown feature(s): ${unknownFeatureFields.join(", ")}` }, 400);
    }
    const update: Partial<OrgFeatures> = {};
    if ("organizations" in featuresRecord) {
      if (typeof featuresRecord.organizations !== "boolean") {
        return c.json({ error: "features.organizations must be a boolean" }, 400);
      }
      update.organizations = featuresRecord.organizations;
    }
    // `setOrgFeatures` merges into the existing TYPED features object rather
    // than clobbering unknown keys — see services/org.ts.
    await setOrgFeatures(db, user.orgId, update);
  }

  const body = await loadOrgResponse(db, user.orgId, "admin");
  if (!body) return c.json({ error: "org not found" }, 404);
  const resp: PatchOrgResponse = body;
  return c.json(resp);
});

// ── Members: gate = org admin AND organizations feature on ──────────────

async function requireOrgAdminAndGate(c: Context<AppEnv>) {
  const { db } = c.var.providers;
  const user = c.var.user;

  const features = await getOrgFeatures(db, user.orgId);
  if (!features.organizations) {
    return c.json(GATE_OFF_ERROR, 404);
  }
  if (!(await isOrgAdmin(db, user.orgId, user.id))) {
    return c.json({ error: "org admin required" }, 403);
  }
  return undefined;
}

orgRouter.get("/members", async (c) => {
  const forbidden = await requireOrgAdminAndGate(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const user = c.var.user;
  const members = await listOrgMembers(db, user.orgId);
  const body: OrgMembersResponse = { members };
  return c.json(body);
});

orgRouter.patch("/members/:userId", async (c) => {
  const forbidden = await requireOrgAdminAndGate(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const user = c.var.user;
  const targetUserId = c.req.param("userId");

  let body: PatchOrgMemberRequest;
  try {
    body = (await c.req.json()) as PatchOrgMemberRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!isOrgRole(body.role)) {
    return c.json({ error: "role must be 'admin' or 'member'" }, 400);
  }

  const result = await setOrgMemberRole(db, user.orgId, targetUserId, body.role);
  if (!result.ok) {
    return c.json({ error: result.error }, result.reason === "not_found" ? 404 : 400);
  }

  const resp: PatchOrgMemberResponse = { ok: true };
  return c.json(resp);
});

export type OrgRouter = typeof orgRouter;
