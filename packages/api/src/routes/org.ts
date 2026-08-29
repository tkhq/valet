/**
 * `/api/org` — settings-shell org surface (split-settings design).
 *
 *   GET   /api/org                   → org member: id/name/createdAt/features/callerRole
 *   PATCH /api/org                   → org admin: rename and/or flip features.organizations
 *   GET   /api/org/directory         → org member + gate on: display identity of every
 *                                      member (no role, no join date) — the teams UI's
 *                                      roster names and add-member picker
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
import { ValidationError } from "@valet/shared";
import {
  getOrgFeatures,
  getSsoTeamGroups,
  isOrgAdmin,
  isOrgMember,
  listOrgDirectory,
  listOrgMembers,
  normalizeSsoTeamGroups,
  renameOrg,
  setOrgFeatures,
  setOrgMemberRole,
  setSsoTeamGroups,
  type OrgFeatures,
  type OrgRole,
} from "../services/org.js";
import {
  getPluginEntitlement,
  orgAllowsPluginForUser,
  setPluginEntitlement,
} from "../services/plugin-entitlements.js";
import type { EngineHost } from "../engine/host.js";
import type { PluginEntitlementMode } from "@valet/shared";
import type {
  OrgDirectoryResponse,
  OrgMembersResponse,
  OrgPluginsResponse,
  OrgPluginWire,
  OrgResponse,
  PatchOrgMemberRequest,
  PatchOrgMemberResponse,
  PatchOrgPluginRequest,
  PatchOrgPluginResponse,
  PatchOrgResponse,
} from "../wire/types.js";

export const orgRouter = new Hono<AppEnv>();

const GATE_OFF_ERROR = { error: "organizations not enabled" } as const;

function isOrgRole(v: unknown): v is OrgRole {
  return v === "admin" || v === "member";
}

/**
 * The gateable-plugin block for the org surfaces (plugin-entitlements design).
 * One entry per loaded plugin that declares a `gate`: the deployment switch,
 * this org's entitlement, and whether the mode admits THIS caller. Shared by
 * `GET /api/org` and `GET /api/org/plugins`, so the two never drift.
 */
async function buildOrgPlugins(
  db: AppDb,
  engineHost: EngineHost,
  orgId: string,
  callerId: string,
): Promise<OrgPluginWire[]> {
  const gateable = engineHost.gateablePlugins();
  return Promise.all(
    gateable.map(async (plugin) => {
      const instanceEnabled = engineHost.isPluginLoaded(plugin.name);
      const entitlement = await getPluginEntitlement(db, orgId, plugin.name);
      const enabledForCaller =
        instanceEnabled && (await orgAllowsPluginForUser(db, orgId, callerId, plugin.name));
      return {
        name: plugin.name,
        label: plugin.label,
        description: plugin.description,
        instanceEnabled,
        entitlement,
        enabledForCaller,
      };
    }),
  );
}

async function loadOrgResponse(
  db: AppDb,
  engineHost: EngineHost,
  orgId: string,
  callerId: string,
  callerRole: OrgRole,
): Promise<OrgResponse | undefined> {
  const rows = await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1);
  const row = rows[0];
  if (!row) return undefined;
  const features = await getOrgFeatures(db, orgId);
  // Never-set (NULL) flattens to `[]` on the wire: both mirror nothing, so
  // the client needs no null case.
  const ssoTeamGroups = (await getSsoTeamGroups(db, orgId)) ?? [];
  const plugins = await buildOrgPlugins(db, engineHost, orgId, callerId);
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    features,
    ssoTeamGroups,
    allowPublicArtifacts: row.allowPublicArtifacts,
    plugins,
    callerRole,
  };
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
  const { db, engineHost } = c.var.providers;
  const user = c.var.user;
  const admin = await isOrgAdmin(db, user.orgId, user.id);
  const body = await loadOrgResponse(db, engineHost, user.orgId, user.id, admin ? "admin" : "member");
  if (!body) return c.json({ error: "org not found" }, 404);
  return c.json(body);
});

// ── PATCH /api/org — org admin only, always reachable ───────────────────

orgRouter.patch("/", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db, engineHost } = c.var.providers;
  const user = c.var.user;

  let raw: Record<string, unknown>;
  try {
    raw = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const allowed = new Set(["name", "features", "ssoTeamGroups"]);
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
    const featureFields = new Set(["organizations", "ssoTeamSync"]);
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
    if ("ssoTeamSync" in featuresRecord) {
      if (typeof featuresRecord.ssoTeamSync !== "boolean") {
        return c.json({ error: "features.ssoTeamSync must be a boolean" }, 400);
      }
      // Either direction takes effect at the next single-sign-on login, with
      // no restart: the claim names are read at boot, but the write path
      // reads this gate on each login (`auth/provisioning.ts`).
      //
      // It lasts only while `valet.yaml` does not declare the same key. The
      // boot reconciler merges the file's `org.features` over this column at
      // every start, so on a deployment that declares it the file wins and
      // this write survives until the next restart. The reconciler prints
      // one line naming the file when it changes a value
      // (`services/config-reconcile.ts`).
      update.ssoTeamSync = featuresRecord.ssoTeamSync;
    }
    // `setOrgFeatures` merges into the raw jsonb, so a key this build does
    // not name — one `valet.yaml` declared — survives this write. See
    // services/org.ts.
    await setOrgFeatures(db, user.orgId, update);
  }

  if ("ssoTeamGroups" in raw) {
    try {
      // Replaces the whole list, normalized (`normalizeSsoTeamGroups` is
      // the shape guard — a bad entry 400s with the corrective message).
      // Same file-wins caveat as the features above: a `valet.yaml` that
      // declares auth.sso.teams.groups overwrites this write at the next
      // restart, and the reconciler prints one line naming the file.
      await setSsoTeamGroups(db, user.orgId, normalizeSsoTeamGroups(raw.ssoTeamGroups));
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
  }

  const body = await loadOrgResponse(db, engineHost, user.orgId, user.id, "admin");
  if (!body) return c.json({ error: "org not found" }, 404);
  const resp: PatchOrgResponse = body;
  return c.json(resp);
});

// ── Directory: gate on, any org member ──────────────────────────────────

/** Gate-only guard for member-visible org routes. */
async function requireGate(c: Context<AppEnv>) {
  const { db } = c.var.providers;
  const user = c.var.user;

  const features = await getOrgFeatures(db, user.orgId);
  if (!features.organizations) {
    return c.json(GATE_OFF_ERROR, 404);
  }
  return undefined;
}

// Any org member: a team admin who is not an org admin needs names and
// emails to run their team's roster and add-member picker. The full roster
// (`GET /members` below) stays admin-only — it carries the org role.
//
// The membership check is load-bearing, not ceremony: `AuthUser.orgId` is
// resolved for every authenticated session (`resolveOrgId`), with no
// `org_members` row required, so without this check any session could
// enumerate every member's email.
orgRouter.get("/directory", async (c) => {
  const forbidden = await requireGate(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const user = c.var.user;
  if (!(await isOrgMember(db, user.orgId, user.id))) {
    return c.json({ error: "org membership required" }, 403);
  }
  const usersList = await listOrgDirectory(db, user.orgId);
  const body: OrgDirectoryResponse = { users: usersList };
  return c.json(body);
});

// ── Members: gate = org admin AND organizations feature on ──────────────

async function requireOrgAdminAndGate(c: Context<AppEnv>) {
  const forbidden = await requireGate(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const user = c.var.user;
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

// ── Plugin entitlements (plugin-entitlements design) ─────────────────────
//
// `GET  /api/org/plugins`        → any member reads the gateable-plugin block.
// `PATCH /api/org/plugins/:name` → org admin sets one plugin's mode + teams.
//
// Not tied to the `organizations` feature gate: a single-org deployment with
// the gate off still runs plugins, and an admin must still be able to narrow
// one. The admin write uses `requireOrgAdmin`, the same guard as `PATCH /`.

const ENTITLEMENT_MODES: readonly PluginEntitlementMode[] = ["off", "all", "teams"];

function isEntitlementMode(v: unknown): v is PluginEntitlementMode {
  return typeof v === "string" && (ENTITLEMENT_MODES as readonly string[]).includes(v);
}

orgRouter.get("/plugins", async (c) => {
  const { db, engineHost } = c.var.providers;
  const user = c.var.user;
  const plugins = await buildOrgPlugins(db, engineHost, user.orgId, user.id);
  const body: OrgPluginsResponse = { plugins };
  return c.json(body);
});

orgRouter.patch("/plugins/:name", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db, engineHost } = c.var.providers;
  const user = c.var.user;
  const name = c.req.param("name");

  // The name must be a currently-gateable plugin. An unknown/non-gateable
  // name 404s — a write to it could never take effect.
  const gateable = engineHost.gateablePlugins();
  const plugin = gateable.find((p) => p.name === name);
  if (!plugin) {
    return c.json({ error: `Unknown plugin '${name}'. It is not gateable on this deployment.` }, 404);
  }

  let body: PatchOrgPluginRequest;
  try {
    body = (await c.req.json()) as PatchOrgPluginRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!isEntitlementMode(body.mode)) {
    return c.json({ error: `mode must be one of ${ENTITLEMENT_MODES.join(", ")}` }, 400);
  }
  const teamIds = body.teamIds ?? [];
  if (!Array.isArray(teamIds) || teamIds.some((id) => typeof id !== "string")) {
    return c.json({ error: "teamIds must be a list of team ids, or omit the field." }, 400);
  }

  try {
    await setPluginEntitlement(db, user.orgId, name, { mode: body.mode, teamIds });
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }

  // Return the updated entry in the same shape the visibility block uses.
  const instanceEnabled = engineHost.isPluginLoaded(name);
  const entitlement = await getPluginEntitlement(db, user.orgId, name);
  const enabledForCaller =
    instanceEnabled && (await orgAllowsPluginForUser(db, user.orgId, user.id, name));
  const resp: PatchOrgPluginResponse = {
    name: plugin.name,
    label: plugin.label,
    description: plugin.description,
    instanceEnabled,
    entitlement,
    enabledForCaller,
  };
  return c.json(resp);
});
