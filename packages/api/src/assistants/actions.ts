/**
 * Agent-facing assistant-profile actions, exposed through the plugin catalog
 * (`list_tools`/`call_tool`) — the tool mirror of `routes/assistants.ts`, so
 * an orchestrator can manage the assistants its acting user can manage.
 *
 * Both surfaces reach the same service (`assistants/service.ts`) and the
 * same authorization (`canAdministerAssistantOwner`), so ownership, team
 * membership, validation, normalization, and default-slot rules are checked
 * in ONE place: this module adds no rule of its own and skips none.
 *
 * AUTHORIZATION follows the session's ACTING USER (`ctx.userId`), the same
 * model `workflows.patch_workflow` applies: a team assistant's session
 * freezes `userId` to the first person who woke it, so what these actions
 * may touch is what that person may touch — never more.
 *
 * RISK LEVELS mirror `skills-actions.ts`, and for the same reason: a
 * personality or behavior config is standing instruction text that every
 * later wake of that assistant injects, and the catalog's default policy
 * auto-allows anything below `high` — so every write here asks a human
 * first, org action policies can widen that deliberately, and `list` stays
 * free.
 *
 * EVICTION: a write that changes a persona input must reach the next wake,
 * exactly like the PATCH route. The engine host does not exist yet when
 * plugins assemble (`providers/node.ts`), so eviction arrives through a
 * deferred getter, the same one-slot indirection the workflows actions use.
 */
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import type {
  ActionPlugin,
  PluginAction,
  PluginActionContext,
  PluginActionResult,
} from "@valet/engine";
import type { Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { AssistantBehavior } from "../wire/types.js";
import { listTeamsForUser } from "../services/teams.js";
import { canAdministerAssistantOwner, assistantOwner } from "./access.js";
import {
  applyProfilePatch,
  archiveAssistant,
  ArchivedAssistantError,
  createAssistant,
  DefaultAssistantArchiveError,
  listAssistantsForOwners,
  loadAssistant,
  toAssistantSummary,
  validateProfilePatch,
} from "./service.js";

/** Curried action builder — same shape as `skills-actions.ts`. */
function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction["riskLevel"];
    execute: (args: Static<TParams>, ctx: PluginActionContext) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

const NO_OWNER: PluginActionResult = {
  success: false,
  error: "no authenticated principal in tool context",
};

function callerFromContext(ctx: PluginActionContext): { userId: string; orgId: string } | null {
  const { userId, orgId } = ctx as { userId?: unknown; orgId?: unknown };
  if (typeof userId !== "string" || userId.length === 0) return null;
  if (typeof orgId !== "string" || orgId.length === 0) return null;
  return { userId, orgId };
}



/** Service errors whose messages already name the corrective action pass
 * through; anything else rethrows — an unexpected failure must not read as
 * a validation problem. */
function failure(err: unknown): PluginActionResult {
  if (err instanceof ArchivedAssistantError || err instanceof DefaultAssistantArchiveError) {
    return { success: false, error: err.message };
  }
  throw err;
}

const NOT_FOUND = (id: string): PluginActionResult => ({
  success: false,
  // Existence-hiding, same as the routes: administering and viewing both
  // answer "not found" to a caller without access.
  error: `assistant not found: ${id}. Call assistants.list_assistants to see the ones you can reach.`,
});

// Type.Unknown, not a stricter schema: TypeBox rejections surface as a
// generic "/behavior: must be object" with no shape guidance, while
// validateProfilePatch (via validateAssistantBehavior) names the field and
// the fix. The looser schema routes EVERY malformed value to the validator
// with the corrective messages.
const BEHAVIOR_PARAM = Type.Optional(
  Type.Unknown({
    description:
      "Skills/integrations config: { skills?: { mode: 'all' } | { mode: 'allowlist', names: string[] }, " +
      "integrations?: { mode: 'all' } | { mode: 'allowlist', entries: [{ service, excludeActions? }] } }. " +
      "null clears back to 'everything'.",
  }),
);

/**
 * `evict` drops a session's in-process cache entry (never engine state), so
 * the next wake rebuilds from the row this action just wrote — the same
 * seam PATCH /api/assistants/:id uses.
 */
export function assistantsActionPlugin(db: AppDb, evict: (sessionId: string) => void): ActionPlugin {
  const listAction = action(Type.Object({}))({
    id: "assistants.list_assistants",
    name: "List assistants",
    description:
      "List the assistants you can reach: your own, plus one set per team you belong to. " +
      "Returns each assistant's id, name, owner, default flag, personality, and behavior config.",
    riskLevel: "low",
    execute: async (_args, ctx) => {
      const caller = callerFromContext(ctx);
      if (!caller) return NO_OWNER;
      const teams = await listTeamsForUser(db, caller.userId);
      const owners: Principal[] = [
        { type: "user", id: caller.userId },
        ...teams
          .filter((t) => t.orgId === caller.orgId)
          .map((t): Principal => ({ type: "team", id: t.id })),
      ];
      const rows = await listAssistantsForOwners(db, caller.orgId, owners);
      return { success: true, data: { assistants: rows.map(toAssistantSummary) } };
    },
  });

  const createAction = action(
    Type.Object({
      name: Type.String({ description: "The assistant's display name." }),
      team_id: Type.Optional(
        Type.String({
          description:
            "Create the assistant for this team instead of yourself. You must administer the team.",
        }),
      ),
      personality: Type.Optional(
        Type.String({ description: "Persona text injected at wake: 'You are {name}. {personality}'." }),
      ),
      behavior: BEHAVIOR_PARAM,
    }),
  )({
    id: "assistants.create_assistant",
    name: "Create assistant",
    description:
      "Create an assistant for yourself or a team you administer. The first assistant a " +
      "principal owns becomes its default.",
    riskLevel: "high",
    execute: async (args, ctx) => {
      const caller = callerFromContext(ctx);
      if (!caller) return NO_OWNER;
      const err = validateProfilePatch(args);
      if (err) return { success: false, error: err };
      const owner: Principal = args.team_id
        ? { type: "team", id: args.team_id }
        : { type: "user", id: caller.userId };
      if (!(await canAdministerAssistantOwner(db, owner, caller.userId))) {
        return {
          success: false,
          error:
            "owner not found. Check team_id against assistants.list_assistants; creating a team's " +
            "assistant requires administering that team.",
        };
      }
      const row = await createAssistant(db, caller.orgId, owner, args.name, {
        personality: args.personality ?? null,
        // Safe cast: validateProfilePatch above rejected any shape
        // validateAssistantBehavior does not accept.
        behavior: (args.behavior as AssistantBehavior | null | undefined) ?? null,
      });
      return { success: true, data: toAssistantSummary(row) };
    },
  });

  const updateAction = action(
    Type.Object({
      assistant_id: Type.String({ description: "Row id from assistants.list_assistants." }),
      name: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: "New display name. null clears it (neutral persona).",
        }),
      ),
      personality: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description:
            "Persona text injected at wake. null clears it: the assistant keeps only its name.",
        }),
      ),
      behavior: BEHAVIOR_PARAM,
      is_default: Type.Optional(
        Type.Literal(true, {
          description:
            "Promote this assistant to the owner's default; the previous default is demoted in the same write.",
        }),
      ),
    }),
  )({
    id: "assistants.update_assistant",
    name: "Update assistant",
    description:
      "Rename an assistant, set or clear its personality, replace its skills/integrations " +
      "behavior config, or promote it to the owner's default. A changed persona reaches the " +
      "assistant's NEXT wake; its current turn finishes on the old one.",
    riskLevel: "high",
    execute: async (args, ctx) => {
      const caller = callerFromContext(ctx);
      if (!caller) return NO_OWNER;
      if (
        args.name === undefined &&
        args.personality === undefined &&
        args.behavior === undefined &&
        args.is_default === undefined
      ) {
        return {
          success: false,
          error: "Send a name, personality, behavior, or is_default: true.",
        };
      }
      const err = validateProfilePatch(args);
      if (err) return { success: false, error: err };

      const row = await loadAssistant(db, args.assistant_id);
      if (!row || row.orgId !== caller.orgId) return NOT_FOUND(args.assistant_id);
      if (!(await canAdministerAssistantOwner(db, assistantOwner(row), caller.userId))) {
        return NOT_FOUND(args.assistant_id);
      }

      try {
        // applyProfilePatch owns the changed-values eviction rule
        // (service.ts) — the same seam the PATCH route uses.
        const updated = await applyProfilePatch(
          db,
          row,
          {
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.personality !== undefined ? { personality: args.personality } : {}),
            ...(args.behavior !== undefined
              ? // Safe cast: validateProfilePatch above rejected any shape
                // validateAssistantBehavior does not accept.
                { behavior: args.behavior as AssistantBehavior | null }
              : {}),
            ...(args.is_default === true ? { isDefault: true as const } : {}),
          },
          evict,
        );
        return { success: true, data: toAssistantSummary(updated) };
      } catch (err) {
        return failure(err);
      }
    },
  });

  const archiveAction = action(
    Type.Object({
      assistant_id: Type.String({ description: "Row id from assistants.list_assistants." }),
    }),
  )({
    id: "assistants.archive_assistant",
    name: "Archive assistant",
    description:
      "Archive an assistant: it leaves the sidebar, its conversation history stays readable. " +
      "The owner's default cannot be archived — promote another assistant first.",
    riskLevel: "high",
    execute: async (args, ctx) => {
      const caller = callerFromContext(ctx);
      if (!caller) return NO_OWNER;
      const row = await loadAssistant(db, args.assistant_id);
      if (!row || row.orgId !== caller.orgId) return NOT_FOUND(args.assistant_id);
      if (!(await canAdministerAssistantOwner(db, assistantOwner(row), caller.userId))) {
        return NOT_FOUND(args.assistant_id);
      }
      try {
        await archiveAssistant(db, row);
        return { success: true, data: { assistantId: args.assistant_id, archived: true } };
      } catch (err) {
        return failure(err);
      }
    },
  });

  return {
    service: "assistants",
    description: "Manage assistant profiles: names, personas, behavior configs, defaults, archive.",
    actions: [listAction, createAction, updateAction, archiveAction],
  };
}
