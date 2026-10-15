import { saveTeamSettings } from "./team-settings.js";
/** Conversational settings use the same validators as the settings pages. */
import { and, eq } from "drizzle-orm";
import { Type, type Static, type TSchema } from "typebox";
import type { ActionPlugin, CredentialStore, PluginAction, PluginActionContext, PluginActionResult } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { orgMembers, orgs, users } from "../schema/index.js";
import { loadAccountSettings, patchAccountSettings, validateModelDefaults, type SettingsActor } from "./account-settings.js";
import { getOrgDefaultTier } from "./model-tiers.js";
import { patchModelTiers } from "./model-tier-settings.js";
import { isOrgAdmin, renameOrg } from "./org.js";
import { canAdministerTeam, canViewTeam, getTeamInOrg } from "./teams.js";

const optionalModel = Type.Optional(Type.Union([Type.String(), Type.Null()]));
const defaults = { defaultModel: optionalModel, defaultReasoning: optionalModel };
const refused = { success: false, error: "Open Ask Valet in your own or an accessible team workspace. Settings changes require a signed-in person." };

function action<T extends TSchema>(parameters: T, details: {
  id: string; name: string; description: string; riskLevel: PluginAction["riskLevel"]; approvalScope?: "actor";
  execute: (args: Static<T>, ctx: PluginActionContext) => Promise<PluginActionResult>;
}): PluginAction<T> { return { parameters, ...details }; }

/** A replay checks the current actor and membership again before reading or writing. */
async function actorFor(db: AppDb, ctx: PluginActionContext): Promise<SettingsActor | null> {
  if (ctx.externalSender || ctx.sessionPurpose !== "orchestrator" || !ctx.interactiveActor || ctx.interactiveActor.id !== ctx.userId) return null;
  if (ctx.owner?.type === "user" && ctx.owner.id !== ctx.userId) return null;
  if (ctx.owner?.type !== "user" && ctx.owner?.type !== "team") return null;
  const [row] = await db.select({ id: users.id, email: users.email, role: users.role }).from(users)
    .innerJoin(orgMembers, and(eq(orgMembers.userId, users.id), eq(orgMembers.orgId, ctx.orgId)))
    .where(eq(users.id, ctx.interactiveActor.id)).limit(1);
  if (!row) return null;
  if (ctx.owner.type === "team" && (!await getTeamInOrg(db, ctx.orgId, ctx.owner.id) || !await canViewTeam(db, ctx.owner.id, row.id))) return null;
  return { ...row, orgId: ctx.orgId };
}

function accountView(row: { name: string | null; timezone?: string | null; defaultModel: string | null; defaultReasoning: string | null }) {
  return { name: row.name, timezone: row.timezone ?? null, defaultModel: row.defaultModel, defaultReasoning: row.defaultReasoning,
    url: "/settings/profile", preferencesUrl: "/settings/preferences" };
}

export function settingsActionPlugin(db: AppDb, credentials: () => CredentialStore): ActionPlugin {
  async function teamFor(ctx: PluginActionContext, actor: SettingsActor, id: string, write: boolean) {
    if (ctx.owner?.type === "team" && ctx.owner.id !== id) return undefined;
    const team = await getTeamInOrg(db, actor.orgId, id);
    if (!team || !(write ? await canAdministerTeam(db, id, actor.id) : await canViewTeam(db, id, actor.id))) return undefined;
    return team;
  }
  async function organizationView(actor: SettingsActor) {
    const [row] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, actor.orgId)).limit(1);
    if (!row) return { success: false, error: "Organization not found. Reload Valet and try again." };
    return { success: true, data: { name: row.name, defaultTier: await getOrgDefaultTier(db, actor.orgId),
      canEdit: await isOrgAdmin(db, actor.orgId, actor.id), url: "/settings/organization", modelsUrl: "/settings/organization/models" } };
  }
  const read = action(Type.Object({
    scope: Type.Union([Type.Literal("account"), Type.Literal("team"), Type.Literal("organization")]),
    team_id: Type.Optional(Type.String()),
  }, { additionalProperties: false }), {
    id: "settings.get_settings", name: "Read Valet settings", riskLevel: "low",
    description: "Read safe account, team, or organization settings before a requested change. Team scope requires team_id. Returns current values and Settings links, never credentials. Account settings always belong to the person typing. Browser theme, palette, density and sound are device-local; explain their Settings controls instead.",
    execute: async ({ scope, team_id }, ctx) => {
      const actor = await actorFor(db, ctx);
      if (!actor) return refused;
      if (scope === "organization") return organizationView(actor);
      if (scope === "team") {
        const team = team_id ? await teamFor(ctx, actor, team_id, false) : undefined;
        return team ? { success: true, data: { teamId: team.id, name: team.name, defaultModel: team.defaultModel,
          defaultReasoning: team.defaultReasoning, url: `/settings/teams/${encodeURIComponent(team.id)}` } }
          : { success: false, error: "Team not found. Select that team workspace and try again." };
      }
      const row = await loadAccountSettings(db, actor);
      return row ? { success: true, data: accountView(row) } : refused;
    },
  });
  const account = action(Type.Object({ name: Type.Optional(Type.String()), timezone: optionalModel, ...defaults }, { additionalProperties: false, minProperties: 1 }), {
    id: "settings.update_account", name: "Change your Valet settings", riskLevel: "high", approvalScope: "actor",
    description: "Change the signed-in person's name, IANA timezone, or saved default model/reasoning, only when requested. Read settings first. Null clears an override. Defaults apply to new personal threads; existing threads keep their settings. Report success only after this action succeeds.",
    execute: async (args, ctx) => {
      const actor = await actorFor(db, ctx);
      if (!actor) return refused;
      const row = await patchAccountSettings(db, credentials(), actor, args);
      return "error" in row ? { success: false, error: row.error } : { success: true, data: accountView(row) };
    },
  });
  const team = action(Type.Object({ team_id: Type.String(), ...defaults }, { additionalProperties: false, minProperties: 2 }), {
    id: "settings.update_team", name: "Change team thread defaults", riskLevel: "high", approvalScope: "actor",
    description: "Change default model/reasoning for the named team only when requested. Read its settings first. Requires current team-admin or org-admin authority. A team workspace can change only its own team. Null clears an override. Existing threads keep their settings.",
    execute: async ({ team_id, ...args }, ctx) => {
      const actor = await actorFor(db, ctx);
      if (!actor) return refused;
      const found = await teamFor(ctx, actor, team_id, true);
      if (!found) return { success: false, error: "Team not found or team-admin access is required. Ask a team admin in that team workspace." };
      const update = await validateModelDefaults(db, credentials(), actor, args);
      if ("error" in update) return { success: false, error: update.error };
      const [row] = await saveTeamSettings(db, actor.orgId, team_id, update);
      return row ? { success: true, data: { teamId: row.id, name: row.name, defaultModel: row.defaultModel,
        defaultReasoning: row.defaultReasoning, url: `/settings/teams/${encodeURIComponent(row.id)}` } } : refused;
    },
  });
  const organization = action(Type.Object({ name: Type.Optional(Type.String()), defaultTier: optionalModel }, { additionalProperties: false, minProperties: 1 }), {
    id: "settings.update_organization", name: "Change organization settings", riskLevel: "high", approvalScope: "actor",
    description: "Change the current organization's name or saved default model tier (xs/s/m/l/xl, or null), only when requested. Read its settings first. Requires current organization-admin authority. Does not change tier mappings, provider keys, permissions, memberships, policies or public access.",
    execute: async (args, ctx) => {
      const actor = await actorFor(db, ctx);
      if (!actor) return refused;
      if (!await isOrgAdmin(db, actor.orgId, actor.id)) return { success: false, error: "Organization-admin access is required. Ask an organization admin." };
      if (args.defaultTier !== undefined) {
        const updated = await patchModelTiers(db, credentials(), actor, { defaultTier: args.defaultTier });
        if ("error" in updated) return { success: false, error: updated.error };
      }
      if (args.name !== undefined) await renameOrg(db, actor.orgId, args.name);
      return organizationView(actor);
    },
  });
  return { service: "settings", displayName: "Valet settings", actions: [read, account, team, organization] };
}
